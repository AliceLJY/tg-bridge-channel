import { describe, expect, test } from "bun:test";

import { buildClaudeContractLines, runHealthCheck } from "./doctor.js";

describe("doctor", () => {
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
