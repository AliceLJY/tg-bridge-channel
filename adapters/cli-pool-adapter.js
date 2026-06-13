// adapters/cli-pool-adapter.js
// Wrapper:把 cli-pool(方案 C:per-turn `claude --bg [--resume] "<prompt>"` fork spawn
// + jsonl tail 读输出 + `claude stop` 清理)包成 bridge 统一 adapter 接口
// ({ name, streamQuery, statusInfo, listSessions, resolveSession })。
//
// 接口对齐 adapters/claude.js,bridge.js 现有 `backendName === "claude"` 判断不动。
// 启 env CLAUDE_POOL_ENGINE=1 → bridge 自动选这套引擎(见 adapters/interface.js)。
// streamOverrides 消费状态(2026-06-11 对齐 SDK adapter):model/effort/cwd/systemAppend 透传到
// 每次 --bg spawn;requestPermission 不透传——pool 固定 bypassPermissions,安全线是 PreToolUse
// hook 硬护栏(guard-destructive-bash + block-interactive-ask),不是逐工具审批。

import { createCliPool } from "./cli-pool.js";
import { listSessionFiles, findSessionFile, parseSessionFile } from "./claude-sessions.js";

// 单例 pool —— 同进程多 chat 共享一套 config 默认值(方案 C 无常驻连接,纯配置容器)
let _pool = null;
let _poolStartPromise = null;

function ensurePool(initConfig) {
  if (!_pool) {
    _pool = createCliPool(initConfig);
    _poolStartPromise = _pool.start();
  }
  return _pool;
}

// 把 cli-pool 内部事件映射成 bridge 统一格式。
// 关键:turn_end 时 result.text 必须带本 turn 累积的全文 — bridge 用 result.text 兜底发 TG;
// 不累积 → bridge 报"无输出"(2026-05-26 实测)。
function* mapEvents(poolEvent, state) {
  if (poolEvent.type === "session_init") { yield poolEvent; return; }
  if (poolEvent.type === "user_echo") return;
  if (poolEvent.type === "idle_heartbeat") {
    // 长任务静默心跳→专用 heartbeat 事件。bridge 对每个 event 调 idleMonitor.heartbeat(重置 30min
    // 卡死计时);progress.processEvent 只认 progress/text,天然忽略它,不污染进度列表(Codex 复核坑3)。
    yield { type: "heartbeat", idleSec: poolEvent.idleSec, elapsedSec: poolEvent.elapsedSec };
    return;
  }
  if (poolEvent.type === "busy") {
    // fork 前置检查拒绝(上一长任务仍在后台写产出):不 fork、session 不变,
    // 用户稍后重发即可在产出完整落盘后续上。/new 是确认卡死时的逃生口。
    const idleMin = Math.max(1, Math.round((poolEvent.idleMs || 0) / 60000));
    yield {
      type: "result",
      success: false,
      text: `⏳ 上一条长任务仍在后台执行中(约 ${idleMin} 分钟前还有产出落盘)。请稍等片刻再发消息,它跑完后下一条消息会自动接上全部进展;如果确认卡死,发 /new 重开会话。`,
    };
    return;
  }
  if (poolEvent.type === "text") {
    state.accumulatedText += poolEvent.text;
    yield { type: "text", text: poolEvent.text };
  } else if (poolEvent.type === "thinking") {
    // bridge 当前不展示 thinking,跳过避免污染
  } else if (poolEvent.type === "tool_use") {
    // AskUserQuestion 在非交互 pool 里已被 PreToolUse hook 拦掉真执行(见 cli-pool.js buildSettings +
    // scripts/block-interactive-ask.sh):它作为 blocked tool_use 出现在 jsonl,模型收到 deny reason 后
    // 自主续写正文——那段正文才是要回传的内容,经软结束/turn_duration 正常发出。这里静默跳过该 tool_use。
    // 注(2026-06-13 codex 复核点④,勿轻易回改):一度试过 emit question + inline 按钮对齐 SDK adapter,
    // 但 pool 是 fork-per-turn、worker 每轮即杀,语义并非"暂停等按钮"——hook 已 deny、模型本轮已自主继续,
    // 用户事后点按钮只是【下一轮】的"追答/改口"(submitAndWait fork --resume),相对已继续的会话是滞后的、
    // 易串台;且系统提示 + hook 已把 AskUserQuestion 触发率压到很低。故保持静默跳过(若日后要做交互,
    // 需给按钮加 turn nonce + "本轮已自主继续"提示,而非直接套用 SDK 的暂停语义)。
    if (poolEvent.name === "AskUserQuestion") return;
    yield { type: "progress", toolName: poolEvent.name, input: poolEvent.input };
    const input = poolEvent.input || {};
    if ((poolEvent.name === "Write" || poolEvent.name === "Edit") && input.file_path) {
      yield { type: "file_written", filePath: input.file_path, tool: poolEvent.name };
    }
  } else if (poolEvent.type === "turn_end") {
    yield {
      type: "result",
      success: true,
      text: state.accumulatedText,
      duration: poolEvent.durationMs,
    };
  }
}

export function createAdapter(config = {}) {
  const defaultModel = config.model || process.env.CC_MODEL || "opus";
  const defaultEffort = config.effort || process.env.DEFAULT_EFFORT || "max";
  const defaultPermMode = config.permissionMode || process.env.CC_PERMISSION_MODE || "bypassPermissions";
  const defaultCwd = config.cwd || process.env.CC_CWD || process.env.HOME;

  const pool = ensurePool({
    model: defaultModel,
    effort: defaultEffort,
    permissionMode: defaultPermMode,
    cwd: defaultCwd,
  });

  return {
    name: "claude",
    label: "CC(pool)",
    icon: "🟪",

    availableModels() {
      return [
        { id: "__default__", label: `默认 (${defaultModel})` },
        { id: "opus", label: "Opus 最新" },
        { id: "sonnet", label: "Sonnet 最新" },
        { id: "haiku", label: "Haiku 最新" },
      ];
    },
    availableEfforts() {
      return [
        { id: "__default__", label: `默认 (${defaultEffort})`, description: "标准深度" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max", description: "最深(仅 Opus)" },
      ];
    },

    async *streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      // 等 pool start 完成(只在第一次 query 阻塞一次)
      if (_poolStartPromise) {
        await _poolStartPromise.catch(() => {}); // start 错误不阻塞,sendAndStream 内部会再 probe
      }

      // 方案 C:不再先 newSession 起 idle session。直接把 sessionId(可能为空)交给
      // pool.sendAndStream:有就 --resume fork 续上下文,没有就新建;session_init(fork 出的
      // 最新 sessionId)由 pool 内部 yield、mapEvents 透传给 bridge 持久化。
      // per-turn overrides 透传(2026-06-11):/model /effort /dir 偏好 + systemAppend 落到 CLI flag。
      const { model, effort, cwd, systemAppend } = overrides;
      // turnState 提到 try 外:catch 路径(超时/异常)要能拿到本轮已累积的 CC 文本做兜底回传(见下)。
      const turnState = { accumulatedText: "" };
      try {
        for await (const poolEv of pool.sendAndStream(sessionId || null, prompt, {
          abortSignal,
          heartbeatMs: Number(overrides.heartbeatMs) || Number(process.env.CLI_POOL_HEARTBEAT_MS) || 180000,
          hardLimitMs: Number(overrides.hardLimitMs) || Number(process.env.CLI_POOL_HARD_LIMIT_MS) || 3600000,
          model, effort, cwd, systemAppend,
        })) {
          for (const ev of mapEvents(poolEv, turnState)) yield ev;
        }
      } catch (e) {
        // 用户主动 Stop:原样上抛,bridge 的 isUserAbort 路径接住 → 干净的"已取消"而非"出错:aborted"
        if (abortSignal?.aborted) throw e;
        console.error(`[cli-pool-adapter] streamQuery err sid=${String(sessionId || "new").slice(0,8)}: ${e.message}`);
        // turn 硬上限(默认 60min,真卡死兜底)≠ worker 已死:不 stop worker(见 cli-pool.js sendAndStream
        // finally),后台产出会被下次 fork 继承。注意:正常长任务(配图/发布 20-40min)现在会持续 tail 到
        // turn_end 正常返回、不再走这条;走到这里多半是真卡了 60min。
        const isTimeout = /tail timeout|hard limit/.test(e.message || "");
        const mins = Math.round((Number(process.env.CLI_POOL_HARD_LIMIT_MS) || 3600000) / 60000);
        // 兜底回传(2026-06-13 codex 复核点③):turn 没干净收尾(软结束 end_turn / system turn_duration
        // 都没等到)时,若 CC 本轮已经说了话("发布失败:40164""请加白名单""封面都好了"…),必须把已说的
        // 发出去,绝不能用通用超时/错误文案盖掉——这正是"配图发布石沉大海"的最后一道防线。
        // 用 success:true 走 sendFinalResult 的正文路径;success:false 会被 sanitizeBackendError 压成
        // 一句话、把正文丢光(见 output-relay.js)。
        const acc = (turnState.accumulatedText || "").trim();
        if (acc) {
          const footer = isTimeout
            ? `\n\n———\n⏱️ 注:这轮跑了超过 ${mins} 分钟还没收到收尾信号,以上是 CC 已经产出的内容;如果它还没说完,直接回一句让它继续就行(会接着上下文)。`
            : `\n\n———\n⚠️ 注:这轮中途出了点状况(${(e.message || "").slice(0, 80)}),以上是 CC 已产出的内容。`;
          yield { type: "result", success: true, text: acc + footer };
        } else {
          const text = isTimeout
            ? `⏱️ 这条任务跑了超过 ${mins} 分钟仍没收尾,可能真卡住了。CC 后台会话未被杀(产出会被下次接续),建议发 /new 重开会话再试。`
            : `CC(pool) 出错:${e.message}`;
          yield { type: "result", success: false, text };
        }
      }
    },

    statusInfo(overrideModel, overrideEffort) {
      return {
        model: overrideModel || defaultModel,
        effort: overrideEffort || defaultEffort,
        cwd: defaultCwd,
        mode: "Pool (--bg daemon)",
      };
    },

    async listSessions(limit = 10) {
      // 复用 claude-sessions.js 的 jsonl 列表逻辑
      const recent = listSessionFiles(limit);
      const out = [];
      for (const s of recent) out.push(await parseSessionFile(s, defaultCwd));
      return out;
    },
    async resolveSession(sessionId) {
      const fi = findSessionFile(sessionId);
      return fi ? await parseSessionFile(fi, defaultCwd) : null;
    },
  };
}
