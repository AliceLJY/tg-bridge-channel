// 成本熔断守卫（借鉴 RichardAtCT/claude-code-telegram 的 per-user cost cap）
// 关键区别：外部项目入站用「估算成本」、真实值没闭环；这里直接用 Claude SDK 的
// total_cost_usd 真实回写（record），比它干净。
// per-instance 内存态：每个 bridge 进程独立计数，重启清零。多实例合并预算需共享存储（暂不做）。
// cap = 0 表示不启用该档限制（默认不限，向后兼容）。
// 只对 claude backend 有意义：codex adapter 的 cost 是 null，无数据可熔断。

export function createCostGuard(options = {}) {
  const {
    dailyCapUsd = 0, // 本实例全局日预算上限，0 = 不限
    perChatCapUsd = 0, // 单会话日预算上限，0 = 不限
    windowMs = 86400000, // 24h 滚动窗口
  } = options;

  let globalSpent = 0;
  let globalWindowStart = Date.now();
  // chatId -> { spent, windowStart }
  const chats = new Map();

  function rollGlobal(now) {
    if (now - globalWindowStart >= windowMs) {
      globalSpent = 0;
      globalWindowStart = now;
    }
  }

  function rollChat(chatId, now) {
    const c = chats.get(chatId);
    if (c && now - c.windowStart >= windowMs) {
      c.spent = 0;
      c.windowStart = now;
    }
  }

  // 入站前检查：返回 { allowed, reason?, spent?, cap? }
  function precheck(chatId) {
    const now = Date.now();
    rollGlobal(now);
    rollChat(chatId, now);

    if (dailyCapUsd > 0 && globalSpent >= dailyCapUsd) {
      return { allowed: false, reason: "daily", spent: globalSpent, cap: dailyCapUsd };
    }
    const chatSpent = chats.get(chatId)?.spent || 0;
    if (perChatCapUsd > 0 && chatSpent >= perChatCapUsd) {
      return { allowed: false, reason: "chat", spent: chatSpent, cap: perChatCapUsd };
    }
    return { allowed: true };
  }

  // 真实花费回写（拿到 Claude SDK 的 total_cost_usd 时调用）
  function record(chatId, cost) {
    if (typeof cost !== "number" || !(cost > 0)) return;
    const now = Date.now();
    rollGlobal(now);
    rollChat(chatId, now);
    globalSpent += cost;
    const c = chats.get(chatId);
    if (c) c.spent += cost;
    else chats.set(chatId, { spent: cost, windowStart: now });
  }

  // 给 /cost 命令用
  function stats(chatId) {
    const now = Date.now();
    rollGlobal(now);
    if (chatId != null) rollChat(chatId, now);
    const chatSpent = chatId != null ? chats.get(chatId)?.spent || 0 : 0;
    return { globalSpent, dailyCapUsd, chatSpent, perChatCapUsd, windowMs };
  }

  function reset(chatId) {
    if (chatId == null) {
      globalSpent = 0;
      globalWindowStart = Date.now();
      chats.clear();
    } else {
      chats.delete(chatId);
    }
  }

  // 是否启用了任一档限制（两档都 0 时调用方可整个跳过）
  function isEnabled() {
    return dailyCapUsd > 0 || perChatCapUsd > 0;
  }

  return { precheck, record, stats, reset, isEnabled };
}
