import { describe, expect, test } from "bun:test";
import { cleanUserTopic, extractUserText, listSessionFiles, probeSessionFile, findAllSessionFiles } from "./claude-sessions.js";

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

// probeSessionFile 三态(2026-07-17 codex review P1)/findAllSessionFiles 全量(P2)。
// 这两个函数吃真实 ~/.claude/projects,真实 FS 行为只测"确认不存在"与"找到"两态可稳定复现的部分:
// 拿一个必然不存在的随机 sid 验证 probe 返回 {found:null} 且家目录正常时 scanFailed=false。
describe("probeSessionFile / findAllSessionFiles(真实 FS)", () => {
  test("必然不存在的 sid → found:null + scanFailed:false(家目录可读时是'确认不存在',可判幽灵)", () => {
    const r = probeSessionFile("no-such-session-id-000000");
    expect(r.found).toBe(null);
    expect(r.scanFailed).toBe(false);
  });

  test("findAllSessionFiles 对不存在的 sid → 空数组", () => {
    expect(findAllSessionFiles("no-such-session-id-000000")).toEqual([]);
  });
});
