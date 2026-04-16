import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteAutomationSpec,
  listAutomationSpecs,
  upsertAutomationSpec,
} from "../lib/automation/automation-registry.js";
import {
  deleteAutomationRuntimeState,
  listAutomationRuntimeStates,
  upsertAutomationRuntimeState,
} from "../lib/automation/automation-runtime.js";

function buildAutomationSpec(id, label) {
  return {
    id,
    objective: {
      summary: `automation ${label}`,
      instruction: `run automation ${label}`,
      domain: "generic",
    },
    entry: {
      targetAgent: "controller",
      message: `run automation ${label}`,
    },
    harness: {},
  };
}

test("concurrent automation spec upserts do not lose sibling writes", async () => {
  const base = `automation-store-lock-${Date.now()}`;
  const idA = `${base}-a`;
  const idB = `${base}-b`;

  try {
    await Promise.allSettled([
      deleteAutomationSpec(idA),
      deleteAutomationSpec(idB),
    ]);

    await Promise.all([
      upsertAutomationSpec(buildAutomationSpec(idA, "A")),
      upsertAutomationSpec(buildAutomationSpec(idB, "B")),
    ]);

    const specs = await listAutomationSpecs();
    assert.equal(specs.some((entry) => entry.id === idA), true);
    assert.equal(specs.some((entry) => entry.id === idB), true);
  } finally {
    await Promise.allSettled([
      deleteAutomationSpec(idA),
      deleteAutomationSpec(idB),
    ]);
  }
});

test("concurrent automation runtime upserts do not lose sibling writes", async () => {
  const base = `automation-runtime-store-lock-${Date.now()}`;
  const idA = `${base}-a`;
  const idB = `${base}-b`;

  try {
    await Promise.allSettled([
      deleteAutomationRuntimeState(idA),
      deleteAutomationRuntimeState(idB),
    ]);

    await Promise.all([
      upsertAutomationRuntimeState({
        automationId: idA,
        status: "running",
        currentRound: 1,
      }),
      upsertAutomationRuntimeState({
        automationId: idB,
        status: "idle",
        currentRound: 2,
      }),
    ]);

    const states = await listAutomationRuntimeStates();
    assert.equal(states.some((entry) => entry.automationId === idA), true);
    assert.equal(states.some((entry) => entry.automationId === idB), true);
  } finally {
    await Promise.allSettled([
      deleteAutomationRuntimeState(idA),
      deleteAutomationRuntimeState(idB),
    ]);
  }
});
