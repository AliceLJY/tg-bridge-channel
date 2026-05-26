// adapters/cli-pool.js
// claude --bg daemon control pool — 替代 channel one-shot 引擎
//
// 协议参考:claude --bg 暴露的 daemon background sessions(同 Agent View peek panel 走的同一条接口)
// - daemon control socket:plain JSON line + proto:1
// - reply {short,text} → 给 bg session 发消息
// - jsonl 路径 ~/.claude/projects/<encoded-cwd>/<sid>.jsonl,含完整结构化 turn
//
// Codex review (DONE_WITH_CONCERNS) 关键 catch 落地:
// - 协议契约尚未冻结 → 启动 ping/list 探活 + 版本 allowlist + fallbackAdapter 兜底
// - 同 chat 必须串行 → BgSession.busy 锁,并发 reply 直接 throw
// - jsonl 归属 → resetToCurrentEnd 记 byte offset + expectUserText 匹配 user echo + turn_duration 结束
// - LRU 只驱逐 idle → busy session 跳过,active turn 必须先 abort
// - jsonl 轮转/截断 → tail reader 检测 size < offset 时重置

import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ============ 常量 ============
const DAEMON_PROTO = 1;
// 实测兼容的 cli 版本(canary allowlist)。新版本启动时不在列表 → fallback 到旧 adapter,避免协议漂移把 bridge 拖崩
const COMPATIBLE_CLI_VERSIONS = (process.env.CLI_POOL_VERSION_ALLOWLIST || "2.1.150").split(",").map(s => s.trim());
const ROSTER_PATH = join(homedir(), ".claude/daemon/roster.json");
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");
// 每个 bot 独立 store(防止多 bot 同进程不同 PID 互相覆盖 chat-sessions.json)
// 从 process.argv 抓 --config config-<name>.json 里的 <name> 作为 bot id
function detectBotId() {
  if (process.env.CLI_POOL_BOT_ID) return process.env.CLI_POOL_BOT_ID;
  const args = (process.argv || []).join(" ");
  const m = args.match(/config-?([\w-]+)\.json/);
  return m ? m[1] : "default";
}
const SESSIONS_STORE = process.env.CLI_POOL_STORE || join(homedir(), `.tg-bridge/chat-sessions-${detectBotId()}.json`);
const TURN_END_SUBTYPE = "turn_duration";

// ============ utils ============
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// claude 内部 cwd encoding:非字母数字字符 → `-`
function encodeCwdPath(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function sessionJsonlPath(sessionId, cwd) {
  return join(homedir(), ".claude/projects", encodeCwdPath(cwd), `${sessionId}.jsonl`);
}

// ============ Roster / socket 发现 ============
export function readRoster() {
  if (!existsSync(ROSTER_PATH)) return null;
  try { return JSON.parse(readFileSync(ROSTER_PATH, "utf8")); }
  catch { return null; }
}

// roster.json 不显式存 control.sock 路径,但 workers[*].rendezvousSock 同目录
// /tmp/cc-daemon-501/<rand>/rv/<short>.sock → /tmp/cc-daemon-501/<rand>/control.sock
export function findControlSockPath() {
  const roster = readRoster();
  if (!roster) return null;
  const anyWorker = Object.values(roster.workers || {})[0];
  if (!anyWorker?.rendezvousSock) return null;
  return anyWorker.rendezvousSock.replace(/\/rv\/[^/]+$/, "/control.sock");
}

// ============ Daemon RPC client ============
export class DaemonClient {
  constructor(controlSockPath) {
    this.sockPath = controlSockPath;
  }

  async _request(payload, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.sockPath);
      let buf = "";
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`daemon rpc timeout: op=${payload.op}`)); }, timeoutMs);
      sock.on("connect", () => {
        sock.write(JSON.stringify({ proto: DAEMON_PROTO, ...payload }) + "\n");
      });
      sock.on("data", chunk => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        sock.destroy();
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
      });
      sock.on("error", err => { clearTimeout(timer); reject(err); });
    });
  }

  ping()             { return this._request({ op: "ping" }); }
  list()             { return this._request({ op: "list" }); }
  reply(short, text) { return this._request({ op: "reply", short, text }, 10000); }
  kill(short)        { return this._request({ op: "kill", short }); }
}

// ============ jsonl tail reader ============
// 用 byte offset 增量读 jsonl,yield 结构化事件。
// 关键边界:
//   - expectUserText 用于过滤别人(peek panel / 第二 bridge)注入的 user echo
//   - 只有看见自己的 echo 后才认 assistant block 归属本 turn
//   - turn_duration 标 turn 结束才退出
//   - size < offset 视为 jsonl 截断/轮转,重置 offset
export class JsonlTailReader {
  constructor(jsonlPath) {
    this.path = jsonlPath;
    this.offset = 0;
  }

  resetToCurrentEnd() {
    this.offset = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  async _readNewLines() {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) { this.offset = 0; }  // 轮转/截断
    if (size <= this.offset) return [];
    return new Promise((resolve, reject) => {
      const lines = [];
      const stream = createReadStream(this.path, { encoding: "utf8", start: this.offset, end: size - 1 });
      const rl = createInterface({ input: stream });
      rl.on("line", line => { if (line.trim()) lines.push(line); });
      rl.on("close", () => { this.offset = size; resolve(lines); });
      rl.on("error", reject);
    });
  }

  async* readUntilTurnEnd({ expectUserText, timeoutMs = 120000, pollMs = 200, abortSignal } = {}) {
    const deadline = Date.now() + timeoutMs;
    let userEchoSeen = !expectUserText;  // 没提供 expectUserText 时跳过归属检查
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) throw new Error("aborted");
      const lines = await this._readNewLines();
      for (const line of lines) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        const t = d.type;
        if (t === "user") {
          const c = d.message?.content;
          const text = typeof c === "string" ? c : null;
          if (expectUserText && text === expectUserText) {
            userEchoSeen = true;
            yield { type: "user_echo", text };
          } else if (!expectUserText) {
            yield { type: "user_echo", text };
          }
          // 不匹配的 user(别人 peek 注入)忽略,不影响归属
        } else if (t === "assistant" && userEchoSeen) {
          const c = d.message?.content;
          if (Array.isArray(c)) {
            for (const block of c) {
              if (block.type === "text")     yield { type: "text", text: block.text || "" };
              else if (block.type === "thinking") yield { type: "thinking", text: block.thinking || "" };
              else if (block.type === "tool_use") yield { type: "tool_use", name: block.name, input: block.input, id: block.id };
            }
          }
        } else if (t === "system" && d.subtype === TURN_END_SUBTYPE && userEchoSeen) {
          yield { type: "turn_end", durationMs: d.durationMs };
          return;
        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`jsonl tail timeout (${timeoutMs}ms)`);
  }
}

// ============ BgSession ============
// 一个 chat 对应一个 BgSession。busy 锁防同 session 并发 reply。
export class BgSession {
  constructor({ short, sessionId, cwd, jsonlPath, name, model, effort }) {
    Object.assign(this, { short, sessionId, cwd, jsonlPath, name, model, effort });
    this.lastUsed = Date.now();
    this.busy = false;
    this.tailReader = new JsonlTailReader(jsonlPath);
  }

  async* sendAndStream(text, daemon, opts = {}) {
    if (this.busy) throw new Error(`session ${this.short} busy — bridge 层应排队,不应并发 reply 同 chat`);
    this.busy = true;
    try {
      // Race fix:worker spawn 完到真正 ready 接受 prompt 有秒级窗口。
      // 群聊多 bot 同时 spawn 时,先 reply 会丢失。poll daemon.list 看 detail 含 "agent ready"。
      await this._waitForReady(daemon, opts.readyTimeoutMs || 120000);
      this.tailReader.resetToCurrentEnd();
      const ack = await daemon.reply(this.short, text);
      if (!ack.ok) throw new Error(`reply failed: ${ack.error || "unknown"}`);

      // Fail-open 兜底:如果 5s 没 jsonl 写入,worker 可能还没 ready 接到 reply → 重发一次
      const tickStart = Date.now();
      let retried = false;
      yield* this._tailWithReplyRetry(daemon, text, opts, tickStart, retried);
    } finally {
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }

  async* _tailWithReplyRetry(daemon, text, opts, tickStart, retried) {
    // 内部包一层:期间监测 jsonl 是否在 5s 内有写入,没有就重发 reply 一次
    const retryAfterMs = 5000;
    const reader = this.tailReader;
    let retryTimer = null;
    if (!retried) {
      retryTimer = setTimeout(async () => {
        // 5s 后检查 jsonl size(turn 开始通常 1s 内有 user echo 写入)
        try {
          const sz = existsSync(reader.path) ? statSync(reader.path).size : 0;
          if (sz <= reader.offset) {
            console.warn(`[BgSession] no jsonl growth in ${retryAfterMs}ms for ${this.short}, re-sending reply`);
            await daemon.reply(this.short, text).catch(() => {});
          }
        } catch {}
      }, retryAfterMs);
      retryTimer.unref?.();
    }
    try {
      yield* reader.readUntilTurnEnd({
        expectUserText: text,
        abortSignal: opts.abortSignal,
        timeoutMs: opts.timeoutMs || 120000,
      });
    } finally {
      if (retryTimer) clearTimeout(retryTimer);
    }
  }

  async _waitForReady(daemon, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const list = await daemon.list();
        const job = list.jobs?.find(j => j.short === this.short);
        if (!job) throw new Error(`worker ${this.short} disappeared from daemon list`);
        // detail "agent ready; awaiting task instructions" = worker 完成 init 可接 reply
        // "(idle — send a prompt to start)" 是 launched 但还在 init 的中间态
        if (job.detail && job.detail.includes("agent ready")) return;
      } catch (e) {
        // 暂时性错误,继续 poll
      }
      await new Promise(r => setTimeout(r, 300));
    }
    // 超时则继续往下走 reply(可能仍然能 work,fail-open)
    console.warn(`[BgSession] _waitForReady timeout for ${this.short}, proceeding anyway`);
  }

  // 现阶段 abort = kill worker。上层 ensureSession 会用 --resume 重起带历史。
  // TODO: 调研有没有更优雅的"中断当前 turn 但保 worker"接口(op:kill 可能粒度过粗)
  async abort(daemon) {
    await daemon.kill(this.short).catch(() => {});
    this.busy = false;
  }
}

// ============ CliPool ============
export class CliPool {
  constructor(config = {}) {
    this.config = {
      model: config.model || process.env.CC_MODEL || "claude-opus-4-7",
      effort: config.effort || process.env.DEFAULT_EFFORT || "max",
      permissionMode: config.permissionMode || "bypassPermissions",
      cwd: config.cwd || process.env.HOME,
      maxSessions: config.maxSessions || 8,
      idleEvictMs: config.idleEvictMs || 30 * 60 * 1000,
      fallbackAdapter: config.fallbackAdapter || null,  // 灰度兜底:旧 channel 或 SDK adapter
    };
    this.sessions = new Map();     // chatId -> BgSession
    this.persisted = new Map();    // chatId -> { short, sessionId, cwd, name }
    this.daemon = null;
    this.ready = false;             // daemon 在 + 版本兼容
    this.fallbackTriggered = false; // 版本不兼容,显式走 fallback adapter
    this.daemonVersion = null;
  }

  // start 不强求 daemon 已在 — daemon 可能首次 ensureSession 时被 claude --bg 触发起来。
  // 把"daemon 在 + 版本兼容"叫做 ready;"daemon 版本不兼容"才叫 fallbackTriggered(走 legacy)。
  // "daemon 没起"是中间态,等 ensureSession 内 spawn 后 lazy 重试。
  async start() {
    this.loadPersisted();
    await this._tryProbe({ silentIfMissing: true });
  }

  async _tryProbe({ silentIfMissing = false } = {}) {
    const sockPath = findControlSockPath();
    if (!sockPath) {
      if (!silentIfMissing) console.warn("[cli-pool] no daemon control.sock found");
      this.ready = false;
      this.daemon = null;
      return;
    }
    this.daemon = new DaemonClient(sockPath);
    try {
      const ping = await this.daemon.ping();
      if (!ping.ok) throw new Error(`ping not ok: ${JSON.stringify(ping)}`);
      this.daemonVersion = ping.version;
      if (!COMPATIBLE_CLI_VERSIONS.includes(this.daemonVersion)) {
        console.warn(`[cli-pool] daemon v${this.daemonVersion} not in allowlist ${COMPATIBLE_CLI_VERSIONS.join(",")} — will fallback`);
        this.fallbackTriggered = true;
        this.ready = false;
        return;
      }
      await this.daemon.list();
      this.ready = true;
      this.fallbackTriggered = false;
      console.log(`[cli-pool] ready, daemon v${this.daemonVersion}`);
    } catch (e) {
      // ping 失败:daemon 在但临时挂,不算 fallback,下次再试
      console.warn(`[cli-pool] probe err: ${e.message} (will retry on demand)`);
      this.ready = false;
    }
  }

  // ============ persistence ============
  loadPersisted() {
    if (!existsSync(SESSIONS_STORE)) return;
    try {
      const data = JSON.parse(readFileSync(SESSIONS_STORE, "utf8"));
      for (const [chatId, info] of Object.entries(data)) this.persisted.set(chatId, info);
    } catch (e) {
      console.error(`[cli-pool] loadPersisted err: ${e.message}`);
    }
  }

  savePersisted() {
    ensureDir(SESSIONS_STORE);
    writeFileSync(SESSIONS_STORE, JSON.stringify(Object.fromEntries(this.persisted), null, 2));
  }

  // ============ spawn bg session ============
  // 用 claude --bg 起 worker,从 stdout 抓 short,从 roster.json 拿 sessionId
  async _spawnBgSession(chatId, { resumeSessionId } = {}) {
    const name = `tg-chat-${String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const args = [
      "--bg",
      "--name", name,
      "--model", this.config.model,
      "--effort", this.config.effort,
      "--permission-mode", this.config.permissionMode,
    ];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push("");  // 空 prompt:session 起来 idle,等 op:reply 触发首 turn

    return new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_CLI_PATH, args, {
        cwd: this.config.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdoutBuf = "", stderrBuf = "";
      child.stdout.on("data", c => stdoutBuf += c);
      child.stderr.on("data", c => stderrBuf += c);
      const timer = setTimeout(() => { child.kill(); reject(new Error("spawn timeout (30s)")); }, 30000);

      child.on("exit", async () => {
        clearTimeout(timer);
        const m = stdoutBuf.match(/backgrounded\s+·\s+([a-f0-9]{8})/);
        if (!m) {
          reject(new Error(`no short id in stdout: ${stdoutBuf.slice(0,200)}; stderr: ${stderrBuf.slice(0,200)}`));
          return;
        }
        const short = m[1];
        // 等 roster 同步 sessionId(daemon 写 roster 是异步的)
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 250));
          const w = readRoster()?.workers?.[short];
          if (w?.sessionId) {
            resolve(new BgSession({
              short,
              sessionId: w.sessionId,
              cwd: w.cwd,
              jsonlPath: sessionJsonlPath(w.sessionId, w.cwd),
              name, model: this.config.model, effort: this.config.effort,
            }));
            return;
          }
        }
        reject(new Error(`roster did not surface sessionId for short ${short}`));
      });
    });
  }

  // ============ ensureSession ============
  // 优先级:in-memory pool > persisted + daemon list > persisted + --resume 重起 > 全新 session
  // 内部如果 daemon 没起,会 spawn 触发(claude --bg 自身就是 daemon trigger),然后 lazy probe
  async ensureSession(chatId) {
    if (this.sessions.has(chatId)) return this.sessions.get(chatId);
    if (this.fallbackTriggered) throw new Error("cli-pool fallback triggered, ensureSession unavailable");

    const info = this.persisted.get(chatId);
    if (info && this.ready) {
      // 看 daemon 里 short 还活吗
      try {
        const list = await this.daemon.list();
        const job = list.jobs?.find(j => j.short === info.short);
        if (job) {
          const session = new BgSession({
            short: info.short,
            sessionId: info.sessionId,
            cwd: info.cwd,
            jsonlPath: sessionJsonlPath(info.sessionId, info.cwd),
            name: info.name,
            model: this.config.model,
            effort: this.config.effort,
          });
          this.sessions.set(chatId, session);
          this._evictIfNeeded();
          return session;
        }
      } catch (e) {
        console.warn(`[cli-pool] daemon list check err for chat ${chatId}: ${e.message}`);
      }
      // short 已 gone(daemon 1h 空闲 stop 了),用 sessionId --resume 重起
      try {
        const session = await this._spawnBgSession(chatId, { resumeSessionId: info.sessionId });
        this._updatePersisted(chatId, session);
        this.sessions.set(chatId, session);
        this._evictIfNeeded();
        return session;
      } catch (e) {
        console.warn(`[cli-pool] resume for chat ${chatId} failed (${e.message}), falling back to new session`);
      }
    }

    // 完全新 session(spawn 同时触发 daemon 启动如果没起)
    const session = await this._spawnBgSession(chatId, { resumeSessionId: info?.sessionId });
    // spawn 之后 daemon 必在,重 probe 拿到 daemon client + version 校验
    if (!this.ready) {
      await this._tryProbe({ silentIfMissing: false });
      if (this.fallbackTriggered) throw new Error("daemon version mismatch after spawn");
      if (!this.ready) throw new Error("daemon still not ready after spawning bg session");
    }
    this._updatePersisted(chatId, session);
    this.sessions.set(chatId, session);
    this._evictIfNeeded();
    return session;
  }

  _updatePersisted(chatId, session) {
    this.persisted.set(chatId, {
      short: session.short,
      sessionId: session.sessionId,
      cwd: session.cwd,
      name: session.name,
    });
    this.savePersisted();
  }

  // 只驱逐 idle session;active turn 不动(Codex 反馈)
  _evictIfNeeded() {
    if (this.sessions.size <= this.config.maxSessions) return;
    const candidates = [...this.sessions.entries()]
      .filter(([_, s]) => !s.busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    if (!candidates.length) return;
    const [chatId, session] = candidates[0];
    this.daemon.kill(session.short).catch(() => {});
    this.sessions.delete(chatId);
    // persisted 保留 sessionId,下次 sendAndStream 时 --resume 拉回历史
    console.log(`[cli-pool] evicted short=${session.short} chat=${chatId}`);
  }

  // ============ 主入口 ============
  async* sendAndStream(chatId, text, opts = {}) {
    if (this.fallbackTriggered) {
      if (this.config.fallbackAdapter) {
        yield* this.config.fallbackAdapter.streamQuery(text, null, opts.abortSignal, opts);
        return;
      }
      throw new Error("cli-pool fallback triggered (version mismatch) and no fallback configured");
    }
    // daemon 没起也走 ensureSession,内部会 spawn 触发 daemon + lazy probe
    const session = await this.ensureSession(chatId);
    yield* session.sendAndStream(text, this.daemon, opts);
  }

  async abort(chatId) {
    const session = this.sessions.get(chatId);
    if (session) await session.abort(this.daemon);
    this.sessions.delete(chatId);
    // persisted 保留 sessionId,下次重起
  }

  // adapter wrapper 用:首次没 sessionId 时起新 session,返回真 sessionId
  // pool 内部用真 sessionId 作为 key 持久化
  async newSession(opts = {}) {
    if (this.fallbackTriggered) throw new Error("cli-pool fallback triggered");
    const tempName = `tg-new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
    const session = await this._spawnBgSession(tempName, opts);
    if (!this.ready) {
      await this._tryProbe({ silentIfMissing: false });
      if (this.fallbackTriggered) throw new Error("daemon version mismatch after spawn");
      if (!this.ready) throw new Error("daemon still not ready after spawning bg session");
    }
    // 用真 sessionId 当 key,bridge 后续传 sessionId 就能定位回来
    this.sessions.set(session.sessionId, session);
    this.persisted.set(session.sessionId, {
      short: session.short,
      sessionId: session.sessionId,
      cwd: session.cwd,
      name: session.name,
    });
    this.savePersisted();
    this._evictIfNeeded();
    return session;
  }

  async stop() {
    this.savePersisted();
    this.sessions.clear();
    // 不主动 claude stop,daemon 自己空闲 1h 收 worker;bridge 重启时 ensureSession 会拉回
  }
}

export function createCliPool(config) {
  return new CliPool(config);
}
