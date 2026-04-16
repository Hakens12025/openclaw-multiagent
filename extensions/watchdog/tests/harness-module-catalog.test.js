import test from "node:test";
import assert from "node:assert/strict";

import {
  getHarnessModuleCatalogEntry,
  listHarnessModuleCatalog,
  resolveHarnessModuleCatalogId,
} from "../lib/harness/harness-module-catalog.js";

test("harness module catalog only resolves canonical module ids", () => {
  assert.equal(resolveHarnessModuleCatalogId("run_failure_classifier"), null);
  assert.equal(resolveHarnessModuleCatalogId("review_finding_schema_check"), null);
  assert.equal(resolveHarnessModuleCatalogId("code_quality_gate"), null);

  const failureModule = getHarnessModuleCatalogEntry("run_failure_classifier");
  assert.equal(failureModule, null);

  const canonicalFailureModule = getHarnessModuleCatalogEntry("harness:normalizer.failure");
  assert.deepEqual(canonicalFailureModule, {
    id: "harness:normalizer.failure",
    kind: "normalizer",
    hardShaped: ["failure_classification", "review_verdict_normalization"],
  });
});

test("harness module catalog only exposes canonical harness namespace ids", () => {
  const modules = listHarnessModuleCatalog();
  assert.equal(modules.length > 0, true);
  assert.equal(modules.every((entry) => entry.id.startsWith("harness:")), true);
  assert.equal(modules.every((entry) => ["guard", "collector", "gate", "normalizer"].includes(entry.kind)), true);
});
