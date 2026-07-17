// 迟到产出巡逻（2026-07-17，case 8d6eb755 + 4fb95516 后续）：
// CC 在 turn 里用 run_in_background / Monitor / 子 agent 接力长任务时，bridge 在第一个 result 就收轮；
// 后台任务完成后 harness 重新唤醒 CC、往【同一个 jsonl】续写最终报告——没人在读 = 用户永远看不到，
// CC 还以为发了（2026-07-17 mccode1 盘点报告实况）。
// 本模块在 turn 正常收尾后对该 jsonl 保持低频巡逻：发现 turn 结束之后新写的 assistant 正文，等其
// 稳定（出现 turn 收尾标记或静默 stabilizeMs）后作为"后台补报"补发到 TG；新一轮消息进来前先
// sweepAndStop（把 pending 发完再停，且发生在新轮 op:reply 之前，绝不与活跃轮抢文件/重发）。
//
// 防串台/防刷屏边界：
//   - 读到【真人 user 输入】（非 tool_result 回填）→ 会话被别的通道（手机 RC 等）接管，flush 后退场；
//     tool_result / 后台任务通知形态的 user 行不算（bg 接力恰恰长这样）。
//   - 只补发 ts > turnEndedAt 的 assistant text 块（offset 从 turn 末起 + ts 双保险，防 relocate 归零重放）；
//     thinking / tool_use / system 一律不发。
//   - 补发次数 maxBursts 封顶（防 CC 后台自言自语刷屏），到顶提示一句后退场。
//   - maxAgeMs 超龄退场；每 chat 单例，新 turn 的 handle 顶掉旧巡逻。
// 复用 JsonlTailReader：增量读 + 静默重定位（worktree 迁移）白嫖。

import { JsonlTailReader } from "./adapters/cli-pool.js";
import { extractUserEchoText, isHardTurnEnd, isSoftTurnEnd } from "./adapters/claude-local-contract.js";
import { stripMalformedToolCall } from "./adapters/sanitize-text.js";

export function createLatePatrolManager({
  intervalMs = Number(process.env.LATE_PATROL_INTERVAL_MS) || 60000,
  stabilizeMs = Number(process.env.LATE_PATROL_STABILIZE_MS) || 90000,
  maxAgeMs = Number(process.env.LATE_PATROL_MAX_AGE_MS) || 2 * 60 * 60 * 1000,
  maxBursts = Number(process.env.LATE_PATROL_MAX_BURSTS) || 5,
  prefix = "⏰ 后台任务补报：\n\n",
  capNotice = "\n\n（后台补报已达上限，之后的进展直接发消息问我就能看到）",
  makeReader = (jsonlPath, sessionId) => new JsonlTailReader(jsonlPath, { sessionId }),
  logger = console,
} = {}) {
  const patrols = new Map(); // chatId -> state

  function stop(chatId) {
    const st = patrols.get(chatId);
    if (!st) return;
    st.stopped = true;
    if (st.timer) clearInterval(st.timer);
    patrols.delete(chatId);
  }

  function stopAll() {
    for (const chatId of [...patrols.keys()]) stop(chatId);
  }

  // send: async (text) => void（由 bridge 注入，闭包持 ctx）
  function start(chatId, { sessionId, jsonlPath, offset, turnEndedAt }, send) {
    if (!sessionId || !jsonlPath || typeof send !== "function") return;
    stop(chatId); // 新 turn 的 handle 顶掉旧巡逻
    const reader = makeReader(jsonlPath, sessionId);
    reader.offset = offset || 0;
    const st = {
      reader, send,
      turnEndedAt: turnEndedAt || Date.now(),
      startedAt: Date.now(),
      pendingText: "",
      lastNewTextAt: 0,
      flushHint: false,     // 读到 turn 收尾标记 → 立即可发，不等稳定窗
      bursts: 0,
      stopped: false,
      polling: false,       // poll 重入护栏（interval 与 sweep 并发）
      timer: null,
    };
    patrols.set(chatId, st);
    st.timer = setInterval(() => {
      poll(chatId, st).catch(e => logger.warn?.(`[late-patrol] poll err chatId=${chatId}: ${e.message}`));
    }, intervalMs);
    st.timer.unref?.();  // 巡逻定时器不该拖住进程退出(shutdown stopAll 之外的双保险)
    logger.log?.(`[late-patrol] armed chatId=${chatId} sid=${String(sessionId).slice(0, 8)} offset=${reader.offset}`);
  }

  async function poll(chatId, st, { force = false } = {}) {
    if (st.stopped || st.polling) return;
    st.polling = true;
    try {
      if (Date.now() - st.startedAt > maxAgeMs) { await flush(chatId, st, { force: true }); stop(chatId); return; }
      st.reader.maybeRelocate?.(); // 内部有冷却；worktree 迁移场景跟着文件走
      const lines = await st.reader._readNewLines();
      for (const line of lines) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        const lineMs = d.timestamp ? Date.parse(d.timestamp) : 0;
        if (d.type === "user") {
          const humanText = extractUserEchoText(d.message?.content);
          if (humanText !== null && lineMs > st.turnEndedAt) {
            // 真人输入进了这个会话（手机 RC / 别的通道接管）→ 把已有 pending 发完，退场不再跟
            logger.log?.(`[late-patrol] human input seen, standing down chatId=${chatId}`);
            await flush(chatId, st, { force: true });
            stop(chatId);
            return;
          }
          continue; // tool_result / bg 通知回填：正是接力形态，继续巡逻
        }
        if (d.type === "assistant") {
          if (lineMs && lineMs <= st.turnEndedAt) continue; // turn 内已发过的行（relocate 归零重放）跳过
          const c = d.message?.content;
          if (Array.isArray(c)) {
            for (const block of c) {
              if (block.type !== "text") continue;
              const clean = stripMalformedToolCall(block.text || "");
              if (clean) { st.pendingText += clean; st.lastNewTextAt = Date.now(); }
            }
          }
          if (isSoftTurnEnd(d) && st.pendingText.trim()) st.flushHint = true;
          continue;
        }
        if (isHardTurnEnd(d) && st.pendingText.trim()) st.flushHint = true;
      }
      const stable = st.pendingText.trim()
        && (st.flushHint || force || (st.lastNewTextAt && Date.now() - st.lastNewTextAt >= stabilizeMs));
      if (stable) await flush(chatId, st, { force });
    } finally {
      st.polling = false;
    }
  }

  async function flush(chatId, st, { force = false } = {}) {
    const text = st.pendingText.trim();
    if (!text) return;
    if (st.bursts >= maxBursts) { stop(chatId); return; }
    st.bursts++;
    st.pendingText = "";
    st.flushHint = false;
    const capped = st.bursts >= maxBursts;
    const body = prefix + text + (capped && !force ? capNotice : "");
    try {
      await st.send(body);
      logger.log?.(`[late-patrol] burst ${st.bursts}/${maxBursts} sent chatId=${chatId} (${text.length} chars)`);
    } catch (e) {
      logger.warn?.(`[late-patrol] send failed chatId=${chatId}: ${e.message}`);
    }
    if (capped && !force) stop(chatId);
  }

  // 新消息进入处理流程前调用：最后扫一次、把 pending 立刻发完、退场。
  // 时序保证：发生在新轮 op:reply 之前 → 巡逻器读到的都是旧 turn 之后、新 turn 之前的内容，零重叠。
  async function sweepAndStop(chatId) {
    const st = patrols.get(chatId);
    if (!st) return;
    try {
      await poll(chatId, st, { force: true });
    } catch (e) {
      logger.warn?.(`[late-patrol] final sweep err chatId=${chatId}: ${e.message}`);
    } finally {
      stop(chatId);
    }
  }

  return { start, sweepAndStop, stop, stopAll, size: () => patrols.size };
}
