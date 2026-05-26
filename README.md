<div align="center">

# tg-bridge-channel

**Self-hosted Telegram bridge for AI coding agents — the chat IS the terminal.**

*Drive Claude Code / Codex / Gemini from a Telegram chat, backed by `claude --bg` daemon control RPC for subscription-billed Claude Code sessions, and the A2A-TG envelope protocol for multi-agent collaboration in group chats.*

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
- **Heterogeneous multi-agent collaboration** — Claude, Codex, and Gemini bots talking to each other in a group via the A2A-TG envelope protocol, with generation-counted loop suppression.

## Engine layer

The `claude` backend ships two interchangeable engine implementations, selected at runtime by the `CLAUDE_POOL_ENGINE` environment variable:

| Mode | Implementation | How it works |
|---|---|---|
| default | `adapters/claude.js` | Programmatic adapter built on the Claude Agent SDK. |
| `CLAUDE_POOL_ENGINE=1` | `adapters/cli-pool-adapter.js` | Per-chat `claude --bg` background sessions, driven through the daemon control RPC. |

The pool engine starts a `claude --bg` session per Telegram chat. Inbound Telegram messages reach the worker through the daemon control socket (`/tmp/cc-daemon-501/<rand>/control.sock`) via `op:reply`, which is the same underlying RPC the agent-view peek panel uses to talk to background sessions. The bridge tails the session's local `.jsonl` file to consume structured user / assistant / tool events back to Telegram.

The backend name stays `claude` in both modes, so all orchestration (`backendName === "claude"` checks for approval / labels / A2A / cron) is unchanged. Switching engines is a per-process environment variable; rolling back is removing it.

> The pool engine relies on the official `claude` daemon's spare-process pool for cold-start warmup, on `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` for structured output, and on subscription-billed background sessions (per Anthropic's published billing rules for `claude --bg`). It does not require any plugin install.

> An earlier interactive channel-plugin engine (`CLAUDE_CHANNEL_ENGINE=1`) used a Model Context Protocol server modeled on Claude Code's built-in fakechat channel. That engine was removed in May 2026 due to per-message cold-start overhead; see git history (`adapters/claude-channel.js`, `agent/channel-marketplace/`) for the previous implementation.

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

## A2A-TG protocol

The inter-bot envelope protocol is specified in [docs/a2a-tg-v1.md](docs/a2a-tg-v1.md). It is inspired by — but not compatible with — the official [A2A protocol](https://a2a-protocol.org); it adds generation-based loop suppression and chat-scoped idempotency for the IM scenario.

## Tests

```bash
bun test
```

## License

MIT — see [LICENSE](LICENSE).
