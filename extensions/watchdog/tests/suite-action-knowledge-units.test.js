// suite-action-knowledge-units.test.js — system-action / operator / knowledge 套件纯逻辑单测
//
// 覆盖：checkpoint→CheckResult 映射（含 fail/blocked 语义）、[ACTION] 提示词、SSE 事件查询、
// skip 门控产物、召回地板判读、operator 手写 plan 合规性与响应判读。全部零 IO、零网关。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  SYSTEM_ACTION_CASES,
  buildAssignTaskProbePrompt,
  buildChainStageDescriptors,
  buildCreateTaskProbePrompt,
  buildReviewProbePrompt,
  findAlert,
  listChainStages,
  mapProbeSignalsToChecks,
} from "../lib/formal-runtime/checks/system-action-chain.js";
import {
  buildOperatorApplyProbePlan,
  buildOperatorDestructiveProbePlan,
  buildOperatorDryRunProbePlan,
  classifyOperatorPlanResponse,
  evaluateVerifyGateMetadata,
} from "../lib/formal-runtime/checks/operator-probe.js";
import {
  KNOWLEDGE_CHECK_DESCRIPTORS,
  KNOWLEDGE_RECALL_FLOORS,
  buildKnowledgeSkipChecks,
  evaluateRecallFloors,
  pickKnownGoodCase,
} from "../lib/formal-runtime/suite-knowledge.js";
import { createCheckContext } from "../lib/formal-runtime/checks/check-runner.js";
import { normalizeOperatorPlan } from "../lib/operator/operator-plan.js";

// ── system-action：提示词 ─────────────────────────────────────────────────────

test("system-action: [ACTION] 提示词包含可解析 marker 且参数正确", () => {
  for (const [prompt, expectedType] of [
    [buildCreateTaskProbePrompt(), "create_task"],
    [buildAssignTaskProbePrompt({ delegateAgentId: "worker-x" }), "assign_task"],
    [buildReviewProbePrompt({ artifactPath: "/tmp/REQ-probe.js" }), "request_review"],
  ]) {
    const line = prompt.split("\n").find((l) => l.startsWith("[ACTION] "));
    assert.ok(line, `${expectedType} prompt 必须含 [ACTION] 行`);
    const parsed = JSON.parse(line.slice("[ACTION] ".length));
    assert.equal(parsed.type, expectedType);
  }
  const assign = JSON.parse(buildAssignTaskProbePrompt({ delegateAgentId: "worker-x" })
    .split("\n").find((l) => l.startsWith("[ACTION] ")).slice(9));
  assert.equal(assign.params.targetAgent, "worker-x");
  const review = JSON.parse(buildReviewProbePrompt({ artifactPath: "/tmp/REQ-probe.js" })
    .split("\n").find((l) => l.startsWith("[ACTION] ")).slice(9));
  assert.equal(review.params.artifactManifest[0].path, "/tmp/REQ-probe.js");
});

// ── system-action：事件查询 ───────────────────────────────────────────────────

test("system-action: findAlert 按 type/source/targetAgent/afterMs 过滤", () => {
  const events = [
    { type: "alert", receivedAt: 10, data: { type: "agent_task_assigned", source: "a", targetAgent: "b" } },
    { type: "alert", receivedAt: 20, data: { type: "agent_task_assigned", source: "x", targetAgent: "y" } },
    { type: "track_start", receivedAt: 30, data: { type: "agent_task_assigned" } },
  ];
  assert.equal(findAlert(events, { type: "agent_task_assigned", source: "x" }).receivedAt, 20);
  assert.equal(findAlert(events, { type: "agent_task_assigned", afterMs: 15 }).receivedAt, 20);
  assert.equal(findAlert(events, { type: "agent_task_assigned", targetAgent: "z" }), null);
  assert.equal(findAlert(events, { type: "nope" }), null);
});

// ── system-action：信号 → CheckResult 映射 ────────────────────────────────────

const ALL_SEEN = {
  firstStart: { elapsedMs: 1000, evidence: "sessionKey=agent:hook:1" },
  intermediate: { elapsedMs: 1500, evidence: "worker-x <- TC-1" },
  firstEnd: { elapsedMs: 2000, evidence: "status=completed" },
  bridgeAlert: { elapsedMs: 3000, evidence: "TC-1 <- delegated TC-2 status=completed" },
  resume: { elapsedMs: 3500, evidence: "sessionKey=agent:hook:1" },
  resumeEnd: { elapsedMs: 4000, evidence: "status=completed" },
  bridgeContractTerminal: { elapsedMs: 4200, evidence: "TC-2 completed" },
};

test("system-action: 全链路观测到 → 全 pass 且 pass 不带 code", () => {
  const assignCase = SYSTEM_ACTION_CASES.find((c) => c.action === "assign_task");
  const checks = mapProbeSignalsToChecks(assignCase, ALL_SEEN, { caseElapsedMs: 5000 });
  assert.equal(checks.length, listChainStages("assign_task").length);
  for (const check of checks) {
    assert.equal(check.status, "pass", `${check.id} 应 pass`);
    assert.equal(check.code, undefined, "pass 不得带 code");
    assert.ok(/^system-action\.assign-task-/.test(check.id), `id 形如 system-action.assign-task-*: ${check.id}`);
  }
});

test("system-action: bridge 缺失 → fail 家族码；其下游合约落地 → blocked E-RUNNER-005", () => {
  const createCase = SYSTEM_ACTION_CASES.find((c) => c.action === "create_task");
  const signals = { ...ALL_SEEN };
  delete signals.intermediate; // create_task 无中间步
  delete signals.bridgeAlert;
  delete signals.bridgeContractTerminal;
  const checks = mapProbeSignalsToChecks(createCase, signals, { caseElapsedMs: 240000 });
  const byName = Object.fromEntries(checks.map((c) => [c.id, c]));
  const bridge = byName["system-action.create-task-bridge-delivery"];
  assert.equal(bridge.status, "fail");
  assert.equal(bridge.code, "E-SYSACTION-002");
  assert.equal(bridge.durationMs, 240000);
  const terminal = byName["system-action.create-task-bridge-contract-terminal"];
  assert.equal(terminal.status, "blocked", "前置 bridgeAlert 未见 → blocked 而非二次 fail");
  assert.equal(terminal.code, "E-RUNNER-005");
  assert.match(terminal.evidence, /bridgeAlert/);
  // resume 链独立于 bridge，已观测到 → 仍 pass
  assert.equal(byName["system-action.create-task-same-session-resume"].status, "pass");
});

test("system-action: 中间动作缺失 → E-SYSACTION-001；resume 收尾缺失 → E-SYSACTION-005", () => {
  const reviewCase = SYSTEM_ACTION_CASES.find((c) => c.action === "request_review");
  const signals = { ...ALL_SEEN };
  delete signals.intermediate;
  delete signals.resumeEnd;
  const checks = mapProbeSignalsToChecks(reviewCase, signals, { caseElapsedMs: 300000, topology: { callerAgentId: "worker-a" } });
  const byName = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byName["system-action.request-review-review-requested"].code, "E-SYSACTION-001");
  const resumeEnd = byName["system-action.request-review-resume-end"];
  assert.equal(resumeEnd.status, "fail", "前置 resume 已见 → 如实 fail");
  assert.equal(resumeEnd.code, "E-SYSACTION-005");
});

test("system-action: 映射产物全部通过 check-runner add 时校验（含 blocked 路径）", () => {
  const ctx = createCheckContext({ presetId: "system-action" });
  for (const probeCase of SYSTEM_ACTION_CASES) {
    for (const check of mapProbeSignalsToChecks(probeCase, {}, { caseElapsedMs: 1, topology: { callerAgentId: "w" } })) {
      ctx.addCheck(check); // 任何不合规（缺码/坏 id）会 throw
    }
  }
  const totals = ctx.summarize();
  assert.equal(totals.total, ctx.checks.length);
  assert.equal(totals.pass, 0, "零信号下不存在 pass");
  // 描述符与映射 id 一致（markBlocked 用同一组 id）
  for (const probeCase of SYSTEM_ACTION_CASES) {
    const descriptorIds = buildChainStageDescriptors(probeCase).map((d) => d.id);
    const mappedIds = mapProbeSignalsToChecks(probeCase, {}).map((c) => c.id);
    assert.deepEqual(descriptorIds, mappedIds);
  }
});

// ── operator：手写 plan 合规 + 响应判读 ───────────────────────────────────────

test("operator: 探针 plan 通过真 normalizeOperatorPlan 校验（surface/payload 合规）", () => {
  const apply = normalizeOperatorPlan(buildOperatorApplyProbePlan({ edgeFrom: "a1", edgeTo: "b1", scheduleId: "formal-x" }));
  assert.deepEqual(apply.steps.map((s) => s.surfaceId), ["graph.edge.add", "schedules.create"]);
  assert.equal(apply.steps[0].payload.from, "a1");
  assert.equal(apply.steps[1].payload.enabled, false, "探针 schedule 必须 disabled");
  const dry = normalizeOperatorPlan(buildOperatorDryRunProbePlan({ edgeFrom: "a1", edgeTo: "b1" }));
  assert.equal(dry.steps.length, 1);
  const destructive = normalizeOperatorPlan(buildOperatorDestructiveProbePlan());
  assert.equal(destructive.steps[0].surfaceId, "schedules.delete");
  assert.equal(destructive.steps[0].payload.scheduleId, "formal-nonexistent-probe");
});

test("operator: 强制 verify 门元数据判读", () => {
  assert.equal(evaluateVerifyGateMetadata([]).ok, false, "空 verifications = 门没触发");
  assert.equal(evaluateVerifyGateMetadata(undefined).ok, false);
  const inRun = evaluateVerifyGateMetadata([
    { surfaceId: "schedules.create", required: true, status: "failed_to_start", presetId: "dispatch" },
  ]);
  assert.equal(inRun.ok, true, "failed_to_start 在 active test run 内属预期，门已触发");
  assert.match(inRun.evidence, /failed_to_start is expected/);
  assert.equal(evaluateVerifyGateMetadata([
    { surfaceId: "x", required: true, status: "started", presetId: null },
  ]).ok, false, "presetId 缺失 = 元数据残缺");
  assert.equal(evaluateVerifyGateMetadata([
    { surfaceId: "x", required: true, status: "started", presetId: "health" },
  ]).ok, true);
});

test("operator: plan 响应分类（plan / provider_down / invalid）", () => {
  assert.equal(classifyOperatorPlanResponse({
    ok: true, intent: "graph_mutation", canExecute: true,
    plan: { steps: [{ surfaceId: "graph.edge.add" }], derived: {} },
  }).outcome, "plan");
  assert.equal(classifyOperatorPlanResponse({
    ok: true, intent: "advice_only",
    plan: { steps: [], derived: { reason: "operator_brain_unavailable" }, warnings: ["operator-brain 当前不可用：fetch failed"] },
  }).outcome, "provider_down");
  assert.equal(classifyOperatorPlanResponse({
    ok: true, intent: "advice_only", reply: "计划被拒",
    plan: { steps: [], derived: { reason: "operator_plan_validation_failed" } },
  }).outcome, "invalid");
});

// ── knowledge：skip 门控 + 地板判读 + fixture grounding ───────────────────────

test("knowledge: ollama 不可达 → 全部 check skip 且带 E-KNOWLEDGE-SKIP（经 add 校验）", () => {
  const skips = buildKnowledgeSkipChecks("connect ECONNREFUSED 127.0.0.1:11434");
  assert.equal(skips.length, KNOWLEDGE_CHECK_DESCRIPTORS.length);
  const ctx = createCheckContext({ presetId: "knowledge" });
  for (const check of skips) {
    assert.equal(check.status, "skip");
    assert.equal(check.code, "E-KNOWLEDGE-SKIP");
    assert.match(check.evidence, /ECONNREFUSED/);
    ctx.addCheck(check);
  }
  const totals = ctx.summarize();
  assert.equal(totals.skip, skips.length);
  assert.equal(totals.verdict, "PASS", "skip 永不翻 FAIL（前置条件缺失 ≠ 失败）");
});

test("knowledge: 召回地板判读（floors 与 gate 测试同源数值）", () => {
  assert.deepEqual(KNOWLEDGE_RECALL_FLOORS, { recallAt10: 0.85, recallAt5: 0.65, mrr: 0.5 });
  const good = evaluateRecallFloors({ total: 24, recallAt: { 5: 0.79, 10: 0.958 }, mrr: 0.6 });
  assert.equal(good.ok, true);
  assert.match(good.evidence, /recall@10=95\.8% \(floor 85%\)/);
  assert.match(good.evidence, /tests\/wiki-rag-recall\.test\.js/);
  const bad = evaluateRecallFloors({ total: 24, recallAt: { 5: 0.5, 10: 0.9 }, mrr: 0.4 });
  assert.equal(bad.ok, false);
  assert.equal(bad.breaches.length, 2);
  assert.match(bad.breaches[0], /recall@5/);
  assert.match(bad.breaches[1], /MRR/);
  assert.equal(evaluateRecallFloors({}).ok, false, "空结果 = 全地板击穿");
});

test("knowledge: 真 fixture 含已知良用例（24 例 + topK10 + harness 页）", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/wiki-rag-eval-set.json", import.meta.url), "utf8"));
  assert.equal(fixture.cases.length, 24);
  assert.equal(fixture.topK, 10);
  const knownGood = pickKnownGoodCase(fixture);
  assert.ok(knownGood, "fixture 里必须有 expectedSourcePath=concepts/harness.md 的用例");
  assert.match(knownGood.query, /harness/);
  assert.equal(pickKnownGoodCase(fixture, "concepts/does-not-exist.md"), null);
});
