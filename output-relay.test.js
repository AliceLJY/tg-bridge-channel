import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  authorizeRelayFile,
  detectCodeLang,
  estimateCodeRatio,
  extractFilePathsFromText,
  extractProgressBroadcasts,
  isAutoFileRelayAllowed,
  sanitizeBackendError,
  sendCapturedOutputs,
  stripProgressBroadcasts,
} from "./output-relay.js";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeRelayFixture() {
  const parent = mkdtempSync(join(tmpdir(), "tg-bridge-relay-"));
  tempDirs.push(parent);
  const root = join(parent, "workspace");
  mkdirSync(root);
  return { parent, root };
}

describe("output relay helpers", () => {
  test("extracts existing absolute and home-relative file paths without duplicates", () => {
    const home = "/tmp/tg-bridge-home";
    const existingPaths = new Set([
      `${home}/Desktop/report.md`,
      "/tmp/tg-bridge-abs/result.png",
    ]);
    const files = [{ filePath: `${home}/Desktop/report.md`, source: "persisted" }];
    const exists = (path) => existingPaths.has(path);

    extractFilePathsFromText(
      `生成好了: ~/Desktop/report.md 和 /tmp/tg-bridge-abs/result.png，重复 ~/Desktop/report.md`,
      files,
      { home, exists },
    );

    expect(files).toEqual([
      { filePath: `${home}/Desktop/report.md`, source: "persisted" },
      { filePath: "/tmp/tg-bridge-abs/result.png", source: "text_scan" },
    ]);
  });

  test("matches paths whose directory segments contain CJK, without merging neighbouring paths", () => {
    const home = "/tmp/tg-bridge-home";
    const cjk = `${home}/Desktop/AI产出/2026-08-19-多端联络图/多端联络图-1-底座.png`;
    const existingPaths = new Set([cjk, "/tmp/a/b.png", "/tmp/a/c.png"]);
    const files = [];

    extractFilePathsFromText(
      `截图在 ~/Desktop/AI产出/2026-08-19-多端联络图/多端联络图-1-底座.png，另外 /tmp/a/b.png 和 /tmp/a/c.png`,
      files,
      { home, exists: (path) => existingPaths.has(path) },
    );

    expect(files.map((f) => f.filePath)).toEqual(["/tmp/a/b.png", "/tmp/a/c.png", cjk]);
  });

  test("detects code-heavy output and normalizes common code block languages", () => {
    const text = "说明\n```typescript\nconst value: string = 'ok';\n```\n";

    expect(estimateCodeRatio(text)).toBeGreaterThan(0.6);
    expect(detectCodeLang(text)).toBe("ts");
  });
});

describe("automatic file relay policy", () => {
  test("allows owner private turns and only explicitly trusted owner-triggered groups", () => {
    const owner = { id: 42, is_bot: false };
    const bot = { id: 99, is_bot: true };
    const trustedChatIds = ["-1001"];

    expect(isAutoFileRelayAllowed({
      chat: { id: 42, type: "private" },
      from: owner,
      ownerId: 42,
      trustedChatIds,
    })).toBe(true);
    expect(isAutoFileRelayAllowed({
      chat: { id: -1001, type: "supergroup" },
      from: owner,
      ownerId: 42,
      trustedChatIds,
    })).toBe(true);
    expect(isAutoFileRelayAllowed({
      chat: { id: -1002, type: "group" },
      from: owner,
      ownerId: 42,
      trustedChatIds,
    })).toBe(false);
    expect(isAutoFileRelayAllowed({
      chat: { id: -1001, type: "supergroup" },
      from: bot,
      ownerId: 42,
      trustedChatIds,
    })).toBe(false);
    expect(isAutoFileRelayAllowed({
      chat: { id: 42, type: "channel" },
      from: owner,
      ownerId: 42,
      trustedChatIds,
    })).toBe(false);
  });

  test("authorizes only ordinary non-sensitive files inside the real working directory", () => {
    const { parent, root } = makeRelayFixture();
    const outputDir = join(root, "dist");
    mkdirSync(outputDir);
    const valid = join(outputDir, "report.pdf");
    writeFileSync(valid, "report");

    const hiddenDir = join(root, ".private");
    mkdirSync(hiddenDir);
    const hidden = join(hiddenDir, "report.pdf");
    writeFileSync(hidden, "hidden");
    const hiddenFile = join(root, ".report.pdf");
    writeFileSync(hiddenFile, "hidden");

    const configFile = join(root, "config.json");
    writeFileSync(configFile, "{}");
    const oauthFile = join(root, "oauth_creds.json");
    writeFileSync(oauthFile, "{}");
    const prefixedTokenFile = join(root, "google-token.json");
    writeFileSync(prefixedTokenFile, "{}");
    const logFile = join(root, "run.log");
    writeFileSync(logFile, "log");
    const oversized = join(root, "large.pdf");
    writeFileSync(oversized, "12345");
    const fakeFile = join(root, "folder.pdf");
    mkdirSync(fakeFile);

    const outside = join(parent, "outside.pdf");
    writeFileSync(outside, "outside");
    const escape = join(root, "escape.pdf");
    symlinkSync(outside, escape);

    const uploadDir = join(root, "files");
    mkdirSync(uploadDir);
    const inboundUpload = join(uploadDir, "inbound.pdf");
    writeFileSync(inboundUpload, "upload");
    const similarDir = join(root, "files-safe");
    mkdirSync(similarDir);
    const similarArtifact = join(similarDir, "report.pdf");
    writeFileSync(similarArtifact, "report");

    expect(authorizeRelayFile(valid, { rootDir: root }).ok).toBe(true);
    expect(authorizeRelayFile("dist/report.pdf", { rootDir: root }).ok).toBe(true);
    expect(authorizeRelayFile(outside, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(escape, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(hidden, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(hiddenFile, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(configFile, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(oauthFile, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(prefixedTokenFile, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(logFile, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(oversized, { rootDir: root, maxBytes: 4 }).ok).toBe(false);
    expect(authorizeRelayFile(fakeFile, { rootDir: root }).ok).toBe(false);
    expect(authorizeRelayFile(inboundUpload, { rootDir: root, fileDir: uploadDir }).ok).toBe(false);
    expect(authorizeRelayFile(similarArtifact, { rootDir: root, fileDir: uploadDir }).ok).toBe(true);
  });

  test("applies the same boundary to text_scan and file_written candidates before reading", async () => {
    const { parent, root } = makeRelayFixture();
    const outputDir = join(root, "dist");
    mkdirSync(outputDir);
    const fromText = join(outputDir, "summary.md");
    const fromTool = join(outputDir, "diagram.svg");
    const sensitive = join(root, "token.json");
    const outside = join(parent, "outside.md");
    writeFileSync(fromText, "summary");
    writeFileSync(fromTool, "<svg></svg>");
    writeFileSync(sensitive, "blocked");
    writeFileSync(outside, "blocked");

    const sent = [];
    const warnings = [];
    await sendCapturedOutputs({
      chatId: 42,
      resultSuccess: true,
      capturedImages: [],
      capturedFiles: [
        { filePath: fromText, source: "text_scan" },
        { filePath: outside, source: "text_scan" },
        { filePath: fromTool, source: "Write" },
        { filePath: sensitive, source: "Write" },
      ],
      imageFloodSuppressed: false,
      allowFileRelay: true,
      relayRoot: root,
      sendPhoto: async (_chatId, _payload, name) => sent.push(name),
      sendDocument: async (_chatId, _payload, name) => sent.push(name),
      logger: {
        log() {},
        warn(message) { warnings.push(message); },
        error() {},
      },
      sleepMs: 0,
    });

    expect(sent).toEqual(["summary.md", "diagram.svg"]);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((message) => message.includes("安全策略"))).toBe(true);
    expect(warnings.join("\n")).not.toContain(parent);
  });

  test("does not read candidates when the turn target is not authorized", async () => {
    const { root } = makeRelayFixture();
    const file = join(root, "report.md");
    writeFileSync(file, "report");
    let reads = 0;

    await sendCapturedOutputs({
      chatId: -1001,
      resultSuccess: true,
      capturedImages: [],
      capturedFiles: [{ filePath: file, source: "file_written" }],
      imageFloodSuppressed: false,
      allowFileRelay: false,
      relayRoot: root,
      sendPhoto: async () => {},
      sendDocument: async () => {},
      readFile: () => { reads++; return Buffer.from("unexpected"); },
      logger: { log() {}, warn() {}, error() {} },
    });

    expect(reads).toBe(0);
  });

  test("does not decode or send captured images when the turn target is not authorized", async () => {
    let dataReads = 0;
    let sends = 0;
    const image = {
      get data() {
        dataReads++;
        return Buffer.from("private image").toString("base64");
      },
      mediaType: "image/png",
      source: "generated",
    };

    await sendCapturedOutputs({
      chatId: -1001,
      resultSuccess: true,
      capturedImages: [image],
      capturedFiles: [],
      imageFloodSuppressed: false,
      allowFileRelay: false,
      relayRoot: "/unused",
      sendPhoto: async () => { sends++; },
      sendDocument: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    });

    expect(dataReads).toBe(0);
    expect(sends).toBe(0);
  });

  test("sends captured images for an authorized turn", async () => {
    const sent = [];
    const payload = Buffer.from("generated image");

    await sendCapturedOutputs({
      chatId: 42,
      resultSuccess: true,
      capturedImages: [{
        data: payload.toString("base64"),
        mediaType: "image/png",
        source: "generated",
      }],
      capturedFiles: [],
      imageFloodSuppressed: false,
      allowFileRelay: true,
      relayRoot: "/unused",
      sendPhoto: async (chatId, imagePayload, name) => {
        sent.push({ chatId, imagePayload, name });
      },
      sendDocument: async () => {},
      logger: { log() {}, warn() {}, error() {} },
      sleepMs: 0,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(42);
    expect(sent[0].imagePayload).toEqual(payload);
    expect(sent[0].name).toBe("output.png");
  });
});

describe("sanitizeBackendError", () => {
  test("collapses Codex network / TLS stderr into one human line, no raw trace", () => {
    const raw = [
      "Codex Exec exited with code 1: Reading prompt from stdin...",
      "ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed",
      "ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: tls handshake eof",
    ].join("\n");

    const out = sanitizeBackendError(raw);

    expect(out).toContain("连接中断");
    expect(out).toContain("完整日志见后台");
    expect(out).not.toContain("rmcp");
    expect(out).not.toContain("tls handshake");
    expect(out).not.toContain("websocket");
  });

  test("recognizes apply_patch stale context and thread-not-found together, hides file names", () => {
    const raw = [
      "apply_patch verification failed: Failed to find expected lines in /Users/x/.codex/memories/MEMORY.md",
      "failed to record rollout items: thread 019e5598-79cf-7412-8e99-4ab9ac7866d6 not found",
    ].join("\n");

    const out = sanitizeBackendError(raw);

    expect(out).toContain("上下文已过期");
    expect(out).toContain("短暂不一致");
    expect(out).not.toContain("MEMORY.md");
    expect(out).not.toContain("019e5598");
  });

  test("truncates unrecognized errors to the first line, never dumps the full trace", () => {
    const raw = "突然冒出来一个没见过的错误\n" + "stack frame ...\n".repeat(50);

    const out = sanitizeBackendError(raw);

    expect(out).toContain("突然冒出来一个没见过的错误");
    expect(out).toContain("完整日志见后台");
    expect(out).not.toContain("stack frame");
    expect(out.length).toBeLessThan(230);
  });

  test("returns a friendly placeholder for empty / nullish input", () => {
    expect(sanitizeBackendError("")).toBe("后端未返回错误详情");
    expect(sanitizeBackendError(null)).toBe("后端未返回错误详情");
    expect(sanitizeBackendError(undefined)).toBe("后端未返回错误详情");
  });
});

describe("progress broadcast (PB)", () => {
  test("extracts complete PB lines across streaming chunks, keeps partial line buffered", () => {
    const r1 = extractProgressBroadcasts("正文一行\n::PB:: 阶段一 图生");
    expect(r1.messages).toEqual([]);
    expect(r1.buffer).toBe("::PB:: 阶段一 图生");

    const r2 = extractProgressBroadcasts(r1.buffer + "成完成\n普通正文\n::PB:: 阶段二 排版\n");
    expect(r2.messages).toEqual(["阶段一 图生成完成", "阶段二 排版"]);
    expect(r2.buffer).toBe("");
  });

  test("only matches the exact line-start ::PB:: prefix, never normal prose", () => {
    const r = extractProgressBroadcasts(
      "句中出现 ::PB:: 不在行首不算\n我们讨论 core_task_progress: 这种也不算\n",
    );
    expect(r.messages).toEqual([]);
    expect(r.buffer).toBe("");
  });

  test("strips broadcast lines from the final result body and collapses blank runs", () => {
    const body = "开头\n::PB:: 阶段一\n\n正文段落\n::PB:: 阶段二\n结尾";
    expect(stripProgressBroadcasts(body)).toBe("开头\n\n正文段落\n\n结尾");
  });
});
