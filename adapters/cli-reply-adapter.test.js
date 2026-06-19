import { describe, expect, test } from "bun:test";

import { mapEvents } from "./cli-reply-adapter.js";

// mapEvents(ev, state):reply 引擎把 cli-pool 底层事件映射成 bridge 统一事件。
// state 形如 { accumulatedText, turnStartAt }(turn_end 用 accumulatedText 兜底回传)。
function collect(ev, state = { accumulatedText: "", turnStartAt: 0 }) {
  return [...mapEvents(ev, state)];
}

describe("cli-reply-adapter mapEvents", () => {
  test("thinking 块 → 「🤔 思考中」进度态(哨兵 toolName __thinking__)", () => {
    // 核心改动:长思考 + 纯文字回复时,thinking 不再被默默丢弃,而是上报为进度信号,
    // 让 TG 那条消息从"死等"变成"🤔 思考中",消灭"以为卡死"的错觉。
    expect(collect({ type: "thinking", text: "让我想想这道题的结构……" })).toEqual([
      { type: "progress", toolName: "__thinking__" },
    ]);
  });

  test("thinking 只发状态、不把模型内心独白发到 TG", () => {
    const out = collect({ type: "thinking", text: "用户其实想要的是 X,但这段推理不该外泄" });
    expect(out).toEqual([{ type: "progress", toolName: "__thinking__" }]);
    expect(out.some(e => e.type === "text")).toBe(false);
  });

  test("text 块 → text 事件并累积到 state(turn_end 兜底回传用)", () => {
    const state = { accumulatedText: "", turnStartAt: 0 };
    expect([...mapEvents({ type: "text", text: "答案是 42。" }, state)]).toEqual([
      { type: "text", text: "答案是 42。" },
    ]);
    expect(state.accumulatedText).toBe("答案是 42。");
  });

  test("tool_use(非 AskUserQuestion)→ progress 事件", () => {
    expect(collect({ type: "tool_use", name: "Read", input: { file_path: "/a.js" } })).toEqual([
      { type: "progress", toolName: "Read", input: { file_path: "/a.js" } },
    ]);
  });

  test("AskUserQuestion 静默跳过(hook 已拦、模型自主续写)", () => {
    expect(collect({ type: "tool_use", name: "AskUserQuestion", input: {} })).toEqual([]);
  });

  test("turn_end → result,text 取 state 累积全文", () => {
    const state = { accumulatedText: "前半段。后半段。", turnStartAt: 0 };
    const out = [...mapEvents({ type: "turn_end", durationMs: 123 }, state)];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "result", success: true, text: "前半段。后半段。" });
  });
});
