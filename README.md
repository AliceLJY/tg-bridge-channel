<div align="center">

# tg-bridge-channel

**Self-hosted Telegram bridge for AI coding agents — the chat IS the terminal.**

*Drive Claude Code / Codex / Gemini from a Telegram chat through SDK or local CLI engines, with the A2A-TG envelope protocol for multi-agent collaboration in group chats.*

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

The **primary, battle-tested path** is single-agent private-chat control of Claude Code via the reply engine below (the pool engine held that role until June 2026 and is kept as the rollback path). Parallel sessions and A2A collaboration work but are experimental; the Gemini backend and the `local-agent` executor are compatibility layers that see far less real-world use.

## Architecture

```mermaid
flowchart TB
    subgraph tg["Telegram — the chat IS the terminal"]
        U["Owner<br/>only ownerTelegramId"]
        BC["claude bot"]
        BX["codex bot"]
        BG["gemini bot"]
    end

    U <--> BC
    U <--> BX
    U <--> BG

    subgraph bridge["tg-bridge-channel · Bun"]
        ROUTER["Router + per-chat prefs<br/>/model /effort /dir · Stop"]
        ENGINE{"claude engine?"}
        SDK["SDK adapter<br/>adapters/claude.js"]
        POOL["pool engine<br/>adapters/cli-pool-adapter.js"]
        PRINT["print engine<br/>adapters/cli-print-adapter.js"]
        REPLY["reply engine<br/>adapters/cli-reply-adapter.js"]
        CTX[("shared context<br/>SQLite / Redis")]
        GUARD["PreToolUse guard<br/>blocks catastrophic Bash"]
    end

    BC --> ROUTER
    BX --> ROUTER
    BG --> ROUTER
    ROUTER --> ENGINE
    ENGINE -->|"default"| SDK
    ENGINE -->|"CLAUDE_POOL_ENGINE=1"| POOL
    ENGINE -->|"CLAUDE_PRINT_ENGINE=1"| PRINT
    ENGINE -->|"CLAUDE_REPLY_ENGINE=1"| REPLY

    SDK --> CC["Claude Code session"]
    POOL -->|"one claude --bg fork per turn; --resume keeps context"| CC
    PRINT -->|"claude --print stream-json"| CC
    REPLY -->|"persistent --bg + local op:reply"| CC
    ROUTER --> CX["Codex"]
    ROUTER --> GM["Gemini"]

    CC -.->|"tail transcript .jsonl"| POOL
    CC -.->|"stream-json result"| PRINT
    CC -.->|"roster/jsonl + daemon reply"| REPLY
    GUARD -.->|"injected per session"| CC
    ROUTER <--> CTX

    BC <-.->|"A2A-TG envelope (experimental)"| BX
    BX <-.-> BG
```

## Engine layer

The `claude` backend ships four engine implementations. Environment-variable priority is reply → print → pool → SDK:

| Mode | Implementation | How it works | Status |
|---|---|---|---|
| default | `adapters/claude.js` | Programmatic adapter built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/agent-sdk). | Fallback / API-billed path |
| `CLAUDE_POOL_ENGINE=1` | `adapters/cli-pool-adapter.js` | Per-**turn** `claude --bg [--resume]` workers; output is tailed from the forked transcript. | Superseded by reply; kept as rollback path |
| `CLAUDE_PRINT_ENGINE=1` | `adapters/cli-print-adapter.js` | `claude --print --output-format stream-json [--resume]`; no daemon reply socket. | Superseded by reply; headless, so no remote control |
| `CLAUDE_REPLY_ENGINE=1` | `adapters/cli-reply-adapter.js` | Persistent `claude --bg` worker plus an authenticated local daemon `op:reply`. | **Primary owner-used CLI path** since June 2026; highest upgrade coupling |

### Why three CLI engines, and why reply won

Each earlier engine solved half the problem:

| Engine | One session per chat? | Reachable by Claude's remote control? | Blocker |
|---|---|---|---|
| pool | No — `--bg --resume` forks a **new session id every turn** | Yes (worker has a PTY) | Every turn leaves another `tg-turn-*` transcript behind |
| print | Yes — `--print --resume` appends in place | No — headless, no TTY | Never enters the daemon's remote-control roster |
| **reply** | Yes | Yes | — |

Claude's remote control needs a TTY plus a resident process, so "don't fork" and "stay reachable from the phone app" were mutually exclusive until the reply engine.

**The reply engine** keeps **one persistent `claude --bg` worker per chat**. The first message spawns it; every later message is delivered into that same session through an authenticated local daemon `op:reply`, so no fork occurs and only one transcript file exists per chat. If the daemon has idle-reclaimed the worker (or the bridge restarted), the next message revives the session with `--bg --resume <session-id>` — that path *does* fork once, but only after an idle gap, not on every turn. Output is read by tailing the same transcript from a recorded offset.

**The pool engine** (previous generation, still the rollback path — and the reply engine reuses its `buildTurnArgs` / transcript tailing / roster helpers) spawns one short-lived `claude --bg` worker **per turn**: each inbound Telegram message launches `claude --bg [--resume <session-id>] "<prompt>"`, which forks a new session inheriting the full conversation history, streams the reply back by tailing the forked session's local transcript file, and stops the worker when the turn completes. The bridge persists the forked session id per chat and resumes it on the next message, so the conversation stays continuous across turns. In all engines, per-chat `/model`, `/effort` and `/dir` preferences plus the bridge's system-prompt scaffold are passed to every spawn as plain CLI flags.

Two practical caveats:

- **Quota grows with conversation length — fork-per-turn (pool) only.** Every turn re-forks the full history, so very long conversations consume subscription usage superlinearly. Start a fresh session (`/new`) when switching topics. The reply engine does not re-send history per turn and is not affected.
- **Silence isn't a hang, and a timeout doesn't kill the task — all CLI engines.** When a long-running task goes quiet for more than `CLI_POOL_HEARTBEAT_MS` (default 3 min), the bridge keeps emitting a "still running" heartbeat instead of declaring failure; only when the turn's total duration exceeds `CLI_POOL_HARD_LIMIT_MS` (default 60 min) does it report a hard timeout — and even then it deliberately leaves the worker running, so its output keeps landing in the session transcript and your next message inherits everything written in the meantime. Normal completion and the Stop button still stop the worker immediately.

Reply-specific tunables: `CLI_REPLY_ROSTER_WAIT_MS` (default 30 s) is how long a revived session waits for the daemon to register the new session id — large conversations must load their full history before that id appears, and a value that is too low makes the bridge silently fall back to a *new* session and lose context. `CLI_REPLY_ECHO_GRACE_MS` (default 90 s) bounds the watchdog for an `op:reply` that was accepted but never produced output.

The backend name stays `claude` in all four modes, so all orchestration (`backendName === "claude"` checks for approval / labels / A2A / cron) is unchanged. Switching engines is a per-process environment variable; rolling back is removing it.

> All three CLI engines invoke documented Claude CLI commands, but reply discovery and completion detection also depend on **observed local implementation contracts**: the `backgrounded · <short-id>` stdout line, `~/.claude/daemon/roster.json`, `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, user/assistant record shapes, and either visible-text `end_turn` or `system.turn_duration`. The reply engine additionally depends on the daemon's `control.sock`, its `control.key` authentication, and the `op:reply` protocol itself. None of these is a stable public API. A Claude Code upgrade can therefore break the bridge even when `claude --bg` itself still exists — which is exactly why pool and print are kept rather than deleted.

> An earlier interactive channel-plugin engine (`CLAUDE_CHANNEL_ENGINE=1`) used a local Model Context Protocol server modeled on Claude Code's built-in fakechat channel. It was removed in May 2026 in favor of the Agent View based pool engine; see git history before May 2026 for the channel-plugin engine implementation.

### Claude Code compatibility boundary

| Engine | Documented surface used | Observed / internal contract also used | Upgrade posture |
|---|---|---|---|
| SDK | Published Agent SDK event stream | Local transcripts are consulted for session discovery and resume-noise repair | SDK version pin and regression tests |
| print | `--print`, `--resume`, `--output-format stream-json`, `--settings` | Exact stream-json message/result shapes and local persisted sessions | Synthetic event/result fixtures; no direct roster/socket contract |
| pool | `--bg`, `--resume`, `claude stop`, `--settings` | Background stdout short ID, daemon roster schema, transcript path/records, two turn-end forms | Synthetic roster/transcript fixtures plus optional live startup self-check |
| reply | The same background CLI commands | Everything in pool, plus `control.sock`, a non-empty `control.key` file, and the daemon `op:reply` protocol | In daily use, but the widest internal surface here — expect breakage when daemon internals change, and keep pool/print as fallbacks |

The bridge does **not** bundle or auto-update Claude Code. CLI engines resolve `CLAUDE_CLI_PATH`, defaulting to `~/.local/bin/claude`, so the operator controls the installed version.

The synthetic local-contract fixtures dated 2026-07-17 were re-run against Claude Code **2.1.229 on 2026-08-13**; that version was also npm's `latest` at release-preparation time. This confirms that the required CLI help surfaces were present and the fixtures still matched the parser. It is not a promise that every future Claude Code release will work.

`/doctor` performs a non-invasive structural check for the selected engine. It checks required flags, roster shape, transcript-directory presence, and—only for reply mode—whether `control.key` is a non-empty regular file; it never reads or prints the key. For enabled CLI engines, the delayed startup self-check is the live end-to-end check (`spawn → roster/stream → transcript/result → stop`). It consumes a small Claude turn and can be disabled with `POOL_SELF_CHECK=0`.

## Quick start

Claude Code is installed separately from this package. For a Claude CLI engine, install a current Claude Code release, verify it with `claude --version`, and check the compatibility boundary above before upgrading an existing bridge.

```bash
# 1. install dependencies
bun install

# 2. configure
cp config.example.json config.json
# edit config.json: set ownerTelegramId and backends.<engine>.telegramBotToken

# 3. run (default SDK engine)
bun run start --backend claude --config config.json
```

To run the **reply engine** (recommended; subscription-billed background sessions, one persistent session per chat, reachable from Claude's remote control):

```bash
CLAUDE_REPLY_ENGINE=1 bun run start --backend claude --config config.json
```

If the daemon's `op:reply` protocol breaks after a Claude Code upgrade, fall back to the pool engine — same billing path, at the cost of one forked transcript per turn:

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
- `outputRelayTrustedChatIds` — group chats allowed to receive generated file and image attachments. Empty by default; even listed groups require the owner to trigger the turn.
- `a2aEnabled` / `a2aPorts` — enable A2A-TG inter-bot messaging.

## Security

Automatic file and image attachments are enabled for owner-triggered private chats. Group attachments are disabled unless the group ID is listed in `outputRelayTrustedChatIds`, and bot-triggered Discuss turns never send attachments. Every detected file path—whether reported by a tool event or found in model text—must resolve to a regular, non-hidden file inside that turn's working directory. Common credential/config/log names, symlink escapes, the inbound upload directory, unsupported types, and files over 20 MB are rejected before reading. In-memory images keep the existing 10 MB limit.

The `claude --bg` engine runs with `--permission-mode bypassPermissions`, so the bot never stalls on permission prompts. To stop that from meaning "the bot will run anything", every `--bg` worker is launched with an injected `PreToolUse` hook (`scripts/guard-destructive-bash.sh`) that hard-blocks a small set of catastrophic, irreversible Bash commands: recursive deletion of `/`, `~`, `$HOME` or a top-level system directory; `mkfs`; `dd` onto a block device; redirecting onto a block device; fork bombs; and `shred` of a device. Everyday commands — including `rm -rf node_modules` — pass untouched.

The hook is injected per session via `--settings` (inline JSON), so it never touches your own `~/.claude/settings.json`. Set `CLI_POOL_DESTRUCTIVE_GUARD=0` to disable it (not recommended for public-facing deployments).

This is a hand brake, not a sandbox: the blocklist only catches straightforward forms and can be bypassed by obfuscated commands (`base64 -d | sh`, variable splicing, spawning a subprocess). For real isolation, run the bot in a container, under a restricted account, or with a constrained working directory.

## A2A-TG protocol

The inter-bot envelope protocol is specified in [docs/a2a-tg-v1.md](docs/a2a-tg-v1.md). It is inspired by — but not compatible with — the official [A2A protocol](https://a2a-protocol.org); it adds generation-based loop suppression and chat-scoped idempotency for the IM scenario.

## Tests

```bash
bun test
bun run check:claude-contract
```

## Ecosystem

- [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) — original Telegram bridge using A2A-TG protocol
- [wechat-ai-bridge](https://github.com/AliceLJY/wechat-ai-bridge) — same idea on WeChat
- [recallnest](https://github.com/AliceLJY/recallnest) — shared memory MCP across Claude/Codex/Gemini

## License

MIT — see [LICENSE](LICENSE).
