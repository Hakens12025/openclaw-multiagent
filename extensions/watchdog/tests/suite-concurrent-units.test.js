// tests/suite-concurrent-units.test.js — concurrent 套件纯逻辑单测(零 IO)
//
// 锁 checks/concurrent-chain.js 的信号→CheckResult 映射:case 真值、探针消息、
// 各评估器(受理/忙位/FIFO/双绑/终态/释放)、verdict 聚合与 blocked 语义。
// 注意:fail 态 E-CONC-* 码的 add 时注册校验属集成接线(error-codes.js 注册后由
// check-runner 兜底),本文件对 fail check 只断言形状;pass/blocked(E-RUNNER-005)
// 走真 createCheckContext.addCheck 全量校验。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONCURRENT_CASES,
  buildCaseDescriptors,
  buildConcurrentProbeMessage,
  buildConcurrentStageDescriptors,
  buildConcurrentVerdicts,
  buildProbeMarker,
  evaluateAcceptance,
  evaluateAllTerminal,
  evaluateBusySlotUniqueness,
  evaluateFifoActivation,
  evaluateNoDoubleBind,
  evaluateReleaseReconciled,
  listConcurrentStages,
  mapConcurrentVerdictsToChecks,
} from "../lib/formal-runtime/checks/concurrent-chain.js";
import { createCheckContext } from "../lib/formal-runtime/checks/check-runner.js";

const SAME3 = CONCURRENT_CASES.find((c) => c.id === "conc-same-3");
const BURST5 = CONCURRENT_CASES.find((c) => c.id === "conc-burst-5");

// ── case 真值与 stage 声明 ────────────────────────────────────────────────────

test("concurrent: case 真值(3 连注/5 连发,每 case 预算 ≤300000ms)", () => {
  assert.equal(CONCURRENT_CASES.length, 2);
  assert.equal(SAME3.injectCount, 3);
  assert.equal(BURST5.injectCount, 5);
  for (const probeCase of CONCURRENT_CASES) {
    assert.ok(probeCase.timeoutMs <= 300000, `${probeCase.id} timeoutMs 必须 ≤300000`);
  }
});

test("concurrent: stage 声明(码分工 + 依赖链)与描述符 id 一致", () => {
  for (const probeCase of CONCURRENT_CASES) {
    const stages = listConcurrentStages(probeCase);
    const codeByKey = Object.fromEntries(stages.map((s) => [s.key, s.code]));
    assert.deepEqual(codeByKey, {
      accepted: "E-CONC-001",
      busyUnique: "E-CONC-002",
      fifoOrder: "E-CONC-002",
      noDoubleBind: "E-CONC-003",
      allTerminal: "E-CONC-004",
      releaseSettled: "E-CONC-004",
    });
    const depsByKey = Object.fromEntries(stages.map((s) => [s.key, s.deps]));
    assert.deepEqual(depsByKey.accepted, []);
    assert.deepEqual(depsByKey.busyUnique, ["accepted"]);
    assert.deepEqual(depsByKey.releaseSettled, ["allTerminal"]);

    // 描述符与映射 id 一致(markBlocked 与判定共用同一组 id,防字面量漂移)
    const descriptorIds = buildConcurrentStageDescriptors(probeCase).map((d) => d.id);
    const mappedIds = mapConcurrentVerdictsToChecks(probeCase, {}).map((c) => c.id);
    assert.deepEqual(descriptorIds, mappedIds);
    // 完整描述符序 = inject + stage(prep 位随图夹具于 2026-08-18 退场,
    // 本套件不再有前置副作用,不留永不产生结果的幽灵 descriptor)
    const fullIds = buildCaseDescriptors(probeCase).map((d) => d.id);
    assert.equal(fullIds[0], `concurrent.${probeCase.id}-inject`);
    assert.deepEqual(fullIds.slice(1), descriptorIds);
    assert.ok(!fullIds.some((id) => id.endsWith("-prep")), "prep descriptor 已退场");
  }
});

test("concurrent: 探针消息含唯一标记与序号,marker 构造稳定", () => {
  const marker = buildProbeMarker("conc-same-3", 1, "zzz");
  assert.equal(marker, "CONC-conc-same-3-2-zzz");
  const message = buildConcurrentProbeMessage({ marker, index: 1, total: 3 });
  assert.match(message, /2\/3/);
  assert.ok(message.includes(marker), "消息必须内嵌 marker(受理兜底按 task 文本对号)");
});

// ── 各评估器 ─────────────────────────────────────────────────────────────────

test("concurrent: evaluateAcceptance 全员立约 ok;缺约/重复 id 不 ok", () => {
  const good = evaluateAcceptance({
    expectedCount: 3,
    accepted: [
      { marker: "m1", contractId: "TC-1" },
      { marker: "m2", contractId: "TC-2" },
      { marker: "m3", contractId: "TC-3" },
    ],
  });
  assert.equal(good.ok, true);
  assert.match(good.evidence, /3\/3/);

  const partial = evaluateAcceptance({
    expectedCount: 3,
    accepted: [
      { marker: "m1", contractId: "TC-1" },
      { marker: "m2", contractId: null },
      { marker: "m3", contractId: "TC-3" },
    ],
  });
  assert.equal(partial.ok, false);
  assert.match(partial.evidence, /2\/3/);
  assert.match(partial.evidence, /m2/);

  const duplicate = evaluateAcceptance({
    expectedCount: 2,
    accepted: [
      { marker: "m1", contractId: "TC-1" },
      { marker: "m2", contractId: "TC-1" },
    ],
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.evidence, /not distinct/);
});

test("concurrent: evaluateBusySlotUniqueness 忙位唯一 ok;>1 running 违反;零采样不 ok", () => {
  const good = evaluateBusySlotUniqueness({
    samples: [
      { elapsedMs: 1000, runningContractIds: ["TC-1"], queuedContractIds: ["TC-2", "TC-3"] },
      { elapsedMs: 2000, runningContractIds: [], queuedContractIds: ["TC-2", "TC-3"] },
      { elapsedMs: 3000, runningContractIds: ["TC-2"], queuedContractIds: ["TC-3"] },
    ],
  });
  assert.equal(good.ok, true);
  assert.match(good.evidence, /max concurrent running=1/);
  assert.match(good.evidence, /peak queue depth=2/);

  const shared = evaluateBusySlotUniqueness({
    samples: [
      { elapsedMs: 1000, runningContractIds: ["TC-1"], queuedContractIds: [] },
      { elapsedMs: 2000, runningContractIds: ["TC-1", "TC-2"], queuedContractIds: ["TC-3"] },
    ],
  });
  assert.equal(shared.ok, false);
  assert.match(shared.evidence, /busy slot shared in 1\/2 samples/);
  assert.match(shared.evidence, /TC-1, TC-2/);

  assert.equal(evaluateBusySlotUniqueness({ samples: [] }).ok, false, "零采样 = 没验证到,不能宣告 pass");
});

test("concurrent: evaluateFifoActivation 子序列一致 ok;乱序违反;漏观测不算违反", () => {
  const creationOrder = ["TC-1", "TC-2", "TC-3"];
  const good = evaluateFifoActivation({ creationOrder, activationOrder: ["TC-1", "TC-2", "TC-3"] });
  assert.equal(good.ok, true);
  assert.match(good.evidence, /3\/3 activations observed/);

  // 漏观测(TC-2 在两次采样间跑完):相对序仍一致 → ok
  const sparse = evaluateFifoActivation({ creationOrder, activationOrder: ["TC-1", "TC-3"] });
  assert.equal(sparse.ok, true);
  assert.match(sparse.evidence, /2\/3 activations observed/);

  const violated = evaluateFifoActivation({ creationOrder, activationOrder: ["TC-1", "TC-3", "TC-2"] });
  assert.equal(violated.ok, false);
  assert.match(violated.evidence, /FIFO violated/);
  assert.match(violated.evidence, /TC-2 \(created #2\) activated after TC-3 \(created #3\)/);

  const unknown = evaluateFifoActivation({ creationOrder, activationOrder: ["TC-9"] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.evidence, /outside the probe set/);
});

test("concurrent: evaluateNoDoubleBind 单认领 ok(resume 同 key 不算双绑);双认领违反", () => {
  const good = evaluateNoDoubleBind({
    claims: {
      "TC-1": ["agent:planner:contract:TC-1", "agent:planner:contract:TC-1"],
      "TC-2": ["agent:planner:contract:TC-2"],
      "TC-3": [],
    },
  });
  assert.equal(good.ok, true);
  assert.match(good.evidence, /2 contracts each claimed by exactly one session/);

  const doubled = evaluateNoDoubleBind({
    claims: {
      "TC-1": ["agent:planner:contract:TC-1", "agent:worker:contract:TC-1"],
    },
  });
  assert.equal(doubled.ok, false);
  assert.match(doubled.evidence, /TC-1 claimed by 2 sessions/);
});

test("concurrent: evaluateAllTerminal 全终态 ok;卡死列名;空集不 ok", () => {
  const good = evaluateAllTerminal({
    expectedContractIds: ["TC-1", "TC-2"],
    terminalStatuses: { "TC-1": "completed", "TC-2": "failed" },
    timeoutMs: 300000,
  });
  assert.equal(good.ok, true, "failed 也是终态——本套件测并发力学不测任务成败");
  assert.match(good.evidence, /TC-2=failed/);

  const stuck = evaluateAllTerminal({
    expectedContractIds: ["TC-1", "TC-2", "TC-3"],
    terminalStatuses: { "TC-1": "completed" },
    timeoutMs: 300000,
  });
  assert.equal(stuck.ok, false);
  assert.match(stuck.evidence, /1\/3 contracts terminal within 300000ms/);
  assert.match(stuck.evidence, /stuck: TC-2, TC-3/);

  assert.equal(evaluateAllTerminal({ expectedContractIds: [] }).ok, false);
});

test("concurrent: evaluateReleaseReconciled 无残留 ok;busy/队列残留违反;快照缺失不 ok", () => {
  const clean = evaluateReleaseReconciled({
    targetState: { busy: false, currentContract: null, queue: [], dispatchingQueueEntry: null },
    probeContractIds: ["TC-1", "TC-2"],
  });
  assert.equal(clean.ok, true);

  const busyResidue = evaluateReleaseReconciled({
    targetState: { busy: true, currentContract: "TC-2", queue: [] },
    probeContractIds: ["TC-1", "TC-2"],
  });
  assert.equal(busyResidue.ok, false);
  assert.match(busyResidue.evidence, /busy=true/);
  assert.match(busyResidue.evidence, /currentContract still holds TC-2/);

  const queueResidue = evaluateReleaseReconciled({
    targetState: { busy: false, currentContract: null, queue: [{ contractId: "TC-3" }] },
    probeContractIds: ["TC-3"],
  });
  assert.equal(queueResidue.ok, false);
  assert.match(queueResidue.evidence, /queue still holds: TC-3/);

  assert.equal(evaluateReleaseReconciled({ targetState: null, probeContractIds: [] }).ok, false);
});

// ── verdict 聚合 + CheckResult 映射 ───────────────────────────────────────────

const GOOD_OBSERVED = Object.freeze({
  accepted: [
    { marker: "m1", contractId: "TC-1" },
    { marker: "m2", contractId: "TC-2" },
    { marker: "m3", contractId: "TC-3" },
  ],
  samples: [
    { elapsedMs: 1000, runningContractIds: ["TC-1"], queuedContractIds: ["TC-2", "TC-3"] },
    { elapsedMs: 5000, runningContractIds: ["TC-2"], queuedContractIds: ["TC-3"] },
    { elapsedMs: 9000, runningContractIds: ["TC-3"], queuedContractIds: [] },
  ],
  activationOrder: ["TC-1", "TC-2", "TC-3"],
  claims: {
    "TC-1": ["agent:planner:contract:TC-1"],
    "TC-2": ["agent:planner:contract:TC-2"],
    "TC-3": ["agent:planner:contract:TC-3"],
  },
  terminalStatuses: { "TC-1": "completed", "TC-2": "completed", "TC-3": "completed" },
  finalTargetState: { busy: false, currentContract: null, queue: [], dispatchingQueueEntry: null },
});

test("concurrent: 全量良观测 → 全 stage pass,经真 addCheck 校验(pass 不带 code)", () => {
  const verdicts = buildConcurrentVerdicts(SAME3, GOOD_OBSERVED);
  const checks = mapConcurrentVerdictsToChecks(SAME3, verdicts, { caseElapsedMs: 12000 });
  assert.equal(checks.length, listConcurrentStages(SAME3).length);
  const ctx = createCheckContext({ presetId: "concurrent" });
  for (const check of checks) {
    assert.equal(check.status, "pass", `${check.id} 应 pass`);
    assert.equal(check.code, undefined, "pass 不得带 code");
    assert.ok(/^concurrent\.conc-same-3-/.test(check.id), `id 形如 concurrent.conc-same-3-*: ${check.id}`);
    ctx.addCheck(check); // 任何不合规(坏 id/pass 带码)会 throw
  }
  assert.equal(ctx.summarize().verdict, "PASS");
});

test("concurrent: 受理缺失 → accepted fail E-CONC-001,下游全部 blocked E-RUNNER-005", () => {
  const verdicts = buildConcurrentVerdicts(SAME3, {
    ...GOOD_OBSERVED,
    accepted: [{ marker: "m1", contractId: "TC-1" }, { marker: "m2", contractId: null }, { marker: "m3", contractId: null }],
  });
  assert.equal(Object.keys(verdicts).length, 1, "受理不 ok 时不评下游");
  const checks = mapConcurrentVerdictsToChecks(SAME3, verdicts, { caseElapsedMs: 300000 });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  const accepted = byId["concurrent.conc-same-3-accepted"];
  assert.equal(accepted.status, "fail");
  assert.equal(accepted.code, "E-CONC-001");
  assert.equal(accepted.durationMs, 300000);
  const ctx = createCheckContext({ presetId: "concurrent" });
  for (const check of checks) {
    if (check.id === accepted.id) continue;
    assert.equal(check.status, "blocked", `${check.id} 前置受理缺失应 blocked 而非二次 fail`);
    assert.equal(check.code, "E-RUNNER-005");
    assert.match(check.evidence, /accepted|allTerminal/);
    ctx.addCheck(check); // blocked E-RUNNER-005 已注册,走真校验
  }
});

test("concurrent: 忙位共享/FIFO 乱序 → fail E-CONC-002;双绑 → E-CONC-003", () => {
  const verdicts = buildConcurrentVerdicts(SAME3, {
    ...GOOD_OBSERVED,
    samples: [{ elapsedMs: 2000, runningContractIds: ["TC-1", "TC-2"], queuedContractIds: [] }],
    activationOrder: ["TC-2", "TC-1", "TC-3"],
    claims: { ...GOOD_OBSERVED.claims, "TC-1": ["agent:planner:contract:TC-1", "agent:worker:contract:TC-1"] },
  });
  const byId = Object.fromEntries(
    mapConcurrentVerdictsToChecks(SAME3, verdicts, { caseElapsedMs: 60000 }).map((c) => [c.id, c]),
  );
  assert.equal(byId["concurrent.conc-same-3-busy-slot-unique"].status, "fail");
  assert.equal(byId["concurrent.conc-same-3-busy-slot-unique"].code, "E-CONC-002");
  assert.equal(byId["concurrent.conc-same-3-fifo-activation"].status, "fail");
  assert.equal(byId["concurrent.conc-same-3-fifo-activation"].code, "E-CONC-002");
  assert.equal(byId["concurrent.conc-same-3-no-double-bind"].status, "fail");
  assert.equal(byId["concurrent.conc-same-3-no-double-bind"].code, "E-CONC-003");
  // 相互独立的 stage 不受牵连
  assert.equal(byId["concurrent.conc-same-3-all-terminal"].status, "pass");
  assert.equal(byId["concurrent.conc-same-3-release-reconciled"].status, "pass");
});

test("concurrent: 终态缺失 → fail E-CONC-004,释放对账 blocked;释放残留 → fail E-CONC-004", () => {
  const stuckVerdicts = buildConcurrentVerdicts(BURST5, {
    ...GOOD_OBSERVED,
    accepted: [
      { marker: "m1", contractId: "TC-1" },
      { marker: "m2", contractId: "TC-2" },
      { marker: "m3", contractId: "TC-3" },
      { marker: "m4", contractId: "TC-4" },
      { marker: "m5", contractId: "TC-5" },
    ],
    terminalStatuses: { "TC-1": "completed", "TC-2": "completed" },
  });
  assert.equal(stuckVerdicts.releaseSettled, undefined, "全终态不 ok 时不评释放对账");
  const byId = Object.fromEntries(
    mapConcurrentVerdictsToChecks(BURST5, stuckVerdicts, { caseElapsedMs: 300000 }).map((c) => [c.id, c]),
  );
  const terminal = byId["concurrent.conc-burst-5-all-terminal"];
  assert.equal(terminal.status, "fail");
  assert.equal(terminal.code, "E-CONC-004");
  assert.match(terminal.evidence, /stuck: TC-3, TC-4, TC-5/);
  const release = byId["concurrent.conc-burst-5-release-reconciled"];
  assert.equal(release.status, "blocked");
  assert.equal(release.code, "E-RUNNER-005");
  assert.match(release.evidence, /allTerminal/);

  const residueVerdicts = buildConcurrentVerdicts(SAME3, {
    ...GOOD_OBSERVED,
    finalTargetState: { busy: true, currentContract: "TC-3", queue: [] },
  });
  const residue = mapConcurrentVerdictsToChecks(SAME3, residueVerdicts, { caseElapsedMs: 20000 })
    .find((c) => c.id === "concurrent.conc-same-3-release-reconciled");
  assert.equal(residue.status, "fail");
  assert.equal(residue.code, "E-CONC-004");
});

test("concurrent: 前置全 ok 但 verdict 缺位 → 如实 fail(不冒充 blocked/pass)", () => {
  const verdicts = buildConcurrentVerdicts(SAME3, GOOD_OBSERVED);
  delete verdicts.busyUnique;
  const check = mapConcurrentVerdictsToChecks(SAME3, verdicts, { caseElapsedMs: 5000 })
    .find((c) => c.id === "concurrent.conc-same-3-busy-slot-unique");
  assert.equal(check.status, "fail");
  assert.equal(check.code, "E-CONC-002");
  assert.match(check.evidence, /not evaluated/);
});
