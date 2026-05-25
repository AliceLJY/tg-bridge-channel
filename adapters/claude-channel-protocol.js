// Claude channel 引擎的纯协议层：channel side-channel 消息 ↔ streamQuery 事件。
// 无副作用、无 I/O，便于单测（照 codex.js 的 mapCodexEvent 模式）。
// 异步审批回路（调 requestPermission 等用户）由 claude-channel.js 集成层处理；
// 本模块只做同步的事件映射 + 字段适配。

export function createChannelState(sessionId) {
  return {
    sessionId,
    yieldedInit: false,
    replyBuffer: [],   // 累积每次 reply 的文本，turn 结束作为 result.text
  };
}

// 首次发 session_init（预生成 / resume 的 UUID），照 codex 的 yieldedInit 兜底
export function maybeEmitInit(state) {
  if (state.yieldedInit) return [];
  state.yieldedInit = true;
  return [{ type: "session_init", sessionId: state.sessionId }];
}

// 把一条 side-channel 消息映射成 streamQuery 事件数组
export function mapChannelMessage(msg, state) {
  const out = [];
  if (!msg || typeof msg !== "object") return out;

  if (msg.type === "reply") {
    const text = String(msg.text || "");
    if (text) {
      state.replyBuffer.push(text);
      out.push({ type: "text", text });
    }
    // channel 的 reply.files 是文件路径（非 base64），统一映射成 file_written
    for (const f of msg.files || []) {
      out.push({ type: "file_written", filePath: f, tool: "reply" });
    }
    return out;
  }

  if (msg.type === "permission_request") {
    const { input } = adaptPermissionRequest(msg);
    out.push({ type: "progress", toolName: msg.tool_name, input });
    return out;
  }

  return out;
}

// 字段适配：channel permission_request → 编排层 requestPermission(toolName, input, sdkOptions)
export function adaptPermissionRequest(msg) {
  let input;
  try {
    input = JSON.parse(msg.input_preview);
    if (input === null || typeof input !== "object") input = { preview: msg.input_preview };
  } catch {
    input = { preview: String(msg.input_preview ?? "") };
  }
  return {
    toolName: msg.tool_name,
    input,
    sdkOptions: { toolUseID: msg.request_id, suggestions: [] },
  };
}

// 把编排层返回的审批决定回送成 channel permission side-channel 消息
export function buildPermissionResponse(requestId, decision) {
  const behavior = decision?.behavior === "allow" ? "allow" : "deny";
  return { type: "permission_response", request_id: requestId, behavior };
}

// turn 结束时发 result。text = 累积的 reply；cost/duration 置 null（同 codex）。
// channel 协议无 turn-done 信号（fakechat 实证），集成层用 grace period 后调本函数。
export function finalizeChannel(state, { success, errorText } = {}) {
  return [{
    type: "result",
    success: !!success,
    text: success ? state.replyBuffer.join("\n") : (errorText || "channel turn failed"),
    cost: null,
    duration: null,
  }];
}
