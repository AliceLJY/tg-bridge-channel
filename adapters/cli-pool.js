// adapters/cli-pool.js
// claude --bg one-shot fork pool — 替代 channel one-shot 引擎
//
// 2026-06-10 重构(方案 C):CC 2.1.168 给 daemon control socket 加了 control key 校验,
// 旧的「直连 control.sock 发 op:reply」被拒(reply rejected: this client didn't present
// the daemon control key)。改成完全不碰 control socket:每个 turn 用官方 CLI
//   claude --bg [--resume <sid>] "<prompt>"
// spawn 一个带 prompt 的后台 worker(--resume 会 fork 出新 sessionId 并继承全部上下文,
// 2026-06-10 spike 实测续上下文 OK),从新 sessionId 的 jsonl tail 读输出,turn 结束后
// claude stop 清理 worker。
// 优点:全程只用官方 CLI 子命令(--bg / stop),不直连 daemon socket → 不受 control key 影响。
// 代价:fork 模式每 turn 带全历史重 spawn(jsonl 会逐 turn 增大),长对话成本递增;
//   仍走本机订阅登录态(6-15 前不计费;6-15 后 --bg 是否计费见账单实测)。
//
// 保留:JsonlTailReader(turn 归属过滤 + 心跳超时 + 截断重置)完全复用。
// 删除:DaemonClient(reply/list/kill/ping 全直连 control socket)、BgSession(常驻 + reply)、
//   _waitForReady(spawn 带 prompt 不需要等 ready)、findControlSockPath、persistence。

import { spawn } from "node:child_process";
import { readFileSync, statSync, existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ============ 常量 ============
const ROSTER_PATH = join(homedir(), ".claude/daemon/roster.json");
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");
// 安全护栏脚本(PreToolUse hook):bypassPermissions 下硬拦灾难性不可逆命令。
const GUARD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "guard-destructive-bash.sh");
const TURN_END_SUBTYPE = "turn_duration";

// 构造 --settings inline JSON:只注入 PreToolUse/Bash 护栏,不落地文件、不碰用户 settings.json。
function buildGuardSettings() {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "bash " + JSON.stringify(GUARD_SCRIPT) }] },
      ],
    },
  });
}

// ============ utils ============
// claude 内部 cwd encoding:非字母数字字符 → `-`
function encodeCwdPath(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
function sessionJsonlPath(sessionId, cwd) {
  return join(homedir(), ".claude/projects", encodeCwdPath(cwd), `${sessionId}.jsonl`);
}

export function readRoster() {
  if (!existsSync(ROSTER_PATH)) return null;
  try { return JSON.parse(readFileSync(ROSTER_PATH, "utf8")); }
  catch { return null; }
}

// ============ jsonl tail reader(原样保留)============
// 用 byte offset 增量读 jsonl,yield 结构化事件。
//   - expectUserText 过滤掉 fork 继承的历史 user/assistant(只认本 turn 的 user echo 之后)
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
    // 心跳重置语义:timeoutMs 是"jsonl 静默"上限,每收到新行就把 deadline 推后。
    let deadline = Date.now() + timeoutMs;
    let userEchoSeen = !expectUserText;  // 没提供 expectUserText 时跳过归属检查
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) throw new Error("aborted");
      const lines = await this._readNewLines();
      if (lines.length > 0) deadline = Date.now() + timeoutMs;  // 心跳:有新行就续命
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
          // 不匹配的 user(fork 继承的历史 / 别人 peek 注入)忽略,不影响归属
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

// ============ CliPool(方案 C:每 turn fork spawn,不碰 control socket)============
export class CliPool {
  constructor(config = {}) {
    this.config = {
      model: config.model || process.env.CC_MODEL || "opus",
      effort: config.effort || process.env.DEFAULT_EFFORT || "max",
      permissionMode: config.permissionMode || "bypassPermissions",
      cwd: config.cwd || process.env.HOME,
      // 危险命令护栏:默认开,设 config.destructiveGuard=false 或 env CLI_POOL_DESTRUCTIVE_GUARD=0 关闭。
      destructiveGuard: config.destructiveGuard !== false && process.env.CLI_POOL_DESTRUCTIVE_GUARD !== "0",
      spawnTimeoutMs: config.spawnTimeoutMs || 30000,
    };
  }

  // 无常驻 daemon 连接,start/stop 都是空操作(每 turn 自带 spawn)。
  async start() { /* no-op */ }
  async stop() { /* no-op:无常驻 worker,daemon 自己回收 idle */ }

  // 起一个带 prompt 的 --bg worker;有 resumeSessionId 则 fork 续上下文。
  // 返回 { short, sessionId, cwd, jsonlPath }
  async _spawnTurn(text, { resumeSessionId } = {}) {
    const safe = String(resumeSessionId || "new").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
    const name = `tg-turn-${safe}-${Date.now().toString(36)}`;
    const args = [
      "--bg", "--name", name,
      "--model", this.config.model,
      "--effort", this.config.effort,
      "--permission-mode", this.config.permissionMode,
    ];
    if (this.config.destructiveGuard) args.push("--settings", buildGuardSettings());
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push(text);  // 关键:带 prompt spawn,worker 起来即跑首 turn,无需 op:reply

    return new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_CLI_PATH, args, { cwd: this.config.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", c => out += c);
      child.stderr.on("data", c => err += c);
      const timer = setTimeout(() => { child.kill(); reject(new Error("spawn timeout (30s)")); }, this.config.spawnTimeoutMs);
      child.on("error", e => { clearTimeout(timer); reject(e); });
      child.on("exit", async () => {
        clearTimeout(timer);
        const m = out.match(/backgrounded\s+·\s+([a-f0-9]{8})/);
        if (!m) {
          reject(new Error(`no short id in stdout: ${out.slice(0,200)}; stderr: ${err.slice(0,200)}`));
          return;
        }
        const short = m[1];
        // 等 roster 异步同步 fork 出的 sessionId
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 250));
          const w = readRoster()?.workers?.[short];
          if (w?.sessionId) {
            const cwd = w.cwd || this.config.cwd;
            resolve({ short, sessionId: w.sessionId, cwd, jsonlPath: sessionJsonlPath(w.sessionId, cwd) });
            return;
          }
        }
        reject(new Error(`roster did not surface sessionId for short ${short}`));
      });
    });
  }

  // 官方 stop 子命令清理 worker(不碰 control socket)。
  stopWorker(short) {
    return new Promise(resolve => {
      try {
        const c = spawn(CLAUDE_CLI_PATH, ["stop", short], { stdio: "ignore" });
        c.on("exit", () => resolve());
        c.on("error", () => resolve());
        setTimeout(() => { try { c.kill(); } catch {} resolve(); }, 8000);
      } catch { resolve(); }
    });
  }

  // 主入口:sessionId 有值 → --resume fork 续上下文;无 → 新建。
  // 每 turn yield 最新 sessionId(fork 后会变),bridge 持久化它,下次传回。
  async* sendAndStream(sessionId, text, opts = {}) {
    let turn;
    try {
      turn = await this._spawnTurn(text, { resumeSessionId: sessionId || null });
    } catch (e) {
      // resume 的 session 可能已失效/被回收 → 回退新建
      if (sessionId) {
        console.warn(`[cli-pool] resume spawn failed for ${String(sessionId).slice(0,8)} (${e.message}), retrying as new session`);
        turn = await this._spawnTurn(text, {});
      } else {
        throw e;
      }
    }

    // fork 出的新 sessionId 暴露给 bridge 更新持久化(下个 turn --resume 它)
    yield { type: "session_init", sessionId: turn.sessionId };

    try {
      const reader = new JsonlTailReader(turn.jsonlPath);
      yield* reader.readUntilTurnEnd({
        expectUserText: text,
        abortSignal: opts.abortSignal,
        timeoutMs: opts.timeoutMs || 600000,
      });
    } finally {
      // 用完即停,worker 不堆积(官方 stop,不碰 control socket)
      this.stopWorker(turn.short).catch(() => {});
    }
  }

  // 无常驻 worker;turn 级 abort 由 readUntilTurnEnd 的 abortSignal 接住。保留接口给 adapter。
  async abort(_sessionId) { /* no-op */ }
}

export function createCliPool(config) {
  return new CliPool(config);
}
