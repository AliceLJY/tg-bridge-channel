import { describe, expect, test } from "bun:test";

import { createProgressTracker } from "./progress.js";

describe("progress tracker", () => {
  test("can start typing without a visible progress message", async () => {
    const calls = [];
    const ctx = {
      api: {
        sendMessage: async (...args) => {
          calls.push(["sendMessage", ...args]);
          return { message_id: 123 };
        },
        sendChatAction: async (...args) => {
          calls.push(["sendChatAction", ...args]);
        },
        editMessageText: async (...args) => {
          calls.push(["editMessageText", ...args]);
        },
        deleteMessage: async (...args) => {
          calls.push(["deleteMessage", ...args]);
        },
      },
    };

    const progress = createProgressTracker(ctx, -100, 1, "CC");
    await progress.start({ visibleMessage: false });
    progress.processEvent({ type: "progress", toolName: "Read" });
    await progress.finish();

    expect(calls).toEqual([
      ["sendChatAction", -100, "typing"],
    ]);
  });

  test("__thinking__ 进度事件渲染为「🤔 思考中」(消灭长思考的卡死错觉)", async () => {
    const edits = [];
    const ctx = {
      api: {
        sendMessage: async () => ({ message_id: 123 }),
        sendChatAction: async () => {},
        editMessageText: async (_chatId, _msgId, text) => { edits.push(text); },
        deleteMessage: async () => {},
      },
    };

    const progress = createProgressTracker(ctx, -100, 1, "CC");
    await progress.start({ visibleMessage: true });
    progress.processEvent({ type: "progress", toolName: "__thinking__" });

    expect(edits.length).toBeGreaterThan(0);
    expect(edits[edits.length - 1]).toContain("🤔 思考中");
    await progress.finish({ skipMessage: true });
  });

  test("连续多条 thinking 不刷屏,只保留单行「🤔 思考中」", async () => {
    const edits = [];
    const ctx = {
      api: {
        sendMessage: async () => ({ message_id: 123 }),
        sendChatAction: async () => {},
        editMessageText: async (_chatId, _msgId, text) => { edits.push(text); },
        deleteMessage: async () => {},
      },
    };

    const progress = createProgressTracker(ctx, -100, 1, "CC");
    await progress.start({ visibleMessage: true });
    for (let i = 0; i < 5; i++) {
      progress.processEvent({ type: "progress", toolName: "__thinking__" });
    }

    const last = edits[edits.length - 1] || "";
    const occurrences = (last.match(/🤔 思考中/g) || []).length;
    expect(occurrences).toBe(1);
    await progress.finish({ skipMessage: true });
  });
});
