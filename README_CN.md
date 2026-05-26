<div align="center">

# tg-bridge-channel

**自托管的 Telegram AI 编程代理桥 —— 聊天窗口就是终端。**

*在 Telegram 聊天里驱动 Claude Code / Codex / Gemini，引擎层走 `claude --bg` daemon control RPC 拿订阅计费的 Claude Code 会话，并通过 A2A-TG 信封协议支持群聊内多代理协作。*

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![Telegram](https://img.shields.io/badge/Interface-Telegram-26A5E4?logo=telegram)](https://telegram.org/)

[English](README.md) | **简体中文**

</div>

---

## 这是什么

`tg-bridge-channel` 把 AI 编程代理跑成 Telegram bot。每个 bot 是一个完整的代理会话，你从手机或桌面跟它对话 —— 聊天窗口就是终端。支持三种模式：

- **单代理控制** —— 每个 bot 一个 Claude Code / Codex / Gemini 会话，通过 Telegram 驱动。
- **并行会话** —— 一个群里跑 N 个独立 bot，各自独立会话，带共享上下文（SQLite/Redis）。
- **异构多代理协作** —— Claude、Codex、Gemini bot 在群里通过 A2A-TG 信封协议互相对话，带基于代际计数的环路抑制。

## 引擎层

`claude` 后端有两套可互换的引擎实现，运行时由 `CLAUDE_POOL_ENGINE` 环境变量选择：

| 模式 | 实现 | 工作方式 |
|---|---|---|
| 默认 | `adapters/claude.js` | 基于 Claude Agent SDK 的程序化适配器。 |
| `CLAUDE_POOL_ENGINE=1` | `adapters/cli-pool-adapter.js` | 每个 Telegram chat 一个 `claude --bg` 后台会话，通过 daemon control RPC 驱动。 |

pool 引擎为每个 Telegram chat 起一个 `claude --bg` 会话。Telegram 入站消息通过 daemon control socket（`/tmp/cc-daemon-501/<rand>/control.sock`）的 `op:reply` 送到 worker —— 这是 agent-view peek panel 跟 background sessions 通信用的同款底层 RPC。bridge 通过 tail 会话的本地 `.jsonl` 文件读结构化的 user / assistant / tool 事件回传 Telegram。

两种模式下后端名都保持 `claude`，所以所有编排逻辑（审批 / 标签 / A2A / cron 的 `backendName === "claude"` 判断）不变。切换引擎是进程级环境变量；回滚就是删掉它。

> pool 引擎依赖官方 `claude` daemon 的 spare 进程池做 cold-start 预热，依赖 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` 读结构化输出，依赖 `claude --bg` 的订阅计费规则（按 Anthropic 公开的计费说明）。不需要安装任何插件。

> 之前的交互式 channel-plugin 引擎（`CLAUDE_CHANNEL_ENGINE=1`）通过一个仿照 Claude Code 内置 fakechat channel 的 Model Context Protocol server 驱动。该引擎已于 2026 年 5 月下线，原因是每条消息的 cold-start 开销过高；旧实现见 git history（`adapters/claude-channel.js`、`agent/channel-marketplace/`）。

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 配置
cp config.example.json config.json
# 编辑 config.json：设置 ownerTelegramId 和 backends.<引擎>.telegramBotToken

# 3. 运行（默认 SDK 引擎）
bun run start --backend claude --config config.json
```

运行 **pool 引擎**（推荐；订阅计费的 background sessions）：

```bash
CLAUDE_POOL_ENGINE=1 bun run start --backend claude --config config.json
```

## 多实例

每个 bot 实例用自己的配置文件（`config.json`、`config-2.json`……），各自独立的 bot token 和会话数据库。常驻运行的 launch agent 模板在 `launchd/`。

## 配置

见 `config.example.json` 完整 schema。关键字段：

- `ownerTelegramId` —— 只有这个用户能驱动 bot。
- `backends.<claude|codex|gemini>.telegramBotToken` —— 各后端的 bot token。
- `sharedContextBackend` —— `sqlite` 或 `redis`，跨 bot 共享记忆。
- `a2aEnabled` / `a2aPorts` —— 启用 A2A-TG 跨 bot 消息。

## A2A-TG 协议

跨 bot 信封协议规范见 [docs/a2a-tg-v1_CN.md](docs/a2a-tg-v1_CN.md)。它受官方 [A2A 协议](https://a2a-protocol.org)启发但不兼容；为 IM 场景增加了基于代际的环路抑制和会话域幂等。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
