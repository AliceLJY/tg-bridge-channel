// adapters/claude-event-map.js
// 把 Claude 的一条 message 映射成 bridge 统一事件。
//
// 关键:Agent SDK 的 query() 产出的 msg,和 `claude --print --output-format stream-json --verbose`
// 每行 JSON 的结构是【一致】的(SDK 本就是 CLI stream-json 的封装)。所以:
//   - adapters/claude.js(SDK 引擎,fallback)          : for await (msg of query()) yield* mapClaudeMessage(msg)
//   - adapters/cli-print-adapter.js(--print 引擎,新主线): readline(child.stdout) → JSON.parse → yield* mapClaudeMessage(msg)
// 两边共用这一份映射,单一真相源。从 claude.js._runQuery 抽出,行为逐字保留。
//
// 调用方约定:遇到 yield 出的 { type:"result" } 后自行 break(result 是一轮终点)。
// 本函数在检测到 SDK 把 API 400 当 success 返回时会 throw,让上层走 resume 重试。

import { stripMalformedToolCall } from "./sanitize-text.js";

const FILE_EXTS = "png|jpg|jpeg|gif|webp|pdf|docx|xlsx|svg";

export function* mapClaudeMessage(msg, { logger = console } = {}) {
  if (msg.type === "system" && msg.subtype === "init") {
    yield { type: "session_init", sessionId: msg.session_id };
  }

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "tool_use") {
        // AskUserQuestion → question 事件(bridge 渲染按钮)
        if (block.name === "AskUserQuestion" && block.input?.questions) {
          for (const q of block.input.questions) {
            yield {
              type: "question",
              question: q.question || "",
              header: q.header || "",
              options: (q.options || []).map(o => ({ label: o.label, description: o.description || "" })),
              multiSelect: q.multiSelect || false,
            };
          }
        }
        // Write/Edit 输出文件
        if ((block.name === "Write" || block.name === "Edit") && block.input?.file_path) {
          yield { type: "file_written", filePath: block.input.file_path, tool: block.name };
        }
        // Bash 命令里提取输出文件路径
        if (block.name === "Bash" && block.input?.command) {
          const cmd = block.input.command;
          const destRe = new RegExp(`(?:cp|mv)\\s+.*?((?:\\/|~\\/)[^\\s"']+\\.(?:${FILE_EXTS}))`, "gi");
          let dm;
          while ((dm = destRe.exec(cmd)) !== null) yield { type: "file_written", filePath: dm[1], tool: "Bash" };
          const scRe = new RegExp(`screencapture\\s+[^\\s]*\\s*((?:\\/|~\\/)[^\\s"']+\\.(?:${FILE_EXTS}))`, "gi");
          while ((dm = scRe.exec(cmd)) !== null) yield { type: "file_written", filePath: dm[1], tool: "Bash" };
          const tailRe = new RegExp(`((?:\\/|~\\/)(?:[\\w.\\-]+\\/)*[\\w.\\-\\u4e00-\\u9fff]+\\.(?:${FILE_EXTS}))\\s*$`, "gi");
          while ((dm = tailRe.exec(cmd)) !== null) yield { type: "file_written", filePath: dm[1], tool: "Bash" };
        }
        yield { type: "progress", toolName: block.name, input: block.input };
      } else if (block.type === "text" && block.text) {
        const clean = stripMalformedToolCall(block.text);  // 剥模型 malformed 的 <invoke> 文本 XML(见 sanitize-text.js)
        if (clean) yield { type: "text", text: clean };
      }
    }
  }

  // 工具结果里的图片(SDKUserMessage / tool_result)
  if (msg.type === "user") {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part.type === "image" && part.source?.data) {
              yield { type: "image", data: part.source.data, mediaType: part.source.media_type || "image/png", toolUseId: block.tool_use_id, source: "tool_result" };
            }
          }
        }
        if (block.type === "image" && block.source?.data) {
          yield { type: "image", data: block.source.data, mediaType: block.source.media_type || "image/png" };
        }
      }
    }
  }

  if (msg.type === "system" && msg.subtype === "files_persisted") {
    for (const f of msg.files || []) {
      yield { type: "file_persisted", filename: f.filename, fileId: f.file_id };
    }
  }

  if (msg.type === "result") {
    const resultText = msg.subtype === "success" ? (msg.result || "") : (msg.errors || []).join("\n");
    const u = msg.usage || {};
    const cacheInfo = `input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0} cacheRead=${u.cache_read_input_tokens ?? 0} cacheCreate=${u.cache_creation_input_tokens ?? 0}`;
    logger.log(`[claude-event-map] result: subtype=${msg.subtype} cost=${msg.total_cost_usd} ${cacheInfo} text=${resultText.slice(0, 200)}`);
    // SDK/CLI 把 API 400(invalid signature 等)当 success 返回 → 检测并抛,让上层重试
    if (resultText.startsWith("API Error:") && /invalid.*signature|invalid_request_error/i.test(resultText)) {
      throw new Error(resultText);
    }
    yield { type: "result", success: msg.subtype === "success", text: stripMalformedToolCall(resultText), cost: msg.total_cost_usd, duration: msg.duration_ms };
  }
}
