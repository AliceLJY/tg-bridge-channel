import { describe, expect, test } from "bun:test";
import {
  createChannelState,
  maybeEmitInit,
  mapChannelMessage,
  adaptPermissionRequest,
  buildPermissionResponse,
  finalizeChannel,
} from "./claude-channel-protocol.js";

describe("channel protocol mapping", () => {
  test("maybeEmitInit yields session_init once", () => {
    const s = createChannelState("uuid-1");
    expect(maybeEmitInit(s)).toEqual([{ type: "session_init", sessionId: "uuid-1" }]);
    expect(maybeEmitInit(s)).toEqual([]); // 第二次不再发
  });

  test("reply message maps to a text event and buffers result text", () => {
    const s = createChannelState("uuid-1");
    expect(mapChannelMessage({ type: "reply", text: "你好" }, s)).toEqual([{ type: "text", text: "你好" }]);
    expect(s.replyBuffer).toEqual(["你好"]);
  });

  test("reply with file maps to text + file_written", () => {
    const s = createChannelState("uuid-1");
    const out = mapChannelMessage({ type: "reply", text: "看图", files: ["/abs/a.png"] }, s);
    expect(out).toEqual([
      { type: "text", text: "看图" },
      { type: "file_written", filePath: "/abs/a.png", tool: "reply" },
    ]);
  });

  test("permission_request maps to a progress event", () => {
    const s = createChannelState("uuid-1");
    const out = mapChannelMessage(
      { type: "permission_request", request_id: "abcde", tool_name: "Bash", description: "run", input_preview: '{"command":"ls"}' },
      s,
    );
    expect(out).toEqual([{ type: "progress", toolName: "Bash", input: { command: "ls" } }]);
  });

  test("adaptPermissionRequest parses input_preview and maps request_id to toolUseID", () => {
    expect(
      adaptPermissionRequest({ request_id: "abcde", tool_name: "Bash", description: "run", input_preview: '{"command":"ls"}' }),
    ).toEqual({ toolName: "Bash", input: { command: "ls" }, sdkOptions: { toolUseID: "abcde", suggestions: [] } });
  });

  test("adaptPermissionRequest tolerates non-JSON input_preview", () => {
    const r = adaptPermissionRequest({ request_id: "x", tool_name: "T", description: "d", input_preview: "not json" });
    expect(r.input).toEqual({ preview: "not json" });
    expect(r.sdkOptions.toolUseID).toBe("x");
  });

  test("buildPermissionResponse maps allow/deny decisions", () => {
    expect(buildPermissionResponse("abcde", { behavior: "allow" })).toEqual({
      type: "permission_response", request_id: "abcde", behavior: "allow",
    });
    expect(buildPermissionResponse("abcde", { behavior: "deny" })).toEqual({
      type: "permission_response", request_id: "abcde", behavior: "deny",
    });
    // 缺失/异常决定一律按 deny 兜底
    expect(buildPermissionResponse("abcde", {}).behavior).toBe("deny");
  });

  test("finalizeChannel emits a result with buffered text and null cost/duration", () => {
    const s = createChannelState("uuid-1");
    mapChannelMessage({ type: "reply", text: "part1" }, s);
    mapChannelMessage({ type: "reply", text: "part2" }, s);
    expect(finalizeChannel(s, { success: true })).toEqual([
      { type: "result", success: true, text: "part1\npart2", cost: null, duration: null },
    ]);
  });

  test("finalizeChannel on failure carries the error text", () => {
    const s = createChannelState("uuid-1");
    expect(finalizeChannel(s, { success: false, errorText: "crashed" })).toEqual([
      { type: "result", success: false, text: "crashed", cost: null, duration: null },
    ]);
  });
});
