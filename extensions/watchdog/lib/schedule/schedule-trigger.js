import { getScheduleSpec } from "./schedule-registry.js";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { listLifecycleWorkItems } from "../contracts.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { isActiveContractStatus } from "../core/runtime-status.js";
import { buildAgentMainSessionKey } from "../session-keys.js";

export const SCHEDULE_TRIGGER_COMMAND = "watchdog-schedule-run";

function buildDefaultSystemActionDelivery(spec) {
  const targetAgent = normalizeString(spec?.entry?.targetAgent);
  if (!targetAgent) return null;
  return {
    agentId: targetAgent,
    sessionKey: buildAgentMainSessionKey(targetAgent),
  };
}

export function buildScheduleTriggerCommandMessage(scheduleId) {
  const normalizedId = normalizeString(scheduleId);
  if (!normalizedId) {
    throw new Error("missing schedule id");
  }
  return `/${SCHEDULE_TRIGGER_COMMAND} ${normalizedId}`;
}

export function parseScheduleTriggerCommandArgs(rawArgs) {
  return normalizeString(String(rawArgs || "").split(/\s+/g)[0]);
}

function buildScheduleContext(spec) {
  const source = normalizeRecord(spec, {});
  return {
    id: source.id || null,
    enabled: source.enabled === true,
    trigger: normalizeRecord(source.trigger, null),
    entry: normalizeRecord(source.entry, null),
    systemActionDelivery: normalizeRecord(source.systemActionDelivery, null),
    resultPolicy: normalizeRecord(source.resultPolicy, null),
    concurrency: normalizeRecord(source.concurrency, null),
  };
}

async function findActiveScheduleContract(scheduleId) {
  const workItems = await listLifecycleWorkItems();
  return workItems.find((entry) =>
    entry?.scheduleContext?.id === scheduleId
    && isActiveContractStatus(entry?.status)) || null;
}

async function findActiveSchedulePipeline(scheduleId) {
  // scheduleContext is a comms field on the contract, not on loop-session-store.
  // After P2 migration, loop-session doesn't carry scheduleContext.
  // Schedule concurrency is fully covered by findActiveScheduleContract() above.
  // This function is a no-op placeholder until pipeline-store is deleted (P4).
  return null;
}

export async function executeScheduleTrigger(scheduleId, {
  api,
  enqueue,
  wakePlanner,
  logger,
} = {}) {
  const normalizedId = normalizeString(scheduleId);
  if (!normalizedId) {
    throw new Error("missing schedule id");
  }
  if (!api || typeof enqueue !== "function" || typeof wakePlanner !== "function") {
    throw new Error("missing runtime context for schedule trigger");
  }

  const spec = await getScheduleSpec(normalizedId);
  if (!spec) {
    throw new Error(`unknown schedule id: ${normalizedId}`);
  }

  if (spec.enabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: "schedule_disabled",
      scheduleId: normalizedId,
      schedule: spec,
    };
  }

  if (spec.concurrency?.skipIfRunning === true) {
    const activeContract = await findActiveScheduleContract(normalizedId);
    if (activeContract) {
      return {
        ok: true,
        skipped: true,
        reason: "schedule_contract_running",
        scheduleId: normalizedId,
        schedule: spec,
        activeContractId: activeContract.id || null,
      };
    }

    const activePipeline = await findActiveSchedulePipeline(normalizedId);
    if (activePipeline) {
      return {
        ok: true,
        skipped: true,
        reason: "schedule_pipeline_running",
        scheduleId: normalizedId,
        schedule: spec,
        activePipelineId: activePipeline.pipelineId || null,
        activeLoopId: activePipeline.loopId || null,
      };
    }
  }

  const replyTo = spec.systemActionDelivery || buildDefaultSystemActionDelivery(spec);
  const triggerResult = await dispatchAcceptIngressMessage(spec.entry.message, {
    source: "schedule",
    replyTo,
    deliveryTargets: spec.deliveryTargets,
    scheduleContext: buildScheduleContext(spec),
    ingressDirective: {
      routeHint: spec.entry.routeHint,
    },
    api,
    enqueue,
    wakePlanner,
    logger,
  });

  return {
    ok: true,
    skipped: false,
    scheduleId: normalizedId,
    schedule: spec,
    triggerResult,
  };
}
