import { describe, expect, test } from "bun:test";

import {
  isCommandForAnotherBot,
  parseMentionFirstCommand,
  parseTelegramCommandTarget,
} from "./telegram-command-routing.js";

describe("Telegram command routing", () => {
  test("parses slash commands with optional bot target", () => {
    expect(parseTelegramCommandTarget("/new@AgentA_bot")).toEqual({
      command: "new",
      targetUsername: "AgentA_bot",
    });
    expect(parseTelegramCommandTarget("/discuss@AgentB_bot status")).toEqual({
      command: "discuss",
      targetUsername: "AgentB_bot",
    });
    expect(parseTelegramCommandTarget("/status")).toEqual({
      command: "status",
      targetUsername: null,
    });
  });

  test("detects commands addressed to a different bot case-insensitively", () => {
    expect(isCommandForAnotherBot("/new@AgentA_bot", "AgentB_bot")).toBe(true);
    expect(isCommandForAnotherBot("/new@AgentB_bot", "agentb_bot")).toBe(false);
    expect(isCommandForAnotherBot("/new", "AgentB_bot")).toBe(false);
    expect(isCommandForAnotherBot("hello @Other_bot", "AgentB_bot")).toBe(false);
  });

  test("parses mention-first commands addressed to this bot", () => {
    expect(parseMentionFirstCommand("@AgentB_bot /discuss on", "AgentB_bot")).toEqual({
      command: "discuss",
      targetUsername: "AgentB_bot",
      args: "on",
    });
    expect(parseMentionFirstCommand("@agentb_bot /discuss@AgentB_bot status", "AgentB_bot")).toEqual({
      command: "discuss",
      targetUsername: "AgentB_bot",
      args: "status",
    });
    expect(parseMentionFirstCommand("@Other_bot /discuss on", "AgentB_bot")).toBeNull();
    expect(parseMentionFirstCommand("@AgentB_bot hello", "AgentB_bot")).toBeNull();
  });
});
