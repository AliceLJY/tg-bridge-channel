// 统一适配器接口定义 + 工厂函数
//
// 每个适配器导出 createAdapter(config) → { name, streamQuery, statusInfo }
// streamQuery 是 async generator，yield 统一事件：
//   { type: "session_init", sessionId }
//   { type: "progress", toolName?, toolIcon?, detail? }
//   { type: "text", text }
//   { type: "result", success, text, cost?, duration? }

import { createAdapter as createClaudeAdapter } from "./claude.js";
import { createAdapter as createClaudeChannelAdapter } from "./claude-channel.js";
import { createAdapter as createCodexAdapter } from "./codex.js";
import { createAdapter as createGeminiAdapter } from "./gemini.js";

// claude backend 按 env 切引擎实现：默认 SDK（claude.js），CLAUDE_CHANNEL_ENGINE=1 → 交互式 channel 引擎（claude-channel.js）。
// 关键：backend 名保持 "claude"，bridge.js 所有 `backendName === "claude"` 判断（审批/label/A2A/cron）继续命中，
// 编排层零改动；引擎选择靠进程级环境变量，回滚 = 删 env。
const USE_CHANNEL_ENGINE = process.env.CLAUDE_CHANNEL_ENGINE === "1";
const ADAPTERS = {
  claude: USE_CHANNEL_ENGINE ? createClaudeChannelAdapter : createClaudeAdapter,
  "claude-channel": createClaudeChannelAdapter,  // 独立名保留，便于测试/显式选用
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
