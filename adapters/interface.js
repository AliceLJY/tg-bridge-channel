// 统一适配器接口定义 + 工厂函数
//
// 每个适配器导出 createAdapter(config) → { name, streamQuery, statusInfo }
// streamQuery 是 async generator，yield 统一事件：
//   { type: "session_init", sessionId }
//   { type: "progress", toolName?, toolIcon?, detail? }
//   { type: "text", text }
//   { type: "result", success, text, cost?, duration? }

import { createAdapter as createClaudeAdapter } from "./claude.js";
import { createAdapter as createClaudePoolAdapter } from "./cli-pool-adapter.js";
import { createAdapter as createClaudePrintAdapter } from "./cli-print-adapter.js";
import { createAdapter as createCodexAdapter } from "./codex.js";
import { createAdapter as createGeminiAdapter } from "./gemini.js";

// claude backend 按 env 切引擎(优先级 print > pool > SDK):
//   CLAUDE_PRINT_ENGINE=1 → cli-print(--print --resume 同会话 append,零 fork、零垃圾,2026-06-14 新主线;
//                           灰度中,先单 bot 验证再全量;回滚 = CLAUDE_PRINT_ENGINE=0 即回 pool/SDK)
//   CLAUDE_POOL_ENGINE=1  → cli-pool(--bg daemon fork + jsonl tail,2026-05-26 主线;每轮 fork 新会话 = 垃圾来源,
//                           print 引擎稳定后封存)
//   默认                  → SDK(claude.js,6-15 后会被 Anthropic 切到 Agent SDK credit;保留作非订阅场景的 fallback)
// 关键:backend 名保持 "claude",bridge.js 所有 `backendName === "claude"` 判断(审批/label/A2A/cron)继续命中。
// channel one-shot 引擎(2026-05-26 之前主线)已下线,代码 + plugin 删除,见 commit history。
const USE_PRINT_ENGINE = process.env.CLAUDE_PRINT_ENGINE === "1";
const USE_POOL_ENGINE = process.env.CLAUDE_POOL_ENGINE === "1";
function selectClaudeEngine() {
  if (USE_PRINT_ENGINE) return createClaudePrintAdapter;
  if (USE_POOL_ENGINE) return createClaudePoolAdapter;
  return createClaudeAdapter;
}
const ADAPTERS = {
  claude: selectClaudeEngine(),
  "claude-pool": createClaudePoolAdapter,    // 独立名保留,便于显式选用
  "claude-print": createClaudePrintAdapter,  // 独立名保留,便于显式选用
  codex: createCodexAdapter,
  gemini: createGeminiAdapter,
};

export function createBackend(name, config = {}) {
  const factory = ADAPTERS[name];
  if (!factory) {
    throw new Error(`Unknown backend: ${name}. Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return factory(config);
}

export const AVAILABLE_BACKENDS = Object.keys(ADAPTERS);
