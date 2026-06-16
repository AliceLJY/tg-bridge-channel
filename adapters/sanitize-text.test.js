// adapters/sanitize-text.test.js
// stripMalformedToolCall:剥离模型偶发把工具调用吐成文本 XML 的 malformed 块。
// fixture 取自 2026-06-16 mccode2 会话 8fdba35a 的真实 jsonl(line 65/147)。

import { describe, expect, test } from "bun:test";
import { stripMalformedToolCall } from "./sanitize-text.js";

describe("stripMalformedToolCall", () => {
  // —— 真实 line 65:叙述 + 孤立 call + 两个 <invoke> 块 ——
  const REAL_LINE65 = `工具就绪。现在做 Stage 1 话题挖掘搜索:抓 The Conversation 原文(核心源)+ 搜 Alpha School 独立背景(为两源互证做准备)。

call
<invoke name="WebFetch">
<parameter name="url">https://theconversation.com/ai-schools-282464</parameter>
<parameter name="prompt">提取要点</parameter>
</invoke>
<invoke name="WebSearch">
<parameter name="query">Alpha School criticism</parameter>
</invoke>`;

  test("真实 line65:保留叙述、剥光 invoke/parameter/孤立 call", () => {
    const out = stripMalformedToolCall(REAL_LINE65);
    expect(out).toContain("工具就绪");
    expect(out).toContain("Stage 1");
    expect(out).not.toContain("<invoke");
    expect(out).not.toContain("</invoke>");
    expect(out).not.toContain("<parameter");
    expect(out).not.toContain("theconversation.com");
    expect(out.endsWith("准备)。")).toBe(true);
  });

  // —— 真实 line 147:几乎纯 malformed(开头就是 call、无实质叙述)→ 应整块丢弃 ——
  const REAL_LINE147 = `call
<invoke name="Bash">
<parameter name="command">grep -rinE "效率|混乱" ~/Downloads/hermes-shared/material-goldmine/ | head -12</parameter>
<parameter name="description">扫燃料仓留痕</parameter>
</invoke>`;

  test("纯 malformed 块 → 返回空串(调用点据此整块跳过)", () => {
    expect(stripMalformedToolCall(REAL_LINE147)).toBe("");
  });

  test("未闭合的 invoke(被 turn 截断)→ 删到末尾、保留前面叙述", () => {
    const t = `先做点检索\ncall\n<invoke name="Bash">\n<parameter name="command">grep something long...`;
    const out = stripMalformedToolCall(t);
    expect(out).toBe("先做点检索");
    expect(out).not.toContain("<invoke");
  });

  test("叙述夹在两个 invoke 之间 → 两段叙述都保留、XML 全去", () => {
    const t = `第一步\n<invoke name="Read"><parameter name="file_path">/a</parameter></invoke>\n第二步\n<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`;
    const out = stripMalformedToolCall(t);
    expect(out).toContain("第一步");
    expect(out).toContain("第二步");
    expect(out).not.toContain("<invoke");
    expect(out).not.toContain("name=");
  });

  test("兼容 antml: 前缀(用变量拼接,避免源码里出现字面标签)", () => {
    const ns = "antml:";
    const t = `做事\n<${ns}invoke name="Bash"><${ns}parameter name="command">ls</${ns}parameter></${ns}invoke>`;
    const out = stripMalformedToolCall(t);
    expect(out).toBe("做事");
    expect(out).not.toContain("invoke");
  });

  test("正常文本(无工具调用 XML)→ 原样返回", () => {
    const t = "这是一篇正常的文章正文,讲 AI 教育和儿童发展。";
    expect(stripMalformedToolCall(t)).toBe(t);
  });

  test("正常文本含散落尖括号 / HTML 标签 → 不动(不含 invoke name= 不触发)", () => {
    const t = "比较 a < b 和 c > d;用 <div> 包一下。";
    expect(stripMalformedToolCall(t)).toBe(t);
  });

  test("未闭合 function_calls 外层 → 不残留标签", () => {
    const ns = "antml:";
    const t = `<${ns}function_calls>\n<${ns}invoke name="Bash"><${ns}parameter name="command">ls</${ns}parameter></${ns}invoke>`;
    const out = stripMalformedToolCall(t);
    expect(out).toBe("");
    expect(out).not.toContain("function_calls");
  });

  test("null / undefined / 空串 → 安全", () => {
    expect(stripMalformedToolCall("")).toBe("");
    expect(stripMalformedToolCall(null)).toBe(null);
    expect(stripMalformedToolCall(undefined)).toBe(undefined);
  });
});
