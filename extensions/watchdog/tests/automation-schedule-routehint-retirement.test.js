import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { normalizeAutomationSpec } from "../lib/automation/automation-registry.js";
import { normalizeScheduleSpec } from "../lib/schedule/schedule-registry.js";

test("automation and schedule specs discard retired route hints", () => {
  const automationSpec = normalizeAutomationSpec({
    id: "routehint-automation",
    objective: {
      summary: "Route hint retirement",
      instruction: "Verify retired route hints are not persisted",
    },
    entry: {
      targetAgent: "controller",
      message: "run automation",
      routeHint: "short",
    },
    routeHint: "full-path",
  });

  const scheduleSpec = normalizeScheduleSpec({
    id: "routehint-schedule",
    trigger: {
      type: "cron",
      expr: "*/5 * * * *",
    },
    entry: {
      targetAgent: "controller",
      message: "run schedule",
      routeHint: "short",
    },
  });

  assert.equal("routeHint" in automationSpec.entry, false);
  assert.equal("routeHint" in scheduleSpec.entry, false);
});

const dispatchCalls = [];
const pendingSignals = [];
const workItems = [];

mock.module("../lib/ingress/dispatch-entry.js", {
  namedExports: {
    dispatchAcceptIngressMessage: async (message, options = {}) => {
      dispatchCalls.push({ message, options });
      return { ok: true, contractId: "TC-SCHEDULE-ROUTEHINT" };
    },
  },
});

mock.module("../lib/contract/contracts.js", {
  namedExports: {
    listLifecycleWorkItems: async () => workItems,
  },
});

mock.module("../lib/runtime/pending-signal-registry.js", {
  namedExports: {
    PENDING_SIGNAL_KINDS: Object.freeze({
      SCHEDULE_DUE: "schedule_due",
    }),
    registerPendingSignal: (entry) => pendingSignals.push({ op: "register", ...entry }),
    clearPendingSignal: (entry) => pendingSignals.push({ op: "clear", ...entry }),
  },
});

const { upsertScheduleSpec, deleteScheduleSpec } = await import("../lib/schedule/schedule-registry.js");
const { executeScheduleTrigger } = await import("../lib/schedule/schedule-trigger.js");

test("schedule trigger sends canonical ingress without route hint directive", async () => {
  const scheduleId = `schedule-routehint-retirement-${Date.now()}`;
  dispatchCalls.length = 0;
  pendingSignals.length = 0;
  workItems.length = 0;

  try {
    await upsertScheduleSpec({
      id: scheduleId,
      trigger: {
        type: "cron",
        expr: "*/5 * * * *",
      },
      entry: {
        targetAgent: "controller",
        message: "run canonical schedule",
        routeHint: "short",
      },
    });

    const result = await executeScheduleTrigger(scheduleId, {
      api: {},
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].message, "run canonical schedule");
    assert.equal("ingressDirective" in dispatchCalls[0].options, false);
    assert.equal(pendingSignals.some((entry) => entry.op === "register" && entry.sourceKind === "schedule_due"), true);
    assert.equal(pendingSignals.some((entry) => entry.op === "clear" && entry.sourceKind === "schedule_due"), true);
  } finally {
    await deleteScheduleSpec(scheduleId).catch(() => {});
  }
});
