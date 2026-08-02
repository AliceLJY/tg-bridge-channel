// 健康检查模块（借鉴 cc-connect DoctorChecker）
// /doctor 命令：全面诊断 bridge 运行状态

import { existsSync, readFileSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { getSharedContextStatus } from "./shared-context.js";
import { checkRedisHealth } from "./shared-context/redis-health.js";
import {
  CLAUDE_LOCAL_CONTRACT_REVISION,
  inspectClaudeLocalContract,
  selectClaudeLocalContractMode,
} from "./adapters/claude-local-contract.js";

// execFileSync 参数数组形式：CLAUDE_CLI_PATH 来自 env，不经 shell 插值，防注入
function safeExecFile(file, args, cwd) {
  try {
    return execFileSync(file, args, { cwd, timeout: 5000, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// 进程与版本指纹：根治"repo 已 pull 新代码但进程还在跑旧代码"——2026-06-11 mini 部署滞后
// 事故（修复 push 了 3 小时、进程没重启、用户以为已修）就是它要照出来的
function buildVersionLines() {
  const lines = [];
  const repoSha = safeExecFile("git", ["rev-parse", "--short", "HEAD"], import.meta.dir);
  const repoDirty = safeExecFile("git", ["status", "--porcelain"], import.meta.dir) ? " (有未提交改动)" : "";
  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  const startedStr = startedAt.toLocaleString("zh-CN", { timeZone: "Asia/Singapore", hour12: false });
  const claudeCli = process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");
  const ccVersion = safeExecFile(claudeCli, ["--version"]);
  lines.push(`📌 repo: ${repoSha || "(git 不可用)"}${repoDirty}`);
  lines.push(`📌 进程启动: ${startedStr}（已运行 ${Math.round(process.uptime() / 60)} 分钟）`);
  lines.push(`📌 Claude Code: ${ccVersion || "(版本获取失败)"}`);
  return lines;
}

function readJsonSnapshot(path) {
  if (!existsSync(path)) return { exists: false, parseOk: false, value: null };
  try {
    return { exists: true, parseOk: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { exists: true, parseOk: false, value: null };
  }
}

function isNonEmptyRegularFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function evaluateStartupSelfCheckResult({ success, text } = {}) {
  const response = typeof text === "string" ? text.trim() : "";
  if (success !== true) {
    return {
      ok: false,
      text: response,
      error: response.slice(0, 200) || "result success=false",
    };
  }
  if (response.toLowerCase() !== "pong") {
    return {
      ok: false,
      text: response,
      error: `unexpected self-check response: ${response.slice(0, 160) || "(empty)"}`,
    };
  }
  return { ok: true, text: response, error: "" };
}

export function buildClaudeContractLines({
  env = process.env,
  cliHelp,
  stopHelp,
  rosterSnapshot,
  projectsDirExists,
  controlKeyFile,
} = {}) {
  const mode = selectClaudeLocalContractMode(env);
  if (mode === "sdk") {
    return [`⏭️ Claude local contract [sdk/${CLAUDE_LOCAL_CONTRACT_REVISION}]: SDK execution path; daemon roster transport not active`];
  }

  const claudeCli = env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");
  const effectiveCliHelp = cliHelp ?? safeExecFile(claudeCli, ["--help"]);
  const effectiveStopHelp = stopHelp ?? safeExecFile(claudeCli, ["stop", "--help"]);
  const effectiveRoster = rosterSnapshot ?? readJsonSnapshot(join(homedir(), ".claude/daemon/roster.json"));
  const effectiveProjectsDir = projectsDirExists ?? existsSync(join(homedir(), ".claude/projects"));
  // Reply mode needs the control-key file, but /doctor checks only regular-file
  // existence and non-emptiness. It never reads or prints the credential.
  const effectiveControlKey = controlKeyFile ?? isNonEmptyRegularFile(join(homedir(), ".claude/daemon/control.key"));
  const result = inspectClaudeLocalContract({
    mode,
    cliHelp: effectiveCliHelp,
    stopHelp: effectiveStopHelp,
    rosterExists: effectiveRoster.exists,
    rosterParseOk: effectiveRoster.parseOk,
    roster: effectiveRoster.value,
    projectsDirExists: effectiveProjectsDir,
    controlKeyFile: effectiveControlKey,
  });
  const marker = result.ok ? "✅" : "❌";
  const details = result.ok ? "required CLI and local structures present" : result.problems.join(", ");
  return [`${marker} Claude local contract [${mode}/${CLAUDE_LOCAL_CONTRACT_REVISION}]: ${details}`];
}

export async function runHealthCheck(ctx) {
  const {
    adapters = {},
    activeBackends = [],
    sessions = null,
    cronManager = null,
    rateLimiter = null,
    idleMonitor = null,
    dirManager = null,
    a2aBus = null,
    sharedContextConfig = null,
    cwd = "",
    chatId = 0,
  } = ctx;

  const lines = ["🩺 *Bridge Health Check*\n"];

  // 0. 进程与版本指纹（部署滞后检测）
  lines.push(...buildVersionLines());
  lines.push(...buildClaudeContractLines());

  // 1. Backend 连通性
  for (const name of activeBackends) {
    const adapter = adapters[name];
    if (adapter) {
      try {
        const info = adapter.statusInfo?.();
        // 计费路径体检(🔴 命门):claude backend 走 cli-pool(--bg daemon)=订阅;
        // 缺 CLAUDE_POOL_ENGINE 会回退 SDK adapter,6-15 后按 API token 计费 → 必须能一眼照出。
        let billing = "";
        if (name === "claude") {
          billing = process.env.CLAUDE_POOL_ENGINE === "1"
            ? " · 💳 Pool/订阅"
            : " · ⚠️ SDK/API计费(缺 CLAUDE_POOL_ENGINE)";
        }
        const modeStr = info?.mode ? ` [${info.mode}]` : "";
        lines.push(`✅ ${adapter.label || name}: ready (${info?.model || "default"}${modeStr})${billing}`);
      } catch (e) {
        lines.push(`❌ ${adapter.label || name}: ${e.message}`);
      }
    } else {
      lines.push(`❌ ${name}: adapter not loaded`);
    }
  }

  // 2. 工作目录
  if (cwd && existsSync(cwd)) {
    lines.push(`✅ 工作目录: ${cwd}`);
  } else {
    lines.push(`❌ 工作目录: ${cwd || "(未设置)"} ${cwd ? "不存在" : ""}`);
  }

  // 3. Session DB
  const sessionsDbPath = process.env.SESSIONS_DB;
  if (sessionsDbPath && existsSync(sessionsDbPath)) {
    try {
      if (sessions?.getSession) {
        lines.push(`✅ Session DB: ${sessionsDbPath}`);
      } else {
        lines.push(`✅ Session DB: ${sessionsDbPath} (file exists)`);
      }
    } catch {
      lines.push(`❌ Session DB: 读取失败`);
    }
  } else {
    lines.push(`⚠️ Session DB: ${sessionsDbPath || "(未配置)"}`);
  }

  // 4. Tasks DB
  const tasksDbPath = process.env.TASKS_DB;
  if (tasksDbPath && existsSync(tasksDbPath)) {
    lines.push(`✅ Tasks DB: ${tasksDbPath}`);
  } else {
    lines.push(`⚠️ Tasks DB: ${tasksDbPath || "(未配置)"}`);
  }

  // 5. A2A Bus
  if (a2aBus) {
    try {
      const stats = a2aBus.getStats?.();
      lines.push(`✅ A2A Bus: port=${process.env.A2A_PORT || "?"}, received=${stats?.loopGuard?.received || 0}`);
    } catch {
      lines.push(`❌ A2A Bus: 状态获取失败`);
    }
  } else {
    lines.push(`⏭️ A2A: disabled`);
  }

  // 6. Shared Context
  if (sharedContextConfig) {
    const backend = sharedContextConfig.sharedContextBackend || "sqlite";
    lines.push(`✅ Shared Context: ${backend}`);
    const sharedStatus = getSharedContextStatus();
    if (sharedStatus.lastWriteError) {
      lines.push(`⚠️ Shared Context write: ${sharedStatus.lastWriteError.message}`);
    }
    if (backend === "redis") {
      const redisHealth = await checkRedisHealth(sharedContextConfig);
      if (redisHealth.ok) {
        lines.push(`✅ Redis: ping ok`);
      } else {
        lines.push(`❌ Redis: ${redisHealth.error}`);
      }
    }
  } else {
    lines.push(`⏭️ Shared Context: disabled`);
  }

  // 7. Cron
  if (cronManager) {
    const jobList = cronManager.list(chatId);
    const activeCount = jobList.filter((j) => j.status === "active").length;
    const nextJob = jobList.find((j) => j.nextRun);
    const nextStr = nextJob
      ? `, next: ${new Date(nextJob.nextRun).toLocaleTimeString("zh-CN")}`
      : "";
    lines.push(`✅ Cron: ${activeCount} active / ${jobList.length} total${nextStr}`);
  } else {
    lines.push(`⏭️ Cron: disabled`);
  }

  // 8. Rate Limiter
  if (rateLimiter) {
    const stats = rateLimiter.stats(chatId);
    lines.push(`📊 限流: ${stats.used}/${stats.max} used (window ${Math.round(stats.windowMs / 1000)}s)`);
  }

  // 9. Idle Monitor
  if (idleMonitor) {
    const info = idleMonitor.statusInfo();
    const timeoutStr = info.idleTimeoutMs > 0
      ? `${Math.round(info.idleTimeoutMs / 60000)}min`
      : "off";
    const resetStr = info.resetOnIdleMs > 0
      ? `${Math.round(info.resetOnIdleMs / 60000)}min`
      : "off";
    lines.push(`📊 Idle: timeout=${timeoutStr}, reset=${resetStr}, sessions=${info.activeSessions}`);
  }

  // 10. Dir Manager
  if (dirManager) {
    const currentDir = dirManager.current(chatId);
    const hist = dirManager.history(chatId);
    lines.push(`📊 目录: ${currentDir} (history: ${hist.length})`);
  }

  return lines.join("\n");
}
