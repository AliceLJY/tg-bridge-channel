<div align="center">

# tg-bridge-channel

**自托管的 Telegram AI 编程代理桥 —— 聊天窗口就是终端。**

*在 Telegram 聊天里驱动 Claude Code / Codex / Gemini，引擎层用交互式 Claude CLI（channel 机制），并通过 A2A-TG 信封协议支持群聊内多代理协作。*

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

`claude` 后端有两套可互换的引擎实现，运行时由 `CLAUDE_CHANNEL_ENGINE` 环境变量选择：

| 模式 | 实现 | 工作方式 |
|---|---|---|
| 默认 | `adapters/claude.js` | 基于 Claude Agent SDK 的程序化适配器。 |
| `CLAUDE_CHANNEL_ENGINE=1` | `adapters/claude-channel.js` | 通过本地 MCP channel 驱动交互式 `claude` CLI 进程。 |

channel 引擎起一个交互式 `claude` 进程，通过**本地 channel 插件**（一个仿照 Claude Code 内置 fakechat channel 的 Model Context Protocol server）与它通信。Telegram 入站消息以 channel 通知形式送达 CLI；CLI 通过 `reply` 工具回复；工具调用审批回传给真人，在 Telegram 里点 Allow/Deny。

两种模式下后端名都保持 `claude`，所以所有编排逻辑（审批 / 标签 / A2A / cron 的 `backendName === "claude"` 判断）不变。切换引擎是进程级环境变量；回滚就是删掉它。

> channel 引擎用 macOS `script` 提供 PTY（node-pty 不兼容 bun），通过 `--channels plugin:bridge-channel@bridge` 激活 channel。channel 插件需从本地 marketplace 安装并批准（见 `agent/channel-marketplace/`）。

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

运行 **channel 引擎**：

```bash
CLAUDE_CHANNEL_ENGINE=1 bun run start --backend claude --config config.json
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
