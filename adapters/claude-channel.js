// 交互式 claude CLI（channel 机制）引擎 adapter。
// one-shot：每轮起一个 claude 子进程，答完关。
// 与 claude.js 同接口异机制；session 元数据复用 claude-sessions.js。
// TTY 用 macOS `script`（node-pty 不兼容 bun）；channel 走 plugin: 路径。
import net from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { listSessionFiles, findSessionFile, parseSessionFile } from "./claude-sessions.js";
import {
  createChannelState, maybeEmitInit, mapChannelMessage,
  adaptPermissionRequest, buildPermissionResponse, finalizeChannel,
} from "./claude-channel-protocol.js";

const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");
const CHANNEL_MARKETPLACE = process.env.BRIDGE_CHANNEL_MARKETPLACE || "bridge";
const CHANNEL_PLUGIN = "bridge-channel";
// channel 协议无 turn-done 信号（fakechat 实证）→ reply 后 grace 窗口内无新消息即判定 turn 结束
const TURN_GRACE_MS = Number(process.env.CHANNEL_TURN_GRACE_MS || 2500);
// channel server 起来后多久没连上 socket 就认定 channel 没激活（多半未 approve）
const READY_TIMEOUT_MS = Number(process.env.CHANNEL_READY_TIMEOUT_MS || 30000);
// channel 连上后（started）claude 若卡死（既不 reply 也不 exit，如卡在工具/网络等待），主循环只剩
// exited/grace/abort 三出口 → 无限等 → 永久 typing。加总体超时兜底：单轮 attempt 总时长超此值强制收尾+kill。
// 默认 5min，channel 聊天/任务正常轮次远小于此；长任务可调 CHANNEL_OVERALL_TIMEOUT_MS。必须 > READY_TIMEOUT_MS。
const OVERALL_TIMEOUT_MS = Number(process.env.CHANNEL_OVERALL_TIMEOUT_MS || 300000);
// 防呆：OVERALL 必须显著大于 READY，否则 channel ready 后会立刻误触发总体超时；配错时取安全下限。
const OVERALL_TIMEOUT_EFFECTIVE_MS = OVERALL_TIMEOUT_MS > READY_TIMEOUT_MS ? OVERALL_TIMEOUT_MS : READY_TIMEOUT_MS + 60000;

// 跨进程 cold-start 闸：mccode1/mccode2 等多 bot 进程各有自己的进程内 queryQueue（turn 级串行），
// 但挡不住跨进程同时 cold start —— 多个 claude 子进程并发初始化十几个 MCP 互抢资源 → 卡死。
// 用一把 host-wide 原子锁（mkdir 是原子操作）把"同时在 cold start 的 claude 数"限制为 1：
// spawn 前抢锁，channel ready（过了 MCP 初始化危险区）即释放放行下一个，不等整轮答完。
const COLDSTART_LOCK_DIR = process.env.CHANNEL_COLDSTART_LOCK_DIR || join(homedir(), ".cache/tg-bridge/coldstart.lock");
const COLDSTART_LOCK_OWNER = join(COLDSTART_LOCK_DIR, "owner.json");
// 持锁进程崩溃/卡死不会自动释放 mkdir 锁 → stale。超此值后来者强夺，防一个卡死的 cold start 焊死全队。
const COLDSTART_LOCK_TTL_MS = Number(process.env.CHANNEL_COLDSTART_LOCK_TTL_MS || 90000);
// 抢锁最长等待；超过则降级"无锁启动"（宁可退化成并发，也不丢消息/死等）。
const COLDSTART_LOCK_MAX_WAIT_MS = Number(process.env.CHANNEL_COLDSTART_LOCK_MAX_WAIT_MS || 120000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 抢跨进程 cold-start 锁。返回 handle（给 releaseColdStartLock）或 null（降级无锁，不阻塞链路）。
// 传入 abortSignal：锁等待期间若请求被取消，立即放弃，不白等也不白 spawn。
async function acquireColdStartLock(abortSignal) {
  const token = randomUUID();
  const deadline = Date.now() + COLDSTART_LOCK_MAX_WAIT_MS;
  try { mkdirSync(dirname(COLDSTART_LOCK_DIR), { recursive: true }); } catch {}
  while (true) {
    if (abortSignal?.aborted) return null; // 等待期间请求被取消 → 放弃抢锁
    try {
      mkdirSync(COLDSTART_LOCK_DIR); // 原子：抛 EEXIST=已被占，成功=独占
      // owner.json 仅用于 release 时 token 校验；stale 判断改用锁目录 mtime（见下），不依赖此文件写入时序
      writeFileSync(COLDSTART_LOCK_OWNER, JSON.stringify({ pid: process.pid, token }));
      return { token, released: false };
    } catch (e) {
      if (e?.code !== "EEXIST") { // 异常 FS 错误：降级无锁，别卡死整条链路
        console.error(`[claude-channel] cold-start 锁异常，降级无锁启动: ${e?.message}`);
        return null;
      }
      // stale 用锁目录 mtime：mkdir 原子创建即计时起点，避开 mkdir 与写 owner.json 间的非原子窗口
      // （竞争者在 owner.json 尚未写完时读到空会误判 stale 删锁 → 退化并发）。
      let lockAge = Infinity;
      try { lockAge = Date.now() - statSync(COLDSTART_LOCK_DIR).mtimeMs; } catch {}
      if (lockAge > COLDSTART_LOCK_TTL_MS) { // stale：持锁者多半崩了/卡死，强夺
        console.error(`[claude-channel] cold-start 锁 stale（age=${Math.round(lockAge / 1000)}s），强制夺锁`);
        try { rmSync(COLDSTART_LOCK_DIR, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() > deadline) {
        console.error("[claude-channel] cold-start 锁等待超时，降级无锁启动");
        return null;
      }
      await sleep(200 + Math.floor(Math.random() * 300)); // 抖动避免羊群
    }
  }
}

// 释放 cold-start 锁（幂等）。token 校验：只删自己持有的，避免误删 stale 后被他人夺走的锁。
function releaseColdStartLock(handle) {
  if (!handle || handle.released) return;
  handle.released = true;
  try {
    const owner = JSON.parse(readFileSync(COLDSTART_LOCK_OWNER, "utf8"));
    if (owner?.token !== handle.token) return; // 已被 stale 夺走，不是我的锁
  } catch { /* owner 文件已不在：继续尝试清理目录 */ }
  try { rmSync(COLDSTART_LOCK_DIR, { recursive: true, force: true }); } catch {}
}

// 递归杀进程树。child.kill() 只杀 script 父进程，claude 及其 MCP 子进程会残留；
// 超时/abort/cleanup 时不杀干净 → orphan claude + MCP 累积 → 下一轮更容易堆死。
function killTree(rootPid, signal = "SIGTERM") {
  if (!rootPid) return;
  const pids = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    pids.push(pid);
    try {
      const r = Bun.spawnSync(["pgrep", "-P", String(pid)]);
      const out = r?.stdout ? new TextDecoder().decode(r.stdout).trim() : "";
      if (out) for (const c of out.split("\n").map((n) => parseInt(n, 10))) if (c) queue.push(c);
    } catch {}
  }
  for (const pid of [...pids].reverse()) { try { process.kill(pid, signal); } catch {} } // 子先父后
  const t = setTimeout(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} } }, 2000);
  t.unref?.(); // 别因兜底定时器挂住进程退出
}

export function createAdapter(config = {}) {
  const defaultModel = config.model || process.env.CC_MODEL || "claude-sonnet-4-7";
  const cwd = config.cwd || process.env.CC_CWD || process.env.HOME;
  const permMode = process.env.CC_PERMISSION_MODE || "default";
  // 串行锁：channel 每轮起一个 claude 子进程，单 bot 多消息并发会堆积过载（群聊连续消息）。仿 claude.js 排队，单 bot 一次只跑一个 claude。
  let queryQueue = Promise.resolve();

  // 单次尝试：建 socket server + script 起 claude + streamQuery 主循环。
  // resume 启动失败（非零退出且未完成握手）→ 置 o.ctx.resumeFailed，由 streamQuery 回退新 session（design §11）。
  async function* attemptOnce(sid, isResume, o) {
    const {
      prompt, model, effort, effectivePerm, effectiveCwd,
      allowedTools, settingSources, systemAppend, requestPermission, abortSignal, ctx,
    } = o;
    const state = createChannelState(sid);
    let lockHandle = null; // 跨进程 cold-start 锁 handle；started 时释放，cleanup 兜底
    let killed = false;    // killTree 幂等：onAbort 和 cleanup 都可能触发，只杀一次
    let child = null;      // 提前声明，便于 spawn 前早退路径下 cleanup 安全引用

    // 1) Unix socket server，等 channel server 回连
    const sockPath = join(tmpdir(), `bridge-ch-${randomUUID()}.sock`);
    const inbox = [];
    let notify = null;
    const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
    let channelSock = null;
    const server = net.createServer(s => {
      channelSock = s;
      s.on("error", () => {}); // peer reset 等：吞掉，避免 unhandled rejection
      const rl = createInterface({ input: s });
      (async () => {
        for await (const line of rl) {
          if (!String(line || "").trim()) continue;
          try { inbox.push(JSON.parse(line)); wake(); } catch { /* skip 半行/坏行 */ }
        }
      })().catch(() => {}); // 流异常不抛 unhandled
    });
    await new Promise((res, rej) => { server.once("error", rej); server.listen(sockPath, res); });

    // 2) script 造 PTY 起 claude（防降级 --print），channel 走 plugin: 路径
    const args = [
      isResume ? "--resume" : "--session-id", sid,
      "--channels", `plugin:${CHANNEL_PLUGIN}@${CHANNEL_MARKETPLACE}`,
      "--model", model,
      "--permission-mode", effectivePerm,
      ...(effort ? ["--effort", effort] : []),
      ...(allowedTools ? ["--allowedTools", allowedTools.join(" ")] : []),
      // settingSources / systemAppend 仅新 session 注入；resume 沿用原 session 建立时的
      ...(!isResume && settingSources ? ["--setting-sources", settingSources.join(",")] : []),
      ...(!isResume && systemAppend ? ["--append-system-prompt", systemAppend] : []),
    ];
    const spawnArgs = ["script", "-q", "/dev/null", CLAUDE_CLI_PATH, ...args];
    console.error(`[claude-channel] spawn: ${spawnArgs.join(" ")} | cwd=${effectiveCwd}`);
    // 抢锁前先看请求是否已被取消（锁等待最长 120s，期间不该再为已取消的请求 spawn）
    if (abortSignal?.aborted) { try { server.close(); } catch {} return; }
    // 抢跨进程 cold-start 锁：限制同时 cold start 的 claude 数为 1，避免多 bot 并发挤爆 MCP 初始化
    lockHandle = await acquireColdStartLock(abortSignal);
    // 抢锁期间被取消 → 释放锁 + 关 server 后早退（finally 也会兜底，这里立即处理更干净）
    if (abortSignal?.aborted) { releaseColdStartLock(lockHandle); try { server.close(); } catch {} return; }
    try {
      child = Bun.spawn(spawnArgs, {
        cwd: effectiveCwd,
        // ENABLE_TOOL_SEARCH=auto:9999：把 tool defer 阈值拉到极高 → 禁掉 ToolSearch。
        // 否则 bridge claude 继承用户全局十几个 MCP、工具一多就触发 defer，channel 的 reply tool
        // 被延迟加载、claude 调不到（select failed none found），整个 turn 卡死。
        env: { ...process.env, BRIDGE_CHANNEL_SOCKET: sockPath, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || "auto:9999" },
        stdout: "pipe", stderr: "pipe", // 不设 stdin（script 要 TTY，不能 pipe）
      });
    } catch (spawnErr) {
      // Bun.spawn 同步抛错（cwd/可执行文件等）：立即释放锁 + 关 server，别让锁泄漏到 stale TTL
      releaseColdStartLock(lockHandle);
      try { server.close(); } catch {}
      throw spawnErr;
    }
    // 必须持续消费 child.stdout/stderr：script 把 claude 整屏 TUI 写进 stdout，
    // 不读会撑满 pipe buffer → claude 写阻塞 → 进程崩/exit。留尾部用于 exit 非 0 诊断
    // （script 把 claude 的 stderr 合并进了 PTY stdout）。
    let tailOut = "";
    const dec = new TextDecoder();
    (async () => { for await (const c of child.stdout) tailOut = (tailOut + dec.decode(c)).slice(-3000); })().catch(() => {});
    (async () => { for await (const c of child.stderr) tailOut = (tailOut + dec.decode(c)).slice(-3000); })().catch(() => {});
    let exited = false, exitCode = 0;
    child.exited.then(code => { exited = true; exitCode = code ?? 0; wake(); });
    // 注：child.kill() 杀的是 script 父进程；claude 是其子。Task 8 需 live abort 测试确认无 orphan claude。
    const onAbort = () => { if (child && !killed) { killed = true; try { killTree(child.pid); } catch {} } };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    // 3) 主循环：消费 channel→adapter 消息 → yield 事件；reply 后 grace 判 turn-done
    let graceTimer = null, graceFired = false;
    const armGrace = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => { graceFired = true; wake(); }, TURN_GRACE_MS);
    };
    const cleanup = () => {
      if (graceTimer) clearTimeout(graceTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      releaseColdStartLock(lockHandle); // 没走到 started 就收尾时兜底释放，别焊死后面的 bot
      if (child && !killed) { killed = true; try { killTree(child.pid); } catch {} }
      try { server.close(); } catch {}
      try { channelSock?.end(); } catch {}
    };

    const startTime = Date.now();
    try {
      yield* maybeEmitInit(state);
      let started = false;
      while (true) {
        while (inbox.length) {
          const msg = inbox.shift();
          if (msg.type === "ready") {
            // chat_id 占位：bridge channel 是 per-streamQuery 单会话，真实路由在 bridge 层，
            // 此 meta 仅作 channel notification 上下文传给 claude，固定值无副作用。
            channelSock?.write(JSON.stringify({
              type: "user_message", content: prompt, meta: { chat_id: "bridge" },
            }) + "\n");
            started = true;
            // channel 已连上 = 过了 MCP 冷启动危险区，立刻释放 cold-start 锁，放行下一个 bot（不等整轮答完）
            releaseColdStartLock(lockHandle); lockHandle = null;
          } else if (msg.type === "permission_request") {
            for (const ev of mapChannelMessage(msg, state)) yield ev;
            // 审批：bypass 直接放行；否则交编排层（真人在 TG 点）；handler 异常或缺失 → 安全拒
            let decision = { behavior: "deny" };
            if (effectivePerm === "bypassPermissions") {
              decision = { behavior: "allow" };
            } else if (requestPermission) {
              try {
                const { toolName, input, sdkOptions } = adaptPermissionRequest(msg);
                decision = await requestPermission(toolName, input, sdkOptions);
              } catch {
                decision = { behavior: "deny" };
              }
            }
            // 无论如何都回送，让 claude 收尾该工具调用（不留挂起）
            channelSock?.write(JSON.stringify(buildPermissionResponse(msg.request_id, decision)) + "\n");
          } else if (msg.type === "reply") {
            for (const ev of mapChannelMessage(msg, state)) yield ev;
            armGrace(); // 每条 reply 重置 grace 窗口；窗口内无新消息 → turn 结束
          }
          // edit_message / react 等：MVP 忽略
        }

        if (exited && !inbox.length) {
          if (exitCode !== 0) {
            console.error(`[claude-channel] claude exit ${exitCode}, last PTY output:\n${tailOut.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").slice(-1200)}`);
          }
          // resume 失败（非零退出且没产出任何回复）→ 让 streamQuery 回退新 session。
          // 不能用 !started 判断：claude 会先起 channel server(ready → started=true) 再验证 resume，
          // 所以 resume 失败时 started 已是 true；用 replyBuffer 空判定这轮没真跑成才可靠。
          if (isResume && exitCode !== 0 && state.replyBuffer.length === 0) {
            ctx.resumeFailed = true;
            return;
          }
          // 握手成功但零 reply 的 clean exit → 软失败（区分于真有内容的成功，避免静默空回复）
          if (exitCode === 0 && started && state.replyBuffer.length === 0) {
            yield* finalizeChannel(state, { success: false, errorText: "claude 结束但未产出回复（channel 可能未 approve，或模型未调 reply）" });
          } else {
            yield* finalizeChannel(state, exitCode === 0
              ? { success: true }
              : { success: false, errorText: `claude exited ${exitCode}` });
          }
          return;
        }
        if (graceFired && started) {
          yield* finalizeChannel(state, { success: true });
          return;
        }
        if (!started && Date.now() - startTime > READY_TIMEOUT_MS) {
          throw new Error("channel server 未在超时内连接：channel 可能未激活或未 approve（见 design doc §19.3）");
        }
        // started 后兜底：claude 连上 channel 却卡死（无 reply 无 exit）→ 超总体时长强制中断，杜绝永久 typing
        if (started && Date.now() - startTime > OVERALL_TIMEOUT_EFFECTIVE_MS) {
          console.error(`[claude-channel] 单轮超 ${Math.round(OVERALL_TIMEOUT_EFFECTIVE_MS / 1000)}s 未完成，强制中断 session ${String(sid).slice(0, 8)}`);
          yield* finalizeChannel(state, { success: false, errorText: `单轮超时（>${Math.round(OVERALL_TIMEOUT_EFFECTIVE_MS / 1000)}s）未完成，已中断，可重发` });
          return;
        }

        // 挂起等下一条消息/退出/grace；50ms tick 兜底竞态（仿 executor/local-agent.js）
        await Promise.race([
          new Promise(res => { notify = res; }),
          new Promise(res => setTimeout(res, 50)),
        ]);
        notify = null;
      }
    } finally {
      cleanup();
    }
  }

  return {
    name: "claude-channel",
    label: "CC(channel)",
    icon: "🟣",

    availableModels() {
      return [
        { id: "__default__", label: `默认 (${defaultModel})` },
        { id: "claude-sonnet-4-7", label: "Sonnet 4.7" },
        { id: "claude-opus-4-7", label: "Opus 4.7" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ];
    },
    availableEfforts() {
      return [
        { id: "__default__", label: `默认 (${process.env.DEFAULT_EFFORT || "high"})`, description: "标准思考深度" },
        { id: "low", label: "Low", description: "最快速" },
        { id: "medium", label: "Medium", description: "中等" },
        { id: "high", label: "High ✦", description: "标准深度" },
        { id: "max", label: "Max", description: "最深（仅 Opus）" },
      ];
    },

    async *streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      // 排队等前一个 query 完成（单 bot 一次只跑一个 claude 子进程，防群聊多消息并发堆积）
      let releaseLock;
      const myLock = new Promise((r) => { releaseLock = r; });
      const waitForTurn = queryQueue;
      queryQueue = myLock;
      await waitForTurn;
      try {
        const {
          requestPermission, model: oModel, effort, permissionMode: oPerm,
          cwd: oCwd, allowedTools, settingSources, systemAppend,
        } = overrides;
        const o = {
          prompt,
          model: (oModel && oModel !== "__default__") ? oModel : defaultModel,
          effort,
          effectivePerm: oPerm || permMode,
          effectiveCwd: oCwd || cwd,
          allowedTools, settingSources, systemAppend, requestPermission, abortSignal,
          ctx: {},
        };

        if (sessionId) {
          yield* attemptOnce(sessionId, true, o);
          // resume 启动失败 → 回退新 session（仿 claude.js:559-585 / design §11）
          if (o.ctx.resumeFailed) {
            console.log(`[claude-channel] resume ${String(sessionId).slice(0, 8)} failed, retrying as new session`);
            yield* attemptOnce(randomUUID(), false, o);
          }
        } else {
          yield* attemptOnce(randomUUID(), false, o);
        }
      } finally {
        releaseLock();
      }
    },

    statusInfo(overrideModel, overrideEffort) {
      return { model: overrideModel || defaultModel, effort: overrideEffort || null, cwd, mode: "Channel" };
    },

    async listSessions(limit = 10) {
      const recent = listSessionFiles(limit);
      const out = [];
      for (const s of recent) out.push(await parseSessionFile(s, cwd));
      return out;
    },
    async resolveSession(sessionId) {
      const fi = findSessionFile(sessionId);
      return fi ? await parseSessionFile(fi, cwd) : null;
    },
  };
}
