// adapters/cli-pool.test.js
// 给生产 pool 引擎补行为测试(此前零覆盖)。聚焦两个 anti-hang 命门:
//   1. JsonlTailReader.readUntilTurnEnd — turn 归属过滤 + 截断重置 + 硬 deadline 超时
//   2. BgSession._waitForReady — 2026-05-29 改的 state 就绪判据(回归网)
// 测真实行为:真 JsonlTailReader 读真临时 jsonl;_waitForReady 注入 fake daemon。

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlTailReader, BgSession } from "./cli-pool.js";

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

// fake daemon:按调用次数返回预设 jobs 序列(最后一项重复)
function fakeDaemon(jobsSequence) {
  let i = 0;
  return { list: async () => ({ jobs: jobsSequence[Math.min(i++, jobsSequence.length - 1)] }) };
}
const mkSession = (short) => new BgSession({ short, sessionId: "s", cwd: "/tmp", jsonlPath: "/tmp/x.jsonl", name: "n" });

describe("BgSession._waitForReady (state 就绪判据)", () => {
  test("job.state === 'running' 立即返回(CLI 2.1.156 实测信号)", async () => {
    const sess = mkSession("abc");
    const t = Date.now();
    await sess._waitForReady(fakeDaemon([[{ short: "abc", state: "running", detail: "" }]]), 5000);
    expect(Date.now() - t).toBeLessThan(500);
  });

  test("job.state === 'adopted' 也算就绪", async () => {
    const sess = mkSession("abc");
    const t = Date.now();
    await sess._waitForReady(fakeDaemon([[{ short: "abc", state: "adopted", detail: "adopted from previous supervisor" }]]), 5000);
    expect(Date.now() - t).toBeLessThan(500);
  });

  test("回归:detail 恒空时仍能就绪(旧 agent-ready 判据会白等满超时)", async () => {
    const sess = mkSession("abc");
    const t = Date.now();
    await sess._waitForReady(fakeDaemon([[{ short: "abc", state: "running", detail: "" }]]), 3000);
    expect(Date.now() - t).toBeLessThan(500);
  });

  test("worker 始终不在 list 时 fail-open:等满超时后 proceed,不抛错", async () => {
    const sess = mkSession("ghost");
    const t = Date.now();
    await sess._waitForReady(fakeDaemon([[{ short: "other", state: "running" }]]), 300);
    const dt = Date.now() - t;
    expect(dt).toBeGreaterThanOrEqual(250);
    expect(dt).toBeLessThan(1500);
  });
});
