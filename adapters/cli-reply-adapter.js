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
import { listSessionFiles, findSessionFile, parseSessionFile } from "./claude-sessions.js";

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
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 250));
        const w = readRoster()?.workers?.[short];
        if (w?.sessionId) {
          const c = w.cwd || spawnCwd;
          resolve({ short, sessionId: w.sessionId, cwd: c, jsonlPath: sessionJsonlPath(w.sessionId, c), spawnStartedAt });
          return;
        }
      }
      reject(new Error(`roster did not surface sessionId for short ${short}`));
    });
  });
}

// pool 风格事件映射(与 cli-pool-adapter 一致):累积 text(turn_end 用它兜底回传 —— bridge 用 result.text
// 发 TG,不累积会"无输出");AskUserQuestion 静默跳过(hook 已拦、模型自主续写);idle_heartbeat→heartbeat。
function* mapEvents(ev, state) {
  if (ev.type === "session_init") { yield ev; return; }
  if (ev.type === "user_echo") return;
  if (ev.type === "idle_heartbeat") { yield { type: "heartbeat", idleSec: ev.idleSec, elapsedSec: ev.elapsedSec }; return; }
  if (ev.type === "text") { state.accumulatedText += ev.text; yield { type: "text", text: ev.text }; return; }
  if (ev.type === "thinking") return;
  if (ev.type === "tool_use") {
    if (ev.name === "AskUserQuestion") return;
    yield { type: "progress", toolName: ev.name, input: ev.input };
    const input = ev.input || {};
    if ((ev.name === "Write" || ev.name === "Edit") && input.file_path) yield { type: "file_written", filePath: input.file_path, tool: ev.name };
    return;
  }
  if (ev.type === "turn_end") { yield { type: "result", success: true, text: state.accumulatedText, duration: ev.durationMs }; return; }
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

    async *streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      const { model, effort, cwd, systemAppend } = overrides;
      const turnCwd = cwd || defaultCwd;
      const heartbeatMs = Number(overrides.heartbeatMs) || Number(process.env.CLI_POOL_HEARTBEAT_MS) || 180000;
      const hardLimitMs = Number(overrides.hardLimitMs) || Number(process.env.CLI_POOL_HARD_LIMIT_MS) || 3600000;
      const state = { accumulatedText: "" };
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
            yield { type: "session_init", sessionId: worker.sessionId };  // 不变,幂等(bridge 持久化它)
            const reader = new JsonlTailReader(worker.jsonlPath);
            reader.offset = offset;  // offset 限制重读字节量(长会话 jsonl 大);正确性靠下面的归属门
            // 关键(2026-06-14 实测踩到):必须传 spawnStartedAt=replyStartedAt(+expectUserText),让 userEchoSeen 起始
            // false、只在本轮 reply 的 user echo 之后开闸。否则上一轮【soft-end 早退】留下的 turn_duration(reader 在
            // text+end_turn 处提前 return、worker 仍会补写 turn_duration)会被当作"本轮结束"→ 立刻空 result(无输出)。
            for await (const ev of reader.readUntilTurnEnd({ expectUserText: prompt, spawnStartedAt: replyStartedAt, heartbeatMs, hardLimitMs, abortSignal }))
              for (const m of mapEvents(ev, state)) yield m;
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
        let turn;
        try {
          turn = await spawnWorker(turnConfig, prompt, { resumeSessionId: sessionId || null, model, effort, cwd: turnCwd, systemAppend });
        } catch (spawnErr) {
          if (sessionId) {
            console.warn(`[cli-reply-adapter] resume spawn failed for ${String(sessionId).slice(0, 8)} (${spawnErr.message}); retrying as new session`);
            turn = await spawnWorker(turnConfig, prompt, { resumeSessionId: null, model, effort, cwd: turnCwd, systemAppend });
          } else { throw spawnErr; }
        }
        activeShort = turn.short;
        yield { type: "session_init", sessionId: turn.sessionId };
        const reader = new JsonlTailReader(turn.jsonlPath);
        for await (const ev of reader.readUntilTurnEnd({ expectUserText: prompt, spawnStartedAt: turn.spawnStartedAt, heartbeatMs, hardLimitMs, abortSignal }))
          for (const m of mapEvents(ev, state)) yield m;
      } catch (e) {
        if (abortSignal?.aborted) {
          // 用户 Stop:杀掉本轮 worker,别让它在后台继续 bypassPermissions 跑工具(codex P1)。
          // 代价:这个常驻会话没了,下条消息会 --resume 复活(fork 一次)——Stop 不频繁,安全 > 保持会话。
          if (activeShort) daemon.kill(activeShort).catch(() => {});
          throw e;  // 上抛走 bridge 干净取消
        }
        console.error(`[cli-reply-adapter] streamQuery err sid=${String(sessionId || "new").slice(0, 8)}: ${e.message}`);
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
