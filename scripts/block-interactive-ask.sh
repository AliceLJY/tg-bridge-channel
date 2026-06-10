#!/usr/bin/env bash
# block-interactive-ask.sh — tg-bridge-channel 的 PreToolUse 拦截器(非交互防挂起)
#
# 作用:在无人值守的 Telegram bridge 后台会话里,硬拦 AskUserQuestion 工具。
#   bot 是 --bg 后台 worker,一旦模型调 AskUserQuestion 就会挂起、等用户在终端点选;
#   而 bridge 只 tail jsonl,且 CC 在挂起期间不把这个 tool_use flush 到 jsonl(实测:挂起
#   44 分钟 jsonl 里仍无任何 assistant 内容),于是 bridge 永远看不到提问、skill 卡死到超时。
#   拦下它,让模型收到原因后自行按合理默认决定并继续,不再挂起。
#
# 机制(2026-06-10 claude-code-guide 查证 + spike 实测确定):
#   PreToolUse hook(matcher=AskUserQuestion),即使 --permission-mode bypassPermissions 也触发
#   (hook 与权限层独立;disallowedTools 在 bypass 下被跳过、拦不住,hook 才拦得住)。
#   ✅ 必须 exit 0 + stdout 输出结构化 deny JSON(permissionDecision="deny"):reason 会进模型
#      context,模型据此自主 recover、续写正文。
#   ❌ 不能用 exit 2:CC 2.1.170 把 exit 2 当 "hook error",stderr 只进 debug log、不进模型
#      context → 模型收不到原因 → 无法 recover → turn 卡死超时(已实测 FAIL,勿回退)。
set -uo pipefail

cat >/dev/null 2>&1 || true   # 吸收 stdin 的 hook JSON,避免上游 SIGPIPE

REASON='当前运行在非交互的 Telegram bridge 环境:用户不在终端、无法点选,调用 AskUserQuestion 会让本会话挂起直到超时。请不要调用此工具,改为自行按合理默认做出选择(写作类任务的风格/标题/结构等通常已在 skill 中预设,按既定流程推进即可),必要时用一两句说明你替用户做了哪些假设,然后继续完成任务。'

if command -v jq >/dev/null 2>&1; then
  jq -n --arg r "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
else
  # 无 jq 兜底:REASON 已确保不含双引号/反斜杠/控制字符,可直接内嵌
  printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
fi
exit 0
