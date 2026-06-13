// adapters/daemon-client.js
// CC daemon 控制 socket 客户端 —— 给常驻 `--bg` worker 发 authed op:reply(把一轮新输入喂进同一会话,不 fork)。
//
// 背景:CC 2.1.168 给 daemon control socket 加了 control key 校验,旧的裸 op:reply 被拒(EAUTH)。
// 2026-06-14 从 2.1.177 native binary 的内嵌 strings 挖出协议 + spike 实测确认:
//   发 {proto:1, op:"reply", short:<workerShort>, text:<msg>, auth:<control.key 原文 trim>}\n,读一行 JSON 回执。
//   auth = ~/.claude/daemon/control.key 文件原文 trim(32 字节,无 hash;官方客户端 Y1H() 即 readFile(control.key).trim())。
//   回执 code:ok / EAUTH(key 不对/没带,重读 key 再试)/ ENOJOB(worker 没了)/ ENOREPLY(worker 非交互态,重试)/
//   ESTARTING(daemon 启动中,重试)。reply/kill/dispatch 要 auth;list/ping 不要。
// 与 fork-pool(cli-pool.js)的本质区别:那边每轮 `--bg --resume` fork 新 sessionId = 垃圾;这边一个常驻 worker
//   多轮 op:reply 进同一 session = 零 fork,且 worker 带 PTY → 可被 app/手机 remote control 接管。

import net from "node:net";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DAEMON_PROTO = 1;
const ROSTER_PATH = join(homedir(), ".claude/daemon/roster.json");
const KEY_PATH = join(homedir(), ".claude/daemon/control.key");

export function readRoster() {
  if (!existsSync(ROSTER_PATH)) return null;
  try { return JSON.parse(readFileSync(ROSTER_PATH, "utf8")); }
  catch { return null; }
}

// control.sock 不在 roster 里显式存,但和 worker 的 rendezvousSock 同目录:
//   /tmp/cc-daemon-501/<rand>/rv/<short>.sock → /tmp/cc-daemon-501/<rand>/control.sock
export function findControlSockPath(roster = readRoster()) {
  const w = Object.values(roster?.workers || {}).find(w => w?.rendezvousSock);
  return w ? w.rendezvousSock.replace(/\/rv\/[^/]+$/, "/control.sock") : null;
}

// 读 control key(原文 trim)。每次现读 —— key 会轮换(daemon 重启会重生成),不缓存,EAUTH 时也靠现读拿到新值。
export function readControlKey() {
  try {
    const s = statSync(KEY_PATH);
    if (!s.isFile() || s.size > 4096) return undefined;
    return readFileSync(KEY_PATH, "utf8").trim() || undefined;
  } catch { return undefined; }
}

// claude 内部 cwd 编码:非字母数字 → '-'
function encodeCwdPath(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, "-"); }
export function sessionJsonlPath(sessionId, cwd) {
  return join(homedir(), ".claude/projects", encodeCwdPath(cwd), `${sessionId}.jsonl`);
}

// 按 sessionId 在 roster 里找【活着的】worker(常驻模型的核心:sessionId → 活 worker short → op:reply 进去)。
// 找到返回 { short, sessionId, cwd, jsonlPath, hasPty };找不到(worker 已被 daemon idle 回收 / bridge 重启后)返回 null。
export function findLiveWorkerBySession(sessionId, roster = readRoster()) {
  if (!sessionId) return null;
  for (const [short, w] of Object.entries(roster?.workers || {})) {
    if (w?.sessionId === sessionId) {
      const cwd = w.cwd || homedir();
      return { short, sessionId, cwd, jsonlPath: sessionJsonlPath(sessionId, cwd), hasPty: !!w.ptySock };
    }
  }
  return null;
}

export class DaemonClient {
  constructor(sockPath = findControlSockPath()) {
    this.sockPath = sockPath;
  }

  // 单次 RPC:连 control.sock,写一行 JSON,读一行 JSON 回执。
  _request(payload, timeoutMs = 8000) {
    const sockPath = this.sockPath || findControlSockPath();
    return new Promise((resolve, reject) => {
      if (!sockPath) { reject(new Error("no daemon control.sock (no live workers in roster?)")); return; }
      const sock = net.createConnection(sockPath);
      let buf = "";
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`daemon rpc timeout: op=${payload.op}`)); }, timeoutMs);
      sock.on("connect", () => sock.write(JSON.stringify({ proto: DAEMON_PROTO, ...payload }) + "\n"));
      sock.on("data", chunk => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer); sock.destroy();
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      });
      sock.on("error", err => { clearTimeout(timer); reject(err); });
    });
  }

  ping() { return this._request({ op: "ping" }); }
  list() { return this._request({ op: "list" }); }

  // 把 text 作为新一轮输入喂进 short 对应的常驻 worker(同会话,不 fork)。
  // 内置重试(对齐官方客户端):EAUTH→重读 key 再试一次;ESTARTING/ENOREPLY→worker 还没就绪,退避重试。
  async reply(short, text, { retries = 10, retryDelayMs = 250 } = {}) {
    let key = readControlKey();
    for (let attempt = 0; ; attempt++) {
      const ack = await this._request({ op: "reply", short, text, auth: key }, 12000);
      if (ack.ok) return ack;
      if (ack.code === "EAUTH") {
        const fresh = readControlKey();           // key 可能轮换了,重读一次
        if (fresh && fresh !== key) { key = fresh; continue; }
        return ack;                                // key 没变还是 EAUTH → 真不对,上抛
      }
      if ((ack.code === "ESTARTING" || ack.code === "ENOREPLY") && attempt < retries) {
        await new Promise(r => setTimeout(r, retryDelayMs));
        continue;
      }
      return ack;                                  // ENOJOB 等 → 让上层决定(多半要新建 worker)
    }
  }

  // 停掉 worker(同样要 auth)。/new 或确认卡死时用。
  kill(short, signal = "SIGTERM") {
    return this._request({ op: "kill", short, signal, auth: readControlKey() });
  }
}

export function createDaemonClient(sockPath) { return new DaemonClient(sockPath); }
