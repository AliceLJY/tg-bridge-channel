import { describe, expect, test } from "bun:test";

import {
  buildClaudeContractLines,
  evaluateStartupSelfCheckResult,
  runHealthCheck,
} from "./doctor.js";

describe("doctor", () => {
  test("startup self-check only accepts a successful pong result", () => {
    expect(evaluateStartupSelfCheckResult({ success: true, text: "  pong\n" })).toEqual({
      ok: true,
      text: "pong",
      error: "",
    });

    expect(evaluateStartupSelfCheckResult({
      success: true,
      text: "Please run /login · API Error: 403 Request not allowed",
    })).toMatchObject({ ok: false });

    expect(evaluateStartupSelfCheckResult({ success: true, text: "ready" })).toMatchObject({
      ok: false,
    });

    expect(evaluateStartupSelfCheckResult({ success: false, text: "pong" })).toMatchObject({
      ok: false,
    });
  });

  test("reads A2A received count from loopGuard stats", async () => {
    const report = await runHealthCheck({
      a2aBus: {
        getStats: () => ({
          loopGuard: { received: 7 },
        }),
      },
    });

    expect(report).toContain("received=7");
  });

  test("reports reply local-contract failures without reading a control-key value", () => {
    const lines = buildClaudeContractLines({
      env: { CLAUDE_REPLY_ENGINE: "1", CLAUDE_CLI_PATH: "/synthetic/claude" },
      cliHelp: [
        "--bg, --background",
        "--resume",
        "--settings",
        "--append-system-prompt",
      ].join("\n"),
      stopHelp: "Usage: claude stop <id>",
      rosterSnapshot: { exists: true, parseOk: true, value: { workers: {} } },
      projectsDirExists: true,
      controlKeyFile: false,
    });
    expect(lines.join("\n")).toContain("control-key:missing-or-empty");
    expect(lines.join("\n")).not.toContain("token");
  });
});
