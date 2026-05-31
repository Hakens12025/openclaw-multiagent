import { normalizeString } from "../core/normalize.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { mutateContractSnapshot } from "../contracts.js";
import { removeDispatchContract } from "../routing/dispatch-runtime-state.js";
import { routeInbox } from "../../runtime-mailbox.js";
import { listSharedContractEntries } from "../store/contract-store.js";
import {
  buildInterruptedContractOutcome,
  matchesLoopSessionContract,
} from "./loop-contract-builder.js";

export async function cleanupInterruptedLoopContracts(activeSession, reason, logger) {
  if (!activeSession?.id) {
    return {
      matchedContracts: [],
      updatedContracts: [],
    };
  }

  const entries = await listSharedContractEntries();
  const matchedContracts = entries
    .filter((entry) => matchesLoopSessionContract(entry?.contract, activeSession.id))
    .map((entry) => ({
      contractId: entry.contract.id,
      assignee: entry.contract.assignee || null,
      path: entry.path,
    }));

  const interruptedStage = activeSession.currentStage || null;
  const terminalOutcome = buildInterruptedContractOutcome({
    reason,
    loopId: activeSession.loopId || activeSession.pipelineId || null,
    loopSessionId: activeSession.id,
    interruptedStage,
  });

  for (const entry of matchedContracts) {
    await mutateContractSnapshot(entry.path, logger, (contract) => {
      contract.status = CONTRACT_STATUS.CANCELLED;
      contract.terminalOutcome = terminalOutcome;
      contract.runtimeDiagnostics = {
        ...(contract.runtimeDiagnostics && typeof contract.runtimeDiagnostics === "object"
          ? contract.runtimeDiagnostics
          : {}),
        loopInterrupt: {
          reason: normalizeString(reason) || "manual_interrupt",
          loopId: activeSession.loopId || activeSession.pipelineId || null,
          loopSessionId: activeSession.id,
          interruptedStage,
          ts: Date.now(),
        },
      };
    });
    await removeDispatchContract(entry.contractId, logger);
    if (entry.assignee) {
      await routeInbox(entry.assignee, logger, {
        contractIdHint: entry.contractId,
        contractPathHint: entry.path,
      });
    }
  }

  return {
    matchedContracts,
    updatedContracts: matchedContracts.map((entry) => entry.contractId),
  };
}
