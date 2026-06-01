import test from "node:test";
import assert from "node:assert/strict";

import { recommendHarnessModules } from "../lib/operator/operator-harness-recommend.js";
import { listHarnessModuleCatalog } from "../lib/harness/harness-module-catalog.js";

const CATALOG_IDS = new Set(listHarnessModuleCatalog().map((m) => m.id));

test("静态基线: 无失败信号/无历史 → 4 kind 均衡基线, 全在 catalog 内", () => {
  const r = recommendHarnessModules({});
  assert.equal(r.source, "baseline");
  assert.ok(r.moduleRefs.length >= 4);
  assert.ok(r.moduleRefs.every((id) => CATALOG_IDS.has(id)), "推荐的 moduleRefs 必须都在 catalog 内");
  // 4 kind 各覆盖
  const kinds = new Set(r.moduleRefs.map((id) => listHarnessModuleCatalog().find((m) => m.id === id)?.kind));
  for (const k of ["guard", "collector", "gate", "normalizer"]) {
    assert.ok(kinds.has(k), `基线应覆盖 ${k} 类`);
  }
});

test("失败信号补强: test 失败 → 加 gate.test; schema 失败 → 加 gate.schema", () => {
  const r = recommendHarnessModules({ failedModules: ["test_gate", "schema_gate"] });
  assert.equal(r.source, "baseline");
  assert.ok(r.moduleRefs.includes("harness:gate.test"));
  assert.ok(r.moduleRefs.includes("harness:gate.schema"));
});

test("动态学习: 有历史成功组合(全在 catalog) → 优先采用 learned", () => {
  const learnedCombo = ["harness:guard.scope", "harness:gate.test"];
  const r = recommendHarnessModules({
    failedModules: ["test_gate"],
    pastSuccessfulCombos: [learnedCombo],
  });
  assert.equal(r.source, "learned");
  assert.deepEqual(r.moduleRefs, learnedCombo);
});

test("动态学习: 历史组合含非 catalog id → 忽略, 回退静态基线", () => {
  const r = recommendHarnessModules({
    pastSuccessfulCombos: [["harness:not-a-real-module", "harness:gate.test"]],
  });
  assert.equal(r.source, "baseline");
});

test("纯函数防御: 无入参不抛", () => {
  assert.ok(Array.isArray(recommendHarnessModules().moduleRefs));
});
