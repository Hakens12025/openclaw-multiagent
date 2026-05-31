import { getScheduleSpec } from "./schedule-registry.js";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { listLifecycleWorkItems } from "../contracts.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { isActiveContractStatus } from "../core/runtime-status.js";
import { buildAgentMainSessionKey } from "../session-keys.js";
import {
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
  clearPendingSignal,
} from "../runtime/pending-signal-registry.js";

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

  }

  const replyTo = spec.systemActionDelivery || buildDefaultSystemActionDelivery(spec);
  const targetAgentId = normalizeString(spec?.entry?.targetAgent) || replyTo?.agentId || null;
  if (targetAgentId) {
    registerPendingSignal({
      agentId: targetAgentId,
      sourceKind: PENDING_SIGNAL_KINDS.SCHEDULE_DUE,
      sourceRef: normalizedId,
    });
  }
  let triggerResult;
  try {
    triggerResult = await dispatchAcceptIngressMessage(spec.entry.message, {
      source: "schedule",
      replyTo,
      deliveryTargets: spec.deliveryTargets,
      scheduleContext: buildScheduleContext(spec),
      api,
      enqueue,
      wakePlanner,
      logger,
    });
  } finally {
    if (targetAgentId) {
      clearPendingSignal({
        agentId: targetAgentId,
        sourceKind: PENDING_SIGNAL_KINDS.SCHEDULE_DUE,
        sourceRef: normalizedId,
      });
    }
  }

  return {
    ok: true,
    skipped: false,
    scheduleId: normalizedId,
    schedule: spec,
    triggerResult,
  };
}
