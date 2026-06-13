#!/usr/bin/env node
// prune-fork-sessions.mjs — 清理 pool 引擎 fork-per-turn 留下的"中间会话"副产物。
//
// 背景:pool 引擎每轮 `claude --bg --resume` fork 一个新会话(custom-title = worker 名
//   tg-turn-* / 早期 tg-chat-* / tg-new-*),新会话继承前一个全部内容 → 旧 fork 冗余。
//   这些会堆在 ~/.claude/projects/<cwd>/ 里、撑长 claude app 的会话列表(Alice 2026-06-13 反馈)。
//
// 安全规则(只挪不删、可从 Trash 找回):一个 jsonl 被清,当且仅当
//   ① custom-title 是 worker 名(^tg-(turn|chat|new)-)——bridge fork 副产物;
//   ② 没有 ai-title 行(说明 app 里显示的就是 "tg-*" 那串、是 Alice 说的 clutter;
//      有 AI 标题的是有内容的正经会话,即使底层也是 fork,也保留);
//   ③ mtime 超过 keepDays(默认 3)天——近期/当前会话天然排除(活跃 bot 的当前会话 mtime 都很新);
//   ④ 不在 keepIds(各 bot DB 的当前 session 指针)里——双保险,防长期 idle bot 的当前会话被误清。
// 非 fork 会话(AI 标题的工作会话 / 终端会话 / 别的 CC 实例)一律不碰。
//
// 用法:
//   node scripts/prune-fork-sessions.mjs --dry-run            # 只报告,不动
//   node scripts/prune-fork-sessions.mjs                      # 执行(挪到 ~/.Trash/tg-fork-prune-<date>/)
//   node scripts/prune-fork-sessions.mjs --keep-days 3
// 也可被 bridge.js 启动清理 import { pruneForkSessions } 调用(带 12h marker 防频繁重跑)。

import { readdirSync, statSync, openSync, readSync, closeSync, renameSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const FORK_TITLE_RE = /"(?:customTitle|agentName)":\s*"tg-(?:turn|chat|new)-/;
const AI_TITLE_RE = /"type":\s*"ai-title"/;
const HEAD_BYTES = 16384; // custom-title / ai-title 都是会话起始的元数据行,读头部 16KB 足够判定

function encodeCwdPath(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

// 读文件头部判定是否"无 AI 标题的 bridge fork 副产物"
function isPrunableFork(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("utf8");
    return FORK_TITLE_RE.test(head) && !AI_TITLE_RE.test(head);
  } catch {
    return false; // 读不动就别碰
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

export function pruneForkSessions({
  cwd = homedir(),
  keepDays = 3,
  keepIds = new Set(),
  dryRun = false,
  projectsBase = join(homedir(), ".claude/projects"),
  trashRoot = join(homedir(), ".Trash"),
  stamp = "manual",
  logger = console,
} = {}) {
  const dir = join(projectsBase, encodeCwdPath(cwd));
  if (!existsSync(dir)) return { scanned: 0, moved: 0, bytes: 0, dir };
  const cutoff = Date.now() - keepDays * 86400_000;
  const trashDir = join(trashRoot, `tg-fork-prune-${stamp}`);
  let scanned = 0, moved = 0, bytes = 0;
  const sample = [];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    scanned++;
    const sid = name.slice(0, -6);
    if (keepIds.has(sid)) continue;                 // ④ 当前 session 不碰
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.mtimeMs > cutoff) continue;              // ③ 近期不碰
    if (!isPrunableFork(path)) continue;            // ①② 只清无标题的 tg-* fork
    bytes += st.size;
    if (sample.length < 5) sample.push(`${sid.slice(0, 8)} (${(st.size / 1024).toFixed(0)}KB, ${Math.round((Date.now() - st.mtimeMs) / 86400_000)}d)`);
    if (dryRun) { moved++; continue; }
    try {
      if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
      renameSync(path, join(trashDir, name));
      moved++;
    } catch (e) {
      logger.warn(`[prune-fork] 挪 ${name} 失败: ${e.message}`);
    }
  }
  const mb = (bytes / 1024 / 1024).toFixed(1);
  logger.log(`[prune-fork] ${dryRun ? "DRY-RUN " : ""}扫 ${scanned} 个 jsonl,${dryRun ? "命中" : "挪走"} ${moved} 个 tg-* fork(>${keepDays}天、无标题),${mb}MB${moved ? ` → ${dryRun ? "(将挪到)" : ""}${trashDir}` : ""}`);
  if (sample.length) logger.log(`[prune-fork] 样本: ${sample.join(" / ")}`);
  return { scanned, moved, bytes, dir, trashDir };
}

// CLI 入口
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const kdIdx = args.indexOf("--keep-days");
  const keepDays = kdIdx >= 0 ? Number(args[kdIdx + 1]) : 3;
  const cwd = process.env.CC_CWD || homedir();
  // stamp 用日期(脚本里不能用 new Date()? CLI 可以,这是普通脚本不是 workflow)
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  pruneForkSessions({ cwd, keepDays, dryRun, stamp });
}
