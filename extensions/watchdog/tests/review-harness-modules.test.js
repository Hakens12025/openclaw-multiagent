import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHarnessSelection,
  getHarnessModule,
  resolveModuleId,
} from "../lib/harness/harness-registry.js";

test("evaluation.score_and_verdict profile includes review harness modules", () => {
  const selection = normalizeHarnessSelection({ profileId: "evaluation.score_and_verdict" });
  assert.ok(selection, "selection should not be null");
  assert.ok(selection.moduleRefs.includes("harness:gate.schema"),
    "should include harness:gate.schema");
  assert.ok(selection.moduleRefs.includes("harness:normalizer.failure"),
    "should include harness:normalizer.failure");
  assert.ok(selection.moduleRefs.includes("harness:gate.artifact"),
    "should include harness:gate.artifact");
});

test("review harness modules are registered with correct kinds", () => {
  const findingSchema = getHarnessModule("harness:gate.schema");
  assert.ok(findingSchema);
  assert.equal(findingSchema.kind, "gate");

  const verdictNormalizer = getHarnessModule("harness:normalizer.failure");
  assert.ok(verdictNormalizer);
  assert.equal(verdictNormalizer.kind, "normalizer");

  const artifactRequired = getHarnessModule("harness:gate.artifact");
  assert.ok(artifactRequired);
  assert.equal(artifactRequired.kind, "gate");
});

test("review harness modules stay within the four active runtime kinds", () => {
  const modules = [
    getHarnessModule("harness:gate.schema"),
    getHarnessModule("harness:normalizer.failure"),
    getHarnessModule("harness:gate.artifact"),
  ];
  const activeKinds = new Set(["guard", "collector", "gate", "normalizer"]);
  assert.equal(modules.every((module) => activeKinds.has(module.kind)), true);
});

test("resolveModuleId only accepts canonical harness namespace IDs", () => {
  // Removed legacy IDs are rejected
  assert.equal(resolveModuleId("review_finding_schema_check"), null);
  assert.equal(resolveModuleId("review_verdict_normalizer"), null);
  assert.equal(resolveModuleId("review_artifact_required_check"), null);
  assert.equal(resolveModuleId("artifact_collector"), null);
  assert.equal(resolveModuleId("run_failure_classifier"), null);

  // Deleted legacy ID remains null
  assert.equal(resolveModuleId("code_quality_gate"), null);

  // New-style IDs pass through
  assert.equal(resolveModuleId("harness:gate.artifact"), "harness:gate.artifact");
  assert.equal(resolveModuleId("harness:guard.budget"), "harness:guard.budget");

  // Unknown ID resolves to null
  assert.equal(resolveModuleId("nonexistent_module"), null);
});

test("normalizeHarnessSelection rejects removed legacy harness ids", () => {
  const selection = normalizeHarnessSelection({
    moduleRefs: [
      "tool_whitelist_guard",
      "network_policy_guard",
      "workspace_scope_guard",
      "sandbox_policy_guard",
    ],
    moduleConfig: {
      tool_whitelist_guard: {
        allowedTools: ["web_search"],
      },
      network_policy_guard: {
        allowNetwork: false,
      },
      workspace_scope_guard: {
        allowedWorkspaceRoots: ["~/.openclaw/workspaces/controller"],
      },
      sandbox_policy_guard: {
        policy: "workspace_local_only",
      },
    },
  });

  assert.equal(selection, null);
});

test("normalizeHarnessSelection preserves canonical harness ids without side-channel aliases", () => {
  const selection = normalizeHarnessSelection({
    moduleRefs: [
      "harness:guard.tool_access",
      "harness:guard.scope",
    ],
    moduleConfig: {
      "harness:guard.tool_access": {
        allowedTools: ["web_search"],
        allowNetwork: false,
      },
      "harness:guard.scope": {
        policy: "workspace_local_only",
      },
    },
  });

  assert.deepEqual(selection.moduleRefs, [
    "harness:guard.tool_access",
    "harness:guard.scope",
  ]);
  assert.deepEqual(Object.keys(selection.moduleConfig).sort(), [
    "harness:guard.scope",
    "harness:guard.tool_access",
  ]);
});
