import test from "node:test";
import assert from "node:assert/strict";

import { deleteAutomationSpec, upsertAutomationSpec } from "../lib/automation/automation-registry.js";
import { deleteAutomationRuntimeState } from "../lib/automation/automation-runtime.js";
import { handleAutomationContractTerminal, startAutomationRound } from "../lib/automation/automation-executor.js";

function buildLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("handleAutomationContractTerminal backfills final decision onto lastHarnessRun", async () => {
  const automationId = `automation-harness-decision-${Date.now()}`;

  try {
    await upsertAutomationSpec({
      id: automationId,
      objective: {
        summary: "decision backfill test",
        instruction: "verify harness decision backfill",
        domain: "coding",
      },
      entry: {
        targetAgent: "controller",
        routeHint: "long",
      },
      wakePolicy: {
        type: "result",
        onResult: true,
      },
      harness: {
        moduleRefs: ["harness:gate.artifact"],
      },
      systemActionDelivery: {
        agentId: "controller",
      },
    });

    await startAutomationRound(automationId, {
      api: {},
      enqueue: () => {},
      wakePlanner: async () => null,
      logger: buildLogger(),
      dispatchAcceptIngressMessageFn: async () => ({
        ok: true,
        route: "long",
        contractId: "TC-AUTOMATION-HARNESS-DECISION",
      }),
    });

    const payload = await handleAutomationContractTerminal({
      id: "TC-AUTOMATION-HARNESS-DECISION",
      status: "completed",
      terminalOutcome: {
        summary: "artifact emitted",
        artifact: "/tmp/harness-decision.patch",
      },
      automationContext: {
        automationId,
        round: 1,
      },
    }, {
      logger: buildLogger(),
    });

    assert.equal(payload.handled, true);
    assert.equal(payload.runtime?.lastAutomationDecision?.decision, "continue");
    assert.equal(payload.runtime?.lastHarnessRun?.decision, "continue");
    assert.equal(payload.runtime?.lastHarnessRun?.completionReason, payload.runtime?.lastAutomationDecision?.reason);
    assert.equal(payload.runtime?.lastHarnessRun?.runtimeStatus, payload.runtime?.lastAutomationDecision?.status);
  } finally {
    await deleteAutomationRuntimeState(automationId).catch(() => {});
    await deleteAutomationSpec(automationId).catch(() => {});
  }
});
