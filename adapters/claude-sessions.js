// 共享 session 元数据：扫 ~/.claude/projects/*.jsonl 读 cwd/topic/mtime。
// 阶段1 从 claude.js 复制（运行时隔离，不动 claude.js）；阶段2 再让两边 DRY。
import { readdirSync, statSync, createReadStream } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const BRIDGE_HINT_RE = /^\[系统提示:.*?\]\s*/s;
const FILE_TAG_RE = /\n?\[(?:图片文件|文件):.*$/s;

export function cleanUserTopic(raw) {
  if (!raw || raw.startsWith("[Request interrupted")) return "";
  return raw.replace(BRIDGE_HINT_RE, "").replace(FILE_TAG_RE, "").trim();
}

export function extractUserText(content) {
  if (Array.isArray(content)) {
    const txt = content.find(c => typeof c === "object" && c.type === "text");
    return txt?.text || "";
  }
  return typeof content === "string" ? content : "";
}

export function listSessionFiles(limit = 10) {
  const projectsDir = join(homedir(), ".claude", "projects");
  const allFiles = [];
  try {
    const dirs = readdirSync(projectsDir).filter(d => {
      try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const fullDir = join(projectsDir, dir);
      try {
        const files = readdirSync(fullDir)
          .filter(f => f.endsWith(".jsonl"))
          .map(f => {
            const fp = join(fullDir, f);
            const stat = statSync(fp);
            return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, sessionId: f.replace(".jsonl", "") };
          });
        allFiles.push(...files);
      } catch { /* skip */ }
    }
  } catch { return []; }
  allFiles.sort((a, b) => b.mtime - a.mtime);
  return allFiles.slice(0, limit);
}

export function findSessionFile(sessionId) {
  const projectsDir = join(homedir(), ".claude", "projects");
  try {
    for (const dir of readdirSync(projectsDir)) {
      const fullDir = join(projectsDir, dir);
      try { if (!statSync(fullDir).isDirectory()) continue; } catch { continue; }
      const match = readdirSync(fullDir).find(f => f === `${sessionId}.jsonl`);
      if (match) {
        const path = join(fullDir, match);
        const stat = statSync(path);
        return { file: match, path, mtime: stat.mtimeMs, size: stat.size, sessionId };
      }
    }
  } catch { return null; }
  return null;
}

// 三态查找(2026-07-17 codex review P1):findSessionFile 把"扫描失败"吞成 null,调用方无法与
// "确认不存在"区分——幽灵判定/写回防护误把瞬时 IO 失败当"文件不存在",会丢上下文/丢会话映射。
// 返回 { found: fileInfo|null, scanFailed: boolean }:
//   - found 非空 → 确证存在(即使途中有目录读失败,找到即为准);
//   - found 空 + scanFailed=false → 全部目录扫完确无此文件(可放心判幽灵);
//   - found 空 + scanFailed=true  → 结果不可信(顶层/某子目录读失败,文件可能就在那),调用方按"存在"兜底。
export function probeSessionFile(sessionId) {
  const projectsDir = join(homedir(), ".claude", "projects");
  const target = `${sessionId}.jsonl`;
  let scanFailed = false;
  let dirs;
  // ENOENT(projects 目录不存在)= 这台机从没写过会话,任何 sid 都确认不存在,不算扫描失败;
  // EACCES/EIO 等才是"结果不可信"。子目录同理:列出后被删(ENOENT race)当"该目录无文件"。
  try { dirs = readdirSync(projectsDir); } catch (e) { return { found: null, scanFailed: e?.code !== "ENOENT" }; }
  for (const dir of dirs) {
    const fullDir = join(projectsDir, dir);
    try {
      if (!statSync(fullDir).isDirectory()) continue;
      if (readdirSync(fullDir).includes(target)) {
        const path = join(fullDir, target);
        const stat = statSync(path);
        return { found: { file: target, path, mtime: stat.mtimeMs, size: stat.size, sessionId }, scanFailed: false };
      }
    } catch (e) { if (e?.code !== "ENOENT") scanFailed = true; }
  }
  return { found: null, scanFailed };
}

// 全量查找(2026-07-17 codex review P2):cwd/worktree 迁移可能"复制留旧"——同一 sessionId 的 jsonl
// 多目录共存,first-match(findSessionFile)会一直撞旧文件。重定位要收集全部候选,由调用方按 mtime 择新。
export function findAllSessionFiles(sessionId) {
  const projectsDir = join(homedir(), ".claude", "projects");
  const target = `${sessionId}.jsonl`;
  const out = [];
  try {
    for (const dir of readdirSync(projectsDir)) {
      const fullDir = join(projectsDir, dir);
      try {
        if (!statSync(fullDir).isDirectory()) continue;
        if (readdirSync(fullDir).includes(target)) {
          const path = join(fullDir, target);
          const stat = statSync(path);
          out.push({ file: target, path, mtime: stat.mtimeMs, size: stat.size, sessionId });
        }
      } catch { /* skip unreadable dir */ }
    }
  } catch { /* projects 不可读 → 空列表,调用方不动 */ }
  return out;
}

export async function parseSessionFile(fileInfo, fallbackCwd) {
  let firstTopic = "", lastTopic = "", resolvedCwd = "";
  try {
    const stream = createReadStream(fileInfo.path, { encoding: "utf8" });
    const rl = createInterface({ input: stream });
    for await (const line of rl) {
      try {
        const d = JSON.parse(line);
        if (!resolvedCwd && typeof d.cwd === "string" && d.cwd) resolvedCwd = d.cwd;
        if (d.message?.role === "user") {
          const cleaned = cleanUserTopic(extractUserText(d.message.content));
          if (cleaned) {
            if (!firstTopic) firstTopic = cleaned.slice(0, 80);
            lastTopic = cleaned.slice(0, 80);
          }
        }
      } catch { /* skip */ }
    }
    rl.close(); stream.destroy();
  } catch { /* skip */ }
  const finalCwd = resolvedCwd || fallbackCwd;
  return {
    session_id: fileInfo.sessionId,
    display_name: lastTopic || firstTopic || "(空)",
    last_active: fileInfo.mtime,
    backend: "claude",
    cwd: finalCwd,
    project_name: basename(finalCwd) || finalCwd,
    session_source: "CLI",
  };
}
