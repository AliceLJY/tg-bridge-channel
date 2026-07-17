export function createTaskFinalizer({ taskId, completeTask, failTask }) {
  let taskFinalized = false;

  return {
    success(summary = "") {
      if (taskFinalized) return;
      completeTask(taskId, summary);
      taskFinalized = true;
    },
    failure(summary = "", errorCode = "RESULT_ERROR") {
      if (taskFinalized) return;
      failTask(taskId, summary, errorCode);
      taskFinalized = true;
    },
    get finalized() {
      return taskFinalized;
    },
  };
}

export function saveCapturedSession({
  capturedSessionId,
  sessionId,
  chatId,
  prompt,
  backendName,
  sessionType = "normal",
  setSession,
  peekSession = null,
  getResetAt = null,
  turnStartedAt = 0,
  sessionFileExists = null,
  patchCodexStateDb,
  logger = console,
}) {
  if (!capturedSessionId) {
    logger.log(`[Session Debug] NOT saving session: capturedSessionId is null/empty (original sessionId=${sessionId?.slice(0, 8) || "null"})`);
    return false;
  }

  // 防护一：turn 开始后映射被 /new 或 idle-reset 清过 → 放弃写回。
  // 否则被取消/超时 turn 的收尾回调会把旧对话链写回，/new 失效、旧对话复活
  // （2026-06-12 mccode1 串台事故根因）。时间戳比对才能覆盖"清空前映射本来就是空"的新会话场景。
  if (typeof getResetAt === "function" && turnStartedAt > 0) {
    const resetAt = getResetAt(chatId) || 0;
    if (resetAt >= turnStartedAt) {
      logger.log(`[Session Debug] NOT saving session: mapping reset during turn (resetAt=${resetAt} >= turnStartedAt=${turnStartedAt}, captured=${capturedSessionId.slice(0, 8)}...)`);
      return false;
    }
  }

  // 防护二（CAS）：映射在 turn 期间被切到别的会话（/resume 等）→ 放弃写回。
  // current === captured 时放行（本 turn 已写过，幂等）。peekSession 无 touch 副作用。
  if (typeof peekSession === "function") {
    const current = peekSession(chatId);
    const currentId = current?.session_id || null;
    const startedFrom = sessionId || null;
    if (currentId !== startedFrom && currentId !== capturedSessionId) {
      logger.log(`[Session Debug] NOT saving session: mapping changed during turn (started=${startedFrom?.slice(0, 8) || "null"}, now=${currentId?.slice(0, 8) || "null"}, captured=${capturedSessionId.slice(0, 8)}...)`);
      return false;
    }
  }

  // 防护三（幽灵 ID，2026-07-17 case 4fb95516）：本轮【换代】出的新 sessionId 必须已在盘上有会话文件才写回。
  // fork 复活在"加载历史→写首行"窗口内被取消/卡死时，新 sid 永远不会落盘——写回它就是黑洞 ID：
  // 之后每条消息 resume 一个不存在的会话，静默退化、用户再取消又造新黑洞，死循环（mccode2 实况）。
  // 保留旧 sessionId（db 不动），下条消息仍 --resume 旧会话 → 上下文不丢。
  // 同 sid 轮（op:reply 未换代）跳过：文件本就存在，省一次全局扫。sessionFileExists 由 bridge 按
  // backend 决定是否注入（只有 claude 的 jsonl 体系可查；codex/gemini 不传 = 不检查，行为不变）。
  if (typeof sessionFileExists === "function" && capturedSessionId !== sessionId && !sessionFileExists(capturedSessionId)) {
    logger.log(`[Session Debug] NOT saving session: captured ${capturedSessionId.slice(0, 8)}... has no session file on disk (ghost id, keeping ${sessionId?.slice(0, 8) || "null"})`);
    return false;
  }

  const displayName = prompt.slice(0, 30);
  logger.log(`[Session Debug] Saving session: chatId=${chatId} sessionId=${capturedSessionId.slice(0, 8)}... backend=${backendName} (was=${sessionId?.slice(0, 8) || "null"})`);
  setSession(chatId, capturedSessionId, displayName, backendName, "owned", sessionType);
  if (backendName === "codex") {
    setTimeout(patchCodexStateDb, 1000);
  }
  return true;
}

export async function finishTurnProgress({
  previewActivated,
  streamPreview,
  progress,
  chatId,
  resultSuccess,
  verboseLevel,
  keepAsSummary = true,
  durationMs,
  deleteMessage,
  activeProgressTrackers,
}) {
  if (previewActivated) {
    const previewMsgId = streamPreview.finish();
    if (previewMsgId) {
      deleteMessage(chatId, previewMsgId);
    }
    await progress.finish({ skipMessage: true });
  } else {
    await progress.finish({
      keepAsSummary: keepAsSummary && verboseLevel >= 1 && resultSuccess,
      durationMs,
    });
  }
  activeProgressTrackers?.delete(chatId);
}
