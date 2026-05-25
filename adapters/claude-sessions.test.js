import { describe, expect, test } from "bun:test";
import { cleanUserTopic, extractUserText, listSessionFiles } from "./claude-sessions.js";

describe("claude-sessions", () => {
  test("cleanUserTopic strips bridge hint prefix", () => {
    expect(cleanUserTopic("[系统提示: x] 真问题")).toBe("真问题");
  });
  test("cleanUserTopic drops interrupted markers", () => {
    expect(cleanUserTopic("[Request interrupted by user]")).toBe("");
  });
  test("extractUserText reads text block from array content", () => {
    expect(extractUserText([{ type: "text", text: "hi" }])).toBe("hi");
  });
  test("extractUserText passes through string content", () => {
    expect(extractUserText("plain")).toBe("plain");
  });
  test("listSessionFiles returns an array without throwing", () => {
    const r = listSessionFiles(3);
    expect(Array.isArray(r)).toBe(true);
  });
});
