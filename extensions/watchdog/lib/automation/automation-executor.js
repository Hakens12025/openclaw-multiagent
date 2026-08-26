import {
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
  clearPendingSignal,
} from "../runtime/pending-signal-registry.js";
import { listAutomationSpecs } from "./automation-registry.js";
import { ensureAutomationRuntimeState } from "./automation-runtime.js";
import { ensureRuntimeContext } from "./automation-round-context.js";
import { startAutomationRound } from "./automation-start.js";

// Re-export public API so callers don't need to change their imports
export { startAutomationRound } from "./automation-start.js";
export { handleAutomationContractTerminal } from "./automation-finalize.js";
export { reconcileAutomationRuntimeStates } from "./automation-reconcile.js";

export async function pollDueAutomations({
  api,
  logger,
  onAlert,
  limit = 4,
} = {}) {
  ensureRuntimeContext({ api });

  const specs = await listAutomationSpecs({ enabled: true });
  const now = Date.now();
  const results = [];

  for (const spec of specs) {
    if (results.length >= limit) break;
    const runtime = await ensureAutomationRuntimeState(spec);
    if (runtime?.status !== "idle") continue;
    if (!Number.isFinite(runtime?.nextWakeAt) || runtime.nextWakeAt > now) continue;
    const targetAgentId = spec?.targetAgentId || spec?.assignee || null;
    if (targetAgentId) {
      registerPendingSignal({
        agentId: targetAgentId,
        sourceKind: PENDING_SIGNAL_KINDS.AUTOMATION_DUE,
        sourceRef: spec.id,
      });
    }
    try {
      results.push(await startAutomationRound(spec.id, {
        trigger: "due_poll",
        api,
        logger,
        onAlert,
      }));
    } finally {
      if (targetAgentId) {
        clearPendingSignal({
          agentId: targetAgentId,
          sourceKind: PENDING_SIGNAL_KINDS.AUTOMATION_DUE,
          sourceRef: spec.id,
        });
      }
    }
  }

  return {
    ok: true,
    due: results.length,
    results,
  };
}
