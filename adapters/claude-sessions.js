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
