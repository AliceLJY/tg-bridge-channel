<div align="center">

# tg-bridge-channel

**Self-hosted Telegram bridge for AI coding agents — the chat IS the terminal.**

*Drive Claude Code / Codex / Gemini from a Telegram chat, backed by `claude --bg` Agent View background sessions for subscription-billed Claude Code, and the A2A-TG envelope protocol for multi-agent collaboration in group chats.*

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![Telegram](https://img.shields.io/badge/Interface-Telegram-26A5E4?logo=telegram)](https://telegram.org/)

**English** | [简体中文](README_CN.md)

</div>

---

## What it is

`tg-bridge-channel` runs AI coding agents as Telegram bots. Each bot is a full agent session you talk to from your phone or desktop — the chat *is* the terminal. It supports three modes:

- **Single-agent control** — one Claude Code / Codex / Gemini session per bot, driven over Telegram.
- **Parallel sessions** — N independent bots in one group, each its own session, with shared context (SQLite/Redis).
- **Heterogeneous multi-agent collaboration** _(experimental, disabled by default — set `a2aEnabled` to opt in)_ — Claude, Codex, and Gemini bots talking to each other in a group via the A2A-TG envelope protocol, with generation-counted loop suppression.

The **primary, battle-tested path** is single-agent private-chat control of Claude Code via the pool engine below. Parallel sessions and A2A collaboration work but are experimental; the Gemini backend and the `local-agent` executor are compatibility layers that see far less real-world use.

## Engine layer

The `claude` backend ships two interchangeable engine implementations, selected at runtime by the `CLAUDE_POOL_ENGINE` environment variable:

| Mode | Implementation | How it works |
|---|---|---|
| default | `adapters/claude.js` | Programmatic adapter built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/agent-sdk). |
| `CLAUDE_POOL_ENGINE=1` | `adapters/cli-pool-adapter.js` | Per-**turn** `claude --bg` fork workers built on [background sessions](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/agent-view) (Agent View). |

The pool engine spawns one short-lived `claude --bg` worker **per turn**: each inbound Telegram message launches `claude --bg [--resume <session-id>] "<prompt>"`, which forks a new session inheriting the full conversation history, streams the reply back by tailing the forked session's local transcript file, and stops the worker when the turn completes. The bridge persists the forked session id per chat and resumes it on the next message, so the conversation stays continuous across turns. Per-chat `/model`, `/effort` and `/dir` preferences plus the bridge's system-prompt scaffold are passed to every spawn as plain CLI flags.

Two practical caveats of the fork-per-turn design:

- **Quota grows with conversation length.** Every turn re-forks the full history, so very long conversations consume subscription usage superlinearly. Start a fresh session (`/new`) when switching topics.
- **A turn timeout does not kill the task.** If a long-running task produces no transcript output for `CLI_POOL_TURN_TIMEOUT_MS` (default 10 min), the bridge reports a timeout but deliberately leaves the worker running — its output keeps landing in the session transcript, and your next message forks from that same session and inherits everything written in the meantime. Normal completion and the Stop button still stop the worker immediately.

The backend name stays `claude` in both modes, so all orchestration (`backendName === "claude"` checks for approval / labels / A2A / cron) is unchanged. Switching engines is a per-process environment variable; rolling back is removing it.

> The pool engine relies on the official `claude` Agent View infrastructure: the per-user supervisor / spare-process warmup, the local `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` transcript files, and the subscription-usage billing that Anthropic [documents for background sessions](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/agent-view#limitations). It does not install plugins, does not change credentials, and does not bypass any quota — each background session counts toward your Claude subscription usage just like an interactive session you opened yourself.

> An earlier interactive channel-plugin engine (`CLAUDE_CHANNEL_ENGINE=1`) used a local Model Context Protocol server modeled on Claude Code's built-in fakechat channel. It was removed in May 2026 in favor of the Agent View based pool engine; see git history before May 2026 for the channel-plugin engine implementation.

## Quick start

```bash
# 1. install dependencies
bun install

# 2. configure
cp config.example.json config.json
# edit config.json: set ownerTelegramId and backends.<engine>.telegramBotToken

# 3. run (default SDK engine)
bun run start --backend claude --config config.json
```

To run the **pool engine** (recommended; subscription-billed background sessions):

```bash
CLAUDE_POOL_ENGINE=1 bun run start --backend claude --config config.json
```

## Multi-instance

Each bot instance uses its own config file (`config.json`, `config-2.json`, …) with a distinct bot token and sessions database. Launch agent templates for always-on operation live in `launchd/`.

## Configuration

See `config.example.json` for the full schema. Key fields:

- `ownerTelegramId` — only this user can drive the bot.
- `backends.<claude|codex|gemini>.telegramBotToken` — bot token per backend.
- `sharedContextBackend` — `sqlite` or `redis` for cross-bot shared memory.
- `a2aEnabled` / `a2aPorts` — enable A2A-TG inter-bot messaging.

## Security

The `claude --bg` engine runs with `--permission-mode bypassPermissions`, so the bot never stalls on permission prompts. To stop that from meaning "the bot will run anything", every `--bg` worker is launched with an injected `PreToolUse` hook (`scripts/guard-destructive-bash.sh`) that hard-blocks a small set of catastrophic, irreversible Bash commands: recursive deletion of `/`, `~`, `$HOME` or a top-level system directory; `mkfs`; `dd` onto a block device; redirecting onto a block device; fork bombs; and `shred` of a device. Everyday commands — including `rm -rf node_modules` — pass untouched.

The hook is injected per session via `--settings` (inline JSON), so it never touches your own `~/.claude/settings.json`. Set `CLI_POOL_DESTRUCTIVE_GUARD=0` to disable it (not recommended for public-facing deployments).

This is a hand brake, not a sandbox: the blocklist only catches straightforward forms and can be bypassed by obfuscated commands (`base64 -d | sh`, variable splicing, spawning a subprocess). For real isolation, run the bot in a container, under a restricted account, or with a constrained working directory.

## A2A-TG protocol

The inter-bot envelope protocol is specified in [docs/a2a-tg-v1.md](docs/a2a-tg-v1.md). It is inspired by — but not compatible with — the official [A2A protocol](https://a2a-protocol.org); it adds generation-based loop suppression and chat-scoped idempotency for the IM scenario.

## Tests

```bash
bun test
```

## Ecosystem

- [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) — original Telegram bridge using A2A-TG protocol
- [wechat-ai-bridge](https://github.com/AliceLJY/wechat-ai-bridge) — same idea on WeChat
- [recallnest](https://github.com/AliceLJY/recallnest) — shared memory MCP across Claude/Codex/Gemini

## License

MIT — see [LICENSE](LICENSE).
