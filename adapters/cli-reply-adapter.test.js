import { describe, expect, test } from "bun:test";

import { mapEvents, selfHealStuckWorker, resolveResumeSid, GHOST_SESSION_NOTICE } from "./cli-reply-adapter.js";

// mapEvents(ev, state):reply 引擎把 cli-pool 底层事件映射成 bridge 统一事件。
// state 形如 { accumulatedText, turnStartAt }(turn_end 用 accumulatedText 兜底回传)。
function collect(ev, state = { accumulatedText: "", turnStartAt: 0 }) {
  return [...mapEvents(ev, state)];
}

describe("cli-reply-adapter mapEvents", () => {
  test("thinking 块 → 「🤔 思考中」进度态(哨兵 toolName __thinking__)", () => {
    // 核心改动:长思考 + 纯文字回复时,thinking 不再被默默丢弃,而是上报为进度信号,
    // 让 TG 那条消息从"死等"变成"🤔 思考中",消灭"以为卡死"的错觉。
    expect(collect({ type: "thinking", text: "让我想想这道题的结构……" })).toEqual([
      { type: "progress", toolName: "__thinking__" },
    ]);
  });

  test("thinking 只发状态、不把模型内心独白发到 TG", () => {
    const out = collect({ type: "thinking", text: "用户其实想要的是 X,但这段推理不该外泄" });
    expect(out).toEqual([{ type: "progress", toolName: "__thinking__" }]);
    expect(out.some(e => e.type === "text")).toBe(false);
  });

  test("text 块 → text 事件并累积到 state(turn_end 兜底回传用)", () => {
    const state = { accumulatedText: "", turnStartAt: 0 };
    expect([...mapEvents({ type: "text", text: "答案是 42。" }, state)]).toEqual([
      { type: "text", text: "答案是 42。" },
    ]);
    expect(state.accumulatedText).toBe("答案是 42。");
  });

  test("tool_use(非 AskUserQuestion)→ progress 事件", () => {
    expect(collect({ type: "tool_use", name: "Read", input: { file_path: "/a.js" } })).toEqual([
      { type: "progress", toolName: "Read", input: { file_path: "/a.js" } },
    ]);
  });

  test("AskUserQuestion 静默跳过(hook 已拦、模型自主续写)", () => {
    expect(collect({ type: "tool_use", name: "AskUserQuestion", input: {} })).toEqual([]);
  });

  test("turn_end → result,text 取 state 累积全文", () => {
    const state = { accumulatedText: "前半段。后半段。", turnStartAt: 0 };
    const out = [...mapEvents({ type: "turn_end", durationMs: 123 }, state)];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "result", success: true, text: "前半段。后半段。" });
  });
});

// ECHO_TIMEOUT 自愈判定(2026-07-17):CLI 升级 → daemon 换代 → respawn worker 卡死 state:"resuming"
// (op:reply 黑洞,"提示重发"死循环,案例 RecallNest e8e136f7)。deps 全注入,压短等待参数让测试瞬时跑完。
describe("selfHealStuckWorker", () => {
  const fast = { waitMs: 1, maxWaitRounds: 3 };

  test("worker 卡死 resuming → kill 被调、roster 摘除后返回 true(调用方递归重投)", async () => {
    const killed = [];
    let rosterGone = false;
    const healed = await selfHealStuckWorker("abcd1234", {
      list: async () => ({ ok: true, jobs: [{ short: "abcd1234", state: "resuming" }] }),
      kill: async s => { killed.push(s); rosterGone = true; return { ok: true }; },
      rosterHas: () => !rosterGone,
      ...fast,
    });
    expect(healed).toBe(true);
    expect(killed).toEqual(["abcd1234"]);
  });

  test("worker 已消失(list 无此 job)→ 不 kill、直接 true(重投走 --resume 复活)", async () => {
    const killed = [];
    const healed = await selfHealStuckWorker("abcd1234", {
      list: async () => ({ ok: true, jobs: [] }),
      kill: async s => { killed.push(s); },
      rosterHas: () => false,
      ...fast,
    });
    expect(healed).toBe(true);
    expect(killed).toEqual([]);  // 没 worker 可杀,不动刀
  });

  test("worker 状态正常(running,可能真在跑活)→ 不 kill、返回 false(宁漏勿误杀,回落提示文案)", async () => {
    const killed = [];
    const healed = await selfHealStuckWorker("abcd1234", {
      list: async () => ({ ok: true, jobs: [{ short: "abcd1234", state: "running" }] }),
      kill: async s => { killed.push(s); },
      rosterHas: () => true,
      ...fast,
    });
    expect(healed).toBe(false);
    expect(killed).toEqual([]);
  });

  test("daemon 不可达(list 抛错)→ false,不自愈走原提示", async () => {
    const healed = await selfHealStuckWorker("abcd1234", {
      list: async () => { throw new Error("no daemon control.sock"); },
      kill: async () => {},
      rosterHas: () => true,
      ...fast,
    });
    expect(healed).toBe(false);
  });

  test("kill 已发出但 roster 迟迟不摘 → 等待轮次用尽仍 true(重投由 __echoRetried 防循环)", async () => {
    const healed = await selfHealStuckWorker("abcd1234", {
      list: async () => ({ ok: true, jobs: [{ short: "abcd1234", state: "resuming" }] }),
      kill: async () => ({ ok: true }),
      rosterHas: () => true,  // 永远在 roster 里
      ...fast,
    });
    expect(healed).toBe(true);
  });
});

// 幽灵会话判定(2026-07-17,case 4fb95516):黑洞 ID(jsonl 从未落盘)不 resume,直接新建 + 明示,
// 一条消息自愈,不再"静默退化 → 用户取消 → 再造黑洞"死循环。probeSession 注入(三态,codex review P1)。
describe("resolveResumeSid 幽灵会话判定", () => {
  test("无 sessionId → 全新会话,非幽灵", () => {
    expect(resolveResumeSid(null, { probeSession: () => { throw new Error("不该被调"); } }))
      .toEqual({ sid: null, ghost: false });
  });

  test("jsonl 在盘上 → 原样 resume", () => {
    const probed = [];
    expect(resolveResumeSid("aaa-111", { probeSession: sid => { probed.push(sid); return { found: { path: "/x/aaa-111.jsonl" }, scanFailed: false }; } }))
      .toEqual({ sid: "aaa-111", ghost: false });
    expect(probed).toEqual(["aaa-111"]);
  });

  test("全目录扫完确无文件 → 幽灵:sid 置空走全新建", () => {
    expect(resolveResumeSid("bbb-ghost", { probeSession: () => ({ found: null, scanFailed: false }) }))
      .toEqual({ sid: null, ghost: true });
  });

  test("扫描失败(scanFailed=true)→ fail-open:按存在处理照常 resume,不因瞬时 IO 失败丢上下文", () => {
    expect(resolveResumeSid("ccc-222", { probeSession: () => ({ found: null, scanFailed: true }) }))
      .toEqual({ sid: "ccc-222", ghost: false });
  });

  test("probe 本身抛异常 → fail-open:照常 resume", () => {
    expect(resolveResumeSid("ddd-333", { probeSession: () => { throw new Error("EACCES"); } }))
      .toEqual({ sid: "ddd-333", ghost: false });
  });
});
