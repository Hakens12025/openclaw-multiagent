/**
 * agent-timeout-sweep.test.js — per-agent 硬超时巡检
 *
 * 覆盖：
 *   1. getAgentTimeoutMs：显式 timeoutSeconds → ms；无 → null；0/负 → null；低于 60s 下限 → 钳到 60s
 *   2. 显式超时 + elapsed 超 → 经 handleCrashRecovery(error:tracker_timeout) force-fail
 *   3. retry_scheduled → finalizeAgentSession mode=retry_suspend；abandoned → mode=terminal
 *   4. 无显式超时的 agent → 永不硬杀（opt-in），仅静默时 inactivity wake
 *   5. 未超时（elapsed < timeout 且未静默）→ 不动
 *   6. per-agent maxRetry 透传给 handleCrashRecovery
 *   7. 静默超阈值（无硬超时）→ 保留原 inactivity wake 行为
 *   8. 硬超时优先于静默
 *   --- 对抗审查加固守卫 ---
 *   9. 无 contract.path 的会话（direct/QQ）→ 即使超时也不硬杀（避免无法 durable 记 retryCount 的无限重试）
 *  10. agent_end 流水线正在处理的 session → 跳过（守一条路径，不双调 crash-recovery）
 *  11. sweepInProgress 再入守卫：上一次巡检未完成 → 本次跳过（防 sweep+sweep 重叠双处理）
 *
 * mock 重依赖 + cachebust 新 import + finally restore（避免 mock 泄漏到其他测试文件）。时间显式注入 now。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const NOW = 10_000_000;
const STALE_SILENCE_MS = 20 * 60_000;

let bustCounter = 0;

async function withSweep(setup, fn) {
  const crashCalls = [];
  const finalizeCalls = [];
  const wakeCalls = [];
  const inFlight = new Set(setup.inFlight || []);
  const mocks = [
    mock.module("../lib/store/tracker-store.js", {
      namedExports: { listTrackingEntries: () => setup.entries || [] },
    }),
    mock.module("../lib/agent/agent-identity.js", {
      namedExports: { getRuntimeAgentConfig: (id) => (setup.configs || {})[id] || null },
    }),
    mock.module("../lib/lifecycle/crash-recovery.js", {
      namedExports: {
        handleCrashRecovery: async (args) => {
          crashCalls.push(args);
          if (setup.onCrash) await setup.onCrash();
          return setup.crashResult || { status: "retry_scheduled" };
        },
      },
    }),
    mock.module("../lib/lifecycle/runtime-lifecycle.js", {
      namedExports: {
        finalizeAgentSession: async (args) => { finalizeCalls.push(args); return {}; },
        SESSION_FINALIZE_MODE: {
          TERMINAL: "terminal",
          RETRY_SUSPEND: "retry_suspend",
          SYNTHETIC_COMPLETION: "synthetic_completion",
        },
      },
    }),
    mock.module("../lib/session/session-phase-store.js", {
      namedExports: { isAgentEndInFlight: (sk) => inFlight.has(sk) },
    }),
    mock.module("../lib/transport/runtime-wake-transport.js", {
      namedExports: { runtimeWakeAgent: (...a) => { wakeCalls.push(a); } },
    }),
  ];
  try {
    bustCounter += 1;
    const mod = await import(`../lib/lifecycle/agent-timeout-sweep.js?bust=${bustCounter}`);
    await fn(mod, { crashCalls, finalizeCalls, wakeCalls });
  } finally {
    for (const m of mocks) m.restore();
  }
}

// running tracker entry [sessionKey, trackingState]；默认带 contract.path（持久化合约 = 可硬超时）。
function runningEntry(sessionKey, agentId, { startMs, lastToolTs, contractPath = "/fake/contract.json" } = {}) {
  const t = { status: "running", agentId, startMs: startMs ?? NOW };
  if (lastToolTs != null) t.toolCalls = [{ ts: lastToolTs }];
  if (contractPath) t.contract = { path: contractPath };
  return [sessionKey, t];
}

// ── 1. getAgentTimeoutMs ─────────────────────────────────────────────────────

test("getAgentTimeoutMs：显式/缺失/0/下限", async () => {
  await withSweep(
    { configs: { a1: { constraints: { timeoutSeconds: 120 } }, a2: {}, a3: { constraints: { timeoutSeconds: 0 } }, a4: { constraints: { timeoutSeconds: 10 } } } },
    async ({ getAgentTimeoutMs }) => {
      assert.equal(getAgentTimeoutMs("a1"), 120_000, "显式 120s → 120000ms");
      assert.equal(getAgentTimeoutMs("a2"), null, "无 constraints → null（不硬杀）");
      assert.equal(getAgentTimeoutMs("a3"), null, "timeoutSeconds=0 → null");
      assert.equal(getAgentTimeoutMs("a4"), 60_000, "10s 低于下限 → 钳到 60000ms");
      assert.equal(getAgentTimeoutMs("nonexistent"), null, "未知 agent → null");
    },
  );
});

// ── 2 + 3. 显式超时 → force-fail + mode 分流 ───────────────────────────────────

test("显式超时 elapsed 超 → handleCrashRecovery(tracker_timeout) + retry_suspend", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 200_000 })],
      configs: { a1: { constraints: { timeoutSeconds: 120 } } },
      crashResult: { status: "retry_scheduled" },
    },
    async ({ sweepRunningTrackers }, caps) => {
      const swept = await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls.length, 1, "应调一次 handleCrashRecovery");
      assert.equal(caps.crashCalls[0].error, "tracker_timeout");
      assert.equal(caps.crashCalls[0].sessionKey, "sk1");
      assert.equal(caps.crashCalls[0].trackingState.agentId, "a1");
      assert.equal(caps.crashCalls[0].maxRetryCount, 3, "无 per-agent maxRetry → 全局默认 3");
      assert.equal(caps.finalizeCalls.length, 1);
      assert.equal(caps.finalizeCalls[0].mode, "retry_suspend", "retry_scheduled → RETRY_SUSPEND");
      assert.equal(swept[0].action, "timeout");
      assert.equal(swept[0].outcome, "retry_scheduled");
    },
  );
});

test("显式超时 + 重试耗尽(abandoned) → finalize mode=terminal", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 200_000 })],
      configs: { a1: { constraints: { timeoutSeconds: 120 } } },
      crashResult: { status: "abandoned" },
    },
    async ({ sweepRunningTrackers }, caps) => {
      await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.finalizeCalls[0].mode, "terminal", "非 retry_scheduled → TERMINAL（释放槽位+删 tracker）");
    },
  );
});

// ── 4. 无显式超时 → 永不硬杀 ──────────────────────────────────────────────────

test("无显式 timeout 的 agent → 即使 elapsed 巨大也不硬杀", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 5 * 60 * 60_000, lastToolTs: NOW - 1000 })],
      configs: { a1: {} },
    },
    async ({ sweepRunningTrackers }, caps) => {
      const swept = await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls.length, 0, "无显式超时 → 不 force-fail");
      assert.equal(caps.finalizeCalls.length, 0);
      assert.equal(caps.wakeCalls.length, 0, "刚活动过 → 也不 inactivity wake");
      assert.equal(swept.length, 0);
    },
  );
});

// ── 5. 未超时 → 不动 ─────────────────────────────────────────────────────────

test("elapsed < timeout 且未静默 → 不动", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 100_000, lastToolTs: NOW - 5_000 })],
      configs: { a1: { constraints: { timeoutSeconds: 600 } } },
    },
    async ({ sweepRunningTrackers }, caps) => {
      const swept = await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls.length, 0);
      assert.equal(caps.wakeCalls.length, 0);
      assert.equal(swept.length, 0);
    },
  );
});

// ── 6. per-agent maxRetry 透传 ────────────────────────────────────────────────

test("per-agent maxRetry → 透传给 handleCrashRecovery", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 200_000 })],
      configs: { a1: { constraints: { timeoutSeconds: 120, maxRetry: 5 } } },
    },
    async ({ sweepRunningTrackers }, caps) => {
      await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls[0].maxRetryCount, 5, "per-agent maxRetry=5 应被透传");
    },
  );
});

// ── 7. 静默 inactivity wake 保留 ──────────────────────────────────────────────

test("无硬超时 + 静默超阈值 → 保留 inactivity wake", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 30 * 60_000, lastToolTs: NOW - 25 * 60_000 })],
      configs: { a1: {} },
    },
    async ({ sweepRunningTrackers }, caps) => {
      const swept = await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls.length, 0, "无硬超时 → 不 fail");
      assert.equal(caps.wakeCalls.length, 1, "静默超阈值 → inactivity wake");
      assert.equal(caps.wakeCalls[0][1], "inactivity");
      assert.equal(swept[0].action, "inactivity_wake");
      assert.ok(STALE_SILENCE_MS > 0);
    },
  );
});

// ── 8. 硬超时优先于静默 ───────────────────────────────────────────────────────

test("硬超时 + 同时静默 → 走 timeout fail（不退化成 wake）", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 30 * 60_000, lastToolTs: NOW - 25 * 60_000 })],
      configs: { a1: { constraints: { timeoutSeconds: 120 } } },
    },
    async ({ sweepRunningTrackers }, caps) => {
      const swept = await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls.length, 1, "应 force-fail");
      assert.equal(caps.wakeCalls.length, 0, "不应再 inactivity wake");
      assert.equal(swept[0].action, "timeout");
    },
  );
});

// ── 9. 无 contract.path → 不硬杀（对抗审查 #4）─────────────────────────────────

test("超时但无 contract.path（direct/QQ 会话）→ 不硬杀（避免无限重试）", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 200_000, contractPath: null, lastToolTs: NOW - 1000 })],
      configs: { a1: { constraints: { timeoutSeconds: 120 } } },
    },
    async ({ sweepRunningTrackers }, caps) => {
      const swept = await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls.length, 0, "无持久合约 → 不 force-fail");
      assert.equal(swept.length, 0);
    },
  );
});

// ── 10. agent_end 进行中 → 跳过（对抗审查 #1，守一条路径）──────────────────────

test("session 正被 agent_end 处理 → sweep 跳过（不双调 crash-recovery）", async () => {
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 200_000 })],
      configs: { a1: { constraints: { timeoutSeconds: 120 } } },
      inFlight: ["sk1"], // agent_end 正在处理 sk1
    },
    async ({ sweepRunningTrackers }, caps) => {
      const swept = await sweepRunningTrackers({ now: NOW, api: {}, logger: null });
      assert.equal(caps.crashCalls.length, 0, "agent_end 在处理 → sweep 不应再触发 recover");
      assert.equal(caps.finalizeCalls.length, 0);
      assert.equal(swept.length, 0);
    },
  );
});

// ── 11. sweepInProgress 再入守卫（对抗审查 #6）────────────────────────────────

test("巡检未完成时再次触发 → 再入守卫跳过（防 sweep+sweep 重叠）", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withSweep(
    {
      entries: [runningEntry("sk1", "a1", { startMs: NOW - 200_000 })],
      configs: { a1: { constraints: { timeoutSeconds: 120 } } },
      onCrash: () => gate, // 让第一次 sweep 卡在 handleCrashRecovery 内
    },
    async ({ sweepRunningTrackers }, caps) => {
      const p1 = sweepRunningTrackers({ now: NOW, api: {}, logger: null }); // 进入并卡住
      await new Promise((r) => setImmediate(r)); // 让 p1 到达 await
      const r2 = await sweepRunningTrackers({ now: NOW, api: {}, logger: null }); // 应被再入守卫挡
      assert.equal(r2.length, 0, "重叠巡检应被跳过");
      assert.equal(caps.crashCalls.length, 1, "第二次不应再触发 recover");
      release();
      await p1;
      assert.equal(caps.crashCalls.length, 1, "第一次完成后仍只 1 次 recover");
    },
  );
});
