// adapters/cli-pool.test.js
// 给生产 pool 引擎补行为测试(此前零覆盖)。聚焦两个 anti-hang 命门:
//   1. JsonlTailReader.readUntilTurnEnd — turn 归属过滤 + 截断重置 + 硬 deadline 超时
//   2. BgSession._waitForReady — 2026-05-29 改的 state 就绪判据(回归网)
// 测真实行为:真 JsonlTailReader 读真临时 jsonl;_waitForReady 注入 fake daemon。

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlTailReader, buildTurnArgs, CliPool, readLastTurnState, INTERRUPTED_TURN_NOTE } from "./cli-pool.js";

const J = (o) => JSON.stringify(o);

describe("JsonlTailReader.readUntilTurnEnd", () => {
  let dir, path;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tail-")); path = join(dir, "s.jsonl"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("匹配 user echo 后才 yield assistant text,turn_duration 结束", async () => {
    writeFileSync(path, [
      J({ type: "user", message: { content: "hello" } }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } }),
      J({ type: "system", subtype: "turn_duration", durationMs: 1234 }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const events = [];
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "hello", pollMs: 5, timeoutMs: 2000 })) events.push(ev);
    expect(events.some(e => e.type === "text" && e.text === "hi there")).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: "turn_end", durationMs: 1234 });
  });

  test("忽略不匹配 user echo 的 assistant 块(防 peek 注入串台)", async () => {
    writeFileSync(path, [
      J({ type: "user", message: { content: "SOMEONE ELSE" } }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "leaked" }] } }),
      J({ type: "user", message: { content: "mine" } }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "ours" }] } }),
      J({ type: "system", subtype: "turn_duration", durationMs: 1 }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const texts = [];
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "mine", pollMs: 5, timeoutMs: 2000 })) {
      if (ev.type === "text") texts.push(ev.text);
    }
    expect(texts).toEqual(["ours"]); // "leaked" 不该泄漏到本 turn
  });

  test("anti-hang:无 turn_end 时到 deadline 抛 jsonl tail timeout", async () => {
    writeFileSync(path, J({ type: "user", message: { content: "x" } }) + "\n");
    const reader = new JsonlTailReader(path);
    let err = null;
    try {
      for await (const _ of reader.readUntilTurnEnd({ expectUserText: "x", pollMs: 10, timeoutMs: 150 })) { /* drain */ }
    } catch (e) { err = e; }
    expect(err?.message).toMatch(/tail timeout/);
  });

  test("心跳重置:持续 jsonl 增长不撞硬超时(长任务总耗时 > timeoutMs 仍能完成)", async () => {
    // 起始只有 user 行,timeoutMs=200ms(若不重置 deadline,200ms 必 throw)
    writeFileSync(path, J({ type: "user", message: { content: "x" } }) + "\n");
    const reader = new JsonlTailReader(path);

    // 后台每 80ms append 一行,共 5 次(总长 ~400ms >> 200ms timeoutMs)
    // 前 4 次是 assistant text,第 5 次写 turn_end
    let n = 0;
    const interval = setInterval(() => {
      n++;
      if (n < 5) {
        appendFileSync(path, J({ type: "assistant", message: { content: [{ type: "text", text: "tick" + n }] } }) + "\n");
      } else {
        appendFileSync(path, J({ type: "system", subtype: "turn_duration", durationMs: 400 }) + "\n");
        clearInterval(interval);
      }
    }, 80);

    const events = [];
    try {
      for await (const ev of reader.readUntilTurnEnd({ expectUserText: "x", pollMs: 30, timeoutMs: 200 })) {
        events.push(ev);
      }
    } finally {
      clearInterval(interval);
    }
    const texts = events.filter(e => e.type === "text").map(e => e.text);
    expect(texts).toEqual(["tick1", "tick2", "tick3", "tick4"]);
    expect(events[events.length - 1]).toMatchObject({ type: "turn_end", durationMs: 400 });
  });

  test("文件截断/轮转(size < offset)时重置 offset", async () => {
    writeFileSync(path, J({ type: "user", message: { content: "a" } }) + "\n");
    const reader = new JsonlTailReader(path);
    reader.resetToCurrentEnd();
    expect(reader.offset).toBeGreaterThan(0);
    writeFileSync(path, ""); // 截断
    const lines = await reader._readNewLines();
    expect(reader.offset).toBe(0);
    expect(lines).toEqual([]);
  });
});

// BgSession._waitForReady / DaemonClient 测试已随 2026-06-10 方案 C 重构删除:
// 直连 control socket 的 BgSession/DaemonClient 整套被移除,改为 CliPool 每 turn fork spawn
// (claude --bg --resume + tail jsonl + claude stop)。JsonlTailReader(上方测试)原样复用,
// 仍是新架构的核心 anti-hang 命门。

describe("buildTurnArgs per-turn overrides(2026-06-11 streamOverrides 透传)", () => {
  const config = { model: "opus", effort: "max", permissionMode: "bypassPermissions", destructiveGuard: true };

  test("无 overrides 时用 config 默认,不带 --resume", () => {
    const { args } = buildTurnArgs(config, {});
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
    expect(args).not.toContain("--resume");
  });

  test("model/effort/resume 覆盖生效,__default__ 哨兵视为未覆盖", () => {
    const { args } = buildTurnArgs(config, { model: "haiku", effort: "low", resumeSessionId: "abc-123" });
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    expect(args[args.indexOf("--resume") + 1]).toBe("abc-123");

    const { args: args2 } = buildTurnArgs(config, { model: "__default__" });
    expect(args2[args2.indexOf("--model") + 1]).toBe("opus");
  });

  test("systemAppend 拼在固定非交互提示之后(两段都要在)", () => {
    const { args } = buildTurnArgs(config, { systemAppend: "群聊上下文框架说明" });
    const note = args[args.indexOf("--append-system-prompt") + 1];
    expect(note).toContain("AskUserQuestion");
    expect(note).toContain("群聊上下文框架说明");
    expect(note.indexOf("AskUserQuestion")).toBeLessThan(note.indexOf("群聊上下文框架说明"));
  });
});

describe("CliPool.sendAndStream 超时语义(2026-06-11 临床修正:超时不杀 worker)", () => {
  const J2 = (o) => JSON.stringify(o);

  function makePool(jsonlContent) {
    const dir = mkdtempSync(join(tmpdir(), "pool-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, jsonlContent);
    const pool = new CliPool({ cwd: dir });
    const stops = [];
    pool._spawnTurn = async () => ({ short: "fake0001", sessionId: "sess-1", cwd: dir, jsonlPath: path });
    pool.stopWorker = (short) => { stops.push(short); return Promise.resolve(); };
    return { pool, stops, dir };
  }

  test("正常 turn_end → stopWorker 被调(用完即停)", async () => {
    const { pool, stops, dir } = makePool([
      J2({ type: "user", message: { content: "hi" } }),
      J2({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
      J2({ type: "system", subtype: "turn_duration", durationMs: 1 }),
    ].join("\n") + "\n");
    try {
      for await (const _ of pool.sendAndStream(null, "hi", { timeoutMs: 2000 })) { /* drain */ }
      expect(stops).toEqual(["fake0001"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("jsonl tail timeout → 不 stop(worker 留活,产出由下一次 fork 继承)", async () => {
    const { pool, stops, dir } = makePool(J2({ type: "user", message: { content: "hi" } }) + "\n");
    let err = null;
    try {
      for await (const _ of pool.sendAndStream(null, "hi", { timeoutMs: 150 })) { /* drain */ }
    } catch (e) {
      err = e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(err?.message).toMatch(/tail timeout/);
    expect(stops).toEqual([]);
  });
});

describe("readLastTurnState(fork 前置检查的 jsonl 尾部扫描)", () => {
  const J3 = (o) => JSON.stringify(o);
  let dir, path;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lts-")); path = join(dir, "s.jsonl"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("尾部是 turn_duration → complete", () => {
    writeFileSync(path, [
      J3({ type: "user", message: { content: "hi" } }),
      J3({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
      J3({ type: "system", subtype: "turn_duration", durationMs: 1 }),
    ].join("\n") + "\n");
    expect(readLastTurnState(path)).toMatchObject({ exists: true, complete: true });
  });

  test("最后一个 user 之后无 turn_end → incomplete(半截快照)", () => {
    writeFileSync(path, [
      J3({ type: "system", subtype: "turn_duration", durationMs: 1 }),
      J3({ type: "user", message: { content: "next msg" } }),
      J3({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
    ].join("\n") + "\n");
    expect(readLastTurnState(path)).toMatchObject({ exists: true, complete: false });
  });

  test("turn_end 后跟 summary 等杂行仍 complete(杂行被跳过)", () => {
    writeFileSync(path, [
      J3({ type: "user", message: { content: "hi" } }),
      J3({ type: "system", subtype: "turn_duration", durationMs: 1 }),
      J3({ type: "summary", summary: "t" }),
      "not-json-line",
    ].join("\n") + "\n");
    expect(readLastTurnState(path)).toMatchObject({ exists: true, complete: true });
  });

  test("文件不存在 → exists:false + complete:true(放行新建)", () => {
    expect(readLastTurnState(join(dir, "nope.jsonl"))).toMatchObject({ exists: false, complete: true });
  });
});

describe("CliPool.sendAndStream fork 前置检查(2026-06-11 半截快照错乱修复)", () => {
  const J4 = (o) => JSON.stringify(o);

  function makeResumePool(prevState) {
    const dir = mkdtempSync(join(tmpdir(), "fork-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, [
      J4({ type: "user", message: { content: "hi" } }),
      J4({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
      J4({ type: "system", subtype: "turn_duration", durationMs: 1 }),
    ].join("\n") + "\n");
    const pool = new CliPool({ cwd: dir });
    const spawnedOpts = [];
    pool._readPrevTurnState = () => prevState;
    pool._spawnTurn = async (text, opts) => { spawnedOpts.push(opts); return { short: "fake0001", sessionId: "sess-2", cwd: dir, jsonlPath: path }; };
    pool.stopWorker = () => Promise.resolve();
    return { pool, spawnedOpts, dir };
  }

  test("上一 turn 未完成 + jsonl 仍在写 → yield busy、不 spawn", async () => {
    const { pool, spawnedOpts, dir } = makeResumePool({ exists: true, complete: false, mtimeMs: Date.now() - 10_000 });
    const events = [];
    try {
      for await (const ev of pool.sendAndStream("prev-sess", "hi", { timeoutMs: 2000 })) events.push(ev);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("busy");
    expect(spawnedOpts).toHaveLength(0);
  });

  test("上一 turn 未完成 + jsonl 已停滞 → 放行 fork 且 systemAppend 注入切断警示", async () => {
    const { pool, spawnedOpts, dir } = makeResumePool({ exists: true, complete: false, mtimeMs: Date.now() - 600_000 });
    try {
      for await (const _ of pool.sendAndStream("prev-sess", "hi", { timeoutMs: 2000, systemAppend: "群聊框架" })) { /* drain */ }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(spawnedOpts).toHaveLength(1);
    expect(spawnedOpts[0].systemAppend).toContain(INTERRUPTED_TURN_NOTE);
    expect(spawnedOpts[0].systemAppend).toContain("群聊框架");
  });

  test("上一 turn 完整 → 正常放行、无警示注入", async () => {
    const { pool, spawnedOpts, dir } = makeResumePool({ exists: true, complete: true, mtimeMs: Date.now() });
    try {
      for await (const _ of pool.sendAndStream("prev-sess", "hi", { timeoutMs: 2000 })) { /* drain */ }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(spawnedOpts).toHaveLength(1);
    expect(spawnedOpts[0].systemAppend).toBeUndefined();
  });
});
