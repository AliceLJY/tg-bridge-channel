import { existsSync, readFileSync } from "fs";
import { basename } from "path";

const SENDABLE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".docx", ".xlsx", ".csv", ".html", ".svg"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DOC_EXTS = new Set([".pdf", ".docx", ".xlsx", ".csv", ".html", ".txt", ".md", ".json", ".js", ".ts", ".py", ".sh", ".yaml", ".yml", ".xml", ".log", ".zip", ".tar", ".gz"]);

export function extractFilePathsFromText(text, fileList, options = {}) {
  const home = options.home ?? process.env.HOME ?? "";
  const exists = options.exists ?? existsSync;
  const existing = new Set(fileList.map(f => f.filePath));
  const extGroup = "png|jpg|jpeg|gif|webp|pdf|docx|xlsx|csv|html|svg|txt|md|json|js|ts|py|sh|yaml|yml|xml|log|zip|tar|gz";

  const absPattern = new RegExp(`(\\/(?:[\\w.\\-]+\\/)*[\\w.\\-\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef ]+\\.(?:${extGroup}))`, "gi");
  const tildePattern = new RegExp(`(~\\/(?:[\\w.\\-]+\\/)*[\\w.\\-\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef ]+\\.(?:${extGroup}))`, "gi");

  function addPath(path) {
    const resolved = path.startsWith("~/") ? path.replace("~", home) : path.trim();
    if (!existing.has(resolved) && exists(resolved)) {
      existing.add(resolved);
      fileList.push({ filePath: resolved, source: "text_scan" });
    }
  }

  for (const match of text.match(absPattern) || []) addPath(match);
  for (const match of text.match(tildePattern) || []) addPath(match);
}

// 把后端（Codex / Claude SDK）的原始错误 stderr 压成用户能看懂的一句话。
// 满屏 TLS handshake / rmcp / apply_patch / rollout trace 对用户没有行动价值，
// 原样发到 Telegram 只会吓人——完整 stderr 只进后台日志，这里只回传归类后的人话。
const BACKEND_ERROR_PATTERNS = [
  {
    re: /tls handshake|failed to connect to websocket|http\/?request failed|transport channel closed|wham\/apps|backend-api\/codex\/responses|websocket|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i,
    msg: "与模型后端的连接中断了一次（网络或 TLS 握手失败）",
  },
  {
    re: /apply_patch verification failed|failed to find expected lines/i,
    msg: "某次文件修改的上下文已过期，该次改动被自动跳过（不影响其他结果）",
  },
  {
    re: /thread .*not found|failed to record rollout items/i,
    msg: "会话记录层出现一次短暂不一致（本地会话文件仍在）",
  },
  {
    re: /rate.?limit|\b429\b|quota|usage limit/i,
    msg: "触发了模型用量限制，建议稍后重试",
  },
  {
    re: /not installed|ENOENT|command not found|cannot find module/i,
    msg: "后端依赖缺失或未正确安装",
  },
  {
    re: /exited with code|exit code|non-zero|Codex Exec/i,
    msg: "后端进程异常退出了一次",
  },
];

export function sanitizeBackendError(rawText, { maxLen = 200 } = {}) {
  const raw = String(rawText || "").replace(/\r/g, "").trim();
  if (!raw) return "后端未返回错误详情";

  const hits = [];
  for (const { re, msg } of BACKEND_ERROR_PATTERNS) {
    if (re.test(raw) && !hits.includes(msg)) hits.push(msg);
  }
  if (hits.length > 0) {
    return `${hits.join("；")}。完整日志见后台。`;
  }

  // 未识别模式：只取首条非空行 + 长度上限，绝不把整屏 trace 回传给用户
  const firstLine = raw.split("\n").map((l) => l.trim()).find(Boolean) || raw;
  const short = firstLine.length > maxLen ? `${firstLine.slice(0, maxLen - 3)}...` : firstLine;
  return `${short}（完整日志见后台）`;
}

// ── 进度广播（Progress Broadcast, PB）──
// CC 在长任务里主动打的进度标记行，独立发成一条留档消息，区别于会被 turn 末删除的
// streaming preview。解决长任务中途 TG 只看到临时预览、事后无留档、用户误以为卡住的问题。
// 标记语法：行首 ::PB:: + 至少一个空格/Tab + 内容。前缀选正文里绝不会自然出现的序列，
// 避免把普通句子（含对 "core_task_progress" 一类词的讨论）误当进度广播。
const PB_LINE_RE = /^::PB::[ \t]+(.+?)[ \t]*$/;

// 从流式增量文本里按整行提取进度标记，维护跨 chunk 的行缓冲（未以 \n 结束的残行留到下次）。
// @param {string} buffer - 上次遗留的未完成行 + 本次新增增量（调用方负责拼接后传入）
// @returns {{ messages: string[], buffer: string }} messages=本次提取到的进度内容；buffer=残余未完成行
export function extractProgressBroadcasts(buffer) {
  const messages = [];
  let rest = buffer;
  let nlIdx;
  while ((nlIdx = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, nlIdx);
    rest = rest.slice(nlIdx + 1);
    const m = line.match(PB_LINE_RE);
    if (m) messages.push(m[1]);
  }
  return { messages, buffer: rest };
}

// 从最终结果正文里剔除进度标记行（已单独广播过，避免在结论里重复出现），并压掉多余空行。
export function stripProgressBroadcasts(text) {
  if (!text) return text;
  return text
    .replace(/^::PB::[ \t].*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function estimateCodeRatio(text) {
  const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
  const codeLen = codeBlocks.reduce((sum, block) => sum + block.length, 0);
  return text.length > 0 ? codeLen / text.length : 0;
}

export function detectCodeLang(text) {
  const match = text.match(/```(\w+)/);
  const lang = match?.[1]?.toLowerCase();
  const map = { javascript: "js", typescript: "ts", python: "py", bash: "sh", shell: "sh", ruby: "rb" };
  return map[lang] || lang || "txt";
}

export async function sendCapturedOutputs({
  chatId,
  resultSuccess,
  capturedImages,
  capturedFiles,
  imageFloodSuppressed,
  fileDir,
  sendPhoto,
  sendDocument,
  logger = console,
  home = process.env.HOME ?? "",
  exists = existsSync,
  readFile = readFileSync,
  basenameFn = basename,
  sleepMs = 300,
}) {
  if (capturedImages.length > 0 || capturedFiles.length > 0) {
    logger.log(`[Bridge] 输出回传: ${capturedImages.length} 张图片${imageFloodSuppressed ? " (防刷已触发，部分跳过)" : ""}, ${capturedFiles.length} 个文件`);
  }

  if (resultSuccess && capturedImages.length > 0) {
    let sentImageCount = 0;
    for (const img of capturedImages) {
      if (img.source === "tool_result") {
        logger.log(`[Bridge] 跳过工具结果图片 (toolUseId: ${img.toolUseId || "?"})`);
        continue;
      }
      try {
        const buf = Buffer.from(img.data, "base64");
        if (buf.length > 10 * 1024 * 1024) continue;
        const ext = (img.mediaType || "image/png").split("/")[1] || "png";
        await sendPhoto(chatId, buf, `output.${ext}`);
        sentImageCount++;
        if (sentImageCount < capturedImages.length) {
          await new Promise(resolve => setTimeout(resolve, sleepMs));
        }
      } catch (error) {
        logger.error(`[Bridge] sendPhoto failed: ${error.message}`);
      }
    }
  }

  if (resultSuccess && capturedFiles.length > 0) {
    const sentPaths = new Set();
    for (const file of capturedFiles) {
      if (!file.filePath) continue;
      const resolved = file.filePath.startsWith("~/") ? file.filePath.replace("~", home) : file.filePath;
      if (fileDir && resolved.startsWith(fileDir)) continue;
      if (sentPaths.has(resolved)) continue;
      const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
      if (!IMAGE_EXTS.has(ext) && !DOC_EXTS.has(ext)) continue;
      if (!exists(resolved)) continue;
      sentPaths.add(resolved);
      logger.log(`[Bridge] 发送文件: ${basenameFn(resolved)} (来源: ${file.source})`);
      try {
        if (IMAGE_EXTS.has(ext)) {
          await sendPhoto(chatId, readFile(resolved), basenameFn(resolved));
        } else {
          await sendDocument(chatId, readFile(resolved), basenameFn(resolved));
        }
      } catch (error) {
        logger.error(`[Bridge] sendFile failed (${basenameFn(resolved)}): ${error.message}`);
      }
    }
  }
}

export async function sendFinalResult({
  ctx,
  chatId,
  adapterLabel,
  resultText,
  resultSuccess,
  finalizeSuccess,
  finalizeFailure,
  summarizeText,
  detectQuickReplies,
  InlineKeyboard,
  sendLong,
  sendDocument,
  protectFileReferences,
  hasMarkdownFormatting,
  markdownToTelegramHTML,
  withRetry,
}) {
  let text = resultText ? protectFileReferences(resultText) : resultText;

  // 让最终结果在 Telegram 上 quote 触发本次任务的原消息，对齐"提问↔答案"视觉关系
  const _mid = ctx?.message?.message_id;
  const quote = _mid
    ? { reply_parameters: { message_id: _mid, allow_sending_without_reply: true } }
    : {};

  if (!resultSuccess) {
    finalizeFailure(summarizeText(text, 240), "RESULT_ERROR");
    // 不把后端整屏 raw stderr 发给用户，只发归类后的人话；完整 stderr 已在 bridge 日志里
    await sendLong(ctx, `${adapterLabel} 出错：${sanitizeBackendError(text)}`);
    return text;
  }

  if (!text) {
    finalizeSuccess("");
    await ctx.reply(`${adapterLabel} 无输出。`, quote);
    return text;
  }

  finalizeSuccess(summarizeText(text, 240));
  const replies = detectQuickReplies(text);
  if (replies && text.length <= 4000) {
    const kb = new InlineKeyboard();
    for (const reply of replies) {
      let cbSuffix = reply;
      while (Buffer.byteLength(`reply:${cbSuffix}`, "utf-8") > 64) {
        cbSuffix = cbSuffix.slice(0, -1);
      }
      kb.text(reply, `reply:${cbSuffix}`);
    }
    if (hasMarkdownFormatting(text)) {
      await withRetry(
        () => ctx.reply(markdownToTelegramHTML(text), { reply_markup: kb, parse_mode: "HTML", ...quote }),
        { onParseFallback: () => ctx.reply(text, { reply_markup: kb, ...quote }) },
      );
    } else {
      await ctx.reply(text, { reply_markup: kb, ...quote });
    }
  } else if (text.length > 4000 && estimateCodeRatio(text) > 0.6) {
    const ext = detectCodeLang(text) || "txt";
    await sendDocument(chatId, Buffer.from(text, "utf-8"), `output.${ext}`);
    const preview = text.slice(0, 300).replace(/```\w*\n?/, "");
    await ctx.reply(`${preview}\n\n📎 完整输出 (${text.length} 字符) 见附件`, quote);
  } else {
    await sendLong(ctx, text);
  }

  return text;
}

export { SENDABLE_EXTS };
