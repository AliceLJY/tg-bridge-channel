import { test, expect } from "bun:test";
import { createCostGuard } from "./cost-guard.js";

test("cap=0 不启用，precheck 永远放行", () => {
  const g = createCostGuard({});
  expect(g.isEnabled()).toBe(false);
  g.record(1, 999);
  expect(g.precheck(1).allowed).toBe(true);
});

test("perChat 上限：累计达到即熔断", () => {
  const g = createCostGuard({ perChatCapUsd: 1.0 });
  expect(g.isEnabled()).toBe(true);
  expect(g.precheck(1).allowed).toBe(true);
  g.record(1, 0.6);
  expect(g.precheck(1).allowed).toBe(true); // 0.6 < 1.0
  g.record(1, 0.5); // 累计 1.1 >= 1.0
  const r = g.precheck(1);
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("chat");
  expect(r.cap).toBe(1.0);
});

test("daily 全局上限：跨会话累计也熔断", () => {
  const g = createCostGuard({ dailyCapUsd: 1.0 });
  g.record(1, 0.6);
  g.record(2, 0.5); // 不同 chat，全局累计 1.1
  const r = g.precheck(3); // 第三个全新 chat 也被全局熔断
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("daily");
});

test("两档独立：perChat 未超但 daily 超 → 按 daily 熔断", () => {
  const g = createCostGuard({ dailyCapUsd: 1.0, perChatCapUsd: 5.0 });
  g.record(1, 0.5);
  g.record(2, 0.6); // 全局 1.1 超 daily，但单会话都没超 5.0
  expect(g.precheck(1).reason).toBe("daily");
});

test("record 忽略 null / 0 / 负数", () => {
  const g = createCostGuard({ perChatCapUsd: 1.0 });
  g.record(1, null);
  g.record(1, 0);
  g.record(1, -5);
  g.record(1, undefined);
  expect(g.stats(1).chatSpent).toBe(0);
});

test("stats 反映累计", () => {
  const g = createCostGuard({ dailyCapUsd: 10, perChatCapUsd: 5 });
  g.record(1, 1.2345);
  const s = g.stats(1);
  expect(s.chatSpent).toBeCloseTo(1.2345);
  expect(s.globalSpent).toBeCloseTo(1.2345);
  expect(s.dailyCapUsd).toBe(10);
  expect(s.perChatCapUsd).toBe(5);
});

test("窗口滚动后清零", async () => {
  const g = createCostGuard({ perChatCapUsd: 1.0, windowMs: 10 });
  g.record(1, 0.9);
  expect(g.stats(1).chatSpent).toBeCloseTo(0.9);
  await new Promise((r) => setTimeout(r, 25)); // 等窗口(10ms)过期
  expect(g.stats(1).chatSpent).toBe(0); // 下次操作触发 roll 清零
  expect(g.precheck(1).allowed).toBe(true);
});

test("reset 清空", () => {
  const g = createCostGuard({ perChatCapUsd: 1.0 });
  g.record(1, 0.8);
  g.reset(1);
  expect(g.stats(1).chatSpent).toBe(0);
});
