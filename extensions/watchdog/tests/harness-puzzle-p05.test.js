/**
 * harness-puzzle-p05.test.js — P0.5 harness 拼图性+反逼性补位
 *
 * 设计来源：备忘录78（拼图模型/硬管软管/run-shape）+ 备忘录113（meta-harness 倒逼）。
 *
 * 4 件交付：
 *   1. Run-Shape Map 正式对象：buildRunShapeMap / validateRunShapeMap（合规 + 拒重叠）
 *      + 挂到 HarnessRun（normalize 消费点）+ dashboard 投影消费点
 *   2. coverage 完整性校验：validateCoverageCompleteness（声明硬管段但 map 未标 → 警告）
 *      + 接到 init 写 diagnostics.warnings（写了必被读）
 *   3. 软管反逼：buildSoftGuidanceSuggestions 对 soft 段产建议（enforced:false，不卡关）
 *   4. Meta-harness 校验：validateMetaHarnessModuleSpec 强制问全套；不合规非静默拒绝
 *
 * 红线自查：纯 harness 域，不碰 graph/loop/delivery/commit。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RUN_SHAPE_LAYER,
  VALID_RUN_SHAPE_LAYERS,
  buildRunShapeMap,
  validateRunShapeMap,
  validateCoverageCompleteness,
} from "../lib/harness/run-shape-map.js";
import { buildSoftGuidanceSuggestions } from "../lib/harness/soft-guidance.js";
import {
  validateMetaHarnessModuleSpec,
  validateHarnessModuleDefinition,
} from "../lib/harness/harness-module-schema.js";
import {
  buildHarnessSpec,
  startHarnessRun,
  normalizeHarnessRun,
} from "../lib/harness/harness-run.js";
import { initializeHarnessRunModules } from "../lib/harness/harness-module-runner.js";
import { projectAutomationHarnessSummary } from "../lib/automation/automation-harness-projection.js";

// ── 1. Run-Shape Map 正式对象 ──────────────────────────────────────────────────

test("buildRunShapeMap：三层 + segments 并集 + counts；互斥（soft/freeform 去重 hard）", () => {
  const map = buildRunShapeMap({
    hardShaped: ["a", "b", "a"],
    softGuided: ["c", "a"],     // a 与 hard 重叠 → 去掉
    freeform: ["d", "c"],        // c 与 soft 重叠 → 去掉
  });
  assert.deepEqual(map.hardShaped, ["a", "b"]);
  assert.deepEqual(map.softGuided, ["c"]);
  assert.deepEqual(map.freeform, ["d"]);
  assert.deepEqual(map.segments, ["a", "b", "c", "d"]);
  assert.deepEqual(map.counts, { hardShaped: 2, softGuided: 1, freeform: 1, total: 4 });
});

test("validateRunShapeMap：合规通过 / 非数组层拒 / 跨层重叠拒（防假安全感）", () => {
  assert.equal(validateRunShapeMap({ hardShaped: ["a"], softGuided: ["b"], freeform: [] }).ok, true);
  // 非对象
  assert.equal(validateRunShapeMap(null).ok, false);
  // 层非数组
  assert.equal(validateRunShapeMap({ hardShaped: "a", softGuided: [], freeform: [] }).ok, false);
  // 跨层重叠（同段既 hard 又 soft → 塑形等级矛盾）
  const dup = validateRunShapeMap({ hardShaped: ["x"], softGuided: ["x"], freeform: [] });
  assert.equal(dup.ok, false);
  assert.ok(dup.problems.some((p) => p.includes("disjoint")), "应报跨层重叠");
  // 含非字符串
  assert.equal(validateRunShapeMap({ hardShaped: [1], softGuided: [], freeform: [] }).ok, false);
  // 三层名称常量齐全
  assert.deepEqual(VALID_RUN_SHAPE_LAYERS, ["hardShaped", "softGuided", "freeform"]);
  assert.equal(RUN_SHAPE_LAYER.HARD, "hardShaped");
});

test("消费点①：normalizeHarnessRun 把 runShapeMap 挂到 run（coverage 正式对象化）", () => {
  const spec = buildHarnessSpec({ id: "auto-rsm", harness: { enabled: true, coverage: {
    hardShaped: ["timeout_budget"], softGuided: ["change_summary"], freeform: ["research_reasoning"],
  } } }, { round: 1 });
  const run = startHarnessRun(spec, { startedAt: 1 });
  assert.ok(run.runShapeMap, "run 应带 runShapeMap");
  assert.equal(validateRunShapeMap(run.runShapeMap).ok, true);
  assert.deepEqual(run.runShapeMap.hardShaped, ["timeout_budget"]);
  // round-trip 经 normalizeHarnessRun 仍在
  const renorm = normalizeHarnessRun(run);
  assert.ok(renorm.runShapeMap, "normalize round-trip 应保留 runShapeMap");
});

test("消费点②：dashboard 投影带 harnessRunShapeMap", () => {
  const summary = projectAutomationHarnessSummary({
    harness: { enabled: true, coverage: { hardShaped: ["artifact_capture"], softGuided: ["handoff_note"], freeform: [] } },
    runtime: {},
  });
  assert.ok(summary.harnessRunShapeMap, "投影应带 harnessRunShapeMap");
  assert.deepEqual(summary.harnessRunShapeMap.hardShaped, ["artifact_capture"]);
  assert.deepEqual(summary.harnessRunShapeMap.softGuided, ["handoff_note"]);
});

// ── 2. coverage 完整性校验 ─────────────────────────────────────────────────────

test("validateCoverageCompleteness：模块声明硬管段但 map 未标 → 警告（消除假安全感）", () => {
  // collector.artifact 声明 hardShaped: artifact_capture/diff_capture
  const gap = validateCoverageCompleteness({ hardShaped: [] }, ["harness:collector.artifact"]);
  assert.equal(gap.complete, false);
  assert.deepEqual(gap.missingHardSegments.sort(), ["artifact_capture", "diff_capture"]);
  assert.equal(gap.warnings.length, 1, "应产 1 条警告");
  assert.match(gap.warnings[0], /假安全感/);
});

test("validateCoverageCompleteness：map 已显式声明全部硬管段 → complete", () => {
  const ok = validateCoverageCompleteness(
    { hardShaped: ["artifact_capture", "diff_capture"] },
    ["harness:collector.artifact"],
  );
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.missingHardSegments, []);
  assert.deepEqual(ok.warnings, []);
});

test("validateCoverageCompleteness：无模块/未知模块 → complete（不误报）", () => {
  assert.equal(validateCoverageCompleteness({ hardShaped: [] }, []).complete, true);
  assert.equal(validateCoverageCompleteness({ hardShaped: [] }, ["harness:does.not.exist"]).complete, true);
});

test("接入点：initializeHarnessRunModules 把完整性缺口写进 diagnostics.warnings（非硬失败）", async () => {
  const spec = buildHarnessSpec({ id: "auto-gap", harness: { enabled: true,
    moduleRefs: ["harness:collector.artifact"],
    coverage: { hardShaped: [], softGuided: [], freeform: [] }, // 故意不声明硬管段
  } }, { round: 1 });
  const run = startHarnessRun(spec, { startedAt: 1 });
  const initialized = await initializeHarnessRunModules(run, { automationSpec: { id: "auto-gap" } });
  assert.ok(initialized, "init 不应因缺口失败（非硬失败）");
  const warnings = initialized.diagnostics?.warnings || [];
  assert.ok(warnings.some((w) => /假安全感/.test(w)), "缺口应记进 diagnostics.warnings");
});

// ── 3. 软管反逼 ────────────────────────────────────────────────────────────────

test("buildSoftGuidanceSuggestions：已知 soft 段给模板，未知段走兜底，enforced:false", () => {
  const suggestions = buildSoftGuidanceSuggestions({
    softGuided: ["change_summary", "experiment_memo", "some_unknown_summary_xyz"],
  });
  assert.equal(suggestions.length, 3);
  const known = suggestions.find((s) => s.segment === "change_summary");
  assert.deepEqual(known.recommendedFields, ["what_changed", "why", "files_touched", "risk"]);
  assert.equal(known.kind, "soft_structure_suggestion");
  assert.equal(known.enforced, false, "软管：要结构但不强制（不是 gate 卡关）");
  // 未知段兜底（含 summary → outcome/rationale/evidence_refs）
  const fallback = suggestions.find((s) => s.segment === "some_unknown_summary_xyz");
  assert.ok(fallback.recommendedFields.length > 0, "未知段也应有兜底结构提示");
  assert.equal(fallback.enforced, false);
});

test("buildSoftGuidanceSuggestions：无 soft 段 → 空数组", () => {
  assert.deepEqual(buildSoftGuidanceSuggestions({ softGuided: [] }), []);
  assert.deepEqual(buildSoftGuidanceSuggestions({}), []);
  assert.deepEqual(buildSoftGuidanceSuggestions(null), []);
});

test("消费点：normalizeHarnessRun 把 softGuidance 挂到 run（写了必被读）", () => {
  const spec = buildHarnessSpec({ id: "auto-soft", harness: { enabled: true, coverage: {
    hardShaped: [], softGuided: ["score_explanation"], freeform: [],
  } } }, { round: 1 });
  const run = startHarnessRun(spec, { startedAt: 1 });
  assert.ok(Array.isArray(run.softGuidance), "run 应带 softGuidance 数组");
  assert.equal(run.softGuidance[0].segment, "score_explanation");
  assert.equal(run.softGuidance[0].enforced, false);
});

// ── 4. Meta-harness 校验 ───────────────────────────────────────────────────────

test("validateMetaHarnessModuleSpec：全套合规通过", () => {
  const ok = validateMetaHarnessModuleSpec({
    id: "harness:gate.newcheck",
    kind: "gate",
    hardShaped: ["new_gate"],
    ioContract: { inputs: ["terminalSource"], outputs: ["gate_verdict"] },
    evidenceKeys: ["testSignal", "failureClass"],
    failureClasses: ["failed", "timeout"],
    shapeLayer: "hardShaped",
  });
  assert.equal(ok.ok, true, `应通过: ${ok.problems.join("; ")}`);
});

test("validateMetaHarnessModuleSpec：只声明 id/kind → 非静默拒绝（被问全套）", () => {
  const r = validateMetaHarnessModuleSpec({ id: "harness:gate.bare", kind: "gate" });
  assert.equal(r.ok, false, "缺全套字段应拒绝");
  assert.ok(r.problems.some((p) => p.includes("ioContract")), "应问 ioContract");
  assert.ok(r.problems.some((p) => p.includes("evidenceKeys")), "应问 evidenceKeys");
  assert.ok(r.problems.some((p) => p.includes("failureClasses")), "应问 failureClasses");
  assert.ok(r.problems.some((p) => p.includes("shapeLayer")), "应问 shapeLayer");
});

test("validateMetaHarnessModuleSpec：evidence key/failure_class 必须 ∈ P0 词汇表；layer 须 4选1", () => {
  const r = validateMetaHarnessModuleSpec({
    id: "harness:gate.bad",
    kind: "gate",
    ioContract: { inputs: [], outputs: [] },
    evidenceKeys: ["totallyMadeUp"],
    failureClasses: ["not_a_class"],
    shapeLayer: "wat",
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("HARNESS_EVIDENCE_KEY")), "未知 evidence key 应拒（复用 P0 词汇表）");
  assert.ok(r.problems.some((p) => p.includes("KNOWN_HARNESS_FAILURE_CLASSES")), "未知 failure_class 应拒（复用 P0 词汇表）");
  assert.ok(r.problems.some((p) => p.includes("shapeLayer")), "非法 layer 应拒");
});

test("validateMetaHarnessModuleSpec：非法 kind 经基础闸也被拒（与 validateHarnessModuleDefinition 同源）", () => {
  const r = validateMetaHarnessModuleSpec({
    id: "harness:x.bad", kind: "adapter",
    ioContract: { inputs: [], outputs: [] }, evidenceKeys: [], failureClasses: [], shapeLayer: "freeform",
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("kind")), "非法 kind 应拒");
});

test("不破坏既有：validateHarnessModuleDefinition（catalog 轻量闸）仍只校 id/kind/hardShaped", () => {
  // bare def（无全套）经轻量闸仍合法 → catalog 既有 10 条目不被破坏
  assert.equal(validateHarnessModuleDefinition({ id: "harness:gate.bare", kind: "gate" }).ok, true);
});
