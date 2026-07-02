#!/usr/bin/env python3
# test-relay-recover.py — 验证 --bg worker 遇到 AskUserQuestion 时的「拦截 → 自主恢复」行为。
#
# 每个 worker 被喂「请用 AskUserQuestion 问中午吃什么」的 prompt;block-interactive-ask.sh
# (PreToolUse hook)应硬拦该工具,worker 收到 deny reason 后自主按默认作答、写正文、正常
# 结束 turn。脚本 spawn N 个 worker,逐个等其 turn 跑完,再按 jsonl 终态分类:
#
#   BLOCKED+RECOVER            deny 命中 + 有正文 + turn 正常结束        ← 期望
#   BLOCKED-but-stuck          deny 命中但没写正文 / 没结束              ← 拦了没恢复
#   HUNG(ask not intercepted)  出现 AskUserQuestion 且未被 deny          ← 护栏失效
#   PENDING/HUNG(no-end)       既无 deny 也无 turn_end                   ← 卡死 / 超时
#   OK(no-ask,clean-end)       压根没调 AskUserQuestion 就正常结束       ← prompt 没触发提问
#
# 用法: python3 scripts/test-relay-recover.py [N]      (N = worker 数,默认 3)

import subprocess, json, os, time, re, glob, sys

CLAUDE = os.path.expanduser("~/.local/bin/claude")
HOME   = os.path.expanduser("~")
ROSTER = os.path.expanduser("~/.claude/daemon/roster.json")
BASE   = os.path.dirname(os.path.abspath(__file__))
BLOCK  = os.path.join(BASE, "block-interactive-ask.sh")

# 与 cli-pool.js buildSettings(false) 等价:只注入 AskUserQuestion 拦截 hook。
SETTINGS = json.dumps({"hooks": {"PreToolUse": [
    {"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": "bash " + json.dumps(BLOCK)}]},
]}})
PROMPT = "请马上用 AskUserQuestion 工具问我中午吃什么,弹3个选项按钮。"

# cli-pool.js:184 — `claude --bg` 把 worker fork 到后台后,父进程 stdout 打印 `backgrounded · <8位hex>`。
# strict 照搬原版(中点 U+00B7);loose 兜底,防分隔符/着色码变体。
SHORT_STRICT = re.compile(r"backgrounded\s+·\s+([0-9a-f]{8})")
SHORT_LOOSE  = re.compile(r"backgrounded[^\n]*?([0-9a-f]{8})")


def extract_short(out):
    m = SHORT_STRICT.search(out or "") or SHORT_LOOSE.search(out or "")
    return m.group(1) if m else None


def short_to_sid(short, tries=20, delay=0.25):
    """轮询 roster 等 fork 出的 sessionId(照搬 cli-pool.js:190-200,20×250ms ≈ 5s)。
    roster.workers 以 short 为 key,value.sessionId 是 fork 出的完整 UUID。"""
    for _ in range(tries):
        try:
            w = json.load(open(ROSTER)).get("workers", {}).get(short)
            if w and w.get("sessionId"):
                return w["sessionId"]
        except Exception:
            pass
        time.sleep(delay)
    return None


def spawn_worker(i):
    """spawn 一个带 prompt 的 --bg worker(opus/effort-max,注入拦截 hook)。
    返回 (short, sessionId);失败任一为 None。"""
    args = [CLAUDE, "--bg", "--name", "rel%d" % i,
            "--model", "opus", "--effort", "max",
            "--permission-mode", "bypassPermissions",
            "--settings", SETTINGS, PROMPT]
    try:
        cp = subprocess.run(args, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print("  [rel%d] spawn 超时(--bg 应秒退,卡住说明 daemon 异常)" % i)
        return None, None
    short = extract_short(cp.stdout)
    if not short:
        print("  [rel%d] stdout 无 short: %r / stderr: %r"
              % (i, (cp.stdout or "")[:160], (cp.stderr or "")[:160]))
        return None, None
    sid = short_to_sid(short)
    if not sid:
        print("  [rel%d] short=%s 但 roster 5s 内未浮现 sessionId" % (i, short))
    return short, sid


def classify(sid):
    """读 worker 的 jsonl 判定终态。返回 (label, ended)。
    被 PreToolUse 拦掉的 AskUserQuestion 仍会作为 blocked tool_use 进 jsonl,后面紧跟含
    deny reason 的 tool_result(cli-pool.js:122-126),所以 ask 与 deny 会同时为真 ——
    deny 优先判定,ask-without-deny 才算护栏失效。"""
    hits = glob.glob(HOME + "/.claude/projects/*/" + sid + ".jsonl")
    if not hits:
        return "NOFILE", False
    ask = deny = end = txt = False
    for line in open(hits[0]):
        try: d = json.loads(line)
        except Exception: continue
        t = d.get("type")
        if t == "assistant":
            for b in d.get("message", {}).get("content", []) or []:
                if not isinstance(b, dict): continue
                if b.get("type") == "tool_use" and b.get("name") == "AskUserQuestion": ask = True
                if b.get("type") == "text" and (b.get("text") or "").strip(): txt = True
        elif t == "user":
            for b in d.get("message", {}).get("content", []) or []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    s = b.get("content")
                    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
                    if "非交互" in s: deny = True
        elif t == "system" and d.get("subtype") == "turn_duration":
            end = True
    if deny:
        return ("BLOCKED+RECOVER" if (txt and end) else "BLOCKED-but-stuck"), end
    if ask:                       # 有 AskUserQuestion 但没被 deny = 护栏失效
        return "HUNG(ask not intercepted)", end
    if end:
        return "OK(no-ask,clean-end)", end
    return "PENDING/HUNG(no-end)", end


def classify_when_done(sid, timeout=180, poll=3):
    """轮询 classify 直到 turn 结束(jsonl 出现 turn_duration)或超时。
    spawn 只是把活儿交给后台 daemon,worker 还要时间跑完 turn,过早 classify 会误判。"""
    deadline = time.time() + timeout
    label = "NOFILE"
    while time.time() < deadline:
        label, ended = classify(sid)
        if ended:
            return label
        time.sleep(poll)
    return label + " [timeout]"


def cleanup(short):
    """官方 stop 子命令回收测试 worker,免得污染 roster(cli-pool.js:206 同款)。"""
    if not short:
        return
    try:
        subprocess.run([CLAUDE, "stop", short], capture_output=True, timeout=15)
    except Exception:
        pass


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    print("spawn %d 个 --bg worker(opus/effort-max),验证 AskUserQuestion 拦截→恢复…\n" % n)

    workers = []
    for i in range(n):
        short, sid = spawn_worker(i)
        workers.append((i, short, sid))
        print("  rel%d → short=%s sid=%s" % (i, short, (sid or "-")[:8]))

    print("\n等各 worker 跑完 turn 并判定:\n")
    tally = {}
    for i, short, sid in workers:
        label = classify_when_done(sid) if sid else "SPAWN-FAILED"
        tally[label] = tally.get(label, 0) + 1
        print("  rel%d: %s" % (i, label))
        cleanup(short)

    print("\n=== 汇总 ===")
    for label, cnt in sorted(tally.items(), key=lambda x: -x[1]):
        print("  %2d x %s" % (cnt, label))
    ok = tally.get("BLOCKED+RECOVER", 0)
    verdict = "[PASS] 全部按期望恢复" if ok == len(workers) else "[WARN] 有 worker 未按期望恢复"
    print("\n护栏生效率: %d/%d  %s" % (ok, len(workers), verdict))


if __name__ == "__main__":
    main()
