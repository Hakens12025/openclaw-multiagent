/**
 * harness-composition.test.js — harness 组装连贯性校验(全软建议,非阻断)
 *
 * 真实语义:freeform(0模块)合法;gate 可从 terminalSource 取证→无 collector 仅 info;
 * 有模块无 gate/guard → warn(失去门控/无约束)。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateHarnessComposition, hasHarnessCompositionWarnings } from "../lib/harness/harness-composition.js";

const codes = (refs) => validateHarnessComposition(refs).problems.map((p) => p.code);

test("freeform(空模块) → 无问题(合法)", () => {
  assert.deepEqual(validateHarnessComposition([]).problems, []);
  assert.deepEqual(validateHarnessComposition(undefined).problems, []);
});

test("完整 harness(guard+collector+gate+normalizer) → 无 warn", () => {
  const refs = ["harness:guard.budget", "harness:collector.artifact", "harness:gate.test", "harness:normalizer.failure"];
  assert.equal(hasHarnessCompositionWarnings(refs), false);
  // 全齐时连 info 都不应触发(有 collector)
  assert.deepEqual(validateHarnessComposition(refs).problems, []);
});

test("有模块但无 gate → warn no_gate", () => {
  const c = codes(["harness:guard.budget", "harness:collector.artifact"]);
  assert.ok(c.includes("no_gate"));
  assert.equal(hasHarnessCompositionWarnings(["harness:guard.budget"]), true);
});

test("有模块但无 guard → warn no_guard", () => {
  const c = codes(["harness:gate.test", "harness:collector.artifact"]);
  assert.ok(c.includes("no_guard"));
});

test("有 gate 但无 collector → info gate_without_collector(非 warn)", () => {
  const refs = ["harness:guard.budget", "harness:gate.test"];
  const c = codes(refs);
  assert.ok(c.includes("gate_without_collector"));
  const gateProblem = validateHarnessComposition(refs).problems.find((p) => p.code === "gate_without_collector");
  assert.equal(gateProblem.severity, "info", "gate 能从 terminalSource 取证 → info 非 warn");
  assert.ok(gateProblem.suggestion);
});

test("eval_input 无 collector.artifact → info", () => {
  const c = codes(["harness:guard.budget", "harness:gate.test", "harness:collector.trace", "harness:normalizer.eval_input"]);
  assert.ok(c.includes("eval_input_without_artifact_collector"));
});

test("无法解析的垃圾 ref 被过滤(等价空)", () => {
  assert.deepEqual(validateHarnessComposition(["not:a:module", "garbage"]).problems, []);
});

test("重复 ref 去重(不影响判定)", () => {
  const refs = ["harness:guard.budget", "harness:guard.budget", "harness:gate.test", "harness:collector.artifact"];
  assert.equal(hasHarnessCompositionWarnings(refs), false);
});

// ── 集成:composition 挂进 normalizeHarnessSelection 输出(单源流到 spec)──────────
import { normalizeHarnessSelection } from "../lib/harness/harness-registry.js";

test("normalizeHarnessSelection 挂载 composition.problems(无 gate→标出)", () => {
  const sel = normalizeHarnessSelection({ moduleRefs: ["harness:guard.budget", "harness:collector.artifact"] });
  assert.ok(sel.composition, "应有 composition 字段");
  assert.ok(sel.composition.problems.some((p) => p.code === "no_gate"), "无 gate 应被标出");
});

test("normalizeHarnessSelection: freeform(空) → composition.problems 空", () => {
  const sel = normalizeHarnessSelection({});
  assert.deepEqual(sel.composition.problems, []);
});
