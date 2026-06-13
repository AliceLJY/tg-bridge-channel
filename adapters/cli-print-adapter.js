// adapters/cli-print-adapter.js
// --print 流式接续引擎(2026-06-14 新主线,替代 cli-pool 的 --bg fork)
//
// 根因(为什么换):--bg --resume 每轮 fork 出新 sessionId(--bg 固有"自己管会话 id"),
//   ~/.claude/projects/ 每轮多一个 tg-turn-* jsonl = 用户看到的"垃圾会话";且每轮带全历史
//   重 spawn,长对话成本递增。
// 方案:每个 chat 一个稳定 sessionId,每轮前台
//   claude --print --output-format stream-json --verbose [--session-id <new>|--resume <sid>] ...
//   读 stdout 逐行 stream-json → mapClaudeMessage 映射成 bridge 事件。
//   --print --resume = 同会话 append、零 fork、零垃圾、上下文连续(2026-06-14 CLI 2.1.177 实测:
//   15→31 行同一文件、init 报同一 sessionId、记得前一轮的 secret word)。
//
// 三处复用,单一真相源:
//   - mapClaudeMessage(claude-event-map.js):stream-json 每行 JSON 结构 == SDK query() 的 msg,
//     与 SDK adapter(claude.js)共用同一份映射,区别仅传输层(子进程 stdout vs SDK query())。
//   - buildSettings + BRIDGE_SYSTEM_NOTE(从 cli-pool.js 导出):非交互防护(AskUserQuestion
//     PreToolUse 拦截 + 系统提示让模型自主推进)与 pool 完全一致,行为已被长期使用验证。
//   - claude-sessions.js:listSessions / resolveSession(与 pool adapter 同源)。
//
// 接口对齐 adapters/claude.js + cli-pool-adapter.js({ name:"claude", streamQuery, statusInfo,
//   listSessions, resolveSession }),bridge.js 现有 `backendName === "claude"` 判断不动。
// 启 env CLAUDE_PRINT_ENGINE=1 → bridge 自动选这套引擎(见 adapters/interface.js;默认关、灰度用)。
//
// remote control(Alice 要求默认开):bare --remote-control 与 --print 共存已实测
//   (2026-06-14:不强制交互、turn 结束自然退出 code 0)。turn 运行期间(含配图发布 30-40min
//   长任务)会话在 app 里可见/可接管;turn 之间是可 resume 的历史条目(不是常驻进程,比 --bg
//   lingering worker 更干净)。应急可 CLAUDE_PRINT_NO_REMOTE_CONTROL=1 关掉。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { mapClaudeMessage } from "./claude-event-map.js";
import { buildSettings, BRIDGE_SYSTEM_NOTE } from "./cli-pool.js";
import { listSessionFiles, findSessionFile, parseSessionFile } from "./claude-sessions.js";

const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");
// remote control 默认开(Alice 要求);应急可 CLAUDE_PRINT_NO_REMOTE_CONTROL=1 关。
const REMOTE_CONTROL_DEFAULT = process.env.CLAUDE_PRINT_NO_REMOTE_CONTROL !== "1";

// 构造 --print 单轮 CLI 参数(不含末尾 prompt)。纯函数,便于测试。
// 会话:有 sessionId → --resume 续同一会话(append 不 fork);无 → 生成 uuid 走 --session-id 建会话
//   (两条路径的 sessionId 都稳定、跨轮不变,这是与 --bg fork 的本质区别)。
// model "__default__" 哨兵视为未覆盖(与 pool / SDK adapter 同语义)。
export function buildPrintArgs(config, { sessionId, model, effort, systemAppend, remoteControlName } = {}) {
  const effectiveModel = model && model !== "__default__" ? model : config.model;
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--model", effectiveModel,
    "--effort", effort || config.effort,
    "--permission-mode", config.permissionMode,
  ];
  // remote control 放在 flag 段前部(其后紧跟 --output-format 等 flag),bare 形式无歧义。
  if (config.remoteControl) {
    args.push("--remote-control");
    // 可选 app 显示名:--remote-control-session-name-prefix 是带必填值的独立 flag(不走 --remote-control [name]
    // 的可选参数歧义),便于在 app 里区分多个 bot。bridge 当前不传,留作后续。
    if (remoteControlName) args.push("--remote-control-session-name-prefix", remoteControlName);
  }
  // 非交互防护:与 pool 同源(AskUserQuestion PreToolUse 拦截 + 可选 Bash 危险命令护栏)。
  args.push("--settings", buildSettings(config.destructiveGuard));
  // 主防线:系统提示让模型从源头不调 AskUserQuestion、自主推进(hook 是兜底)。群聊场景 bridge
  // 传 systemAppend(bridgeHint + 上下文框架),拼在固定段之后。--print 每轮重新 spawn → 每轮生效。
  const systemNote = systemAppend ? `${BRIDGE_SYSTEM_NOTE}\n\n${systemAppend}` : BRIDGE_SYSTEM_NOTE;
  args.push("--append-system-prompt", systemNote);
  let sessionIdUsed = sessionId || null;
  if (sessionId) {
    args.push("--resume", sessionId);
  } else {
    sessionIdUsed = randomUUID();
    args.push("--session-id", sessionIdUsed);
  }
  return { args, sessionIdUsed };
}

// 处理一个 mapClaudeMessage 事件:更新 state(sawInit / accumulatedText)+ 决定 yield 什么、是否本轮终点。
// 返回 { emit:<事件或 null>, done:<bool> }。纯函数,便于测试(把 runPrintTurn 的过滤/累积/收尾逻辑隔离出来)。
export function filterPrintEvent(ev, state) {
  // 非交互引擎:AskUserQuestion 的 question 事件 + 对应 progress 静默跳过(hook 已拦、模型自主续写,与 pool 同策)。
  if (ev.type === "question") return { emit: null, done: false };
  if (ev.type === "progress" && ev.toolName === "AskUserQuestion") return { emit: null, done: false };
  if (ev.type === "session_init") state.sawInit = true;
  if (ev.type === "text") state.accumulatedText += ev.text || "";
  if (ev.type === "result") {
    // 兜底:result.text 为空但本轮已累积文本 → 用累积值(防"无输出";--print 的 result.text 通常 == 最终正文)。
    if (!(ev.text && ev.text.trim()) && state.accumulatedText.trim()) {
      return { emit: { ...ev, text: state.accumulatedText }, done: true };
    }
    return { emit: ev, done: true };  // 一轮终点
  }
  return { emit: ev, done: false };
}

// resume 轮里"非抛错"的 resume 失效信号:result 失败 + 整轮从未见 session_init(见 runPrintTurn 注释)。
// 仅 resume 轮(wasResume 为真)成立——首轮新建失败没法"再新建一次",应直接发错误而非回退。纯函数,便于测试。
export function isResumeFailureResult(emit, state, wasResume) {
  return !!wasResume && emit?.type === "result" && emit.success === false && !state.sawInit;
}

// 跑一轮 --print 子进程,yield bridge 事件。见到 result 即止(一轮终点)。
// state(由调用方持有,跨 resume-回退重试共享):
//   - sawInit:已收到 session_init(resume 失败回退的判据:init 前挂 = session 失效)
//   - accumulatedText:本轮已产出的可见文本(中途异常时的兜底回传料,防"无输出")
// 失败语义:
//   - 用户 Stop(abortSignal)→ kill 子进程 → 抛 "aborted",上层 isUserAbort 接住、干净取消。
//   - 硬上限(hardLimitMs,默认 60min)→ SIGKILL 子进程 → 抛 "print hard limit",上层兜底回传。
//   - 子进程读完 stdout 仍无 result → 抛错(让上层决定 resume 回退 / 兜底回传)。
async function* runPrintTurn(prompt, { config, sessionId, model, effort, systemAppend, cwd, remoteControlName, heartbeatMs, hardLimitMs, abortSignal, state }) {
  const { args } = buildPrintArgs(config, { sessionId, model, effort, systemAppend, remoteControlName });
  args.push(prompt);
  const child = spawn(CLAUDE_CLI_PATH, args, { cwd: cwd || config.cwd, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", c => { stderr += c; });

  const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  // 硬上限兜底:真卡死(子进程永不出 result)时杀掉,避免 streamQuery 永久挂起。
  let hitHardLimit = false;
  const hardTimer = setTimeout(() => { hitHardLimit = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, hardLimitMs);
  hardTimer.unref?.();

  let exitCode = null, exitErr = null;
  const exited = new Promise(res => {
    child.once("exit", code => { exitCode = code; res(); });
    child.once("error", e => { exitErr = e; res(); });
  });

  try {
    const rl = createInterface({ input: child.stdout });
    const lineIter = rl[Symbol.asyncIterator]();
    let pending = lineIter.next();
    while (true) {
      // line 与 heartbeat 计时器竞速:heartbeatMs 内无新行 → 发 heartbeat(重置 bridge idle 卡死计时、
      // 给长任务"还在跑"信号),pending 仍在飞、下一圈继续等。--print 是事件驱动的,正常有 progress/text
      // 流过来就会刷新;只有单条操作长时间静默(罕见)才靠 heartbeat 兜底。
      // 每圈 clearTimeout:line 先到时清掉本圈未触发的 hb 定时器,避免高频流式下攒一堆(各自 heartbeatMs
      // 后才自清、白占)。pending 不在 hb 圈重建 → lineIter.next() 每行只调一次,不会并发 .next()。
      let hbTimer;
      const winner = await Promise.race([
        pending.then(v => ({ kind: "line", v })),
        new Promise(res => { hbTimer = setTimeout(() => res({ kind: "hb" }), heartbeatMs); }),
      ]);
      clearTimeout(hbTimer);
      if (winner.kind === "hb") {
        yield { type: "heartbeat" };
        continue;
      }
      const { done: streamDone, value } = winner.v;  // streamDone:readline 迭代结束(区别于下面 filterPrintEvent 的 done)
      if (streamDone) break;
      pending = lineIter.next();  // 重新挂上下一行
      const s = String(value).trim();
      if (!s) continue;
      let msg;
      try { msg = JSON.parse(s); } catch { continue; }  // stream-json 应为干净 JSON,异常行跳过
      for (const ev of mapClaudeMessage(msg, { logger: console })) {
        const { emit, done } = filterPrintEvent(ev, state);
        // resume 失效的"非抛错"形态(2026-06-14 codex 复核 + 实测确认):`--print --resume <失效 sid>` 不报错
        // 退出,而是发一条 result{subtype:"error_during_execution", errors:["No conversation found..."]} 且整轮
        // 无 session_init。若当普通失败结果发出 + 正常返回,streamQuery 的 resume 回退(只认抛错)不触发,
        // bridge 还会把失效 sid 存回 → 该 chat 每轮必失败直到 /new。故:resume 轮(sessionId 为真)出现
        // success:false 且从未见 session_init 时,抛错(不发这条),让上层走新建会话回退。
        if (done && isResumeFailureResult(emit, state, sessionId)) {
          throw new Error(`resume failed without session_init: ${(emit.text || "").slice(0, 120)}`);
        }
        if (emit) yield emit;
        if (done) return;  // 一轮终点,后面不会再有内容
      }
    }
  } finally {
    clearTimeout(hardTimer);
    if (abortSignal) { try { abortSignal.removeEventListener("abort", onAbort); } catch { /* noop */ } }
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }

  // stdout 读完仍未见 result:等子进程退出,按原因抛错(让 streamQuery 决定回退 / 兜底)。
  await exited;
  if (abortSignal?.aborted) throw new Error("aborted");
  if (hitHardLimit) throw new Error(`print hard limit (${Math.round(hardLimitMs / 60000)}min)`);
  if (exitErr) throw exitErr;
  throw new Error(`claude --print exited code=${exitCode} without result; stderr: ${(stderr || "").slice(0, 300)}`);
}

export function createAdapter(config = {}) {
  const defaultModel = config.model || process.env.CC_MODEL || "opus";
  const defaultEffort = config.effort || process.env.DEFAULT_EFFORT || "max";
  const defaultPermMode = config.permissionMode || process.env.CC_PERMISSION_MODE || "bypassPermissions";
  const defaultCwd = config.cwd || process.env.CC_CWD || process.env.HOME;
  // 危险命令护栏复用 pool 的 env 开关(默认开)。
  const destructiveGuard = config.destructiveGuard !== false && process.env.CLI_POOL_DESTRUCTIVE_GUARD !== "0";
  const turnConfig = {
    model: defaultModel,
    effort: defaultEffort,
    permissionMode: defaultPermMode,
    cwd: defaultCwd,
    destructiveGuard,
    remoteControl: config.remoteControl !== undefined ? config.remoteControl : REMOTE_CONTROL_DEFAULT,
  };

  return {
    name: "claude",
    label: "CC(print)",
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
      const heartbeatMs = Number(overrides.heartbeatMs) || Number(process.env.CLI_PRINT_HEARTBEAT_MS) || 180000;
      const hardLimitMs = Number(overrides.hardLimitMs) || Number(process.env.CLI_PRINT_HARD_LIMIT_MS) || 3600000;
      // state 提到 try 外:catch 路径要能拿本轮已累积文本兜底回传,resume 回退也共享它。
      const state = { sawInit: false, accumulatedText: "" };
      const baseOpts = { config: turnConfig, model, effort, systemAppend, cwd: turnCwd, heartbeatMs, hardLimitMs, abortSignal, state };
      try {
        try {
          yield* runPrintTurn(prompt, { ...baseOpts, sessionId });
        } catch (e) {
          if (abortSignal?.aborted) throw e;
          // resume 失效回退新建一次:① init 都没出(session 被回收/不存在);② invalid signature
          //(resume 的 thinking 签名过期 → API 把整轮当错误 result,此时无真实正文产出,重试不会重复)。
          const sigErr = /invalid.*signature|invalid_request_error/i.test(e.message || "");
          if (sessionId && (!state.sawInit || sigErr)) {
            console.warn(`[cli-print-adapter] resume ${String(sessionId).slice(0, 8)} failed (${(e.message || "").slice(0, 80)}); retrying as new session`);
            state.accumulatedText = "";  // 丢弃回退前已累积(此处必为空或仅错误文本)
            state.sawInit = false;
            yield* runPrintTurn(prompt, { ...baseOpts, sessionId: null });
          } else {
            throw e;
          }
        }
      } catch (e) {
        if (abortSignal?.aborted) throw e;  // 用户取消:上抛走 bridge 干净取消(而非"出错:aborted")
        console.error(`[cli-print-adapter] streamQuery err sid=${String(sessionId || "new").slice(0, 8)}: ${e.message}`);
        const isTimeout = /print hard limit/.test(e.message || "");
        const mins = Math.round(hardLimitMs / 60000);
        // 兜底回传:CC 本轮已说的话必须发出(防"无输出"),success:true 走 sendFinalResult 的正文路径;
        // success:false 会被 sanitizeBackendError 压成一句话、把正文丢光(见 output-relay.js)。
        const acc = (state.accumulatedText || "").trim();
        if (acc) {
          const footer = isTimeout
            ? `\n\n———\n⏱️ 注:这轮跑了超过 ${mins} 分钟还没收尾,以上是 CC 已产出的内容;若没说完,回一句让它继续即可(会接着上下文)。`
            : `\n\n———\n⚠️ 注:这轮中途出了点状况(${(e.message || "").slice(0, 80)}),以上是 CC 已产出的内容。`;
          yield { type: "result", success: true, text: acc + footer };
        } else {
          const text = isTimeout
            ? `⏱️ 这条任务跑了超过 ${mins} 分钟仍没收尾,可能真卡住了。建议发 /new 重开会话再试。`
            : `CC(print) 出错:${e.message}`;
          yield { type: "result", success: false, text };
        }
      }
    },

    statusInfo(overrideModel, overrideEffort) {
      return {
        model: overrideModel || defaultModel,
        effort: overrideEffort || defaultEffort,
        cwd: defaultCwd,
        mode: "Print (--print resume)",
      };
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
