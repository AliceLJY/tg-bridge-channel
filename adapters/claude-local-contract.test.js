import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_LOCAL_CONTRACT_REVISION,
  inspectClaudeLocalContract,
  inspectTranscriptRecord,
  validateRosterShape,
} from "./claude-local-contract.js";
import { JsonlTailReader, readLastTurnState } from "./cli-pool.js";
import { mapEvents as mapPoolEvents } from "./cli-pool-adapter.js";
import { filterPrintEvent } from "./cli-print-adapter.js";
import { mapClaudeMessage } from "./claude-event-map.js";

const FIXTURE_DIR = new URL("../test/fixtures/claude-local-contract/", import.meta.url);
const fixturePath = (name) => fileURLToPath(new URL(name, FIXTURE_DIR));
const readJson = (name) => JSON.parse(readFileSync(fixturePath(name), "utf8"));
const readJsonl = (name) => readFileSync(fixturePath(name), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const CLI_HELP_FIXTURE = [
  "--bg, --background",
  "--print",
  "--output-format <format>",
  "--resume [value]",
  "--settings <file-or-json>",
  "--append-system-prompt <prompt>",
].join("\n");
const STOP_HELP_FIXTURE = "Usage: claude stop <id>";

describe("Claude local-contract fixtures", () => {
  test("revision is explicit and synthetic roster matches the observed shape", () => {
    expect(CLAUDE_LOCAL_CONTRACT_REVISION).toBe("2026-07-17");
    expect(validateRosterShape(readJson("roster.json"))).toMatchObject({
      ok: true,
      workerCount: 1,
      sessionWorkerCount: 1,
    });
  });

  test("pool/reply requirements fail visibly when an internal contract is absent", () => {
    const base = {
      cliHelp: CLI_HELP_FIXTURE,
      stopHelp: STOP_HELP_FIXTURE,
      rosterExists: true,
      rosterParseOk: true,
      roster: readJson("roster.json"),
      projectsDirExists: true,
      controlKeyFile: true,
    };
    expect(inspectClaudeLocalContract({ ...base, mode: "pool" }).ok).toBe(true);
    expect(inspectClaudeLocalContract({ ...base, mode: "reply" }).ok).toBe(true);
    expect(inspectClaudeLocalContract({ ...base, mode: "reply", controlKeyFile: false }).problems)
      .toContain("control-key:missing-or-empty");
    expect(inspectClaudeLocalContract({ ...base, mode: "pool", rosterParseOk: false }).problems)
      .toContain("roster:invalid-json");
  });

  test("documented print flags are checked without requiring daemon internals", () => {
    const result = inspectClaudeLocalContract({
      mode: "print",
      cliHelp: CLI_HELP_FIXTURE,
      projectsDirExists: true,
    });
    expect(result.ok).toBe(true);
    expect(result.roster).toBe(null);
  });

  test("record classifier covers user echo, tool result, assistant blocks, and both terminal paths", () => {
    const soft = readJsonl("transcript-soft-end.jsonl").map(inspectTranscriptRecord);
    expect(soft[0]).toMatchObject({ kind: "user_echo", recognized: true, terminal: false });
    expect(soft[1]).toMatchObject({ kind: "assistant", terminal: false, eventTypes: ["thinking"] });
    expect(soft[2]).toMatchObject({ kind: "assistant", terminal: true, eventTypes: ["tool_use", "text"] });

    const arrayEcho = readJsonl("transcript-array-echo.jsonl").map(inspectTranscriptRecord);
    expect(arrayEcho[0]).toMatchObject({ kind: "user_tool_result", recognized: true });
    expect(arrayEcho[2]).toMatchObject({ kind: "user_echo", text: "fixture prompt" });
    expect(arrayEcho[4]).toMatchObject({ kind: "turn_duration", terminal: true });
  });

  test("soft end is complete for both live tailing and next-turn resume preflight", async () => {
    const path = fixturePath("transcript-soft-end.jsonl");
    const events = [];
    for await (const event of new JsonlTailReader(path).readUntilTurnEnd({
      expectUserText: "fixture prompt",
      pollMs: 5,
      hardLimitMs: 500,
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "turn_end", soft: true });
    expect(readLastTurnState(path)).toMatchObject({ exists: true, complete: true });
  });

  test("tool-result-only user stays gated until array text echo, then turn_duration completes", async () => {
    const path = fixturePath("transcript-array-echo.jsonl");
    const events = [];
    for await (const event of new JsonlTailReader(path).readUntilTurnEnd({
      expectUserText: "fixture prompt",
      pollMs: 5,
      hardLimitMs: 500,
    })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "text").map((event) => event.text))
      .toEqual(["fixture answer"]);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", durationMs: 42 });
  });

  test("pool transcript events map to one truthful final result", async () => {
    const state = { accumulatedText: "" };
    const mapped = [];
    for await (const event of new JsonlTailReader(fixturePath("transcript-soft-end.jsonl")).readUntilTurnEnd({
      expectUserText: "fixture prompt",
      pollMs: 5,
      hardLimitMs: 500,
    })) {
      mapped.push(...mapPoolEvents(event, state));
    }
    expect(mapped.some((event) => event.type === "progress" && event.toolName === "Write")).toBe(true);
    expect(mapped.some((event) => event.type === "file_written" && event.filePath === "/tmp/fixture-output.txt")).toBe(true);
    expect(mapped.at(-1)).toMatchObject({ type: "result", success: true, text: "fixture answer" });
  });

  test("stream-json fixture maps init, text, and success result deterministically", () => {
    const state = { sawInit: false, accumulatedText: "" };
    const mapped = [];
    const logger = { log() {} };
    for (const message of readJsonl("stream-result.jsonl")) {
      for (const event of mapClaudeMessage(message, { logger })) {
        const filtered = filterPrintEvent(event, state);
        if (filtered.emit) mapped.push(filtered.emit);
      }
    }
    expect(mapped.map((event) => event.type)).toEqual(["session_init", "text", "result"]);
    expect(mapped.at(-1)).toMatchObject({ success: true, text: "fixture final answer", duration: 42 });
  });
});
