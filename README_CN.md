<div align="center">

# tg-bridge-channel

**自托管的 Telegram AI 编程代理桥 —— 聊天窗口就是终端。**

*在 Telegram 聊天里驱动 Claude Code / Codex / Gemini，引擎层走 `claude --bg` Agent View 背景会话拿订阅计费的 Claude Code，并通过 A2A-TG 信封协议支持群聊内多代理协作。*

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
- **异构多代理协作**（实验性，默认关闭，需置 `a2aEnabled` 开启）—— Claude、Codex、Gemini bot 在群里通过 A2A-TG 信封协议互相对话，带基于代际计数的环路抑制。

**主路径**（经过日常实际使用打磨的部分）是私聊单代理控制 Claude Code + 下方的 pool 引擎。并行会话和 A2A 协作可用但属实验性质；Gemini 后端和 `local-agent` 执行器是兼容层，实际使用频率低得多。

## 引擎层

`claude` 后端有两套可互换的引擎实现，运行时由 `CLAUDE_POOL_ENGINE` 环境变量选择：

| 模式 | 实现 | 工作方式 |
|---|---|---|
| 默认 | `adapters/claude.js` | 基于 [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/agent-sdk) 的程序化适配器。 |
| `CLAUDE_POOL_ENGINE=1` | `adapters/cli-pool-adapter.js` | 每个 **turn** 一个 `claude --bg` fork worker，基于[背景会话](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/agent-view)（Agent View）。 |

pool 引擎为**每条消息**起一个短命的 `claude --bg` worker：入站 Telegram 消息触发 `claude --bg [--resume <session-id>] "<prompt>"`，fork 出一个继承全部对话历史的新 session，通过 tail 该 session 的本地对话记录文件流式读回输出，turn 结束后停掉 worker。bridge 按 chat 持久化 fork 出的 session id、下条消息继续 resume 它，对话因此跨 turn 连续。每 chat 的 `/model`、`/effort`、`/dir` 偏好和 bridge 的系统提示框架以普通 CLI flag 形式注入每次 spawn。

fork-per-turn 设计的两个实际代价：

- **配额随对话长度递增。** 每个 turn 都带全部历史重新 fork，很长的对话会超线性消耗订阅用量。切换话题时用 `/new` 开新会话。
- **静默不等于卡死，超时也不杀任务。** 长任务静默超过 `CLI_POOL_HEARTBEAT_MS`（默认 3 分钟）时，bridge 持续发"还在跑"的心跳而非判失败；只有这一轮总时长超过 `CLI_POOL_HARD_LIMIT_MS`（默认 60 分钟）才报硬超时，且**刻意不停掉 worker**——任务继续跑、产出继续写进 session 记录，你下一条消息从同一 session fork 时会继承这期间写入的一切。正常完成和 Stop 按钮仍会立即停掉 worker。

两种模式下后端名都保持 `claude`，所以所有编排逻辑（审批 / 标签 / A2A / cron 的 `backendName === "claude"` 判断）不变。切换引擎是进程级环境变量；回滚就是删掉它。

> pool 引擎依赖官方 `claude` Agent View 基础设施：每用户的 supervisor / spare 进程预热、本地 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` 对话记录文件、以及 Anthropic [对背景会话明文规定](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/agent-view#limitations)的订阅计费规则。不安装插件，不改动凭据，不绕过任何配额 —— 每个背景会话计入你的 Claude 订阅用量，跟你自己手开的交互式会话完全等同。

> 之前的交互式 channel-plugin 引擎（`CLAUDE_CHANNEL_ENGINE=1`）通过一个仿照 Claude Code 内置 fakechat channel 的本地 Model Context Protocol server 驱动。该引擎已于 2026 年 5 月被基于 Agent View 的 pool 引擎替代；旧实现见 git history（`adapters/claude-channel.js`、`agent/channel-marketplace/`）。

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

## 安全

`claude --bg` 引擎以 `--permission-mode bypassPermissions` 运行,bot 因此不会卡在权限确认上。为了不让它变成"bot 什么都敢跑",每个 `--bg` worker 启动时都会注入一个 `PreToolUse` 钩子(`scripts/guard-destructive-bash.sh`),硬拦一小撮灾难性、不可逆的 Bash 命令:递归删除 `/`、`~`、`$HOME` 或一级系统目录;`mkfs`;`dd` 写块设备;重定向覆写块设备;fork 炸弹;以及 `shred` 擦除设备。日常命令——包括 `rm -rf node_modules`——一律放行。

钩子通过 `--settings`(inline JSON)按会话注入,不会改动你自己的 `~/.claude/settings.json`。设 `CLI_POOL_DESTRUCTIVE_GUARD=0` 可关闭(对外公开部署不建议关)。

这是"手刹",不是"沙箱":黑名单只挡直白写法,可被混淆命令绕过(`base64 -d | sh`、变量拼接、起子进程等)。要真正隔离,请用容器、独立受限账户,或限定工作目录运行 bot。

## A2A-TG 协议

跨 bot 信封协议规范见 [docs/a2a-tg-v1_CN.md](docs/a2a-tg-v1_CN.md)。它受官方 [A2A 协议](https://a2a-protocol.org)启发但不兼容；为 IM 场景增加了基于代际的环路抑制和会话域幂等。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
