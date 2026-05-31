/**
 * automation-rework-guidance-p1.test.js — P1 接通 reworkGuidance → 下一轮（修死链 a）
 *
 * 死链(a)：reworkGuidance 构造后全仓 0 处消费 → 上轮失败教训不进下一轮。
 * P1 接通：rework 决策落 runtime.pendingReworkGuidance → 下一轮 startAutomationRound
 * 读它拼进 spec.entry.message（内容层注入，不碰 transport）→ 清 pending。
 *
 * 门 A：教训真传到下一轮的 entry.message（不是只断言"字段被写入 runtime"）。
 * 门 B：action 与 status/nextWakeAt 三元组映射一致（锁 action=派生投影不漂移）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteAutomationSpec,
  upsertAutomationSpec,
} from "../lib/automation/automation-registry.js";
import {
  deleteAutomationRuntimeState,
  upsertAutomationRuntimeState,
  getAutomationRuntimeState,
  ensureAutomationRuntimeState,
} from "../lib/automation/automation-runtime.js";
import {
  startAutomationRound,
  composeEntryMessageWithRework,
} from "../lib/automation/automation-start.js";
import { deriveDecision, buildNextWakeAt } from "../lib/automation/automation-decision.js";

function buildLogger() {
  return { info() {}, warn() {}, error() {} };
}

// ── 门 A：教训真传到下一轮 entry.message ───────────────────────────────────────

test("门A：pendingReworkGuidance 拼进下一轮 entry.message（含 failureClass/reworkTarget/findings）", async () => {
  const automationId = `p1-rework-${Date.now()}`;
  let capturedMessage = null;
  try {
    await upsertAutomationSpec({
      id: automationId,
      enabled: true,
      objective: { summary: "rework propagation test", instruction: "x", domain: "coding" },
      entry: { targetAgent: "controller", message: "Run experiment X." },
      wakePolicy: { type: "result", onResult: true },
      systemActionDelivery: { agentId: "controller" },
    });

    // 种入上轮教训（模拟 finalize 写进 runtime）
    const seeded = await ensureAutomationRuntimeState({ id: automationId, enabled: true });
    await upsertAutomationRuntimeState({
      ...seeded,
      pendingReworkGuidance: {
        failureClass: "failed",
        reworkTarget: "module-Y",
        strategy: "analyze_failure_and_retry_with_fixes",
        actionableFindings: [{ category: "review", severity: "error", message: "edge case Z unhandled" }],
      },
    });

    await startAutomationRound(automationId, {
      api: {},
      enqueue: () => {},
      wakePlanner: async () => null,
      logger: buildLogger(),
      dispatchAcceptIngressMessageFn: async (message) => {
        capturedMessage = message; // 捕获真正投到下一轮的任务文本
        return { ok: true, contractId: "TC-P1-REWORK" };
      },
    });

    // 教训真进了下一轮任务文本（不是只写 runtime）
    assert.ok(capturedMessage, "应捕获到下一轮 entry.message");
    assert.match(capturedMessage, /Run experiment X\./, "应保留原始任务文本");
    assert.match(capturedMessage, /failureClass: failed/, "应含 failureClass");
    assert.match(capturedMessage, /module-Y/, "应含 reworkTarget");
    assert.match(capturedMessage, /edge case Z unhandled/, "应含 actionableFinding");

    // 注入后清 pending（避免重复注入下下轮）
    const afterStart = await getAutomationRuntimeState(automationId);
    assert.equal(afterStart.pendingReworkGuidance, null, "成功起跑后应清空 pendingReworkGuidance");
  } finally {
    await deleteAutomationRuntimeState(automationId).catch(() => {});
    await deleteAutomationSpec(automationId).catch(() => {});
  }
});

test("门A补充：无 pendingReworkGuidance 时 entry.message 原样投递（不污染）", async () => {
  const automationId = `p1-norework-${Date.now()}`;
  let capturedMessage = null;
  try {
    await upsertAutomationSpec({
      id: automationId,
      enabled: true,
      objective: { summary: "no rework test", instruction: "x", domain: "coding" },
      entry: { targetAgent: "controller", message: "Plain task." },
      wakePolicy: { type: "result", onResult: true },
      systemActionDelivery: { agentId: "controller" },
    });

    await startAutomationRound(automationId, {
      api: {},
      enqueue: () => {},
      wakePlanner: async () => null,
      logger: buildLogger(),
      dispatchAcceptIngressMessageFn: async (message) => {
        capturedMessage = message;
        return { ok: true, contractId: "TC-P1-NOREWORK" };
      },
    });

    assert.equal(capturedMessage, "Plain task.", "无教训时任务文本应原样，不附加 rework 段");
  } finally {
    await deleteAutomationRuntimeState(automationId).catch(() => {});
    await deleteAutomationSpec(automationId).catch(() => {});
  }
});

// composeEntryMessageWithRework 纯函数单测（注入/清洁回退）
test("composeEntryMessageWithRework：有教训注入，无教训原样", () => {
  const withGuidance = composeEntryMessageWithRework("Base.", {
    failureClass: "timeout",
    reworkTarget: "stage-A",
    actionableFindings: [{ message: "too slow" }],
  });
  assert.match(withGuidance, /Base\./);
  assert.match(withGuidance, /failureClass: timeout/);
  assert.match(withGuidance, /stage-A/);
  assert.match(withGuidance, /too slow/);
  // 无教训/空壳 → 原样
  assert.equal(composeEntryMessageWithRework("Base.", null), "Base.");
  assert.equal(composeEntryMessageWithRework("Base.", { actionableFindings: [] }), "Base.");
});

// ── 门 B：action 与 status/nextWakeAt 三元组映射一致（锁 action=派生投影）──────

// deriveDecision 经 normalizeAutomationDecision 产出 { action, decision, status, nextWakeAt }。
// 这里逆向校验：每个分支的 action 必须与 (decision→status/nextWakeAt) 派生映射严格一致，
// 防止本次改动让 action 漂移成独立真值。
test("门B：deriveDecision 的 action 与 status/nextWakeAt 三元组映射严格一致", () => {
  const now = 1000;
  const continuous = { enabled: true, governance: { mode: "continuous" }, wakePolicy: { onResult: true, onFailure: true, cooldownSeconds: 60 } };

  // 1) disabled → pause: action=pause, status=paused, nextWakeAt=null
  const d1 = deriveDecision({ enabled: false }, {}, { round: 1, terminalStatus: "completed", score: null, noImprovementStreak: 0 }, now);
  assert.deepEqual([d1.action, d1.status, d1.nextWakeAt], ["pause", "paused", null], "disabled → pause/paused/null");

  // 2) awaiting_input → pause
  const d2 = deriveDecision(continuous, {}, { round: 1, terminalStatus: "awaiting_input", score: null, noImprovementStreak: 0 }, now);
  assert.deepEqual([d2.action, d2.status, d2.nextWakeAt], ["pause", "paused", null], "awaiting_input → pause/paused/null");

  // 3) reviewer rework → action=rework, status=idle, nextWakeAt=cooldown（下一轮唤醒）
  const reviewerRework = { verdict: "fail", continueHint: "rework", failureClass: "failed", reworkTarget: "m", findings: [{ message: "x" }] };
  const d3 = deriveDecision(continuous, {}, { round: 1, terminalStatus: "failed", score: null, noImprovementStreak: 0, reviewerResult: reviewerRework }, now);
  assert.equal(d3.action, "rework", "reviewer rework → action=rework");
  assert.equal(d3.status, "idle", "rework → status=idle（continue 决策的派生）");
  assert.equal(d3.nextWakeAt, buildNextWakeAt(continuous, now), "rework → nextWakeAt=cooldown 唤醒下一轮");
  assert.ok(d3.reworkGuidance, "rework 决策必须带 reworkGuidance");

  // 4) reviewer conclude → action=conclude, status=completed, nextWakeAt=null
  const d4 = deriveDecision(continuous, {}, { round: 1, terminalStatus: "completed", score: 1, noImprovementStreak: 0, reviewerResult: { verdict: "pass", continueHint: "conclude" } }, now);
  assert.deepEqual([d4.action, d4.status, d4.nextWakeAt], ["conclude", "completed", null], "conclude → conclude/completed/null");
  assert.equal(d4.reworkGuidance, null, "非 rework 决策不带 reworkGuidance");

  // 5) fail without wakeOnFailure → abandon/error/null
  const noWake = { enabled: true, governance: { mode: "continuous" }, wakePolicy: {} };
  const d5 = deriveDecision(noWake, {}, { round: 1, terminalStatus: "failed", score: null, noImprovementStreak: 0, reviewerResult: { verdict: "fail", continueHint: null } }, now);
  assert.deepEqual([d5.action, d5.status, d5.nextWakeAt], ["abandon", "error", null], "fail no-wake → abandon/error/null");

  // 6) continue on result → continue/idle/cooldown
  const d6 = deriveDecision(continuous, {}, { round: 1, terminalStatus: "completed", score: null, noImprovementStreak: 0 }, now);
  assert.deepEqual([d6.action, d6.status], ["continue", "idle"], "continue_on_result → continue/idle");
  assert.equal(d6.nextWakeAt, buildNextWakeAt(continuous, now), "continue → nextWakeAt=cooldown");
});

test("门B：rework 决策才带 reworkGuidance；conclude/pause/abandon 不带", () => {
  const now = 1000;
  const continuous = { enabled: true, governance: { mode: "continuous" }, wakePolicy: { onResult: true, onFailure: true, cooldownSeconds: 60 } };
  const guidanceReviewer = { failureClass: "failed", reworkTarget: "m", findings: [{ message: "x" }] };

  // rework 带
  const rework = deriveDecision(continuous, {}, { round: 1, terminalStatus: "failed", score: null, noImprovementStreak: 0, reviewerResult: { ...guidanceReviewer, verdict: "fail", continueHint: "rework" } }, now);
  assert.equal(rework.action, "rework");
  assert.ok(rework.reworkGuidance, "rework 带 reworkGuidance");

  // pause 不带（即便 reviewerResult 含 failureClass）
  const pause = deriveDecision(continuous, {}, { round: 1, terminalStatus: "completed", score: 1, noImprovementStreak: 0, reviewerResult: { ...guidanceReviewer, verdict: "fail", continueHint: "pause" } }, now);
  assert.equal(pause.action, "pause");
  assert.equal(pause.reworkGuidance, null, "pause 不带 reworkGuidance");
});
