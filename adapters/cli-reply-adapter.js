// adapters/cli-reply-adapter.js
// 常驻 --bg worker + authed op:reply 引擎(2026-06-14)——"无垃圾 + 手机 remote control"的真正和解。
//
// 为什么:fork-pool(cli-pool.js)每轮 `--bg --resume` fork 新 sessionId = 每轮一个垃圾 jsonl;print
//   引擎(cli-print-adapter.js)不 fork、零垃圾,但 `--print` headless 无 TTY → 进不了 daemon 的 RC 列表
//   = app/手机接管不了(官方 RC 要 TTY + 常驻进程,headless RC 仍是 open feature request)。
// 这条:每个 chat 一个【常驻 --bg worker】(带 PTY → 可被 app/手机 remote control 接管),每轮把新输入用
//   authed op:reply 喂进【同一会话】(零 fork、零垃圾)。两全。
//   - 新 chat / 无 sessionId:spawn `claude --bg ... "<prompt>"` 起 worker,turn1 自动跑。
//   - sessionId 在 + worker 还活(roster 命中):DaemonClient.reply(short, prompt) 进同一会话 —— 零 fork。
//   - sessionId 在但 worker 已被 daemon idle 回收 / bridge 重启过:`--bg --resume <sid>` 复活(此处会 fork
//     一次出新 sid,但只在"闲置被回收后"偶发,不是每轮 —— 比 fork-pool 的每轮 fork 少几个数量级)。
// 输出:tail 同一个 jsonl。reply 轮在发 reply 前记 offset、只读新增到 turn 末(稳定 session 无 fork 历史,
//   归属比 fork-pool 简单);新建/复活轮沿用 fork-pool 的 spawnStartedAt + expectUserText 归属(复活轮有继承历史)。
//
// 协议/auth 见 adapters/daemon-client.js(从 2.1.177 binary 挖出 + spike 实测)。auth = control.key 原文 trim。
// 接口对齐 cli-pool-adapter.js / cli-print-adapter.js;启 env CLAUDE_REPLY_ENGINE=1(默认关,见 interface.js)。

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { JsonlTailReader, buildTurnArgs, readRoster } from "./cli-pool.js";
import { DaemonClient, findLiveWorkerBySession, sessionJsonlPath } from "./daemon-client.js";
import { listSessionFiles, findSessionFile, parseSessionFile, probeSessionFile } from "./claude-sessions.js";
import { stripMalformedToolCall } from "./sanitize-text.js";

const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");

// spawn 一个常驻 --bg worker(turn1 带 prompt 自动跑)。复用 cli-pool 的 buildTurnArgs
//   (--bg/model/effort/--settings 非交互防护/--append-system-prompt/[--resume])。
// resumeSessionId 有值 = 复活旧会话(--resume,会 fork 出新 sid);无 = 全新。
// 返回 { short, sessionId, cwd, jsonlPath, spawnStartedAt }。
async function spawnWorker(config, prompt, { resumeSessionId, model, effort, cwd, systemAppend } = {}) {
  const { args } = buildTurnArgs(config, { resumeSessionId, model, effort, systemAppend });
  args.push(prompt);
  const spawnCwd = cwd || config.cwd;
  const spawnStartedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_CLI_PATH, args, { cwd: spawnCwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", c => out += c);
    child.stderr.on("data", c => err += c);
    const timer = setTimeout(() => { child.kill(); reject(new Error("spawn timeout (30s)")); }, config.spawnTimeoutMs || 30000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", async () => {
      clearTimeout(timer);
      const m = out.match(/backgrounded\s+·\s+([a-f0-9]{8})/);
      if (!m) { reject(new Error(`no short in stdout: ${out.slice(0, 150)}; stderr: ${err.slice(0, 150)}`)); return; }
      const short = m[1];
      // 等 daemon 把 fork 出的新 sessionId 注册进 roster。原写死 6s(24×250ms),对 opus max + 大会话
      // (隔久了攒得长,--resume 要先加载完整历史才 fork 出新 sid)经常不够 → 超时后上层退化成新会话、丢上下文
      // (Alice 实测"隔 5 小时以上接不上"的根因)。提到默认 30s 且 env 可配;兜底读 dispatch.sessionId
      // (顶层 sessionId 偶发晚于 dispatch 字段填充)。sawWorker 留作诊断:区分"worker 没注册"(可能真没起)
      // 与"注册了但 sessionId 没填"(慢)。
      const rosterWaitMs = Number(process.env.CLI_REPLY_ROSTER_WAIT_MS) || 30000;
      const pollMs = 250;
      let sawWorker = false;
      for (let i = 0; i < Math.ceil(rosterWaitMs / pollMs); i++) {
        await new Promise(r => setTimeout(r, pollMs));
        const w = readRoster()?.workers?.[short];
        if (w) sawWorker = true;
        const sid = w?.sessionId || w?.dispatch?.sessionId;
        if (sid) {
          const c = w.cwd || spawnCwd;
          resolve({ short, sessionId: sid, cwd: c, jsonlPath: sessionJsonlPath(sid, c), spawnStartedAt });
          return;
        }
      }
      // roster 没浮现 sessionId:worker 可能起来了但 fork 的新 sid 注册太慢(也可能真没起)。必须 stop 掉它再失败——
      // 否则它带着【新 sid】在后台继续 bypassPermissions 跑工具,而 bridge 存的是【旧 sid】、findLiveWorkerBySession
      // 找不到它,上层重发只会再 fork 一个 worker = 双跑 + 重复副作用(codex P2)。stop 后重发是干净的单 worker。
      try { spawn(CLAUDE_CLI_PATH, ["stop", short], { stdio: "ignore" }).unref?.(); } catch { /* best-effort */ }
      reject(new Error(`roster did not surface sessionId for short ${short} (waited ${rosterWaitMs}ms, sawWorker=${sawWorker})`));
    });
  });
}

// ECHO_TIMEOUT 自愈(2026-07-17):实测一大根因是 Claude CLI 自动升级 → daemon 检测到 binary changed
// self-restart 换代 → 接管后 respawn(attempt≥2)的 worker 永久卡死在 state:"resuming"(非交互态)——
// op:reply 回执 ok 但消息进黑洞,"提示用户重发"彻底失效(worker 还卡着,每条必 ECHO_TIMEOUT 死循环,
// 案例 RecallNest e8e136f7)。此函数判定并清除卡死 worker:
//   - state==="resuming" → 官方 op:kill(绝不 kill -9 进程,daemon 会当意外死亡再 respawn 一个卡死的回来),
//     等 roster 摘除后返回 true → 调用方本轮直接递归重投(kill 后 findLiveWorkerBySession 落空,
//     自然走 --resume 复活路径,历史保留、用户无感)。
//   - job 已消失(90s 窗口内 worker 死了)→ 不用 kill,直接 true 重投走复活。
//   - 其他 state(可能真在跑活)/ daemon 不可达 → false,宁漏勿误杀,回落原提示文案。
// deps 可注入(测试用);等待参数放宽给测试压短。
export async function selfHealStuckWorker(short, { list, kill, rosterHas, waitMs = 250, maxWaitRounds = 20 }) {
  try {
    const l = await list();
    const job = l?.jobs?.find(j => j.short === short);
    if (job && job.state !== "resuming") return false;
    if (job) await kill(short);
    for (let i = 0; i < maxWaitRounds; i++) {
      if (!rosterHas(short)) return true;
      await new Promise(r => setTimeout(r, waitMs));
    }
    return true;  // kill 已发出但 roster 迟迟不摘:仍重投——最坏再 ECHO_TIMEOUT 一次,由 __echoRetried 兜住不循环
  } catch { return false; }
}

// 幽灵会话判定(2026-07-17,case 4fb95516):sessionId 有值但该会话的 jsonl 全局不存在 = 黑洞 ID
// (fork 复活在"加载历史→写首行"窗口内被取消 / worker 卡死在落盘前,留下的悬空 ID)。--resume 它会
// "干净退化成新会话"(静默),但下轮 bridge 又把新 fork 的 sid 存回,用户再取消又造一个黑洞 → 死循环
// (2026-07-17 mccode2 实况:每条消息进黑洞,只能靠人重启)。主动识别:ghost=true → 调用方直接开
// 新会话并在回复开头明说。
// fail-open 用三态查找 probeSessionFile(codex review P1):"扫描失败"≠"确认不存在"——目录瞬时
// 不可读时按"存在"处理照常 resume,只有全目录扫完确无文件才判幽灵,绝不因一次 IO 失败丢上下文。
export function resolveResumeSid(sessionId, { probeSession = probeSessionFile } = {}) {
  const sid = sessionId || null;
  if (!sid) return { sid: null, ghost: false };
  let probe;
  try { probe = probeSession(sid); } catch { probe = { found: null, scanFailed: true }; }
  if (probe?.found || probe?.scanFailed) return { sid, ghost: false };
  return { sid: null, ghost: true };
}

// 幽灵会话提示语(拼在本轮回复开头,让用户知道上下文没续上,而非静默退化)
export const GHOST_SESSION_NOTICE = "⚠️ 上个会话的记录文件不存在(多半是之前取消/故障留下的悬空会话),这条起我开了个新会话——旧上下文没续上,需要的话把背景再交代一句。\n\n";

// pool 风格事件映射(与 cli-pool-adapter 一致):累积 text(turn_end 用它兜底回传 —— bridge 用 result.text
// 发 TG,不累积会"无输出");AskUserQuestion 静默跳过(hook 已拦、模型自主续写);idle_heartbeat→heartbeat。
export function* mapEvents(ev, state) {
  if (ev.type === "session_init") { yield ev; return; }
  if (ev.type === "user_echo") return;
  if (ev.type === "idle_heartbeat") { yield { type: "heartbeat", idleSec: ev.idleSec, elapsedSec: ev.elapsedSec }; return; }
  if (ev.type === "text") {
    const clean = stripMalformedToolCall(ev.text);  // 剥模型 malformed 的 <invoke> 文本 XML(见 sanitize-text.js)
    if (clean) { state.accumulatedText += clean; yield { type: "text", text: clean }; }
    return;
  }
  if (ev.type === "thinking") {
    // thinking 块 → "🤔 思考中" 进度态(长思考 + 纯文字回复时消灭"以为卡死"的错觉)。
    // 只取它的"出现"作进度信号,不把模型内心独白发到 TG。"__thinking__" 是与 progress.js 约定的哨兵
    // toolName;progress.js 把连续 thinking 合并为单行、不刷屏。
    yield { type: "progress", toolName: "__thinking__" };
    return;
  }
  if (ev.type === "tool_use") {
    if (ev.name === "AskUserQuestion") return;
    yield { type: "progress", toolName: ev.name, input: ev.input };
    const input = ev.input || {};
    if ((ev.name === "Write" || ev.name === "Edit") && input.file_path) yield { type: "file_written", filePath: input.file_path, tool: ev.name };
    return;
  }
  if (ev.type === "turn_end") { yield { type: "result", success: true, text: state.accumulatedText, duration: state.turnStartAt ? Date.now() - state.turnStartAt : ev.durationMs }; return; }
}

export function createAdapter(config = {}) {
  const defaultModel = config.model || process.env.CC_MODEL || "opus";
  const defaultEffort = config.effort || process.env.DEFAULT_EFFORT || "max";
  const defaultPermMode = config.permissionMode || process.env.CC_PERMISSION_MODE || "bypassPermissions";
  const defaultCwd = config.cwd || process.env.CC_CWD || process.env.HOME;
  const destructiveGuard = config.destructiveGuard !== false && process.env.CLI_POOL_DESTRUCTIVE_GUARD !== "0";
  const turnConfig = { model: defaultModel, effort: defaultEffort, permissionMode: defaultPermMode, cwd: defaultCwd, destructiveGuard };
  const daemon = new DaemonClient();

  return {
    name: "claude",
    label: "CC(rc)",
    icon: "🟪",

    availableModels() {
      return [
        { id: "__default__", label: `默认 (${defaultModel})` },
        { id: "opus", label: "Opus 最新" },
        { id: "sonnet", label: "Sonnet 最新" },
        { id: "haiku", label: "Haiku 最新" },
      ];
    },
    availableEfforts() {
      return [
        { id: "__default__", label: `默认 (${defaultEffort})`, description: "标准深度" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max", description: "最深(仅 Opus)" },
      ];
    },

    // 具名函数表达式:函数名 streamQuery 在体内可自引用 —— ECHO_TIMEOUT 自愈需要递归重投本轮,
    // 对象方法没有稳定自引用(this 依赖解构方式)。
    streamQuery: async function* streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      const { model, effort, cwd, systemAppend } = overrides;
      const turnCwd = cwd || defaultCwd;
      const heartbeatMs = Number(overrides.heartbeatMs) || Number(process.env.CLI_POOL_HEARTBEAT_MS) || 180000;
      const hardLimitMs = Number(overrides.hardLimitMs) || Number(process.env.CLI_POOL_HARD_LIMIT_MS) || 3600000;
      // 本轮启动看门狗:op:reply 偶发没投递成功(worker 没起新 turn、user echo 不出现)时,等 echoGraceMs 即快速失败,
      // 而非闷等 hardLimit(1h)。只用于 op:reply 分支(下面新建/复活轮的 user echo 必到、不传)。可用 env 调,默认 90s。
      const echoGraceMs = Number(overrides.echoGraceMs) || Number(process.env.CLI_REPLY_ECHO_GRACE_MS) || 90000;
      const state = { accumulatedText: "", turnStartAt: 0 };
      let activeShort = null;  // 当前轮投喂到的 worker short:用户 Stop 时杀它,别让它在后台 bypassPermissions 跑工具(codex P1)
      try {
        const live = sessionId ? findLiveWorkerBySession(sessionId) : null;
        // 仅当本轮【显式 /dir 切了 cwd】(overrides.cwd 给了、且和 worker 当前 cwd 不同)才不复用:op:reply 改不了
        // worker 的 cwd,/dir 后还喂旧 worker 会跑错目录(codex P2)。常规轮不显式给 cwd → 一律复用活 worker,
        // 不拿 default cwd 去比 roster cwd(/tmp↔/private/tmp 这类符号链接会假不等、误触发 fork)。
        // model/effort 同理 op:reply 改不了 → 已知限制:per-turn /model//effort 覆盖对【已存在 worker】不即时生效,
        // 下次新建 worker(/new 或被回收复活)才应用;固定配置的 bot(Alice 用法,/model//effort//dir 已不在菜单)影响极小。
        const cwdChanged = overrides.cwd && live && overrides.cwd !== live.cwd;
        const worker = live && !cwdChanged ? live : null;

        if (worker) {
          // —— 常驻 worker 还活 + cwd 一致:op:reply 进同一会话,零 fork ——
          activeShort = worker.short;
          const offset = existsSync(worker.jsonlPath) ? statSync(worker.jsonlPath).size : 0;
          const replyStartedAt = Date.now();  // 归属基准:本轮 reply 之前的行(上一轮收尾的 turn_duration 等)按 ts 滤掉
          const ack = await daemon.reply(worker.short, prompt);
          if (ack.ok) {
            state.turnStartAt = replyStartedAt;  // 本轮耗时基准:不信任 jsonl turn_duration(常驻 worker 下是累计/残留值 → 假"几十分钟")
            yield { type: "session_init", sessionId: worker.sessionId };  // 不变,幂等(bridge 持久化它)
            const reader = new JsonlTailReader(worker.jsonlPath, { sessionId: worker.sessionId });  // sessionId → 静默重定位(worktree 迁移)
            reader.offset = offset;  // offset 限制重读字节量(长会话 jsonl 大);正确性靠下面的归属门
            // 归属门(2026-06-14 复核结论,勿改回 assumeEchoSeen):op:reply 后必须等本轮 user echo 才开闸——上一轮
            // soft-end 早退后 worker 晚写的 turn_duration 可能 ts >= replyStartedAt、落在 offset 之后,若起始即开闸会被
            // 误当本轮结束 → 空 result + 丢消息(codex P1)。
            // 已知遗留(根因不在此处归属逻辑):op:reply 偶发没让 worker 启动新 turn —— user echo 压根没写进 jsonl(实测
            // d184d41a "你只需要发简体版"那轮尾部无对应 user 行),echo 等不到 → 卡 hardLimit。属 daemon op:reply 投递时序,
            // 待查 daemon-client.js;adapter 层可做的缓解是"本轮启动看门狗"(echo 超时即快速失败兜底,而非傻等 1h)。
            for await (const ev of reader.readUntilTurnEnd({ expectUserText: prompt, spawnStartedAt: replyStartedAt, echoGraceMs, heartbeatMs, hardLimitMs, abortSignal }))
              for (const m of mapEvents(ev, state)) yield m;
            // 迟到产出巡逻交接(2026-07-17,case 8d6eb755):turn 正常收尾后,CC 的 bg 接力任务可能稍后往
            // 同一 jsonl 续写最终报告——把"从哪个文件哪个偏移接着盯"交给 bridge 侧巡逻器补发。
            // 只在正常收尾路径 yield(catch/abort 不发:worker 状态未知,别乱盯)。
            yield { type: "late_patrol_handle", sessionId: worker.sessionId, jsonlPath: reader.path, offset: reader.offset, turnEndedAt: Date.now() };
            return;
          }
          if (ack.code !== "ENOJOB") throw new Error(`op:reply failed: ${ack.code || ""} ${ack.error || ""}`.trim());
          activeShort = null;  // worker 没了,清掉
          // ENOJOB:worker 刚好没了 → 落到下面"无活 worker"分支,--resume 复活
          console.warn(`[cli-reply-adapter] worker for ${String(sessionId).slice(0, 8)} gone (ENOJOB), reviving via --resume`);
        }

        // —— 无活 worker(或 cwd 变了):新建(turn1)或 --resume 复活(闲置被回收 / bridge 重启 / /dir 切换;复活会 fork 一次出新 sid)——
        // spawn 失败兜底(codex P2 的稳妥版):spawnWorker 因超时 / 没拿到 short 等异常 reject 时,若本轮是 resume → 退回全新建重试一次。
        // 注(2026-06-14 实测):`--bg --resume <失效 sid>` 本身【不会 reject】——它干净退化成一个新会话(exit 0、照常 backgrounded),
        // 所以 print 引擎那种"session 被删 → 每轮报错卡到 /new"在 --bg 这边天然不存在;这条兜的主要是 spawn 进程本身的异常。
        // 幽灵会话轮前校验(2026-07-17):黑洞 ID 不 resume,直接新建 + 回复开头明示(一条消息自愈,见 resolveResumeSid)。
        const { sid: resumeSid, ghost } = resolveResumeSid(sessionId);
        if (ghost) {
          console.warn(`[cli-reply-adapter] ghost session ${String(sessionId).slice(0, 8)}: no jsonl anywhere, starting fresh with notice`);
          state.accumulatedText = GHOST_SESSION_NOTICE;
        }
        let turn;
        try {
          turn = await spawnWorker(turnConfig, prompt, { resumeSessionId: resumeSid, model, effort, cwd: turnCwd, systemAppend });
        } catch (spawnErr) {
          const sid8 = String(resumeSid || "").slice(0, 8);
          // roster 超时:spawnWorker 已 stop 掉那个慢 worker(防它带新 sid 后台双跑 / 重复副作用,codex P2)。
          // 绝不静默退化成新会话(resumeSessionId:null)—— 那会把旧上下文整段丢掉(Alice"隔久了接不上"的真凶)。
          // 保留旧 sessionId(bridge 不更新 → 下条消息仍 --resume 同一段历史),提示重发:重发是干净的单 worker、
          // 窗口已 30s,大概率接上;上下文始终不丢。
          if (resumeSid && (spawnErr.message || "").includes("roster did not surface sessionId")) {
            console.warn(`[cli-reply-adapter] resume slow for ${sid8} (${spawnErr.message}); stopped slow worker, preserving session, asking resend`);
            yield { type: "result", success: true, text: "刚才那条复活旧会话慢了点(会话没丢),隔两三秒再发一遍就接上了～" };
            return;
          }
          // 其他失败(spawn 30s 超时 / stdout 没给 short = worker 真没起来):旧会话这条确实接不上,
          // 退回全新重试一次(保留原行为,至少给用户一个能回话的会话)。
          if (resumeSid) {
            console.warn(`[cli-reply-adapter] resume spawn failed for ${sid8} (${spawnErr.message}); retrying as new session`);
            turn = await spawnWorker(turnConfig, prompt, { resumeSessionId: null, model, effort, cwd: turnCwd, systemAppend });
          } else { throw spawnErr; }
        }
        activeShort = turn.short;
        state.turnStartAt = turn.spawnStartedAt;  // 同上:本轮耗时用 wall-clock,不信 jsonl turn_duration
        yield { type: "session_init", sessionId: turn.sessionId };
        const reader = new JsonlTailReader(turn.jsonlPath, { sessionId: turn.sessionId });  // sessionId → 静默重定位(worktree 迁移)
        for await (const ev of reader.readUntilTurnEnd({ expectUserText: prompt, spawnStartedAt: turn.spawnStartedAt, heartbeatMs, hardLimitMs, abortSignal }))
          for (const m of mapEvents(ev, state)) yield m;
        // 同上:新建/复活轮正常收尾后交接迟到产出巡逻
        yield { type: "late_patrol_handle", sessionId: turn.sessionId, jsonlPath: reader.path, offset: reader.offset, turnEndedAt: Date.now() };
      } catch (e) {
        if (abortSignal?.aborted) {
          // 用户 Stop:杀掉本轮 worker,别让它在后台继续 bypassPermissions 跑工具(codex P1)。
          // 代价:这个常驻会话没了,下条消息会 --resume 复活(fork 一次)——Stop 不频繁,安全 > 保持会话。
          if (activeShort) daemon.kill(activeShort).catch(() => {});
          throw e;  // 上抛走 bridge 干净取消
        }
        console.error(`[cli-reply-adapter] streamQuery err sid=${String(sessionId || "new").slice(0, 8)}: ${e.message}`);
        // 本轮启动看门狗触发:op:reply 偶发没投递成功(worker 没起新 turn)。worker 仍健康、会话未坏,下条消息照常
        // 续接 —— 给用户明确可操作的提示(纯文本、TG 友好),而非技术错误信息或闷卡。
        // success:true(codex P3):这是预期内的恢复引导,不是 backend 故障。若用 false,bridge sendFinalResult 会
        // 套成"CC(rc) 出错:…完整日志见后台"= 把好心提示显示成报错。用 true 让这句纯文本提示原样发给用户。
        if ((e.message || "").startsWith("ECHO_TIMEOUT")) {
          // 自愈优先(2026-07-17,案例 RecallNest e8e136f7):worker 卡死 state:"resuming"(CLI 升级 daemon 换代
          // respawn 特有)时,"提示重发"是死循环——先查实并清掉卡死 worker,本轮直接递归重投(kill 后
          // findLiveWorkerBySession 落空 → 走 --resume 复活,历史保留、用户无感)。只试一次(__echoRetried);
          // worker 状态正常(可能真在跑)或 daemon 不可达 → 不动刀,回落原提示。
          if (!overrides.__echoRetried && activeShort) {
            const healed = await selfHealStuckWorker(activeShort, {
              list: () => daemon.list(),
              kill: s => daemon.kill(s),
              rosterHas: s => !!readRoster()?.workers?.[s],
            });
            if (healed) {
              console.warn(`[cli-reply-adapter] self-heal: worker ${activeShort} stuck(resuming)/gone after ECHO_TIMEOUT — cleared, re-driving turn via revive`);
              yield* streamQuery(prompt, sessionId, abortSignal, { ...overrides, __echoRetried: true });
              return;
            }
          }
          yield { type: "result", success: true, text: "这条好像没递到我这边(偶发投递问题),我还在、会话没坏,把刚才那句重发一遍就行～" };
          return;
        }
        // 兜底回传:已产出的正文必须发出(防"无输出");success:true 走正文路径,false 会被压成一句话丢正文。
        const acc = (state.accumulatedText || "").trim();
        if (acc) yield { type: "result", success: true, text: acc + `\n\n———\n⚠️ 注:这轮中途出了点状况(${(e.message || "").slice(0, 80)}),以上是已产出的内容。` };
        else yield { type: "result", success: false, text: `CC(rc) 出错:${e.message}` };
      }
    },

    statusInfo(overrideModel, overrideEffort) {
      return { model: overrideModel || defaultModel, effort: overrideEffort || defaultEffort, cwd: defaultCwd, mode: "Reply (persistent --bg + op:reply)" };
    },

    async listSessions(limit = 10) {
      const recent = listSessionFiles(limit);
      const out = [];
      for (const s of recent) out.push(await parseSessionFile(s, defaultCwd));
      return out;
    },
    async resolveSession(sessionId) {
      const fi = findSessionFile(sessionId);
      return fi ? await parseSessionFile(fi, defaultCwd) : null;
    },
  };
}
