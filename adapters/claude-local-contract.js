// Claude CLI engines mix documented command-line flags with observed local
// implementation details. Keep those assumptions explicit and testable so a
// Claude Code upgrade fails visibly instead of silently dropping a reply.

export const CLAUDE_LOCAL_CONTRACT_REVISION = "2026-07-17";
export const TURN_END_SUBTYPE = "turn_duration";

const ENGINE_REQUIREMENTS = Object.freeze({
  sdk: [],
  print: ["print", "outputFormat", "resume", "settings", "appendSystemPrompt"],
  pool: ["background", "resume", "settings", "appendSystemPrompt", "stop"],
  reply: ["background", "resume", "settings", "appendSystemPrompt", "stop"],
});

export function selectClaudeLocalContractMode(env = process.env) {
  if (env.CLAUDE_REPLY_ENGINE === "1") return "reply";
  if (env.CLAUDE_PRINT_ENGINE === "1") return "print";
  if (env.CLAUDE_POOL_ENGINE === "1") return "pool";
  return "sdk";
}

export function detectClaudeCliCapabilities(helpText = "", stopHelpText = "") {
  return {
    background: helpText.includes("--bg") || helpText.includes("--background"),
    print: helpText.includes("--print"),
    outputFormat: helpText.includes("--output-format"),
    resume: helpText.includes("--resume"),
    settings: helpText.includes("--settings"),
    appendSystemPrompt: helpText.includes("--append-system-prompt"),
    stop: /Usage:\s+claude stop <id>/.test(stopHelpText),
  };
}

export function validateRosterShape(roster) {
  if (!roster || typeof roster !== "object" || Array.isArray(roster)) {
    return { ok: false, workerCount: 0, sessionWorkerCount: 0, problem: "roster:not-object" };
  }
  if (!roster.workers || typeof roster.workers !== "object" || Array.isArray(roster.workers)) {
    return { ok: false, workerCount: 0, sessionWorkerCount: 0, problem: "roster:workers-not-object" };
  }
  const workers = Object.values(roster.workers);
  if (workers.some((worker) => !worker || typeof worker !== "object" || Array.isArray(worker))) {
    return { ok: false, workerCount: workers.length, sessionWorkerCount: 0, problem: "roster:worker-not-object" };
  }
  const sessionWorkerCount = workers.filter((worker) => {
    const sessionId = worker.sessionId || worker.dispatch?.sessionId;
    return typeof sessionId === "string" && sessionId.length > 0;
  }).length;
  return { ok: true, workerCount: workers.length, sessionWorkerCount, problem: null };
}

export function inspectClaudeLocalContract({
  mode = "sdk",
  cliHelp = "",
  stopHelp = "",
  rosterExists = false,
  rosterParseOk = true,
  roster = null,
  projectsDirExists = false,
  controlKeyFile = false,
} = {}) {
  const normalizedMode = Object.hasOwn(ENGINE_REQUIREMENTS, mode) ? mode : "sdk";
  const capabilities = detectClaudeCliCapabilities(cliHelp, stopHelp);
  const problems = [];

  for (const capability of ENGINE_REQUIREMENTS[normalizedMode]) {
    if (!capabilities[capability]) problems.push(`cli:${capability}`);
  }

  let rosterCheck = null;
  if (normalizedMode === "pool" || normalizedMode === "reply") {
    if (!rosterExists) {
      problems.push("roster:missing");
    } else if (!rosterParseOk) {
      problems.push("roster:invalid-json");
    } else {
      rosterCheck = validateRosterShape(roster);
      if (!rosterCheck.ok) problems.push(rosterCheck.problem);
    }
  }

  if (normalizedMode !== "sdk" && !projectsDirExists) problems.push("projects:missing");
  if (normalizedMode === "reply" && !controlKeyFile) problems.push("control-key:missing-or-empty");

  return {
    ok: problems.length === 0,
    mode: normalizedMode,
    capabilities,
    roster: rosterCheck,
    problems,
  };
}

// Extract only text that can establish turn ownership. Tool-result-only user
// records intentionally do not open the gate.
export function extractUserEchoText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block?.type === "text" && typeof block.text === "string");
    return textBlock ? textBlock.text : null;
  }
  return null;
}

export function hasVisibleAssistantText(record) {
  return record?.type === "assistant"
    && Array.isArray(record.message?.content)
    && record.message.content.some((block) => block?.type === "text");
}

export function isSoftTurnEnd(record) {
  return hasVisibleAssistantText(record) && record.message?.stop_reason === "end_turn";
}

export function isHardTurnEnd(record) {
  return record?.type === "system" && record.subtype === TURN_END_SUBTYPE;
}

export function inspectTranscriptRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { kind: "invalid", recognized: false, terminal: false };
  }
  if (record.type === "user") {
    const text = extractUserEchoText(record.message?.content);
    if (text !== null) return { kind: "user_echo", recognized: true, terminal: false, text };
    const content = record.message?.content;
    const toolResultOnly = Array.isArray(content)
      && content.length > 0
      && content.every((block) => block?.type === "tool_result");
    return { kind: toolResultOnly ? "user_tool_result" : "user_other", recognized: toolResultOnly, terminal: false };
  }
  if (record.type === "assistant") {
    const content = record.message?.content;
    if (!Array.isArray(content)) return { kind: "assistant", recognized: false, terminal: false };
    const eventTypes = content
      .filter((block) => ["text", "thinking", "tool_use"].includes(block?.type))
      .map((block) => block.type);
    return {
      kind: "assistant",
      recognized: eventTypes.length > 0,
      terminal: isSoftTurnEnd(record),
      eventTypes,
    };
  }
  if (isHardTurnEnd(record)) {
    return { kind: "turn_duration", recognized: true, terminal: true };
  }
  return { kind: "ignored", recognized: true, terminal: false };
}
