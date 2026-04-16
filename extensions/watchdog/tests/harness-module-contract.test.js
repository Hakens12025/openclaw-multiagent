import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeHarnessModuleDefinition,
  buildHarnessModuleStartInput,
  buildHarnessModuleFinalizeInput,
} from "../lib/harness/harness-module-contract.js";

test("normalizeHarnessModuleDefinition rejects legacy adapter kinds", () => {
  const definition = normalizeHarnessModuleDefinition({
    id: "harness:normalizer.failure",
    kind: "adapter",
    hardShaped: ["failure_classification"],
  });

  assert.equal(definition, null);
});

test("buildHarnessModuleStartInput produces the canonical start-phase shape", () => {
  const input = buildHarnessModuleStartInput({
    moduleId: "harness:guard.budget",
    harnessRun: {
      automationId: "auto-1",
      round: 1,
      requestedAt: 1,
      status: "running",
    },
    automationSpec: {
      id: "auto-1",
      harness: {
        moduleConfig: {
          "harness:guard.budget": {
            budgetSeconds: 30,
          },
        },
      },
    },
    executionContext: {
      targetAgent: "worker",
      tools: ["read"],
    },
  });

  assert.equal(input.phase, "start");
  assert.equal(input.module.id, "harness:guard.budget");
  assert.equal(input.module.kind, "guard");
  assert.equal(input.moduleConfig.budgetSeconds, 30);
  assert.equal("terminalSource" in input, false);
  assert.equal("baseEvidence" in input, false);
});

test("buildHarnessModuleFinalizeInput carries terminal evidence but preserves the same module contract", () => {
  const input = buildHarnessModuleFinalizeInput({
    moduleId: "harness:gate.artifact",
    harnessRun: {
      automationId: "auto-1",
      round: 1,
      requestedAt: 1,
      status: "completed",
    },
    automationSpec: {
      id: "auto-1",
    },
    executionContext: {
      targetAgent: "worker",
    },
    terminalSource: {
      terminalOutcome: {
        artifact: "/tmp/out.md",
      },
    },
    baseEvidence: {
      artifact: {
        present: true,
        path: "/tmp/out.md",
      },
    },
  });

  assert.equal(input.phase, "finalize");
  assert.equal(input.module.id, "harness:gate.artifact");
  assert.equal(input.module.kind, "gate");
  assert.equal(input.baseEvidence.artifact.path, "/tmp/out.md");
  assert.equal(input.terminalSource.terminalOutcome.artifact, "/tmp/out.md");
});
