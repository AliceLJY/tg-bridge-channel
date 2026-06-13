// prune-fork-sessions.test.js — fork 会话清理的安全网。
// 挪文件是删除类操作,必须确认:只清"无标题的 tg-* fork 且超期",
// 近期/有 AI 标题/非 fork/当前会话(keepIds)一律不碰。

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneForkSessions } from "./scripts/prune-fork-sessions.mjs";

describe("pruneForkSessions", () => {
  let root, base, trash, cwd, dir;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prune-"));
    base = join(root, "projects");
    trash = join(root, "trash");
    cwd = "/Users/test";
    dir = join(base, cwd.replace(/[/.]/g, "-")); // 对齐 encodeCwdPath
    mkdirSync(dir, { recursive: true });
    mkdirSync(trash, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const writeSession = (sid, rows, ageDays) => {
    const p = join(dir, `${sid}.jsonl`);
    writeFileSync(p, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    if (ageDays != null) {
      const t = (Date.now() - ageDays * 86400_000) / 1000;
      utimesSync(p, t, t);
    }
    return p;
  };

  test("只清 tg-* fork + 无 ai-title + 超期;保留 recent/有标题/非fork/keepIds", () => {
    writeSession("aaa11111", [{ type: "custom-title", customTitle: "tg-turn-xxx-1" }, { type: "user", message: { content: "hi" } }], 5); // 老 fork → 清
    writeSession("bbb22222", [{ type: "custom-title", customTitle: "tg-turn-yyy-2" }], 0);                                              // 近期 → 留
    writeSession("ccc33333", [{ type: "custom-title", customTitle: "tg-turn-zzz-3" }, { type: "ai-title", title: "修复某问题" }], 5);   // 有标题 → 留
    writeSession("ddd44444", [{ type: "custom-title", customTitle: "我的终端会话" }], 5);                                              // 非 fork → 留
    writeSession("eee55555", [{ type: "custom-title", customTitle: "tg-chat-www-5" }], 5);                                            // keepIds → 留(早期命名也认)

    const r = pruneForkSessions({ cwd, keepDays: 3, projectsBase: base, trashRoot: trash, keepIds: new Set(["eee55555"]), stamp: "test" });
    expect(r.moved).toBe(1);
    expect(existsSync(join(dir, "aaa11111.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "bbb22222.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "ccc33333.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "ddd44444.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "eee55555.jsonl"))).toBe(true);
    expect(existsSync(join(trash, "tg-fork-prune-test", "aaa11111.jsonl"))).toBe(true); // 挪到 Trash(可回收)
  });

  test("dry-run 只报告不动文件", () => {
    writeSession("aaa11111", [{ type: "custom-title", customTitle: "tg-turn-xxx-1" }], 5);
    const r = pruneForkSessions({ cwd, keepDays: 3, projectsBase: base, trashRoot: trash, dryRun: true, stamp: "test" });
    expect(r.moved).toBe(1);
    expect(existsSync(join(dir, "aaa11111.jsonl"))).toBe(true);
  });

  test("agentName(非 customTitle)也能识别 fork", () => {
    writeSession("aaa11111", [{ type: "agent-name", agentName: "tg-turn-xxx-1" }], 5);
    const r = pruneForkSessions({ cwd, keepDays: 3, projectsBase: base, trashRoot: trash, stamp: "test" });
    expect(r.moved).toBe(1);
  });
});
