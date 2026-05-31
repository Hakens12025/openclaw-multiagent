import { listLifecycleWorkItems } from "../contracts.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { getActiveLoopRuntime } from "../loop/loop-round-runtime.js";
import {
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { listAutomationSpecs } from "./automation-registry.js";
import {
  ensureAutomationRuntimeState,
  upsertAutomationRuntimeState,
} from "./automation-runtime.js";
import {
  normalizePositiveInteger,
  buildNextWakeAt,
} from "./automation-decision.js";
import {
  buildActiveHarnessLifecycle,
  buildContractIndex,
  isLoopRuntimeActive,
  resolveAutomationIdFromContext,
  resolveRoundFromContext,
  resolveTriggerFromContext,
  resolveRequestedAtFromContext,
} from "./automation-harness-lifecycle.js";
import {
  handleAutomationContractTerminal,
  handleAutomationLoopRuntimeTerminal,
} from "./automation-finalize.js";

export async function reconcileAutomationRuntimeStates({
  logger,
  onAlert,
} = {}) {
  const [specs, contracts, loopRuntime] = await Promise.all([
    listAutomationSpecs(),
    listLifecycleWorkItems(),
    getActiveLoopRuntime(),
  ]);
  const contractIndex = buildContractIndex(contracts);
  const now = Date.now();
  const updates = [];

  for (const spec of specs) {
    const runtime = await ensureAutomationRuntimeState(spec);
    const activeContract = contractIndex.activeByAutomationId.get(spec.id) || null;
    const activeLoopRuntime = isLoopRuntimeActive(loopRuntime)
      && resolveAutomationIdFromContext(loopRuntime?.automationContext) === spec.id
      ? loopRuntime
      : null;

    const runtimeContract = normalizeString(runtime?.activeContractId)
      ? contractIndex.byId.get(runtime.activeContractId) || null
      : null;
    if (runtimeContract && isTerminalContractStatus(runtimeContract?.status)) {
      const recovered = await handleAutomationContractTerminal(runtimeContract, { logger, onAlert });
      updates.push({ automationId: spec.id, action: "recovered_contract_terminal", recovered });
      continue;
    }

    if (normalizeString(runtime?.activePipelineId)
      && normalizeString(loopRuntime?.pipelineId) === normalizeString(runtime?.activePipelineId)
      && loopRuntime?.currentStage === "concluded"
      && resolveAutomationIdFromContext(loopRuntime?.automationContext) === spec.id) {
      const recovered = await handleAutomationLoopRuntimeTerminal(loopRuntime, { logger, onAlert });
      updates.push({ automationId: spec.id, action: "recovered_loop_runtime_terminal", recovered });
      continue;
    }

    let nextRuntime = runtime;
    if (activeContract || activeLoopRuntime) {
      const activeContext = normalizeRecord(
        activeContract?.automationContext || activeLoopRuntime?.automationContext,
        null,
      );
      const resolvedRound = Math.max(
        normalizePositiveInteger(runtime?.currentRound, 0),
        resolveRoundFromContext(activeContract?.automationContext, 0),
        resolveRoundFromContext(activeLoopRuntime?.automationContext, 0),
      );
      const harnessState = await buildActiveHarnessLifecycle(spec, runtime, {
        round: resolvedRound,
        trigger: resolveTriggerFromContext(activeContext, "reconcile"),
        requestedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || now),
        startedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || now),
        contractId: activeContract?.id || null,
        pipelineId: activeLoopRuntime?.pipelineId || null,
        loopId: activeLoopRuntime?.loopId || null,
      });
      nextRuntime = {
        ...runtime,
        status: "running",
        currentRound: resolvedRound,
        activeContractId: activeContract?.id || null,
        activePipelineId: activeLoopRuntime?.pipelineId || null,
        activeLoopId: activeLoopRuntime?.loopId || null,
        activeHarnessSpec: harnessState.activeHarnessSpec,
        activeHarnessRun: harnessState.activeHarnessRun,
      };
    } else if (spec.enabled !== true) {
      nextRuntime = {
        ...runtime,
        status: "paused",
        activeContractId: null,
        activePipelineId: null,
        activeLoopId: null,
        activeHarnessSpec: null,
        activeHarnessRun: null,
        nextWakeAt: null,
      };
    } else if (runtime?.status === "running") {
      nextRuntime = {
        ...runtime,
        status: "idle",
        activeContractId: null,
        activePipelineId: null,
        activeLoopId: null,
        activeHarnessSpec: null,
        activeHarnessRun: null,
      };
    } else if (runtime?.activeHarnessSpec || runtime?.activeHarnessRun) {
      nextRuntime = {
        ...runtime,
        activeHarnessSpec: null,
        activeHarnessRun: null,
      };
    }

    if (spec.enabled === true
      && spec?.wakePolicy?.onBoot === true
      && !activeContract
      && !activeLoopRuntime
      && !Number.isFinite(nextRuntime?.nextWakeAt)
      && !Number.isFinite(nextRuntime?.lastWakeAt)
      && nextRuntime?.status === "idle") {
      nextRuntime = {
        ...nextRuntime,
        nextWakeAt: now,
      };
    }

    if (JSON.stringify(nextRuntime) !== JSON.stringify(runtime)) {
      const saved = await upsertAutomationRuntimeState(nextRuntime);
      updates.push({ automationId: spec.id, action: "runtime_reconciled", runtime: saved });
    }
  }

  return {
    ok: true,
    updates,
  };
}
