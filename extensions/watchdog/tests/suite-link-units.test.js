// tests/suite-link-units.test.js — suite-link 纯逻辑单测
// 覆盖：case 归一化、期望评估、上游到达探测（临时目录 fixture）、阶段→CheckResult 映射（stub deps）。
// 无网络、无 gateway。

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
    readSealedPrimary: () => null,
    readFileText: async () => "LRU LFU FIFO ".repeat(40),
    probeUpstream: async () => ({ found: true, locations: ["trace:a2:inbox/upstream/a1/ (2 files, pointer lists it)"], mismatches: [] }),
    ensureCaseEdge: async () => null, // multiHop 边搭建走注入面,单测不打真 HTTP
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

// ── probeUpstreamPackages（contract 作用域的下游到达证据）──────────────────────
// 树内快照形状（snapshotInboxToRunTree 写，run 家经 contract-index 解析后以 participantsDir 传入）：
//   participants/<agentId>/inbox-<cid>/contract.json      → { id, upstreamPackages:[{path,producer,files,primary}] }
//   participants/<agentId>/inbox-<cid>/upstream/planner/… → manifest.json + brief.md
// fixture 按这个形状搭。

// 造一个 inbox：contract.json（可选 upstreamPackages 指针）+ upstream/<producer>/ 若干文件。
async function makeInbox(inboxDir, { contractId = null, packages = null, producers = {} } = {}) {
  await mkdir(inboxDir, { recursive: true });
  if (contractId) {
    const contract = { id: contractId, task: "t", status: "running" };
    if (packages) contract.upstreamPackages = packages;
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(contract, null, 2), "utf8");
  }
  for (const [producer, files] of Object.entries(producers)) {
    await mkdir(join(inboxDir, "upstream", producer), { recursive: true });
    for (const name of files) await writeFile(join(inboxDir, "upstream", producer, name), "x", "utf8");
  }
  return inboxDir;
}

test("probeUpstreamPackages: run-tree snapshot for the cid is the primary evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-link-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const participantsDir = join(root, "participants");
  await makeInbox(join(participantsDir, "planner", "inbox-TC-1"), { contractId: "TC-1" }); // 上游自己没收包
  await makeInbox(join(participantsDir, "worker", "inbox-TC-1"), {
    contractId: "TC-1",
    packages: [{ path: "upstream/planner/", producer: "planner", files: ["brief.md", "manifest.json"], primary: "brief.md" }],
    producers: { planner: ["manifest.json", "brief.md"] },
  });

  const probe = await probeUpstreamPackages({ contractId: "TC-1", participantsDir });
  assert.equal(probe.found, true);
  assert.equal(probe.locations.length, 1);
  assert.match(probe.locations[0], /tree:worker:inbox-TC-1\/upstream\/planner\/ \(2 files, pointer lists it\)/);
  assert.deepEqual(probe.mismatches, []);
});

test("probeUpstreamPackages: producer-side outbox alone never satisfies the probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-link-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 产者侧整包齐全（participants/planner/outbox-TC-1/ 是产物正本落点），但没有任何
  // 下游 inbox 收到它 → 必须 found:false。产者侧目录无论下游是否收到都存在，证明不了
  // 投递；旧探测读产者侧（当时是 control-plane/artifacts/<cid>/，该副本店已整店退役）
  // 正是这样误判通过的。participantsDir 刻意指向真有 planner 目录的根：探测扫参与者时
  // 只能认 inbox-<cid>/，不得把同级的 outbox-<cid>/ 算成到达证据。
  const participantsDir = join(root, "participants");
  const producerOutbox = join(participantsDir, "planner", "outbox-TC-1");
  await mkdir(producerOutbox, { recursive: true });
  await writeFile(join(producerOutbox, "brief.md"), "brief", "utf8");
  await writeFile(join(producerOutbox, "seal.json"), JSON.stringify({ contractId: "TC-1" }), "utf8");

  const probe = await probeUpstreamPackages({
    contractId: "TC-1",
    participantsDir, // 有产者 outbox，无任何 inbox-TC-1 快照
    inboxRoots: [{ agentId: "worker", inboxDir: join(root, "ws", "worker", "inbox") }],
  });
  assert.equal(probe.found, false);
  assert.deepEqual(probe.locations, []);
});

test("probeUpstreamPackages: live inbox counts only when its contract.json id matches the cid", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-link-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 上一个 contract 的残留包：目录满，但 contract.json 指向 TC-OLD。
  const staleInbox = await makeInbox(join(root, "ws", "worker", "inbox"), {
    contractId: "TC-OLD",
    packages: [{ path: "upstream/planner/", producer: "planner", files: ["brief.md", "manifest.json"], primary: "brief.md" }],
    producers: { planner: ["brief.md"] },
  });
  const inboxRoots = [{ agentId: "worker", inboxDir: staleInbox }];
  const participantsDir = join(root, "participants");

  const stale = await probeUpstreamPackages({ contractId: "TC-NEW", participantsDir, inboxRoots });
  assert.equal(stale.found, false, "另一个 contract 的残留包不得让本 contract 的检查通过");

  // 同一份目录换成本 contract 的 contract.json → 认（快照尚未落盘的时间窗）。
  // 这一处刻意留字符串形态,覆盖 COMPAT 分支(改动落地前写下的在飞合约)。
  await makeInbox(staleInbox, { contractId: "TC-NEW", packages: ["upstream/planner/"] });
  const current = await probeUpstreamPackages({ contractId: "TC-NEW", participantsDir, inboxRoots });
  assert.equal(current.found, true);
  assert.match(current.locations[0], /live:worker:inbox\/upstream\/planner\/ \(1 files, pointer lists it\)/);

  // 没有 cid 就无从定界 → 一律不看 live inbox。
  const unscoped = await probeUpstreamPackages({ contractId: null, participantsDir, inboxRoots });
  assert.equal(unscoped.found, false);
});

test("probeUpstreamPackages: a package the upstreamPackages pointer omits is reported as a mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-link-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const participantsDir = join(root, "participants");
  await makeInbox(join(participantsDir, "worker", "inbox-TC-1"), {
    contractId: "TC-1",
    packages: [{ path: "upstream/planner/", producer: "planner", files: ["brief.md", "manifest.json"], primary: "brief.md" }],
    producers: { planner: ["brief.md"], ghost: ["stray.md"] },
  });

  const probe = await probeUpstreamPackages({ contractId: "TC-1", participantsDir });
  assert.equal(probe.found, true);
  assert.equal(probe.locations.length, 1);
  assert.match(probe.locations[0], /planner\//);
  assert.equal(probe.mismatches.length, 1);
  assert.match(probe.mismatches[0], /ghost\/ \(1 files\) is absent from the upstreamPackages pointer/);
});

test("probeUpstreamPackages: without a pointer the directory alone is accepted; empty dirs are not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-link-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const participantsDir = join(root, "participants");
  await makeInbox(join(participantsDir, "worker", "inbox-TC-1"), { contractId: "TC-1", producers: { planner: ["brief.md"] } });
  const noPointer = await probeUpstreamPackages({ contractId: "TC-1", participantsDir });
  assert.equal(noPointer.found, true);
  assert.match(noPointer.locations[0], /pointer absent/);

  // 空的 upstream/<producer>/（copyUpstreamArtifactsToInbox 一个文件都没搬进来）不算送达。
  // 同一 participants 根：inbox 快照目录名嵌 cid，TC-2 的扫描不会误读 TC-1 的包。
  await makeInbox(join(participantsDir, "worker", "inbox-TC-2"), { contractId: "TC-2", producers: { planner: [] } });
  const empty = await probeUpstreamPackages({ contractId: "TC-2", participantsDir });
  assert.equal(empty.found, false);
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
  assert.match(ctx.checks[5].evidence, /trace:a2:inbox\/upstream\/a1\//);
  assert.equal(ctx.summarize().verdict, "PASS");
});

test("runLinkCase: inject failure fails E-DISPATCH-001 and blocks the rest", async () => {
  const ctx = createCheckContext({ presetId: "single" });
  await runLinkCase(ctx, PIPELINE_CASE, { deps: stubDeps({ inject: async () => ({ ok: false, error: "refused" }) }) });
  assert.equal(ctx.checks[0].status, "fail");
  assert.equal(ctx.checks[0].code, "E-DISPATCH-001");
  const rest = ctx.checks.slice(1);
  assert.equal(rest.length, 5);
  assert.ok(rest.every((c) => c.status === "blocked" && c.code === "E-RUNNER-005"));
  assert.equal(ctx.summarize().verdict, "FAIL");
});

test("runLinkCase: no contract found fails E-CONTRACT-001", async () => {
  const ctx = createCheckContext({ presetId: "single" });
  await runLinkCase(ctx, { id: "s", message: "m" }, { deps: stubDeps({ observeContract: async () => null }) });
  assert.deepEqual(ctx.checks.map((c) => [c.status, c.code || null]), [
    ["pass", null],
    ["fail", "E-CONTRACT-001"],
    ["blocked", "E-RUNNER-005"],
  ]);
});

test("runLinkCase: timeout terminalizes and fails E-CONTRACT-002 with SSE tail evidence", async () => {
  const ctx = createCheckContext({ presetId: "single" });
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
  const ctx = createCheckContext({ presetId: "single" });
  await runLinkCase(ctx, { id: "s", message: "m" }, {
    deps: stubDeps({ waitForTerminal: async () => ({ status: "failed", timedOut: false, lastStatus: "failed", agents: [], lastSseNote: null }) }),
  });
  assert.equal(ctx.checks[2].status, "fail");
  assert.equal(ctx.checks[2].code, "E-CONTRACT-003");
});

test("runLinkCase: missing output mirror fails E-CONTRACT-004; validation miss fails E-CONTRACT-007; upstream miss fails E-CONTRACT-006", async () => {
  const mirrorCtx = createCheckContext({ presetId: "pipeline" });
  // 判据三序全空:树封包缺席 + contract.output 未设 + 快照产物投影为空 → E-CONTRACT-004
  await runLinkCase(mirrorCtx, PIPELINE_CASE, { deps: stubDeps({
    readContract: async () => ({ id: "TC-test-1", status: "completed" }),
    resolveOutputPath: () => null,
  }) });
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
  for (const key of ["now", "sleep", "cleanState", "inject", "createBudget", "observeContract", "waitForTerminal", "terminalize", "readContract", "resolveOutputPath", "readSealedPrimary", "readFileText", "probeUpstream"]) {
    assert.equal(typeof deps[key], "function", `deps.${key} must be a function`);
  }
});
