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
// 超时语义(2026-06-11):jsonl 静默超时 ≠ 任务失败。超时路径**不 stop worker**——让它把长任务
//   跑完、产出继续写进本 turn 的 jsonl;下条消息 --resume 该 sessionId fork 时会继承全部已写内容,
//   "稍等再发一条即可查看进展"的提示因此成立。正常完成/用户 Stop 仍然用完即停。idle worker
//   由 daemon 回收兜底。
//
// 保留:JsonlTailReader(turn 归属过滤 + 心跳超时 + 截断重置)完全复用。
// 删除:DaemonClient(reply/list/kill/ping 全直连 control socket)、BgSession(常驻 + reply)、
//   _waitForReady(spawn 带 prompt 不需要等 ready)、findControlSockPath、persistence。

import { spawn } from "node:child_process";
import { readFileSync, statSync, existsSync, createReadStream, openSync, readSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { findSessionFile } from "./claude-sessions.js";

// ============ 常量 ============
const ROSTER_PATH = join(homedir(), ".claude/daemon/roster.json");
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");
// 安全护栏脚本(PreToolUse hook):bypassPermissions 下硬拦灾难性不可逆命令。
const GUARD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "guard-destructive-bash.sh");
// 非交互拦截脚本(PreToolUse hook):硬拦 AskUserQuestion,防 --bg worker 挂起等终端点选。
// 无条件注入(与 destructiveGuard 开关无关):bridge 永远是非交互环境。
const BLOCK_ASK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "block-interactive-ask.sh");
// 非交互环境系统提示:让模型从源头不调 AskUserQuestion。headless 实测(2026-06-10):加这段后模型
// 会自主定默认 + 直接完成任务(测B 写出完整正文);而仅靠 hook deny(测A)模型会 recover 成"换文本
// 再问一遍"、仍停在原地等答。所以 append 是主防线(模型不调),BLOCK_ASK_SCRIPT 的 hook 是兜底
// 安全网(万一仍调了也拦下、让它 recover、不挂死)。
const BRIDGE_SYSTEM_NOTE = "你运行在非交互的 Telegram 自动化环境:没有人能在终端点选,调用 AskUserQuestion 会让会话挂起直到超时。请不要调用 AskUserQuestion;遇到本来需要用户选择的地方,自行按合理默认做出决定并继续完成任务(写作类任务的风格/标题/结构等通常已在 skill 中预设,按既定流程推进即可),必要时用一两句话说明你替用户做了哪些假设。";
const TURN_END_SUBTYPE = "turn_duration";

// 构造 --settings inline JSON:注入 PreToolUse hook,不落地文件、不碰用户 settings.json。
//   - AskUserQuestion 拦截:无条件(bridge 永远非交互,见 BLOCK_ASK_SCRIPT)。
//   - Bash 危险命令护栏:仅 includeDestructive 时(env CLI_POOL_DESTRUCTIVE_GUARD 控制)。
function buildSettings(includeDestructive) {
  const preToolUse = [
    { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "bash " + JSON.stringify(BLOCK_ASK_SCRIPT) }] },
  ];
  if (includeDestructive) {
    preToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "bash " + JSON.stringify(GUARD_SCRIPT) }] });
  }
  return JSON.stringify({ hooks: { PreToolUse: preToolUse } });
}

// 构造单 turn 的 claude --bg CLI 参数(不含末尾 prompt)。纯函数,便于测试。
// per-turn 覆盖优先于 config 默认;model 的 "__default__" 哨兵值视为未覆盖(与 SDK adapter 同语义)。
export function buildTurnArgs(config, { resumeSessionId, model, effort, systemAppend } = {}) {
  const safe = String(resumeSessionId || "new").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
  const name = `tg-turn-${safe}-${Date.now().toString(36)}`;
  const effectiveModel = model && model !== "__default__" ? model : config.model;
  const args = [
    "--bg", "--name", name,
    "--model", effectiveModel,
    "--effort", effort || config.effort,
    "--permission-mode", config.permissionMode,
  ];
  // 总是注入 settings:至少含 AskUserQuestion 拦截(防非交互挂起);destructiveGuard 开时再加 Bash 护栏。
  args.push("--settings", buildSettings(config.destructiveGuard));
  // 主防线:系统提示让模型从源头不调 AskUserQuestion、自主推进(见 BRIDGE_SYSTEM_NOTE;hook 是兜底)。
  // 群聊场景 bridge 会传 systemAppend(bridgeHint 文件路径约定 + 上下文框架),拼在固定段之后——
  // fork 模式每 turn 重新 spawn,所以每 turn 都生效(优于 SDK 引擎只在新 session 生效)。
  const systemNote = systemAppend ? `${BRIDGE_SYSTEM_NOTE}\n\n${systemAppend}` : BRIDGE_SYSTEM_NOTE;
  args.push("--append-system-prompt", systemNote);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return { name, args };
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

// ============ fork 前置检查(2026-06-11 错乱修复)============
// 背景:turn 超时留活 worker 后,用户下条消息会 --resume fork 出"半截快照"——CC 在新 fork 里
// 看到突然中断的上下文,会脑补衔接(实测产出"命令被你打断了"/凭空报错/虚构已完成,见
// RecallNest case bridge-跑-content-publisher-长任务被超时体系误杀)。
// 对策:fork 前读上一 session jsonl 尾部,判断最后一个 turn 是否完整。
//   - 未完成 + jsonl 近期仍在写(< stallMs) → worker 真在跑,拒绝 fork(yield busy)
//   - 未完成 + jsonl 已停滞 → fork 放行,但注入系统警示让模型先验证状态、不脑补
// 从尾部往前扫:先遇到 turn_duration → 完整;先遇到 user → 未完成。其他行(summary/
// bridge 注入的元数据行等)跳过。读尾部 64KB 足够覆盖最后一个 turn 的边界。
const TAIL_SCAN_BYTES = 65536;
export function readLastTurnState(jsonlPath) {
  if (!existsSync(jsonlPath)) return { exists: false, complete: true, mtimeMs: 0 };
  let mtimeMs = 0;
  try {
    const st = statSync(jsonlPath);
    mtimeMs = st.mtimeMs;
    const start = Math.max(0, st.size - TAIL_SCAN_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const fd = openSync(jsonlPath, "r");
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n");
    // start>0 时第一行可能是被截断的半行,丢弃
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type === "system" && d.subtype === TURN_END_SUBTYPE) {
        return { exists: true, complete: true, mtimeMs };
      }
      if (d.type === "user") {
        // tool_result 行也是 type=user,但属于 turn 进行中的产物,同样意味着 turn 未收尾;
        // 无需区分,先遇到 user 即未完成。
        return { exists: true, complete: false, mtimeMs };
      }
    }
    // 窗口内没扫到决定性事件(超长 assistant 输出占满窗口):保守视为未完成,
    // 走"停滞 → 注入警示"路径不丢消息,且警示是诚实的(让模型验证状态)。
    return { exists: true, complete: false, mtimeMs };
  } catch {
    return { exists: true, complete: true, mtimeMs };
  }
}

// 上一轮被切断时注入的系统警示:不阻止继续,但让模型先验证、不脑补。
export const INTERRUPTED_TURN_NOTE = "注意:本会话上一轮处理因等待超时被切断,切断点之后的工具调用结果可能缺失或不完整。不要假设上一轮中未明确确认完成的操作(如发布、生图、文件写入)已经成功——先用命令实际核验相关状态(文件是否存在、记录是否写入),再决定下一步。如果发现状态与上下文记忆不一致,以实际核验结果为准,并向用户如实说明。";

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
              else if (block.type === "tool_use") {
                // AskUserQuestion 已被 PreToolUse hook 在执行前 block(见 buildSettings + block-interactive-ask.sh),
                // 它会作为 blocked tool_use 出现在 jsonl、后面紧跟 blocked 的 tool_result,模型据此自主续写正文。
                // 所以当普通 tool_use yield 即可,绝不能提前 return——否则会截断后续正文(adapter 层会静默跳过它)。
                yield { type: "tool_use", name: block.name, input: block.input, id: block.id };
              }
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
      // fork 前置检查的"仍在写"判定窗口:上一 session jsonl 的 mtime 距今小于该值视为 worker
      // 仍在跑、拒绝 fork(见 sendAndStream)。默认 3 分钟——CC 干活时 jsonl 写入间隔通常远小于
      // 此值;超过它的静默多半是僵死或单条超长命令,放行 fork + 注入警示。
      workerStallMs: config.workerStallMs || Number(process.env.CLI_POOL_WORKER_STALL_MS || 180000),
    };
  }

  // 无常驻 daemon 连接,start/stop 都是空操作(每 turn 自带 spawn)。
  async start() { /* no-op */ }
  async stop() { /* no-op:无常驻 worker,daemon 自己回收 idle */ }

  // fork 前置检查的状态读取,实例方法便于测试注入(默认走真实 jsonl 尾部扫描)。
  _readPrevTurnState(jsonlPath) { return readLastTurnState(jsonlPath); }

  // 按 sessionId 全局定位 jsonl(不依赖当前 cwd),实例方法便于测试注入。
  _findSessionPath(sessionId) {
    try { return findSessionFile(sessionId)?.path || null; } catch { return null; }
  }

  // 该 sessionId 是否还有活 worker 在 daemon roster 里(busy 判定的必要条件,codex review P2):
  // 用户 Stop / bridge abort 会 claude stop 移除 worker——此时即使 jsonl mtime 还新鲜,也没有
  // 任何进程会补写 turn_end,不该 busy 误堵,应走"fork + 切断警示"路径。
  _hasLiveWorker(sessionId) {
    try {
      const workers = readRoster()?.workers || {};
      for (const w of Object.values(workers)) {
        if (w?.sessionId === sessionId) return true;
      }
    } catch { /* roster 读不到按无活 worker 处理 */ }
    return false;
  }

  // 起一个带 prompt 的 --bg worker;有 resumeSessionId 则 fork 续上下文。
  // per-turn 覆盖(model/effort/cwd/systemAppend)来自 bridge streamOverrides:/model /effort /dir
  // 的 chat 级偏好 + 群聊上下文 scaffold + bridgeHint,优先于 pool 级 config 默认。
  // 返回 { short, sessionId, cwd, jsonlPath }
  async _spawnTurn(text, opts = {}) {
    const { name, args } = buildTurnArgs(this.config, opts);
    args.push(text);  // 关键:带 prompt spawn,worker 起来即跑首 turn,无需 op:reply
    const spawnCwd = opts.cwd || this.config.cwd;

    return new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_CLI_PATH, args, { cwd: spawnCwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", c => out += c);
      child.stderr.on("data", c => err += c);
      const timer = setTimeout(() => {
        child.kill();
        // worker 可能已被 daemon 创建(CLI 前台被 kill ≠ 后台 worker 死),延迟按 name 反查兜底 stop 防泄漏
        this._stopByNameLater(name);
        reject(new Error("spawn timeout (30s)"));
      }, this.config.spawnTimeoutMs);
      child.on("error", e => { clearTimeout(timer); reject(e); });
      child.on("exit", async () => {
        clearTimeout(timer);
        const m = out.match(/backgrounded\s+·\s+([a-f0-9]{8})/);
        if (!m) {
          this._stopByNameLater(name);  // 同上:stdout 没给 short id 不代表 worker 没起来
          reject(new Error(`no short id in stdout: ${out.slice(0,200)}; stderr: ${err.slice(0,200)}`));
          return;
        }
        const short = m[1];
        // 等 roster 异步同步 fork 出的 sessionId
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 250));
          const w = readRoster()?.workers?.[short];
          if (w?.sessionId) {
            const cwd = w.cwd || spawnCwd;
            resolve({ short, sessionId: w.sessionId, cwd, jsonlPath: sessionJsonlPath(w.sessionId, cwd) });
            return;
          }
        }
        this.stopWorker(short).catch(() => {});  // short 已知但 roster 不认:stop 防泄漏再报错
        reject(new Error(`roster did not surface sessionId for short ${short}`));
      });
    });
  }

  // spawn 失败路径的泄漏兜底:延迟到 roster 同步窗口(实测 ≤5s)之后,按 worker name 反查 short 并 stop。
  // roster worker 对象无顶层 name,但 dispatch.launch.args 里保留了 --name 值(2026-06-11 实测结构)。
  _stopByNameLater(name, delayMs = 6000) {
    setTimeout(() => {
      try {
        const workers = readRoster()?.workers || {};
        for (const [short, w] of Object.entries(workers)) {
          const launchArgs = w?.dispatch?.launch?.args;
          if (Array.isArray(launchArgs)) {
            const i = launchArgs.indexOf("--name");
            if (i >= 0 && launchArgs[i + 1] === name) {
              console.warn(`[cli-pool] reaping leaked worker ${short} (name=${name})`);
              this.stopWorker(short).catch(() => {});
              return;
            }
          }
        }
      } catch { /* roster 读不到就算了,daemon idle 回收兜底 */ }
    }, delayMs).unref?.();
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
  // opts 透传 per-turn 覆盖:model/effort/cwd/systemAppend(见 _spawnTurn)。
  async* sendAndStream(sessionId, text, opts = {}) {
    let interruptedNote = null;
    if (sessionId) {
      // fork 前置检查(2026-06-11):上一 turn 未收尾时,fork 出的是半截快照,CC 会脑补衔接。
      // 先按 sessionId 全局定位 jsonl(codex review P2:per-chat /dir 切 cwd 后按当前 cwd 拼
      // 路径会找不到旧 session 的 jsonl、保护被静默跳过),找不到再退回按 cwd 拼。
      const prevPath = this._findSessionPath(sessionId) || sessionJsonlPath(sessionId, opts.cwd || this.config.cwd);
      const prev = this._readPrevTurnState(prevPath);
      if (prev.exists && !prev.complete) {
        const stallMs = this.config.workerStallMs;
        const idleMs = Date.now() - prev.mtimeMs;
        if (idleMs < stallMs && this._hasLiveWorker(sessionId)) {
          // 有活 worker 且 jsonl 近期有写入:真在跑,拒绝 fork,让产出完整落盘后再续。
          console.warn(`[cli-pool] resume ${String(sessionId).slice(0,8)} blocked: previous turn still writing (idle ${Math.round(idleMs/1000)}s < ${Math.round(stallMs/1000)}s, live worker)`);
          yield { type: "busy", idleMs };
          return;
        }
        // worker 已死(Stop/abort/僵死)或 jsonl 停滞:放行 fork,注入警示让模型核验状态、不脑补。
        console.warn(`[cli-pool] resume ${String(sessionId).slice(0,8)}: previous turn incomplete (jsonl idle ${Math.round(idleMs/1000)}s, live=${this._hasLiveWorker(sessionId)}), injecting interrupted-turn note`);
        interruptedNote = INTERRUPTED_TURN_NOTE;
      }
    }
    const turnOpts = {
      resumeSessionId: sessionId || null,
      model: opts.model,
      effort: opts.effort,
      cwd: opts.cwd,
      systemAppend: interruptedNote
        ? (opts.systemAppend ? `${interruptedNote}\n\n${opts.systemAppend}` : interruptedNote)
        : opts.systemAppend,
    };
    let turn;
    try {
      turn = await this._spawnTurn(text, turnOpts);
    } catch (e) {
      // resume 的 session 可能已失效/被回收 → 回退新建
      if (sessionId) {
        console.warn(`[cli-pool] resume spawn failed for ${String(sessionId).slice(0,8)} (${e.message}), retrying as new session`);
        turn = await this._spawnTurn(text, { ...turnOpts, resumeSessionId: null });
      } else {
        throw e;
      }
    }

    // fork 出的新 sessionId 暴露给 bridge 更新持久化(下个 turn --resume 它)
    yield { type: "session_init", sessionId: turn.sessionId };

    // 超时不杀 worker(2026-06-11 临床修正):jsonl 静默超时时长任务可能仍在跑,杀掉 = 产出永久丢失,
    // 而 adapter 发给用户的提示是"并未中断,稍等再发可查看进展"——留 worker 活着,产出继续写进
    // 本 turn jsonl,下条消息 fork 该 sessionId 时全部继承,提示才成立。正常完成/用户 Stop 仍即停。
    let sawTimeout = false;
    try {
      const reader = new JsonlTailReader(turn.jsonlPath);
      yield* reader.readUntilTurnEnd({
        expectUserText: text,
        abortSignal: opts.abortSignal,
        timeoutMs: opts.timeoutMs || 600000,
      });
    } catch (e) {
      if (/tail timeout/.test(e.message || "")) sawTimeout = true;
      throw e;
    } finally {
      if (sawTimeout) {
        console.warn(`[cli-pool] turn timeout for ${turn.short}: leaving worker alive (output inherited by next fork; daemon reclaims idle worker)`);
      } else {
        // 用完即停,worker 不堆积(官方 stop,不碰 control socket)
        this.stopWorker(turn.short).catch(() => {});
      }
    }
  }

  // 无常驻 worker;turn 级 abort 由 readUntilTurnEnd 的 abortSignal 接住。保留接口给 adapter。
  async abort(_sessionId) { /* no-op */ }
}

export function createCliPool(config) {
  return new CliPool(config);
}
