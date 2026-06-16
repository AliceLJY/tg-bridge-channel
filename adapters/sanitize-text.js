// adapters/sanitize-text.js
// 剥离模型偶发的 "malformed tool call"——模型把工具调用吐成了文本 XML
// (invoke/parameter/function_calls 那种标签),而不是发起真正的 tool_use。
//
// 背景(2026-06-16 实测,mccode2 会话 8fdba35a):Opus 4.8 在超长上下文 + 密集工具调用
// (如 content-alchemy 多 stage)下偶发把工具调用写成文本。CC harness 会检测到、注入
// "Your tool call was malformed and could not be parsed. Please retry.",模型下一轮即
// 重试成功 —— 任务本身能完成、工具真的执行了。但这段失败尝试落在 assistant 的 text 块里,
// bridge 各引擎(reply/pool/print-SDK)的 text/result 路径都会无条件把它收进发给用户的回复,
// 用户看到一坨 XML 噪音。本函数在累积/回传前剥掉它。
//
// 高特异性:invoke/parameter/function_calls 是工具调用 XML 的精确格式,正常中文正文不会
// 自然出现 → 不误杀普通文本(只含散落尖括号/HTML 标签的不动)。
// 已知边界:若 text 里【刻意展示】这种工具调用 XML(如讲工具调用格式的代码示例),也会被剥;
//   实际影响小——文章正文是 Write 到文件的、不过本函数,只有对话回复里直接贴 XML 才会中。
// jsonl/stream-json 每行是完整 message,text 块到达时是完整的(非流式半截),整块正则剥离可靠。

// 闭合的 <invoke name="...">...</invoke>(兼容可选 antml: 前缀)
const INVOKE_BLOCK = /<(?:antml:)?invoke\s+name="[^"]*">[\s\S]*?<\/(?:antml:)?invoke>/g;
// 闭合的 <function_calls> 外层包裹
const FN_CALLS_BLOCK = /<(?:antml:)?function_calls>[\s\S]*?<\/(?:antml:)?function_calls>/g;
// 被 turn 截断、未闭合的尾巴:从 <invoke 一直到文本结束
const INVOKE_UNCLOSED = /<(?:antml:)?invoke\s+name="[^"]*">[\s\S]*$/;
// 残留的孤立 function_calls 开/闭标签(未闭合外层、或内部 invoke 已删后剩的壳)
const FN_CALLS_TAG = /<\/?(?:antml:)?function_calls>/g;
// 紧贴 XML 之前那行孤立的 "call"(模型常写一行 call 再吐 XML);靠后面的 XML 锚定,
// 不误删正文里当普通词用的 "call"。必须在删 XML 之前先删它(否则锚没了)。
const LONE_CALL = /(^|\n)[ \t]*call[ \t]*(?=\n+\s*<(?:antml:)?(?:invoke|function_calls)\b)/gi;
// 检测门槛(与剥离正则同口径):invoke 或 function_calls 任一即触发
const HAS_TOOLCALL = /<(?:antml:)?(?:invoke\s+name=|function_calls\b)/;
const HAS_INVOKE = /<(?:antml:)?invoke\s+name=/;

/**
 * 剥离 text 里模型 malformed 的工具调用 XML。
 * @param {string} text
 * @returns {string} 剥离后的文本(已 trim);非字符串原样返回;整块都是 XML 时返回 ""
 */
export function stripMalformedToolCall(text) {
  if (typeof text !== "string") return text;
  if (!HAS_TOOLCALL.test(text)) return text;  // 绝大多数正常文本走这条快速返回
  let t = text;
  t = t.replace(LONE_CALL, "$1");      // 1) 先删 XML 前的孤立 "call"(此时 XML 还在,锚得住)
  t = t.replace(FN_CALLS_BLOCK, "");   // 2) 删闭合的 <function_calls>...</function_calls>
  t = t.replace(INVOKE_BLOCK, "");     // 3) 删闭合的 <invoke>...</invoke>
  if (HAS_INVOKE.test(t)) t = t.replace(INVOKE_UNCLOSED, "");  // 4) 残留未闭合 <invoke → 删到末尾
  t = t.replace(FN_CALLS_TAG, "");     // 5) 残留的孤立 function_calls 标签(未闭合外层等)
  return t.replace(/\n{3,}/g, "\n\n").trim();  // 收尾:压多余空行 + trim
}
