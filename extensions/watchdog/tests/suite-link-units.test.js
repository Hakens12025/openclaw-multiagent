// tests/suite-link-units.test.js — suite-link / suite-loop 纯逻辑单测
// 覆盖：case 归一化、期望评估、上游双布局探测（临时目录）、阶段→CheckResult 映射（stub deps）、
// 以及 suite-loop 的选环/预算回显/收敛/轮次纯判定。无网络、无 gateway。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DISPATCH_LINK_CASES,
  PIPELINE_LINK_CASES,
  buildDefaultLinkDeps,
  buildLinkStageDescriptors,
  evaluateLinkExpectation,
  normalizeLinkCase,
  probeUpstreamPackages,
  runLinkCase,
} from "../lib/formal-runtime/suite-link.js";
import {
  LOOP_STAGE_DESCRIPTORS,
  evaluateBudgetEcho,
  evaluateLoopConvergence,
  evaluateLoopRounds,
  selectLoopTarget,
} from "../lib/formal-runtime/suite-loop.js";
import { createCheckContext } from "../lib/formal-runtime/checks/check-runner.js";

// ── 公共 stub ────────────────────────────────────────────────────────────────

const fakeBudget = () => ({
  remainingMs: () => 999999,
  isExpired: () => false,
  noteProgress: () => {},
});

// 全 stub deps：默认走通满血 happy path；按需覆盖单点。
function stubDeps(overrides = {}) {
  return {
    now: () => 1000,
    sleep: async () => {},
    cleanState: async () => {},
    inject: async () => ({ ok: true }),
    createBudget: () => fakeBudget(),
    observeContract: async () => ({ contractId: "TC-test-1", via: "sse:inbox_dispatch" }),
    waitForTerminal: async () => ({ status: "completed", timedOut: false, lastStatus: "completed", agents: ["a1", "a2"], lastSseNote: "track_end:a2" }),
    terminalize: async () => ({ ok: true }),
    readContract: async () => ({ id: "TC-test-1", status: "completed", output: "/tmp/out.md" }),
    resolveOutputPath: () => "/tmp/out.md",
    readFileText: async () => "LRU LFU FIFO ".repeat(40),
    probeUpstream: async () => ({ found: true, locations: ["artifacts/<cid>/a1/ (2 files, manifest)"] }),
    ...overrides,
  };
}

// ── normalizeLinkCase ───────────────────────────────────────────────────────

test("normalizeLinkCase: valid case gets defaults and derived expectation flags", () => {
  const simple = normalizeLinkCase({ id: "c1", message: "hello" });
  assert.equal(simple.timeoutMs, 240000);
  assert.equal(simple.title, "c1");
  assert.deepEqual({ ...simple.expectation }, { minBytes: 0, keywords: [], multiHop: false, hasValidation: false, requiresOutput: false });

  const hop = normalizeLinkCase({ id: "c2", message: "go", expectation: { minBytes: 99.7, keywords: [" k1 ", "", 3], multiHop: true } });
  assert.equal(hop.timeoutMs, 600000);
  assert.equal(hop.expectation.minBytes, 99);
  assert.deepEqual([...hop.expectation.keywords], ["k1"]);
  assert.equal(hop.expectation.hasValidation, true);
  assert.equal(hop.expectation.requiresOutput, true);
  assert.ok(Object.isFrozen(hop) && Object.isFrozen(hop.expectation));
});

test("normalizeLinkCase: invalid inputs return null", () => {
  assert.equal(normalizeLinkCase(null), null);
  assert.equal(normalizeLinkCase({ id: "x" }), null);
  assert.equal(normalizeLinkCase({ message: "no id" }), null);
  assert.equal(normalizeLinkCase({ id: "has space", message: "m" }), null);
});

test("inline case sets are pre-normalized and well-formed", () => {
  assert.equal(DISPATCH_LINK_CASES.length, 2);
  assert.equal(PIPELINE_LINK_CASES.length, 2);
  for (const testCase of [...DISPATCH_LINK_CASES, ...PIPELINE_LINK_CASES]) {
    assert.ok(testCase && testCase.id && testCase.message);
  }
  assert.ok(PIPELINE_LINK_CASES.every((c) => c.expectation.multiHop === true));
});

// ── evaluateLinkExpectation ─────────────────────────────────────────────────

test("evaluateLinkExpectation: pass / size fail / keyword fail", () => {
  const expectation = { minBytes: 10, keywords: ["alpha"] };
  assert.equal(evaluateLinkExpectation({ content: "alpha beta gamma", expectation }).ok, true);

  const small = evaluateLinkExpectation({ content: "alpha", expectation: { minBytes: 100, keywords: [] } });
  assert.equal(small.ok, false);
  assert.match(small.evidence, /< minBytes 100/);

  const missing = evaluateLinkExpectation({ content: "x".repeat(20), expectation });
  assert.equal(missing.ok, false);
  assert.match(missing.evidence, /missing keywords: alpha/);
});

// ── probeUpstreamPackages（临时目录双布局）────────────────────────────────────

test("probeUpstreamPackages: detects producer-subdir, flat, and inbox layouts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-link-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 布局 A：artifacts/<cid>/<producer>/ + manifest
  const pkgDir = join(root, "artifacts-a", "producer-x");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "manifest.json"), "{}", "utf8");
  await writeFile(join(pkgDir, "report.md"), "hi", "utf8");
  const a = await probeUpstreamPackages({ artifactsContractDir: join(root, "artifacts-a") });
  assert.equal(a.found, true);
  assert.match(a.locations.join("|"), /producer-x\/ \(2 files, manifest\)/);

  // 布局 B：artifacts/<cid>/ 直接放文件（实测旧样本）
  const flatDir = join(root, "artifacts-b");
  await mkdir(flatDir, { recursive: true });
  await writeFile(join(flatDir, "loose.md"), "hi", "utf8");
  const b = await probeUpstreamPackages({ artifactsContractDir: flatDir });
  assert.equal(b.found, true);
  assert.match(b.locations.join("|"), /flat \(1 files\)/);

  // 布局 C：inbox/upstream/<producer>/
  const inboxDir = join(root, "ws-agent", "inbox");
  await mkdir(join(inboxDir, "upstream", "planner-1"), { recursive: true });
  await writeFile(join(inboxDir, "upstream", "planner-1", "brief.md"), "brief", "utf8");
  const c = await probeUpstreamPackages({
    artifactsContractDir: join(root, "nonexistent"),
    inboxRoots: [{ agentId: "agent-1", inboxDir }],
  });
  assert.equal(c.found, true);
  assert.match(c.locations.join("|"), /agent-1:inbox\/upstream\/planner-1\/ \(1 files\)/);

  // 双布局都没有 → found:false
  const none = await probeUpstreamPackages({
    artifactsContractDir: join(root, "nope"),
    inboxRoots: [{ agentId: "agent-1", inboxDir: join(root, "nope-inbox") }],
  });
  assert.deepEqual(none, { found: false, locations: [] });
});

// ── buildLinkStageDescriptors ───────────────────────────────────────────────

test("buildLinkStageDescriptors: stages trimmed by expectation", () => {
  const simple = buildLinkStageDescriptors(normalizeLinkCase({ id: "s", message: "m" }));
  assert.deepEqual(simple.map((s) => s.key), ["inject", "created", "terminal"]);

  const full = buildLinkStageDescriptors(normalizeLinkCase({ id: "f", message: "m", expectation: { minBytes: 10, multiHop: true } }));
  assert.deepEqual(full.map((s) => s.key), ["inject", "created", "terminal", "mirrored", "validated", "upstream"]);
  assert.deepEqual(full.map((s) => s.code), [
    "E-DISPATCH-001", "E-CONTRACT-001", "E-CONTRACT-002", "E-CONTRACT-004", "E-CONTRACT-007", "E-CONTRACT-006",
  ]);
  assert.ok(full.every((s) => /^[^.\s]+\.[^\s]+$/.test(s.id)));
});

// ── runLinkCase 阶段→CheckResult 映射（stub deps）────────────────────────────

const PIPELINE_CASE = { id: "hop", message: "do it", expectation: { minBytes: 10, keywords: ["LRU"], multiHop: true } };

test("runLinkCase happy path emits all stage checks as pass", async () => {
  const ctx = createCheckContext({ presetId: "pipeline" });
  const result = await runLinkCase(ctx, PIPELINE_CASE, { deps: stubDeps() });
  assert.equal(result.completedStages, 6);
  assert.equal(result.blockedStages, 0);
  assert.equal(result.contractId, "TC-test-1");
  assert.deepEqual(ctx.checks.map((c) => c.status), ["pass", "pass", "pass", "pass", "pass", "pass"]);
  assert.match(ctx.checks[2].evidence, /agents=\[a1,a2\]/);
  assert.match(ctx.checks[5].evidence, /manifest/);
  assert.equal(ctx.summarize().verdict, "PASS");
});

test("runLinkCase: inject failure fails E-DISPATCH-001 and blocks the rest", async () => {
  const ctx = createCheckContext({ presetId: "dispatch" });
  await runLinkCase(ctx, PIPELINE_CASE, { deps: stubDeps({ inject: async () => ({ ok: false, error: "refused" }) }) });
  assert.equal(ctx.checks[0].status, "fail");
  assert.equal(ctx.checks[0].code, "E-DISPATCH-001");
  const rest = ctx.checks.slice(1);
  assert.equal(rest.length, 5);
  assert.ok(rest.every((c) => c.status === "blocked" && c.code === "E-RUNNER-005"));
  assert.equal(ctx.summarize().verdict, "FAIL");
});

test("runLinkCase: no contract found fails E-CONTRACT-001", async () => {
  const ctx = createCheckContext({ presetId: "dispatch" });
  await runLinkCase(ctx, { id: "s", message: "m" }, { deps: stubDeps({ observeContract: async () => null }) });
  assert.deepEqual(ctx.checks.map((c) => [c.status, c.code || null]), [
    ["pass", null],
    ["fail", "E-CONTRACT-001"],
    ["blocked", "E-RUNNER-005"],
  ]);
});

test("runLinkCase: timeout terminalizes and fails E-CONTRACT-002 with SSE tail evidence", async () => {
  const ctx = createCheckContext({ presetId: "dispatch" });
  let terminalized = null;
  await runLinkCase(ctx, { id: "s", message: "m" }, {
    deps: stubDeps({
      waitForTerminal: async () => ({ status: null, timedOut: true, lastStatus: "running", agents: ["a1"], lastSseNote: "track_start:a1" }),
      terminalize: async (contractId) => { terminalized = contractId; },
    }),
  });
  const terminal = ctx.checks[2];
  assert.equal(terminal.status, "fail");
  assert.equal(terminal.code, "E-CONTRACT-002");
  assert.match(terminal.evidence, /lastStatus=running/);
  assert.match(terminal.evidence, /lastSse=track_start:a1/);
  assert.equal(terminalized, "TC-test-1");
});

test("runLinkCase: failed terminal overrides to E-CONTRACT-003", async () => {
  const ctx = createCheckContext({ presetId: "dispatch" });
  await runLinkCase(ctx, { id: "s", message: "m" }, {
    deps: stubDeps({ waitForTerminal: async () => ({ status: "failed", timedOut: false, lastStatus: "failed", agents: [], lastSseNote: null }) }),
  });
  assert.equal(ctx.checks[2].status, "fail");
  assert.equal(ctx.checks[2].code, "E-CONTRACT-003");
});

test("runLinkCase: missing output mirror fails E-CONTRACT-004; validation miss fails E-CONTRACT-007; upstream miss fails E-CONTRACT-006", async () => {
  const mirrorCtx = createCheckContext({ presetId: "pipeline" });
  await runLinkCase(mirrorCtx, PIPELINE_CASE, { deps: stubDeps({ resolveOutputPath: () => null }) });
  const mirror = mirrorCtx.checks.find((c) => c.id.endsWith("output-mirrored"));
  assert.equal(mirror.status, "fail");
  assert.equal(mirror.code, "E-CONTRACT-004");
  assert.match(mirror.evidence, /v133 mirror regression class/);

  const validateCtx = createCheckContext({ presetId: "pipeline" });
  await runLinkCase(validateCtx, PIPELINE_CASE, { deps: stubDeps({ readFileText: async () => "no keyword here at all" }) });
  const validated = validateCtx.checks.find((c) => c.id.endsWith("output-validated"));
  assert.equal(validated.status, "fail");
  assert.equal(validated.code, "E-CONTRACT-007");

  const upstreamCtx = createCheckContext({ presetId: "pipeline" });
  await runLinkCase(upstreamCtx, PIPELINE_CASE, { deps: stubDeps({ probeUpstream: async () => ({ found: false, locations: [] }) }) });
  const upstream = upstreamCtx.checks.find((c) => c.id.endsWith("upstream-package"));
  assert.equal(upstream.status, "fail");
  assert.equal(upstream.code, "E-CONTRACT-006");
});

test("buildDefaultLinkDeps exposes every stage observer (stub surface contract)", () => {
  const deps = buildDefaultLinkDeps(null);
  for (const key of ["now", "sleep", "cleanState", "inject", "createBudget", "observeContract", "waitForTerminal", "terminalize", "readContract", "resolveOutputPath", "readFileText", "probeUpstream"]) {
    assert.equal(typeof deps[key], "function", `deps.${key} must be a function`);
  }
});

// ── suite-loop 纯判定 ────────────────────────────────────────────────────────

test("selectLoopTarget prefers registered active loop, falls back to cycle, else null", () => {
  const fromLoop = selectLoopTarget({
    loops: [{ id: "L1", active: true, nodes: ["r1", "w1"], entryAgentId: "r1" }],
    cycles: [["x", "y"]],
    graphNodeIds: ["r1", "w1", "x", "y"],
  });
  assert.equal(fromLoop.source, "registered_loop:L1");
  assert.deepEqual(fromLoop.agents, ["r1", "w1"]);
  assert.equal(fromLoop.entryAgentId, "r1");

  const fromCycle = selectLoopTarget({
    loops: [{ id: "L2", active: false, nodes: ["a", "b"] }],
    cycles: [["ghost", "y"], ["a", "b"]],
    graphNodeIds: ["a", "b", "y"],
  });
  assert.equal(fromCycle.source, "graph_cycle");
  assert.deepEqual(fromCycle.agents, ["a", "b"]);

  assert.equal(selectLoopTarget({ loops: [], cycles: [], graphNodeIds: [] }), null);
});

test("evaluateBudgetEcho / evaluateLoopConvergence / evaluateLoopRounds verdicts", () => {
  assert.equal(evaluateBudgetEcho({ resolvedBudget: { maxRounds: 1 }, budgetSource: { maxRounds: "declared" } }, 1).ok, true);
  assert.equal(evaluateBudgetEcho({ resolvedBudget: { maxRounds: 3 }, budgetSource: { maxRounds: "default" } }, 1).ok, false);
  assert.match(evaluateBudgetEcho(null, 1).evidence, /missing/);

  assert.equal(evaluateLoopConvergence(null).converged, false);
  const governed = evaluateLoopConvergence({ status: "concluded", concludeReason: "loop_budget_exhausted:max_rounds", round: 1 });
  assert.equal(governed.converged, true);
  assert.match(governed.evidence, /loop_budget_exhausted:max_rounds/);
  assert.equal(evaluateLoopConvergence({ status: "failed", concludeReason: "loop_start_dispatch_failed" }).converged, false);

  assert.equal(evaluateLoopRounds({ round: 1, budget: { usedRounds: 1 } }, 1).ok, true);
  assert.equal(evaluateLoopRounds({ round: 2, budget: { usedRounds: 2 } }, 1).ok, false);
  assert.equal(evaluateLoopRounds(null, 1).ok, false);
});

test("LOOP_STAGE_DESCRIPTORS ids/codes are well-formed for skip and blocked marking", () => {
  assert.equal(LOOP_STAGE_DESCRIPTORS.length, 7);
  assert.ok(LOOP_STAGE_DESCRIPTORS.every((s) => /^loop\.[^\s]+$/.test(s.id) && /^E-LOOP-\d{3}$/.test(s.code)));
});
