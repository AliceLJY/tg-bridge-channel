// adapters/cli-pool-adapter.js
// Wrapper:把 cli-pool(方案 C:per-turn `claude --bg [--resume] "<prompt>"` fork spawn
// + jsonl tail 读输出 + `claude stop` 清理)包成 bridge 统一 adapter 接口
// ({ name, streamQuery, statusInfo, listSessions, resolveSession })。
//
// 接口对齐 adapters/claude.js,bridge.js 现有 `backendName === "claude"` 判断不动。
// 启 env CLAUDE_POOL_ENGINE=1 → bridge 自动选这套引擎(见 adapters/interface.js)。
// streamOverrides 消费状态(2026-06-11 对齐 SDK adapter):model/effort/cwd/systemAppend 透传到
// 每次 --bg spawn;requestPermission 不透传——pool 固定 bypassPermissions,安全线是 PreToolUse
// hook 硬护栏(guard-destructive-bash + block-interactive-ask),不是逐工具审批。

import { createCliPool } from "./cli-pool.js";
import { listSessionFiles, findSessionFile, parseSessionFile } from "./claude-sessions.js";

// 单例 pool —— 同进程多 chat 共享一套 config 默认值(方案 C 无常驻连接,纯配置容器)
let _pool = null;
let _poolStartPromise = null;

function ensurePool(initConfig) {
  if (!_pool) {
    _pool = createCliPool(initConfig);
    _poolStartPromise = _pool.start();
  }
  return _pool;
}

// 把 cli-pool 内部事件映射成 bridge 统一格式。
// 关键:turn_end 时 result.text 必须带本 turn 累积的全文 — bridge 用 result.text 兜底发 TG;
// 不累积 → bridge 报"无输出"(2026-05-26 实测)。
function* mapEvents(poolEvent, state) {
  if (poolEvent.type === "session_init") { yield poolEvent; return; }
  if (poolEvent.type === "user_echo") return;
  if (poolEvent.type === "text") {
    state.accumulatedText += poolEvent.text;
    yield { type: "text", text: poolEvent.text };
  } else if (poolEvent.type === "thinking") {
    // bridge 当前不展示 thinking,跳过避免污染
  } else if (poolEvent.type === "tool_use") {
    // AskUserQuestion 在非交互 bridge 里已被 PreToolUse hook 拦截(见 cli-pool.js buildSettings +
    // scripts/block-interactive-ask.sh):它会作为 blocked tool_use 出现在 jsonl,但工具没真执行、
    // 模型会自主续写正文。静默跳过,别在 TG 显示一条无意义的"AskUserQuestion"进度。
    if (poolEvent.name === "AskUserQuestion") return;
    yield { type: "progress", toolName: poolEvent.name, input: poolEvent.input };
    const input = poolEvent.input || {};
    if ((poolEvent.name === "Write" || poolEvent.name === "Edit") && input.file_path) {
      yield { type: "file_written", filePath: input.file_path, tool: poolEvent.name };
    }
  } else if (poolEvent.type === "turn_end") {
    yield {
      type: "result",
      success: true,
      text: state.accumulatedText,
      duration: poolEvent.durationMs,
    };
  }
}

export function createAdapter(config = {}) {
  const defaultModel = config.model || process.env.CC_MODEL || "opus";
  const defaultEffort = config.effort || process.env.DEFAULT_EFFORT || "max";
  const defaultPermMode = config.permissionMode || process.env.CC_PERMISSION_MODE || "bypassPermissions";
  const defaultCwd = config.cwd || process.env.CC_CWD || process.env.HOME;

  const pool = ensurePool({
    model: defaultModel,
    effort: defaultEffort,
    permissionMode: defaultPermMode,
    cwd: defaultCwd,
  });

  return {
    name: "claude",
    label: "CC(pool)",
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
      // 等 pool start 完成(只在第一次 query 阻塞一次)
      if (_poolStartPromise) {
        await _poolStartPromise.catch(() => {}); // start 错误不阻塞,sendAndStream 内部会再 probe
      }

      // 方案 C:不再先 newSession 起 idle session。直接把 sessionId(可能为空)交给
      // pool.sendAndStream:有就 --resume fork 续上下文,没有就新建;session_init(fork 出的
      // 最新 sessionId)由 pool 内部 yield、mapEvents 透传给 bridge 持久化。
      // per-turn overrides 透传(2026-06-11):/model /effort /dir 偏好 + systemAppend 落到 CLI flag。
      const { model, effort, cwd, systemAppend } = overrides;
      try {
        const turnState = { accumulatedText: "" };
        for await (const poolEv of pool.sendAndStream(sessionId || null, prompt, {
          abortSignal,
          timeoutMs: Number(overrides.timeoutMs) || Number(process.env.CLI_POOL_TURN_TIMEOUT_MS || 600000),
          model, effort, cwd, systemAppend,
        })) {
          for (const ev of mapEvents(poolEv, turnState)) yield ev;
        }
      } catch (e) {
        // 用户主动 Stop:原样上抛,bridge 的 isUserAbort 路径接住 → 干净的"已取消"而非"出错:aborted"
        if (abortSignal?.aborted) throw e;
        console.error(`[cli-pool-adapter] streamQuery err sid=${String(sessionId || "new").slice(0,8)}: ${e.message}`);
        // turn 超时(jsonl tail timeout)≠ worker 已死:超时路径不 stop worker(见 cli-pool.js
        // sendAndStream finally),后台会话仍在跑长任务、产出会被下一次 fork 继承。提示因此成立。
        const isTimeout = /tail timeout/.test(e.message || "");
        const mins = Math.round(Number(process.env.CLI_POOL_TURN_TIMEOUT_MS || 600000) / 60000);
        const text = isTimeout
          ? `⏱️ 等待输出超过 ${mins} 分钟。CC 后台会话可能仍在处理这条长任务(并未中断),稍等片刻再发一条消息即可查看进展或继续。`
          : `CC(pool) 出错:${e.message}`;
        yield { type: "result", success: false, text };
      }
    },

    statusInfo(overrideModel, overrideEffort) {
      return {
        model: overrideModel || defaultModel,
        effort: overrideEffort || defaultEffort,
        cwd: defaultCwd,
        mode: "Pool (--bg daemon)",
      };
    },

    async listSessions(limit = 10) {
      // 复用 claude-sessions.js 的 jsonl 列表逻辑
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
