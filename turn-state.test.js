import { describe, expect, test } from "bun:test";

import { createTaskFinalizer, saveCapturedSession } from "./turn-state.js";

describe("turn state helpers", () => {
  test("finalizes a task exactly once", () => {
    const calls = [];
    const finalizer = createTaskFinalizer({
      taskId: "task-1",
      completeTask: (taskId, summary) => calls.push(["complete", taskId, summary]),
      failTask: (taskId, summary, code) => calls.push(["fail", taskId, summary, code]),
    });

    finalizer.success("done");
    finalizer.failure("late error", "RESULT_ERROR");
    finalizer.success("late success");

    expect(finalizer.finalized).toBe(true);
    expect(calls).toEqual([["complete", "task-1", "done"]]);
  });
});

function makeHarness({ currentSessionId = null, resetAt = 0, turnStartedAt = 1000 } = {}) {
  const calls = [];
  return {
    calls,
    args: {
      chatId: 1001,
      prompt: "测试消息",
      backendName: "claude",
      setSession: (...a) => calls.push(a),
      peekSession: () =>
        currentSessionId == null
          ? null
          : { session_id: currentSessionId, backend: "claude", ownership: "owned", session_type: "normal" },
      getResetAt: () => resetAt,
      turnStartedAt,
      patchCodexStateDb: () => {},
      logger: { log: () => {} },
    },
  };
}

describe("saveCapturedSession 写回防护", () => {
  test("正常完成：映射仍是 turn 起点 → 保存", () => {
    const h = makeHarness({ currentSessionId: "aaa-start" });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: "aaa-start",
    });
    expect(saved).toBe(true);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0][1]).toBe("bbb-captured");
  });

  test("turn 期间被 /new 删除（current=null, 起点非 null）→ 不写回，旧链不复活", () => {
    const h = makeHarness({ currentSessionId: null, resetAt: 2000, turnStartedAt: 1000 });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: "aaa-start",
    });
    expect(saved).toBe(false);
    expect(h.calls.length).toBe(0);
  });

  test("新会话第一个 turn 进行中被 /new（reset 晚于 turn 开始，前后映射都为 null）→ 不写回", () => {
    const h = makeHarness({ currentSessionId: null, resetAt: 2000, turnStartedAt: 1000 });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: null,
    });
    expect(saved).toBe(false);
    expect(h.calls.length).toBe(0);
  });

  test("上一次 /new 发生在 turn 开始之前 → 不拦截，正常保存", () => {
    const h = makeHarness({ currentSessionId: null, resetAt: 500, turnStartedAt: 1000 });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: null,
    });
    expect(saved).toBe(true);
    expect(h.calls.length).toBe(1);
  });

  test("turn 期间被 /resume 切到其他会话 → 不写回", () => {
    const h = makeHarness({ currentSessionId: "ccc-other" });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: "aaa-start",
    });
    expect(saved).toBe(false);
    expect(h.calls.length).toBe(0);
  });

  test("新对话第一个 turn（起点 null，current null，无 reset）→ 保存", () => {
    const h = makeHarness({ currentSessionId: null });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: null,
    });
    expect(saved).toBe(true);
    expect(h.calls.length).toBe(1);
  });

  test("current 已等于 captured（本 turn 已写过）→ 幂等放行", () => {
    const h = makeHarness({ currentSessionId: "bbb-captured" });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: "aaa-start",
    });
    expect(saved).toBe(true);
    expect(h.calls.length).toBe(1);
  });

  test("不传 peekSession/getResetAt（旧调用方）→ 跳过防护直接保存", () => {
    const h = makeHarness();
    const saved = saveCapturedSession({
      ...h.args,
      peekSession: undefined,
      getResetAt: undefined,
      capturedSessionId: "bbb-captured",
      sessionId: "aaa-start",
    });
    expect(saved).toBe(true);
    expect(h.calls.length).toBe(1);
  });

  test("capturedSessionId 为空 → 不保存（既有行为不变）", () => {
    const h = makeHarness({ currentSessionId: "aaa-start" });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: null,
      sessionId: "aaa-start",
    });
    expect(saved).toBe(false);
    expect(h.calls.length).toBe(0);
  });
});

// 防护三（2026-07-17 case 4fb95516）：换代出的新 sid 必须已落盘才写回，防"黑洞 ID"
// （fork 复活半途被取消 → 新 sid 永无文件 → 写回后每条消息 resume 不存在的会话 = 死循环）。
describe("saveCapturedSession 防护三：幽灵 ID（会话文件未落盘）", () => {
  test("换代 + 新 sid 无会话文件 → 不写回，旧映射保留", () => {
    const h = makeHarness({ currentSessionId: "aaa-start" });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-ghost",
      sessionId: "aaa-start",
      sessionFileExists: () => false,
    });
    expect(saved).toBe(false);
    expect(h.calls.length).toBe(0);
  });

  test("换代 + 新 sid 文件在盘上 → 正常保存", () => {
    const h = makeHarness({ currentSessionId: "aaa-start" });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: "aaa-start",
      sessionFileExists: () => true,
    });
    expect(saved).toBe(true);
    expect(h.calls[0][1]).toBe("bbb-captured");
  });

  test("同 sid 轮（op:reply 未换代）→ 不查盘直接保存", () => {
    const h = makeHarness({ currentSessionId: "aaa-start" });
    let probed = 0;
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "aaa-start",
      sessionId: "aaa-start",
      sessionFileExists: () => { probed++; return false; },
    });
    expect(saved).toBe(true);
    expect(probed).toBe(0);
  });

  test("新会话第一轮（sessionId=null，captured 有文件）→ 保存", () => {
    const h = makeHarness({ currentSessionId: null });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: null,
      sessionFileExists: () => true,
    });
    expect(saved).toBe(true);
  });

  test("新会话第一轮 spawn 半途被取消（sessionId=null，captured 无文件）→ 不写回", () => {
    const h = makeHarness({ currentSessionId: null });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-ghost",
      sessionId: null,
      sessionFileExists: () => false,
    });
    expect(saved).toBe(false);
    expect(h.calls.length).toBe(0);
  });

  test("不传 sessionFileExists（codex/gemini/旧调用方）→ 行为不变", () => {
    const h = makeHarness({ currentSessionId: "aaa-start" });
    const saved = saveCapturedSession({
      ...h.args,
      capturedSessionId: "bbb-captured",
      sessionId: "aaa-start",
    });
    expect(saved).toBe(true);
  });
});
