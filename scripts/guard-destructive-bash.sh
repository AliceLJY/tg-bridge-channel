#!/usr/bin/env bash
# guard-destructive-bash.sh — tg-bridge-channel 的 PreToolUse 安全护栏
#
# 作用:在 --permission-mode bypassPermissions(bot 默认全自动放行工具调用)下,仍然
#   硬拦一小撮灾难性、不可逆的 Bash 命令——删根/家/系统目录、格式化磁盘、写块设备、
#   fork 炸弹、擦除设备。
#
# 边界(诚实声明):这是"手刹",不是"沙箱"。黑名单只挡直白写法,可被混淆命令绕过
#   (echo ... | base64 -d | sh、变量拼接、别名、Python/Node 子进程等)。它防的是"手滑"
#   和"一句话诱导 bot 删家目录",不防有动机的攻击者。要真正隔离,请用容器 / 独立受限
#   账户 / 只读挂载 / 限定 cwd。对外公开部署时这一点尤其重要。
#
# 机制:Claude Code PreToolUse hook(matcher=Bash)。即使 bypassPermissions 也会触发
#   (hook 与权限提示是独立机制)。stdin 收到 JSON,.tool_input.command 是即将执行的命令。
#   命中→exit 2(阻断,stderr 作为原因回传给模型);放行→exit 0。
#   设计取向"宁放过、不误伤":抠不到命令就放行;项目内 rm -rf 子目录一律放行,只在
#   删除目标恰是根 / 家 / 一级系统目录时才拦。
#
# 装载:bot 启动时由 adapters/cli-pool.js 通过 `--settings` inline JSON 注入,指向本脚本
#   绝对路径。设 env CLI_POOL_DESTRUCTIVE_GUARD=0 可整体关闭(不建议对外部署时关闭)。
set -uo pipefail

input="$(cat)"

# 抠命令:优先 jq,无 jq 时 grep 兜底;抠不到就放行(不误伤)
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
  cmd="$(printf '%s' "$input" | grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | head -1 \
        | sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//')"
fi
[ -z "${cmd:-}" ] && exit 0

# 归一化空白(换行/回车/制表→空格,折叠连续空格),便于匹配多行/拼接命令
c="$(printf '%s' "$cmd" | tr '\n\r\t' '   ' | tr -s ' ')"

deny() {
  printf '🛑 tg-bridge 安全护栏已拦截危险命令:%s\n命令:%s\n这是不可逆操作,已阻止。如确需执行,请人工在终端完成。\n' "$1" "$cmd" >&2
  exit 2
}

# ---- 1) rm 递归删除 根 / 家 / 一级系统目录 ----
# 双重门:既要是 rm 递归命令,目标又恰是危险根目录。项目内 rm -rf 子目录放行,不误伤日常开发。
# 危险目标:/  /*  ~  ~/  $HOME  以及一级系统目录(后面不带更深子路径,或以 /* 结尾)
DANGER_ROOT='( (/|~|\$HOME|/(etc|usr|bin|sbin|var|lib|opt|boot|root|dev|sys|proc|System|Library|Applications|Users|private|cores))(/\*?|\*)?( |$|;|&|\|))'
if printf '%s' "$c" | grep -qE '(^|[;&|(]|sudo |doas | )rm +([^;&|]* )?(-[a-zA-Z]*[rR]|--recursive)'; then
  printf '%s' "$c" | grep -qE "$DANGER_ROOT" && deny "rm 递归删除 根/家/系统目录"
  # 1b) 家目录展开形式(rm -rf /Users/xxx 这类恰为 $HOME 本身),用运行时 HOME 兜底
  if [ -n "${HOME:-}" ]; then
    home_esc="$(printf '%s' "$HOME" | sed 's/[][\\.*^$/]/\\&/g')"
    printf '%s' "$c" | grep -qE " ${home_esc}(/\*?|\*)?( |$|;|&|\|)" && deny "rm 递归删除家目录"
  fi
fi

# ---- 2) mkfs 格式化文件系统 ----
printf '%s' "$c" | grep -qE '(^|[;&|]|&&|\|\||sudo |doas |xargs )mkfs(\.[a-z0-9]+)?( |$)' && deny "mkfs 格式化文件系统"

# ---- 3) dd 写入块设备 ----
printf '%s' "$c" | grep -qE '(^|[;&|]|&&|\|\||sudo |doas )dd( .*)? of=/dev/(sd|disk|nvme|hd|mmcblk|vd)' && deny "dd 写入块设备"

# ---- 4) 重定向覆写块设备 ----
printf '%s' "$c" | grep -qE '> ?/dev/(sd|disk|nvme|hd|mmcblk|vd)[a-z0-9]*( |$)' && deny "重定向覆写块设备"

# ---- 5) fork 炸弹 :(){ :|:& };: ----
printf '%s' "$c" | grep -qE ':[[:space:]]*\([[:space:]]*\)[[:space:]]*\{.*\|.*&.*\}[[:space:]]*;[[:space:]]*:' && deny "fork 炸弹"

# ---- 6) shred 擦除块设备 ----
printf '%s' "$c" | grep -qE '(^|[;&|]|&&|\|\||sudo |doas )shred( .*)?/dev/' && deny "shred 擦除块设备"

exit 0
