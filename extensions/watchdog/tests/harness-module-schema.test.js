import test from "node:test";
import assert from "node:assert/strict";

import { validateHarnessModuleDefinition } from "../lib/harness/harness-module-schema.js";
import { validateHarnessModuleDefinition as validateViaContract } from "../lib/harness/harness-module-contract.js";
import { listHarnessModuleCatalog } from "../lib/harness/harness-module-catalog.js";

// ── 正向测试：所有已注册模块必须通过 ──────────────────────────────────────

test("all registered harness module catalog entries pass schema validation", () => {
  const modules = listHarnessModuleCatalog();
  assert.ok(modules.length > 0, "catalog must return at least one module");

  const failures = [];
  for (const module of modules) {
    const { ok, problems } = validateHarnessModuleDefinition(module);
    if (!ok) {
      failures.push(`${module.id}: ${problems.join("; ")}`);
    }
  }
  assert.deepEqual(failures, [], `modules that failed validation: ${failures.join("\n")}`);
});

test("all four active kinds are represented in the catalog", () => {
  const modules = listHarnessModuleCatalog();
  const kinds = new Set(modules.map((m) => m.kind));
  for (const kind of ["guard", "collector", "gate", "normalizer"]) {
    assert.ok(kinds.has(kind), `catalog must include at least one module of kind="${kind}"`);
  }
});

test("validateHarnessModuleDefinition is re-exported from harness-module-contract", () => {
  // The contract file re-exports from schema — ensure they resolve to the same function
  const minimal = { id: "harness:test.a", kind: "guard" };
  const fromSchema = validateHarnessModuleDefinition(minimal);
  const fromContract = validateViaContract(minimal);
  assert.deepEqual(fromSchema, fromContract);
});

// ── 负向测试：非法 definition 必须被拒绝 ──────────────────────────────────

test("validateHarnessModuleDefinition rejects non-object input", () => {
  assert.equal(validateHarnessModuleDefinition(null).ok, false);
  assert.equal(validateHarnessModuleDefinition(undefined).ok, false);
  assert.equal(validateHarnessModuleDefinition("string").ok, false);
  assert.equal(validateHarnessModuleDefinition([]).ok, false);
  assert.equal(validateHarnessModuleDefinition(42).ok, false);
});

test("validateHarnessModuleDefinition rejects missing id", () => {
  const { ok, problems } = validateHarnessModuleDefinition({ kind: "guard" });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("id")), `expected id problem, got: ${problems.join("; ")}`);
});

test("validateHarnessModuleDefinition rejects id without harness: prefix", () => {
  const { ok, problems } = validateHarnessModuleDefinition({ id: "guard.budget", kind: "guard" });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("harness:")), `expected harness: prefix problem, got: ${problems.join("; ")}`);
});

test("validateHarnessModuleDefinition rejects missing kind", () => {
  const { ok, problems } = validateHarnessModuleDefinition({ id: "harness:guard.budget" });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("kind")), `expected kind problem, got: ${problems.join("; ")}`);
});

test("validateHarnessModuleDefinition rejects invalid kind", () => {
  const { ok, problems } = validateHarnessModuleDefinition({
    id: "harness:guard.budget",
    kind: "adapter",
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("kind")), `expected kind problem, got: ${problems.join("; ")}`);
});

test("validateHarnessModuleDefinition rejects hardShaped that is not an array", () => {
  const { ok, problems } = validateHarnessModuleDefinition({
    id: "harness:guard.budget",
    kind: "guard",
    hardShaped: "not_an_array",
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("hardShaped")), `expected hardShaped problem, got: ${problems.join("; ")}`);
});

test("validateHarnessModuleDefinition rejects hardShaped containing non-strings", () => {
  const { ok, problems } = validateHarnessModuleDefinition({
    id: "harness:gate.artifact",
    kind: "gate",
    hardShaped: ["valid_item", 42, null],
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("hardShaped")), `expected hardShaped problem, got: ${problems.join("; ")}`);
});

// ── 正向：最小合法形状 ─────────────────────────────────────────────────────

test("validateHarnessModuleDefinition accepts minimal valid definition (no hardShaped)", () => {
  for (const kind of ["guard", "collector", "gate", "normalizer"]) {
    const { ok, problems } = validateHarnessModuleDefinition({
      id: `harness:${kind}.test`,
      kind,
    });
    assert.equal(ok, true, `kind="${kind}" should be valid: ${problems.join("; ")}`);
  }
});

test("validateHarnessModuleDefinition accepts definition with valid hardShaped array", () => {
  const { ok, problems } = validateHarnessModuleDefinition({
    id: "harness:collector.artifact",
    kind: "collector",
    hardShaped: ["artifact_capture", "diff_capture"],
  });
  assert.equal(ok, true, `unexpected problems: ${problems.join("; ")}`);
});

test("validateHarnessModuleDefinition accepts empty hardShaped array", () => {
  const { ok } = validateHarnessModuleDefinition({
    id: "harness:gate.test",
    kind: "gate",
    hardShaped: [],
  });
  assert.equal(ok, true);
});
