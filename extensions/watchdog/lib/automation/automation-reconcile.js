import { listLifecycleWorkItems } from "../contract/contracts.js";
import { normalizeString } from "../core/normalize.js";
import {
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { listAutomationSpecs } from "./automation-registry.js";
import {
  ensureAutomationRuntimeState,
  upsertAutomationRuntimeState,
} from "./automation-runtime.js";
import { normalizePositiveInteger } from "./automation-decision.js";
import {
  buildContractIndex,
  resolveRoundFromContext,
} from "./automation-round-context.js";
import { handleAutomationContractTerminal } from "./automation-finalize.js";

export async function reconcileAutomationRuntimeStates({
  logger,
  onAlert,
} = {}) {
  const [specs, contracts] = await Promise.all([
    listAutomationSpecs(),
    listLifecycleWorkItems(),
  ]);
  const contractIndex = buildContractIndex(contracts);
  const now = Date.now();
  const updates = [];

  for (const spec of specs) {
    const runtime = await ensureAutomationRuntimeState(spec);
    const activeContract = contractIndex.activeByAutomationId.get(spec.id) || null;

    // 终态回收单源：runtime.activeContractId 经 contractIndex.byId 反查本条 automation
    // 自己记下的合约。回路退役(2026-08-18)前这里还并了一条按 activePipelineId 比对
    // loopRuntime 的回收腿，其门 `resolveAutomationIdFromContext(loopRuntime.automationContext)`
    // 恒 null，生产上从未执行过；合约腿本就是完整主路径。
    const runtimeContract = normalizeString(runtime?.activeContractId)
      ? contractIndex.byId.get(runtime.activeContractId) || null
      : null;
    if (runtimeContract && isTerminalContractStatus(runtimeContract?.status)) {
      const recovered = await handleAutomationContractTerminal(runtimeContract, { logger, onAlert });
      updates.push({ automationId: spec.id, action: "recovered_contract_terminal", recovered });
      continue;
    }

    let nextRuntime = runtime;
    if (activeContract) {
      const resolvedRound = Math.max(
        normalizePositiveInteger(runtime?.currentRound, 0),
        resolveRoundFromContext(activeContract.automationContext, 0),
      );
      nextRuntime = {
        ...runtime,
        status: "running",
        currentRound: resolvedRound,
        activeContractId: activeContract.id || null,
      };
    } else if (spec.enabled !== true) {
      nextRuntime = {
        ...runtime,
        status: "paused",
        activeContractId: null,
        nextWakeAt: null,
      };
    } else if (runtime?.status === "running") {
      nextRuntime = {
        ...runtime,
        status: "idle",
        activeContractId: null,
      };
    }

    if (spec.enabled === true
      && spec?.wakePolicy?.onBoot === true
      && !activeContract
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
