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
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "hello", pollMs: 5, hardLimitMs: 2000 })) events.push(ev);
    expect(events.some(e => e.type === "text" && e.text === "hi there")).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: "turn_end", durationMs: 1234 });
  });

  test("echoGraceMs 看门狗:op:reply 偶发没投递(本轮 user echo 始终不来)→ echoGraceMs 内快速失败抛 ECHO_TIMEOUT,不傻等 hardLimit", async () => {
    const spawnAt = Date.parse("2026-06-14T10:00:00.000Z");
    // 只有 spawn 之前的历史(被 ts 门跳过);本轮 user echo 从未写入 = op:reply 没让 worker 起新 turn(实测 d184d41a)
    writeFileSync(path, [
      J({ type: "user", message: { content: "上一轮" }, timestamp: "2026-06-14T09:59:00.000Z" }),
      J({ type: "system", subtype: "turn_duration", durationMs: 5, timestamp: "2026-06-14T09:59:01.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    let err;
    try {
      for await (const _ of reader.readUntilTurnEnd({ spawnStartedAt: spawnAt, echoGraceMs: 120, pollMs: 10, heartbeatMs: 5000, hardLimitMs: 10000 })) { /* drain */ }
    } catch (e) { err = e; }
    expect(err?.message).toMatch(/ECHO_TIMEOUT/);  // echoGraceMs(120ms)快速失败,而非傻等 hardLimit(10s)
  });

  test("echoGraceMs 看门狗只在 echo 没来时管:user echo 已到的慢任务不误触发(走 hardLimit 不走 ECHO_TIMEOUT)", async () => {
    const spawnAt = Date.parse("2026-06-14T10:00:00.000Z");
    // 本轮 user echo 已到(userEchoSeen 置位),但迟迟没 turn_duration/end_turn → 慢任务,看门狗不该误杀
    writeFileSync(path, [
      J({ type: "user", message: { content: "干个长活" }, timestamp: "2026-06-14T10:00:01.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    let err;
    try {
      for await (const _ of reader.readUntilTurnEnd({ spawnStartedAt: spawnAt, echoGraceMs: 100, pollMs: 10, heartbeatMs: 5000, hardLimitMs: 250 })) { /* drain */ }
    } catch (e) { err = e; }
    expect(err?.message).toMatch(/hard limit/);        // echo 已到 → 看门狗不误伤,走 hardLimit 兜底
    expect(err?.message).not.toMatch(/ECHO_TIMEOUT/);
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
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "mine", pollMs: 5, hardLimitMs: 2000 })) {
      if (ev.type === "text") texts.push(ev.text);
    }
    expect(texts).toEqual(["ours"]); // "leaked" 不该泄漏到本 turn
  });

  // ── 2026-06-13 codex 复核点①②的回归网:fork-per-turn 回传的两道命门 ──
  // 背景:配图发布"石沉大海"根因——fork --resume 后 jsonl 里 ① 混入旧上下文(时间戳更早)
  // ② user echo 与原 prompt 对不上 → 旧逻辑 userEchoSeen 永 false、assistant 全被忽略 = "无输出";
  // 且 --bg 下常无 system/turn_duration → 不软结束就一直等 = TG 不返回。
  test("spawnStartedAt 归属:跳过 spawn 之前的历史行(fork --resume 继承的旧上下文不泄漏)", async () => {
    const spawnAt = Date.parse("2026-06-13T10:00:00.000Z");
    writeFileSync(path, [
      // 旧上下文(fork --resume 写进新 jsonl):时间戳早于 spawnAt → 必须跳过
      J({ type: "user", message: { content: "上一轮的问题" }, timestamp: "2026-06-13T09:59:00.000Z" }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "上一轮的旧回答" }] }, timestamp: "2026-06-13T09:59:01.000Z" }),
      // 本轮(spawnAt 之后)
      J({ type: "user", message: { content: "配图发布吧" }, timestamp: "2026-06-13T10:00:01.000Z" }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "本轮新回答" }] }, timestamp: "2026-06-13T10:00:02.000Z" }),
      J({ type: "system", subtype: "turn_duration", durationMs: 9, timestamp: "2026-06-13T10:00:03.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const texts = [];
    for await (const ev of reader.readUntilTurnEnd({ spawnStartedAt: spawnAt, pollMs: 5, heartbeatMs: 5000, hardLimitMs: 5000 })) {
      if (ev.type === "text") texts.push(ev.text);
    }
    expect(texts).toEqual(["本轮新回答"]); // 旧回答被时间戳归属过滤掉,不串到本轮
  });

  test("spawnStartedAt echo 放宽:user 内容与 prompt 对不上(fork 包装)仍认作本轮 echo、正文照常回传", async () => {
    const spawnAt = Date.parse("2026-06-13T10:00:00.000Z");
    writeFileSync(path, [
      // fork/scaffold 包装后,jsonl 里 user 内容跟原始 prompt 不一字不差(群聊上下文/系统注入等)
      J({ type: "user", message: { content: "[群聊上下文]\n安闲静雅: 配图发布吧" }, timestamp: "2026-06-13T10:00:01.000Z" }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "好的,开始配图发布" }] }, timestamp: "2026-06-13T10:00:02.000Z" }),
      J({ type: "system", subtype: "turn_duration", durationMs: 9, timestamp: "2026-06-13T10:00:03.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const texts = [];
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "配图发布吧", spawnStartedAt: spawnAt, pollMs: 5, heartbeatMs: 5000, hardLimitMs: 5000 })) {
      if (ev.type === "text") texts.push(ev.text);
    }
    // 旧逻辑:user !== "配图发布吧" → userEchoSeen 永 false → assistant 全忽略 → "无输出"(这次的 bug)
    // 新逻辑:spawnStartedAt 在场 → 本轮第一个 user 即 echo → 正文照常回传
    expect(texts).toEqual(["好的,开始配图发布"]);
  });

  test("软结束:assistant stop_reason=end_turn 即收尾(--bg 下无 turn_duration 也不傻等到 hardLimit)", async () => {
    const spawnAt = Date.parse("2026-06-13T10:00:00.000Z");
    writeFileSync(path, [
      J({ type: "user", message: { content: "配图发布吧" }, timestamp: "2026-06-13T10:00:01.000Z" }),
      // 模型说完一段并 end_turn(如"发布失败:40164,请加白名单"),但 --bg 下后面没有 system/turn_duration
      J({ type: "assistant", message: { content: [{ type: "text", text: "发布失败:40164,请把出口 IP 加白名单" }], stop_reason: "end_turn" }, timestamp: "2026-06-13T10:00:02.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const events = [];
    // hardLimitMs 给小值:若软结束没生效会傻等到 hardLimit 抛错;生效则立刻 turn_end 返回
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "配图发布吧", spawnStartedAt: spawnAt, pollMs: 5, heartbeatMs: 5000, hardLimitMs: 300 })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === "text" && /40164/.test(e.text))).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: "turn_end", soft: true }); // 软结束收尾,非 hardLimit 抛错
  });

  test("软结束 gate 在 text 上:thinking-only end_turn 不收尾,等正文 text end_turn 才收(--effort max 实况,codex 复核回归)", async () => {
    // 实据:开 thinking 时 jsonl 把 thinking 单独写成一条 stop_reason=end_turn 的 assistant 行,正文 text 在下一条
    // (也 end_turn)。本会话实测 19/19 thinking-only end_turn 后面都紧跟 text 行。旧 buggy 软结束会在 thinking 行
    // 就 return → 正文丢失 → 重造"无输出"(正是要修的 bug)。sawText gate 必须挡住 thinking-only。
    const spawnAt = Date.parse("2026-06-13T10:00:00.000Z");
    writeFileSync(path, [
      J({ type: "user", message: { content: "配图发布吧" }, timestamp: "2026-06-13T10:00:01.000Z" }),
      // thinking 单独成行 + stop_reason=end_turn → 不能在这里收尾
      J({ type: "assistant", message: { content: [{ type: "thinking", thinking: "让我想想配图风格..." }], stop_reason: "end_turn" }, timestamp: "2026-06-13T10:00:02.000Z" }),
      // 正文在【下一条】assistant 行(也 end_turn)→ 这里才是真正的轮结束
      J({ type: "assistant", message: { content: [{ type: "text", text: "配图发布完成,草稿已进箱" }], stop_reason: "end_turn" }, timestamp: "2026-06-13T10:00:03.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const events = [];
    // hardLimitMs 给小值:若 thinking 行误收尾,正文丢失;若 sawText gate 生效,会 tail 到正文行才软结束
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "配图发布吧", spawnStartedAt: spawnAt, pollMs: 5, heartbeatMs: 5000, hardLimitMs: 800 })) {
      events.push(ev);
    }
    expect(events.some(e => e.type === "text" && /配图发布完成/.test(e.text))).toBe(true); // 正文必须出现(旧 bug 会丢)
    expect(events[events.length - 1]).toMatchObject({ type: "turn_end", soft: true });      // 收尾发生在正文之后
    // thinking 行不该触发收尾:turn_end 只应有一个、且在最后
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
  });

  test("echo 兼容 array text:post-spawn user 是 [{type:text}](fork --resume 续接形态)仍认 echo、正文回传(codex 复核根因)", async () => {
    // 根因实据(02f3c3d1.jsonl):fork --resume 后本轮 post-spawn 的 user echo 是数组 "Continue from where you
    // left off."(L79),旧逻辑只认 string → text=null → userEchoSeen 永 false → 后续 assistant/turn_duration 全被吞
    // → "终端答完了、TG 不回、卡到 watchdog"。这条复现该形态。
    const spawnAt = Date.parse("2026-06-13T12:02:00.000Z");
    writeFileSync(path, [
      // 继承的旧轮(早于 spawn):string user,必须被归属过滤、不作本轮 echo
      J({ type: "user", message: { content: "上一轮发布文章" }, timestamp: "2026-06-13T11:52:38.000Z" }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "旧轮回答" }] }, timestamp: "2026-06-13T11:52:40.000Z" }),
      // 本轮 post-spawn:echo 是数组形态(resume 续接)
      J({ type: "user", message: { content: [{ type: "text", text: "Continue from where you left off." }] }, timestamp: "2026-06-13T12:02:35.000Z" }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "收工完成,归档已清理" }] }, timestamp: "2026-06-13T12:02:40.000Z" }),
      J({ type: "system", subtype: "turn_duration", durationMs: 40, timestamp: "2026-06-13T12:02:41.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const events = [];
    for await (const ev of reader.readUntilTurnEnd({ expectUserText: "收工", spawnStartedAt: spawnAt, pollMs: 5, heartbeatMs: 5000, hardLimitMs: 800 })) {
      events.push(ev);
    }
    const texts = events.filter(e => e.type === "text").map(e => e.text);
    expect(texts).toEqual(["收工完成,归档已清理"]); // 只本轮正文,旧轮"旧轮回答"被归属过滤掉
    expect(events[events.length - 1]).toMatchObject({ type: "turn_end" }); // turn_duration 收尾(旧 bug 会卡到 hardLimit 抛错)
  });

  test("tool_result 数组不作 echo:先来 tool_result user 不开闸,真 text echo 才开闸", async () => {
    const spawnAt = Date.parse("2026-06-13T12:02:00.000Z");
    writeFileSync(path, [
      // post-spawn 第一条 user 是 tool_result 数组 → 不该被当 echo
      J({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }, timestamp: "2026-06-13T12:02:30.000Z" }),
      // 这条 assistant 在真 echo 之前,若误把 tool_result 当 echo 会被错误 yield
      J({ type: "assistant", message: { content: [{ type: "text", text: "不该提前出现" }] }, timestamp: "2026-06-13T12:02:31.000Z" }),
      // 真正的 text echo
      J({ type: "user", message: { content: [{ type: "text", text: "真echo" }] }, timestamp: "2026-06-13T12:02:35.000Z" }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "本轮正文" }] }, timestamp: "2026-06-13T12:02:40.000Z" }),
      J({ type: "system", subtype: "turn_duration", durationMs: 40, timestamp: "2026-06-13T12:02:41.000Z" }),
    ].join("\n") + "\n");
    const reader = new JsonlTailReader(path);
    const texts = [];
    for await (const ev of reader.readUntilTurnEnd({ spawnStartedAt: spawnAt, pollMs: 5, heartbeatMs: 5000, hardLimitMs: 800 })) {
      if (ev.type === "text") texts.push(ev.text);
    }
    expect(texts).toEqual(["本轮正文"]); // tool_result 不开闸,"不该提前出现"不被 yield
  });

  test("anti-hang:静默时 yield idle_heartbeat 而非判失败,超 hardLimit 才抛", async () => {
    writeFileSync(path, J({ type: "user", message: { content: "x" } }) + "\n");
    const reader = new JsonlTailReader(path);
    const events = [];
    let err = null;
    try {
      for await (const ev of reader.readUntilTurnEnd({ expectUserText: "x", pollMs: 10, heartbeatMs: 40, hardLimitMs: 200 })) events.push(ev);
    } catch (e) { err = e; }
    expect(events.some(e => e.type === "idle_heartbeat")).toBe(true);  // 静默期报进度,不判死
    expect(err?.message).toMatch(/hard limit/);                        // 真卡死(硬上限)才兜底抛
  });

  test("持续盯梢:jsonl 不断增长时正常跑到 turn_end,持续活动不误发心跳", async () => {
    // 起始只有 user 行;后台每 80ms append,活动间隔(80ms) < heartbeatMs(200ms)→ 不该误报 idle_heartbeat
    writeFileSync(path, J({ type: "user", message: { content: "x" } }) + "\n");
    const reader = new JsonlTailReader(path);

    // 后台每 80ms append 一行,共 5 次(总长 ~400ms);前 4 次 assistant text,第 5 次写 turn_end
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
      for await (const ev of reader.readUntilTurnEnd({ expectUserText: "x", pollMs: 30, heartbeatMs: 200, hardLimitMs: 5000 })) {
        events.push(ev);
      }
    } finally {
      clearInterval(interval);
    }
    const texts = events.filter(e => e.type === "text").map(e => e.text);
    expect(texts).toEqual(["tick1", "tick2", "tick3", "tick4"]);
    expect(events.some(e => e.type === "idle_heartbeat")).toBe(false);  // 持续活动期间不误报心跳
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
      for await (const _ of pool.sendAndStream(null, "hi", { hardLimitMs: 2000 })) { /* drain */ }
      expect(stops).toEqual(["fake0001"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("turn hard limit → 不 stop(worker 留活,产出由下一次 fork 继承)", async () => {
    const { pool, stops, dir } = makePool(J2({ type: "user", message: { content: "hi" } }) + "\n");
    let err = null;
    try {
      for await (const _ of pool.sendAndStream(null, "hi", { hardLimitMs: 150, heartbeatMs: 999999 })) { /* drain */ }
    } catch (e) {
      err = e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(err?.message).toMatch(/hard limit/);
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

  function makeResumePool(prevState, { liveWorker = true } = {}) {
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
    pool._findSessionPath = () => path;
    pool._hasLiveWorker = () => liveWorker;
    pool._spawnTurn = async (text, opts) => { spawnedOpts.push(opts); return { short: "fake0001", sessionId: "sess-2", cwd: dir, jsonlPath: path }; };
    pool.stopWorker = () => Promise.resolve();
    return { pool, spawnedOpts, dir };
  }

  test("上一 turn 未完成 + jsonl 仍在写 + 有活 worker → yield busy、不 spawn", async () => {
    const { pool, spawnedOpts, dir } = makeResumePool({ exists: true, complete: false, mtimeMs: Date.now() - 10_000 });
    const events = [];
    try {
      for await (const ev of pool.sendAndStream("prev-sess", "hi", { hardLimitMs: 2000 })) events.push(ev);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("busy");
    expect(spawnedOpts).toHaveLength(0);
  });

  test("上一 turn 未完成 + jsonl 仍在写 + 无活 worker(用户 Stop 过) → 不误堵,fork + 警示", async () => {
    const { pool, spawnedOpts, dir } = makeResumePool(
      { exists: true, complete: false, mtimeMs: Date.now() - 10_000 },
      { liveWorker: false },
    );
    const events = [];
    try {
      for await (const ev of pool.sendAndStream("prev-sess", "hi", { hardLimitMs: 2000 })) events.push(ev);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(events.some(e => e.type === "busy")).toBe(false);
    expect(spawnedOpts).toHaveLength(1);
    expect(spawnedOpts[0].systemAppend).toContain(INTERRUPTED_TURN_NOTE);
  });

  test("上一 turn 未完成 + jsonl 已停滞 → 放行 fork 且 systemAppend 注入切断警示", async () => {
    const { pool, spawnedOpts, dir } = makeResumePool({ exists: true, complete: false, mtimeMs: Date.now() - 600_000 });
    try {
      for await (const _ of pool.sendAndStream("prev-sess", "hi", { hardLimitMs: 2000, systemAppend: "群聊框架" })) { /* drain */ }
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
      for await (const _ of pool.sendAndStream("prev-sess", "hi", { hardLimitMs: 2000 })) { /* drain */ }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(spawnedOpts).toHaveLength(1);
    expect(spawnedOpts[0].systemAppend).toBeUndefined();
  });
});
