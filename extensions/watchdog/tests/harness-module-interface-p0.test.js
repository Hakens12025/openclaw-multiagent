/**
 * harness-module-interface-p0.test.js — P0 HarnessModule 接口归一
 *
 * 覆盖：
 *   1. 5 对象 validate：合规通过 / 拒非法（Config/StartInput/FinalizeInput/Result/HarnessRun）
 *   2. HarnessRun 预留 schemaVersion 槽：缺省可、非负整数可、负/非整拒
 *   3. 4 kind 集合归一：schema 是单一 source，contract 复用同一集合
 *   4. 4 kind start/finalize/evidence 回收 + HarnessRun 聚合（端到端经 builder/normalizer）
 *   5. failure_class 归一清单：vocab 单一权威，evidence.classifyFailure 产值 ∈ 清单，
 *      automation-decision 复用同一 strategies（不重建）
 *
 * 不改运行时行为，只锁接口契约。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HARNESS_MODULE_KIND,
  VALID_HARNESS_MODULE_KINDS,
  validateHarnessModuleDefinition,
  validateHarnessModuleConfig,
  validateHarnessModuleStartInput,
  validateHarnessModuleFinalizeInput,
  validateHarnessModuleResult,
  validateHarnessRun,
} from "../lib/harness/harness-module-schema.js";
import {
  HARNESS_MODULE_KIND as CONTRACT_KIND,
  buildHarnessModuleStartInput,
  buildHarnessModuleFinalizeInput,
} from "../lib/harness/harness-module-contract.js";
import {
  HARNESS_FAILURE_CLASS,
  KNOWN_HARNESS_FAILURE_CLASSES,
  FAILURE_CLASS_STRATEGIES,
} from "../lib/harness/harness-evidence-vocab.js";
import {
  startHarnessRun,
  normalizeHarnessRun,
  normalizeHarnessModuleRun,
  buildHarnessSpec,
} from "../lib/harness/harness-run.js";
import {
  initializeHarnessRunModules,
  finalizeHarnessRunModules,
} from "../lib/harness/harness-module-runner.js";

// ── 3. 4 kind 归一 ─────────────────────────────────────────────────────────────

test("4 kind 集合归一：schema 是单一 source，contract 复用同一枚举", () => {
  assert.deepEqual(VALID_HARNESS_MODULE_KINDS, ["guard", "collector", "gate", "normalizer"]);
  // contract 的 HARNESS_MODULE_KIND 与 schema 是同一对象（re-export）
  assert.deepEqual(CONTRACT_KIND, HARNESS_MODULE_KIND);
  assert.deepEqual(Object.values(HARNESS_MODULE_KIND).sort(), [...VALID_HARNESS_MODULE_KINDS].sort());
});

// ── 1. validate 各对象：合规 / 拒非法 ──────────────────────────────────────────

test("validateHarnessModuleConfig：plain object 通过，非对象拒", () => {
  assert.equal(validateHarnessModuleConfig({}).ok, true);
  assert.equal(validateHarnessModuleConfig({ allowedTools: ["read"], maxRetry: 2 }).ok, true);
  assert.equal(validateHarnessModuleConfig(null).ok, false);
  assert.equal(validateHarnessModuleConfig([]).ok, false);
  assert.equal(validateHarnessModuleConfig("x").ok, false);
});

test("validateHarnessModuleStartInput：合规通过 / phase 错拒 / module 非法拒", () => {
  const good = {
    phase: "start",
    module: { id: "harness:guard.budget", kind: "guard" },
    moduleConfig: {},
  };
  assert.equal(validateHarnessModuleStartInput(good).ok, true);
  // phase 错
  assert.equal(validateHarnessModuleStartInput({ ...good, phase: "finalize" }).ok, false);
  // module 非法（kind 非法）
  assert.equal(validateHarnessModuleStartInput({ ...good, module: { id: "harness:x", kind: "adapter" } }).ok, false);
  // moduleConfig 非对象
  assert.equal(validateHarnessModuleStartInput({ ...good, moduleConfig: [] }).ok, false);
  // 非对象
  assert.equal(validateHarnessModuleStartInput(null).ok, false);
});

test("validateHarnessModuleFinalizeInput：合规通过 / phase 错拒 / terminalSource 非对象拒", () => {
  const good = {
    phase: "finalize",
    module: { id: "harness:gate.test", kind: "gate" },
    terminalSource: {},
    baseEvidence: {},
  };
  assert.equal(validateHarnessModuleFinalizeInput(good).ok, true);
  assert.equal(validateHarnessModuleFinalizeInput({ ...good, phase: "start" }).ok, false);
  assert.equal(validateHarnessModuleFinalizeInput({ ...good, terminalSource: "x" }).ok, false);
  assert.equal(validateHarnessModuleFinalizeInput({ ...good, baseEvidence: 42 }).ok, false);
});

test("validateHarnessModuleResult：合规通过 / 缺 moduleId|kind|status 拒 / evidence 非对象拒", () => {
  const good = { moduleId: "harness:guard.budget", kind: "guard", status: "passed" };
  assert.equal(validateHarnessModuleResult(good).ok, true);
  assert.equal(validateHarnessModuleResult({ ...good, evidence: { failureClass: "timeout" } }).ok, true);
  assert.equal(validateHarnessModuleResult({ ...good, evidence: null }).ok, true);
  // 缺必填
  assert.equal(validateHarnessModuleResult({ kind: "guard", status: "passed" }).ok, false);
  assert.equal(validateHarnessModuleResult({ moduleId: "harness:x", status: "passed" }).ok, false);
  assert.equal(validateHarnessModuleResult({ moduleId: "harness:x", kind: "guard" }).ok, false);
  // kind 非法
  assert.equal(validateHarnessModuleResult({ moduleId: "harness:x", kind: "adapter", status: "passed" }).ok, false);
  // evidence 非对象
  assert.equal(validateHarnessModuleResult({ ...good, evidence: [] }).ok, false);
});

test("validateHarnessRun：合规通过 / 缺 automationId|round|status 拒 / moduleRuns 非数组拒", () => {
  const good = { automationId: "auto-1", round: 1, status: "running" };
  assert.equal(validateHarnessRun(good).ok, true);
  assert.equal(validateHarnessRun({ ...good, moduleRuns: [{ moduleId: "harness:guard.budget", kind: "guard", status: "passed" }] }).ok, true);
  // round 非正整数
  assert.equal(validateHarnessRun({ ...good, round: 0 }).ok, false);
  assert.equal(validateHarnessRun({ ...good, round: 1.5 }).ok, false);
  // 缺必填
  assert.equal(validateHarnessRun({ round: 1, status: "running" }).ok, false);
  assert.equal(validateHarnessRun({ automationId: "auto-1", status: "running" }).ok, false);
  // moduleRuns 非数组
  assert.equal(validateHarnessRun({ ...good, moduleRuns: {} }).ok, false);
  // moduleRuns 内含非法项
  assert.equal(validateHarnessRun({ ...good, moduleRuns: [{ moduleId: "x", kind: "adapter", status: "p" }] }).ok, false);
});

// ── 2. schemaVersion 预留槽 ────────────────────────────────────────────────────

test("validateHarnessRun：schemaVersion 预留槽——缺省可、非负整数可、负/非整拒", () => {
  const base = { automationId: "auto-1", round: 1, status: "running" };
  assert.equal(validateHarnessRun(base).ok, true, "缺省（无 schemaVersion）应可");
  assert.equal(validateHarnessRun({ ...base, schemaVersion: 0 }).ok, true);
  assert.equal(validateHarnessRun({ ...base, schemaVersion: 2 }).ok, true);
  assert.equal(validateHarnessRun({ ...base, schemaVersion: -1 }).ok, false);
  assert.equal(validateHarnessRun({ ...base, schemaVersion: 1.5 }).ok, false);
  assert.equal(validateHarnessRun({ ...base, schemaVersion: "1" }).ok, false);
});

// ── 4. 4 kind start/finalize/evidence 回收 + HarnessRun 聚合（端到端）──────────

function makeRun() {
  const spec = buildHarnessSpec(
    { id: "auto-itf", harness: { enabled: true, mode: "freeform", moduleRefs: [
      "harness:guard.budget",
      "harness:collector.artifact",
      "harness:gate.test",
      "harness:normalizer.failure",
    ] } },
    { round: 1 },
  );
  return startHarnessRun(spec, { startedAt: 1000 });
}

test("4 kind start/finalize：经 builder 产出合规 StartInput/FinalizeInput（带 module 合规）", () => {
  for (const moduleId of [
    "harness:guard.budget",      // guard
    "harness:collector.artifact", // collector
    "harness:gate.test",         // gate
    "harness:normalizer.failure", // normalizer
  ]) {
    const startInput = buildHarnessModuleStartInput({
      moduleId,
      harnessRun: { automationId: "auto-itf", round: 1, requestedAt: 1, status: "running" },
      automationSpec: { id: "auto-itf" },
    });
    assert.ok(startInput, `${moduleId} startInput 应非 null`);
    assert.equal(validateHarnessModuleStartInput(startInput).ok, true, `${moduleId} startInput 应合规`);
    assert.ok(VALID_HARNESS_MODULE_KINDS.includes(startInput.module.kind), `${moduleId} 的 kind 应是 4 类之一`);

    const finalizeInput = buildHarnessModuleFinalizeInput({
      moduleId,
      harnessRun: { automationId: "auto-itf", round: 1, requestedAt: 1, status: "running" },
      automationSpec: { id: "auto-itf" },
      terminalSource: { terminalOutcome: { reason: "done" } },
      baseEvidence: { failureClass: null },
    });
    assert.ok(finalizeInput, `${moduleId} finalizeInput 应非 null`);
    assert.equal(validateHarnessModuleFinalizeInput(finalizeInput).ok, true, `${moduleId} finalizeInput 应合规`);
  }
});

test("HarnessRun 聚合：initialize→finalize 产出的 run 与 moduleRuns 各合规", async () => {
  const run = makeRun();
  assert.equal(validateHarnessRun(run).ok, true, "startHarnessRun 产出应合规");

  const initialized = await initializeHarnessRunModules(run, { automationSpec: { id: "auto-itf" } });
  assert.ok(initialized, "initialize 应非 null");
  assert.equal(validateHarnessRun(initialized).ok, true, "initialized run 应合规");
  // 每个 moduleRun 合规（start 阶段）
  for (const mr of initialized.moduleRuns) {
    assert.equal(validateHarnessModuleResult(mr).ok, true, `moduleRun ${mr.moduleId} 应合规`);
  }

  const finalized = await finalizeHarnessRunModules(initialized, {
    automationSpec: { id: "auto-itf" },
    terminalStatus: "completed",
    finalizedAt: 2000,
  });
  assert.ok(finalized, "finalize 应非 null");
  assert.equal(validateHarnessRun(finalized).ok, true, "finalized run 应合规");
  for (const mr of finalized.moduleRuns) {
    assert.equal(validateHarnessModuleResult(mr).ok, true, `finalized moduleRun ${mr.moduleId} 应合规`);
  }
});

test("normalizeHarnessModuleRun 产出的 4 kind moduleRun 均通过 validateHarnessModuleResult", () => {
  for (const kind of VALID_HARNESS_MODULE_KINDS) {
    const mr = normalizeHarnessModuleRun({ moduleId: `harness:${kind}.x`, kind, status: "passed" });
    assert.ok(mr, `${kind} moduleRun 应非 null`);
    assert.equal(validateHarnessModuleResult(mr).ok, true, `${kind} moduleRun 应合规`);
  }
});

// ── 5. failure_class 归一清单 ──────────────────────────────────────────────────

test("failure_class 归一：vocab 是单一权威，automation-decision 复用同一 strategies", async () => {
  // KNOWN 清单与 strategies key 一一对应
  assert.deepEqual(
    [...KNOWN_HARNESS_FAILURE_CLASSES].sort(),
    Object.keys(FAILURE_CLASS_STRATEGIES).sort(),
    "已知 failure_class 清单应与 strategies key 一致",
  );
  // automation-decision.js 不再本地重定义 FAILURE_CLASS_STRATEGIES（静态护栏）
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/automation/automation-decision.js", import.meta.url), "utf8");
  assert.match(src, /from "\.\.\/harness\/harness-evidence-vocab\.js"/, "应从 vocab 导入 FAILURE_CLASS_STRATEGIES");
  assert.doesNotMatch(src, /const FAILURE_CLASS_STRATEGIES\s*=/, "不应再本地重定义 FAILURE_CLASS_STRATEGIES");
});

test("failure_class 归一：evidence.classifyFailure 引用 HARNESS_FAILURE_CLASS 常量", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/harness/harness-module-evidence.js", import.meta.url), "utf8");
  assert.match(src, /HARNESS_FAILURE_CLASS/, "classifyFailure 应引用 HARNESS_FAILURE_CLASS 常量（不再字面量）");
  assert.match(src, /from "\.\/harness-evidence-vocab\.js"/, "应从 vocab 导入");
  // 验证产出值确实 ∈ 已知清单（timeout 经 reason、failed 经 status）
  assert.ok(KNOWN_HARNESS_FAILURE_CLASSES.includes(HARNESS_FAILURE_CLASS.TIMEOUT));
  assert.ok(KNOWN_HARNESS_FAILURE_CLASSES.includes(HARNESS_FAILURE_CLASS.FAILED));
});
