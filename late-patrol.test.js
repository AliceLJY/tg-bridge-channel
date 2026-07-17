// 迟到产出巡逻(2026-07-17,case 8d6eb755):turn 收尾后 bg 接力任务往同一 jsonl 续写的报告要补发,
// 且绝不与新轮打架、绝不重发、真人接管即退场。makeReader/send 全注入,fake reader 喂行队列。
import { describe, expect, test } from "bun:test";

import { createLatePatrolManager } from "./late-patrol.js";

const J = (o) => JSON.stringify(o);
const T0 = Date.parse("2026-07-17T10:00:00.000Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

// fake reader:_readNewLines 每次弹出队列里的一批行;maybeRelocate 记录调用次数。
function makeFakeReader(batches = []) {
  const r = {
    offset: 0,
    path: "/fake/s.jsonl",
    relocates: 0,
    maybeRelocate() { r.relocates++; return false; },
    async _readNewLines() { return batches.length ? batches.shift() : []; },
  };
  return r;
}

function makeManager({ batches, intervalMs = 10, stabilizeMs = 25, maxAgeMs = 60000, maxBursts = 5 } = {}) {
  const sent = [];
  const reader = makeFakeReader(batches);
  const mgr = createLatePatrolManager({
    intervalMs, stabilizeMs, maxAgeMs, maxBursts,
    makeReader: () => reader,
    logger: { log: () => {}, warn: () => {} },
  });
  const send = async (text) => { sent.push(text); };
  return { mgr, sent, reader, send };
}

const HANDLE = { sessionId: "sid-late", jsonlPath: "/fake/s.jsonl", offset: 0, turnEndedAt: T0 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe("late-patrol 迟到产出巡逻", () => {
  test("迟到 assistant text(ts>turnEnd)→ 稳定窗后带前缀补发", async () => {
    const { mgr, sent, send } = makeManager({
      batches: [[J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "盘点报告:6 个正中批次" }] } })]],
    });
    mgr.start(1001, HANDLE, send);
    await sleep(80);  // > stabilizeMs(25) + 若干 poll
    mgr.stop(1001);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("后台任务补报");
    expect(sent[0]).toContain("盘点报告:6 个正中批次");
  });

  test("hard turn end(turn_duration)标记 → 立即 flush,不等稳定窗", async () => {
    const { mgr, sent, send } = makeManager({
      stabilizeMs: 60000,  // 稳定窗拉长到不可能自然触发
      batches: [[
        J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "写完了" }] } }),
        J({ type: "system", subtype: "turn_duration", durationMs: 9, timestamp: iso(5001) }),
      ]],
    });
    mgr.start(1001, HANDLE, send);
    await sleep(50);
    mgr.stop(1001);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("写完了");
  });

  test("thinking/tool_use/system 不进补发;ts<=turnEnd 的行(重放)跳过", async () => {
    const { mgr, sent, send } = makeManager({
      batches: [[
        J({ type: "assistant", timestamp: iso(-1000), message: { content: [{ type: "text", text: "turn 内已发过的旧行" }] } }),
        J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "thinking", thinking: "内心独白" }, { type: "tool_use", name: "Bash", input: {} }] } }),
        J({ type: "system", subtype: "other", timestamp: iso(5001) }),
      ]],
    });
    mgr.start(1001, HANDLE, send);
    await sleep(70);
    mgr.stop(1001);
    expect(sent).toHaveLength(0);
  });

  test("真人 user 输入(ts>turnEnd)→ flush 已有 pending 后退场", async () => {
    const { mgr, sent, send } = makeManager({
      stabilizeMs: 60000,
      batches: [
        [J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "补到一半的报告" }] } })],
        [J({ type: "user", timestamp: iso(8000), message: { content: "我在手机上直接接管了" } })],
      ],
    });
    mgr.start(1001, HANDLE, send);
    await sleep(70);
    expect(mgr.size()).toBe(0);              // 已退场
    expect(sent).toHaveLength(1);            // pending 发完才走
    expect(sent[0]).toContain("补到一半的报告");
  });

  test("tool_result 形态的 user 行(bg 通知回填)→ 不退场继续巡逻", async () => {
    const { mgr, sent, send } = makeManager({
      batches: [
        [J({ type: "user", timestamp: iso(4000), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "bg done" }] } })],
        [J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "bg 完成后的最终报告" }] } }),
         J({ type: "system", subtype: "turn_duration", durationMs: 3, timestamp: iso(5002) })],
      ],
    });
    mgr.start(1001, HANDLE, send);
    await sleep(80);
    mgr.stop(1001);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("最终报告");
  });

  test("sweepAndStop:pending 立即发完 + 退场(新轮前调用,零重叠)", async () => {
    const { mgr, sent, send } = makeManager({
      intervalMs: 100000,  // interval 永不触发,全靠 sweep
      stabilizeMs: 100000,
      batches: [[J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "迟到内容" }] } })]],
    });
    mgr.start(1001, HANDLE, send);
    await mgr.sweepAndStop(1001);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("迟到内容");
    expect(mgr.size()).toBe(0);
    await mgr.sweepAndStop(1001);  // 幂等:没有巡逻时静默返回
    expect(sent).toHaveLength(1);
  });

  test("maxBursts 到顶 → 末条带上限提示并退场", async () => {
    const mkText = (i) => [J({ type: "assistant", timestamp: iso(5000 + i * 100), message: { content: [{ type: "text", text: `补报${i}` }] } }),
      J({ type: "system", subtype: "turn_duration", durationMs: 1, timestamp: iso(5001 + i * 100) })];
    const { mgr, sent, send } = makeManager({
      maxBursts: 2,
      batches: [mkText(1), mkText(2), mkText(3)],
    });
    mgr.start(1001, HANDLE, send);
    await sleep(90);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("已达上限");
    expect(mgr.size()).toBe(0);  // 到顶退场,第三批不再发
  });

  test("超龄(maxAgeMs)→ flush 残余后退场", async () => {
    const { mgr, sent, send } = makeManager({
      maxAgeMs: 30, stabilizeMs: 100000,
      batches: [[J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "赶在退场前的残余" }] } })]],
    });
    mgr.start(1001, HANDLE, send);
    await sleep(80);
    expect(mgr.size()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("残余");
  });

  test("send 瞬时失败 → pending 保留 + 下次 poll 重试成功,报告不丢(codex P2)", async () => {
    const sent = [];
    let failFirst = true;
    const reader = makeFakeReader([
      [J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "差点被弄丢的报告" }] } }),
       J({ type: "system", subtype: "turn_duration", durationMs: 1, timestamp: iso(5001) })],
    ]);
    const mgr = createLatePatrolManager({
      intervalMs: 10, stabilizeMs: 100000, maxAgeMs: 60000, maxBursts: 5,
      makeReader: () => reader,
      logger: { log: () => {}, warn: () => {} },
    });
    const send = async (text) => {
      if (failFirst) { failFirst = false; throw new Error("ETELEGRAM 502"); }
      sent.push(text);
    };
    mgr.start(1001, HANDLE, send);
    await sleep(80);
    mgr.stop(1001);
    expect(sent).toHaveLength(1);                 // 第二次 poll 重试成功
    expect(sent[0]).toContain("差点被弄丢的报告");
  });

  test("sweepAndStop 撞上进行中的 poll → 排队等待,文本恰好发一次不丢不重(codex P1 竞态)", async () => {
    const sent = [];
    let resolveSlowSend;
    const slowSendGate = new Promise(r => { resolveSlowSend = r; });
    const reader = makeFakeReader([
      [J({ type: "assistant", timestamp: iso(5000), message: { content: [{ type: "text", text: "慢发送期间的报告" }] } }),
       J({ type: "system", subtype: "turn_duration", durationMs: 1, timestamp: iso(5001) })],
    ]);
    const mgr = createLatePatrolManager({
      intervalMs: 10, stabilizeMs: 100000, maxAgeMs: 60000, maxBursts: 5,
      makeReader: () => reader,
      logger: { log: () => {}, warn: () => {} },
    });
    const send = async (text) => { sent.push(text); await slowSendGate; };  // 第一次发送挂起
    mgr.start(1001, HANDLE, send);
    await sleep(30);                       // interval poll 进入 flush,send 挂在 gate 上
    const sweep = mgr.sweepAndStop(1001);  // 此刻 sweep 必须排队,不得跳过或并发
    await sleep(20);
    resolveSlowSend();                     // 放行慢发送
    await sweep;
    expect(sent).toHaveLength(1);          // 恰好一次:进行中的 flush 完成,sweep 无残余可发
    expect(mgr.size()).toBe(0);
  });

  test("同 chat 重复 start → 新 handle 顶掉旧巡逻(单例)", async () => {
    const { mgr, send } = makeManager({ batches: [] });
    mgr.start(1001, HANDLE, send);
    mgr.start(1001, { ...HANDLE, offset: 500 }, send);
    expect(mgr.size()).toBe(1);
    mgr.stopAll();
    expect(mgr.size()).toBe(0);
  });
});
