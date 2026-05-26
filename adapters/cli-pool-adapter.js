// adapters/cli-pool-adapter.js
// Wrapper:把 cli-pool(claude --bg + control.sock op:reply + jsonl tail)包成
// bridge 统一 adapter 接口({ name, streamQuery, statusInfo, listSessions, resolveSession })。
//
// 接口对齐 adapters/claude.js,bridge.js 现有 `backendName === "claude"` 判断不动。
// 启 env CLAUDE_POOL_ENGINE=1 → bridge 自动选这套引擎(见 adapters/interface.js)。

import { createCliPool } from "./cli-pool.js";
import { listSessionFiles, findSessionFile, parseSessionFile } from "./claude-sessions.js";

// 单例 pool —— 同进程多 chat 共享 daemon connection 和 LRU 池
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
  if (poolEvent.type === "user_echo") return;
  if (poolEvent.type === "text") {
    state.accumulatedText += poolEvent.text;
    yield { type: "text", text: poolEvent.text };
  } else if (poolEvent.type === "thinking") {
    // bridge 当前不展示 thinking,跳过避免污染
  } else if (poolEvent.type === "tool_use") {
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
  const defaultModel = config.model || process.env.CC_MODEL || "claude-opus-4-7";
  const defaultEffort = config.effort || process.env.DEFAULT_EFFORT || "max";
  const defaultPermMode = config.permissionMode || process.env.CC_PERMISSION_MODE || "bypassPermissions";
  const defaultCwd = config.cwd || process.env.CC_CWD || process.env.HOME;

  const pool = ensurePool({
    model: defaultModel,
    effort: defaultEffort,
    permissionMode: defaultPermMode,
    cwd: defaultCwd,
    maxSessions: Number(process.env.CLI_POOL_MAX_SESSIONS || 8),
  });

  return {
    name: "claude",
    label: "CC(pool)",
    icon: "🟪",

    availableModels() {
      return [
        { id: "__default__", label: `默认 (${defaultModel})` },
        { id: "claude-opus-4-7", label: "Opus 4.7" },
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
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

      let actualSessionId = sessionId;

      // 首次 chat 没 sessionId → 起新 bg session
      if (!actualSessionId) {
        try {
          const session = await pool.newSession({});
          actualSessionId = session.sessionId;
          yield { type: "session_init", sessionId: actualSessionId };
        } catch (e) {
          console.error(`[cli-pool-adapter] newSession failed: ${e.message}`);
          throw e;
        }
      } else {
        yield { type: "session_init", sessionId: actualSessionId };
      }

      try {
        const turnState = { accumulatedText: "" };
        for await (const poolEv of pool.sendAndStream(actualSessionId, prompt, {
          abortSignal,
          timeoutMs: Number(process.env.CLI_POOL_TURN_TIMEOUT_MS || 600000),
        })) {
          for (const ev of mapEvents(poolEv, turnState)) yield ev;
        }
      } catch (e) {
        console.error(`[cli-pool-adapter] streamQuery err sid=${actualSessionId?.slice(0,8)}: ${e.message}`);
        yield { type: "result", success: false, text: `CC(pool) 出错:${e.message}` };
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
