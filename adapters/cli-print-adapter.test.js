// adapters/cli-print-adapter.test.js
// 给 --print 流式接续引擎补行为测试。聚焦两个纯函数命门(子进程 spawn 不在单测覆盖,靠灰度 e2e 验):
//   1. buildPrintArgs — 会话路径(resume vs 新建 --session-id)、覆盖透传、remote control、非交互防护注入
//   2. filterPrintEvent — 事件过滤/累积/收尾:question 跳过、文本累积、result 空文本兜底、result 收尾
// 这两个是 print 引擎"不 fork / 不无输出 / 不挂死"的核心,与 cli-pool.test.js 同等定位。

import { describe, expect, test } from "bun:test";
import { buildPrintArgs, filterPrintEvent, isResumeFailureResult } from "./cli-print-adapter.js";
import { BRIDGE_SYSTEM_NOTE } from "./cli-pool.js";

// 取一个 flag 的值(--flag value 形式)
function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const baseConfig = { model: "opus[1m]", effort: "max", permissionMode: "bypassPermissions", cwd: "/home/x", destructiveGuard: false, remoteControl: true };

describe("buildPrintArgs", () => {
  test("有 sessionId → --resume,不带 --session-id,sessionIdUsed 原样", () => {
    const { args, sessionIdUsed } = buildPrintArgs(baseConfig, { sessionId: "abc-123" });
    expect(flagVal(args, "--resume")).toBe("abc-123");
    expect(args).not.toContain("--session-id");
    expect(sessionIdUsed).toBe("abc-123");
  });

  test("无 sessionId → 生成 uuid 走 --session-id,不带 --resume", () => {
    const { args, sessionIdUsed } = buildPrintArgs(baseConfig, {});
    expect(args).not.toContain("--resume");
    expect(flagVal(args, "--session-id")).toBe(sessionIdUsed);
    expect(sessionIdUsed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("两次新建的 uuid 不同(每个 chat 一个稳定独立 sid)", () => {
    const a = buildPrintArgs(baseConfig, {}).sessionIdUsed;
    const b = buildPrintArgs(baseConfig, {}).sessionIdUsed;
    expect(a).not.toBe(b);
  });

  test("固定走 --print stream-json --verbose + permission-mode", () => {
    const { args } = buildPrintArgs(baseConfig, { sessionId: "s" });
    expect(args).toContain("--print");
    expect(flagVal(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(flagVal(args, "--permission-mode")).toBe("bypassPermissions");
  });

  test("model __default__ 哨兵 → 用 config.model;显式覆盖 → 用覆盖值", () => {
    expect(flagVal(buildPrintArgs(baseConfig, { sessionId: "s", model: "__default__" }).args, "--model")).toBe("opus[1m]");
    expect(flagVal(buildPrintArgs(baseConfig, { sessionId: "s", model: "sonnet" }).args, "--model")).toBe("sonnet");
  });

  test("effort 覆盖优先于 config 默认", () => {
    expect(flagVal(buildPrintArgs(baseConfig, { sessionId: "s" }).args, "--effort")).toBe("max");
    expect(flagVal(buildPrintArgs(baseConfig, { sessionId: "s", effort: "low" }).args, "--effort")).toBe("low");
  });

  test("systemAppend 拼在 BRIDGE_SYSTEM_NOTE 之后(非交互防护 + 群聊 scaffold 都生效)", () => {
    const note = flagVal(buildPrintArgs(baseConfig, { sessionId: "s", systemAppend: "GROUP-CTX" }).args, "--append-system-prompt");
    expect(note.startsWith(BRIDGE_SYSTEM_NOTE)).toBe(true);
    expect(note.endsWith("GROUP-CTX")).toBe(true);
    // 无 systemAppend 时只有固定段
    const bare = flagVal(buildPrintArgs(baseConfig, { sessionId: "s" }).args, "--append-system-prompt");
    expect(bare).toBe(BRIDGE_SYSTEM_NOTE);
  });

  test("总是注入 --settings(含 AskUserQuestion 拦截 hook)", () => {
    const settings = JSON.parse(flagVal(buildPrintArgs(baseConfig, { sessionId: "s" }).args, "--settings"));
    const matchers = (settings.hooks?.PreToolUse || []).map(h => h.matcher);
    expect(matchers).toContain("AskUserQuestion");
  });

  test("destructiveGuard 开 → settings 额外含 Bash 护栏", () => {
    const settings = JSON.parse(flagVal(buildPrintArgs({ ...baseConfig, destructiveGuard: true }, { sessionId: "s" }).args, "--settings"));
    const matchers = (settings.hooks?.PreToolUse || []).map(h => h.matcher);
    expect(matchers).toContain("AskUserQuestion");
    expect(matchers).toContain("Bash");
  });

  test("remoteControl 开 → 含 bare --remote-control;关 → 不含", () => {
    expect(buildPrintArgs({ ...baseConfig, remoteControl: true }, { sessionId: "s" }).args).toContain("--remote-control");
    expect(buildPrintArgs({ ...baseConfig, remoteControl: false }, { sessionId: "s" }).args).not.toContain("--remote-control");
  });

  test("remoteControlName → 用带值的 prefix flag(不走 [name] 可选参数歧义)", () => {
    const { args } = buildPrintArgs({ ...baseConfig, remoteControl: true }, { sessionId: "s", remoteControlName: "mmcode2" });
    expect(flagVal(args, "--remote-control-session-name-prefix")).toBe("mmcode2");
  });
});

describe("filterPrintEvent", () => {
  const fresh = () => ({ sawInit: false, accumulatedText: "" });

  test("session_init → 透传 + 标记 sawInit", () => {
    const s = fresh();
    const { emit, done } = filterPrintEvent({ type: "session_init", sessionId: "x" }, s);
    expect(emit).toMatchObject({ type: "session_init", sessionId: "x" });
    expect(done).toBe(false);
    expect(s.sawInit).toBe(true);
  });

  test("text → 透传 + 累积", () => {
    const s = fresh();
    filterPrintEvent({ type: "text", text: "Hello " }, s);
    const { emit } = filterPrintEvent({ type: "text", text: "world" }, s);
    expect(emit).toMatchObject({ type: "text", text: "world" });
    expect(s.accumulatedText).toBe("Hello world");
  });

  test("question 事件静默跳过(非交互,不渲染按钮)", () => {
    expect(filterPrintEvent({ type: "question", question: "选哪个?" }, fresh())).toEqual({ emit: null, done: false });
  });

  test("AskUserQuestion 的 progress 跳过,其它工具 progress 透传", () => {
    expect(filterPrintEvent({ type: "progress", toolName: "AskUserQuestion" }, fresh())).toEqual({ emit: null, done: false });
    const { emit } = filterPrintEvent({ type: "progress", toolName: "Bash", input: {} }, fresh());
    expect(emit).toMatchObject({ type: "progress", toolName: "Bash" });
  });

  test("result 有文本 → 原样透传 + done", () => {
    const { emit, done } = filterPrintEvent({ type: "result", success: true, text: "final answer" }, fresh());
    expect(emit).toMatchObject({ type: "result", success: true, text: "final answer" });
    expect(done).toBe(true);
  });

  test("result 文本为空但已累积 → 用累积值兜底(防无输出)+ done", () => {
    const s = { sawInit: true, accumulatedText: "已经说过的正文" };
    const { emit, done } = filterPrintEvent({ type: "result", success: true, text: "" }, s);
    expect(emit).toMatchObject({ type: "result", success: true, text: "已经说过的正文" });
    expect(done).toBe(true);
  });

  test("result 文本与累积都空 → 原样透传(无可兜底)", () => {
    const { emit, done } = filterPrintEvent({ type: "result", success: false, text: "" }, fresh());
    expect(emit).toMatchObject({ type: "result", success: false, text: "" });
    expect(done).toBe(true);
  });

  test("file_written / image 等普通事件透传不收尾", () => {
    expect(filterPrintEvent({ type: "file_written", filePath: "/a.png" }, fresh())).toEqual({ emit: { type: "file_written", filePath: "/a.png" }, done: false });
    expect(filterPrintEvent({ type: "image", data: "..." }, fresh()).done).toBe(false);
  });
});

describe("isResumeFailureResult(resume 失效非抛错形态,codex P2)", () => {
  // 实测:--print --resume <失效 sid> 发 result{success:false,"No conversation found..."} 且无 session_init,
  // 不抛错退出(exit 0)。必须识别出来触发新建会话回退,否则该 chat 卡死到 /new。
  const noInit = () => ({ sawInit: false, accumulatedText: "" });
  const withInit = () => ({ sawInit: true, accumulatedText: "" });
  const failResult = { type: "result", success: false, text: "No conversation found with session ID: x" };

  test("resume 轮 + 失败 result + 无 session_init → true(触发新建回退)", () => {
    expect(isResumeFailureResult(failResult, noInit(), "stale-sid")).toBe(true);
  });
  test("resume 轮但本轮已见 session_init → false(是 session 内的真失败,如实发出不回退)", () => {
    expect(isResumeFailureResult(failResult, withInit(), "stale-sid")).toBe(false);
  });
  test("首轮新建(wasResume 假)失败 → false(没法再新建一次,直接发错误)", () => {
    expect(isResumeFailureResult(failResult, noInit(), null)).toBe(false);
  });
  test("resume 轮成功 result → false", () => {
    expect(isResumeFailureResult({ type: "result", success: true, text: "ok" }, noInit(), "sid")).toBe(false);
  });
  test("非 result 事件 → false", () => {
    expect(isResumeFailureResult({ type: "text", text: "hi" }, noInit(), "sid")).toBe(false);
  });
});
