// adapters/daemon-client.test.js
// 纯函数测试:control.sock 路径推导 + sessionId→活 worker 查找(注入 roster,不碰真 daemon)。
// op:reply 的 auth/重试是 live 行为(spike + dc-test 实测过),单测只覆盖可注入的纯逻辑。

import { describe, expect, test } from "bun:test";
import { findControlSockPath, findLiveWorkerBySession } from "./daemon-client.js";

describe("findControlSockPath", () => {
  test("rendezvousSock 同目录推出 control.sock", () => {
    const roster = { workers: { ab12: { rendezvousSock: "/tmp/cc-daemon-501/4cbeaa6e/rv/ab12.sock" } } };
    expect(findControlSockPath(roster)).toBe("/tmp/cc-daemon-501/4cbeaa6e/control.sock");
  });
  test("无 worker → null", () => {
    expect(findControlSockPath({ workers: {} })).toBe(null);
    expect(findControlSockPath(null)).toBe(null);
  });
  test("worker 无 rendezvousSock → 跳过,取下一个有的", () => {
    const roster = { workers: { a: { pid: 1 }, b: { rendezvousSock: "/tmp/cc-daemon-501/zz/rv/b.sock" } } };
    expect(findControlSockPath(roster)).toBe("/tmp/cc-daemon-501/zz/control.sock");
  });
});

describe("findLiveWorkerBySession", () => {
  const roster = {
    workers: {
      short1: { sessionId: "sid-aaa", cwd: "/Users/x", ptySock: "/tmp/x/spare/p.pty.sock", rendezvousSock: "/tmp/x/rv/short1.sock" },
      short2: { sessionId: "sid-bbb", cwd: "/tmp", rendezvousSock: "/tmp/x/rv/short2.sock" },  // 无 ptySock
    },
  };

  test("命中 sessionId → 返回 short/cwd/jsonlPath/hasPty", () => {
    const w = findLiveWorkerBySession("sid-aaa", roster);
    expect(w.short).toBe("short1");
    expect(w.sessionId).toBe("sid-aaa");
    expect(w.cwd).toBe("/Users/x");
    expect(w.hasPty).toBe(true);
    // jsonlPath = <homedir>/.claude/projects/<encodeCwd(cwd)>/<sid>.jsonl(cwd 非字母数字→'-')
    expect(w.jsonlPath.endsWith("/.claude/projects/-Users-x/sid-aaa.jsonl")).toBe(true);
  });

  test("worker 无 ptySock → hasPty=false(print 那种就接管不了)", () => {
    expect(findLiveWorkerBySession("sid-bbb", roster).hasPty).toBe(false);
  });

  test("无匹配 / 空 sessionId → null", () => {
    expect(findLiveWorkerBySession("sid-zzz", roster)).toBe(null);
    expect(findLiveWorkerBySession(null, roster)).toBe(null);
    expect(findLiveWorkerBySession("sid-aaa", { workers: {} })).toBe(null);
  });
});
