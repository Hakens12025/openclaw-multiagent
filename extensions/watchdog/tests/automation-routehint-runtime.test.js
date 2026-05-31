import test from "node:test";
import assert from "node:assert/strict";

import { createAutomationDefinition, deleteAutomationDefinition } from "../lib/automation/automation-admin.js";
import { startAutomationRound } from "../lib/automation/automation-executor.js";
import {
  deleteAutomationRuntimeState,
  summarizeAutomationRuntimeRegistry,
} from "../lib/automation/automation-runtime.js";

function buildLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function buildAutomationRouteHintPayload(automationId) {
  return {
    automationId,
    summary: "Automation route hint retirement",
    instruction: "Verify retired automation route hints are not propagated",
    targetAgent: "controller",
    message: "run canonical automation",
    routeHint: "short",
  };
}

test("automation admin, executor, and runtime summary do not propagate route hints", async () => {
  const automationId = `automation-routehint-retirement-${Date.now()}`;
  const dispatchCalls = [];

  try {
    const created = await createAutomationDefinition({
      payload: buildAutomationRouteHintPayload(automationId),
      logger: buildLogger(),
    });

    assert.equal(created.ok, true);
    assert.equal("routeHint" in created.automation.entry, false);

    const start = await startAutomationRound(automationId, {
      api: {},
      enqueue: () => {},
      wakePlanner: async () => null,
      logger: buildLogger(),
      dispatchAcceptIngressMessageFn: async (message, options = {}) => {
        dispatchCalls.push({ message, options });
        return { ok: true, contractId: "TC-AUTOMATION-ROUTEHINT" };
      },
    });

    assert.equal(start.ok, true);
    assert.equal(dispatchCalls.length, 1);
    assert.equal("ingressDirective" in dispatchCalls[0].options, false);

    const registry = await summarizeAutomationRuntimeRegistry();
    const entry = registry.automations.find((item) => item.id === automationId) || null;
    assert.equal("routeHint" in entry.summary, false);
  } finally {
    await deleteAutomationRuntimeState(automationId).catch(() => {});
    await deleteAutomationDefinition({
      payload: { automationId },
      logger: buildLogger(),
    }).catch(() => {});
  }
});
