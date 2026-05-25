// 交互式 claude CLI（channel 机制）引擎 adapter。
// one-shot：每轮起一个 claude 子进程，答完关。
// 与 claude.js 同接口异机制；session 元数据复用 claude-sessions.js。
// TTY 用 macOS `script`（node-pty 不兼容 bun）；channel 走 plugin: 路径。
import net from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "path";
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
    const child = Bun.spawn(spawnArgs, {
      cwd: effectiveCwd,
      // ENABLE_TOOL_SEARCH=auto:9999：把 tool defer 阈值拉到极高 → 禁掉 ToolSearch。
      // 否则 bridge claude 继承用户全局十几个 MCP、工具一多就触发 defer，channel 的 reply tool
      // 被延迟加载、claude 调不到（select failed none found），整个 turn 卡死。
      env: { ...process.env, BRIDGE_CHANNEL_SOCKET: sockPath, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || "auto:9999" },
      stdout: "pipe", stderr: "pipe", // 不设 stdin（script 要 TTY，不能 pipe）
    });
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
    const onAbort = () => { try { child.kill(); } catch {} };
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
      try { child.kill(); } catch {}
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
