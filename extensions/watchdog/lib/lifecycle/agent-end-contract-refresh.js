import { readContractSnapshotByPath } from "../contracts.js";
import { getErrorMessage } from "../core/normalize.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";

async function readTrackingContractSnapshot(trackingState, {
  agentId,
  sessionKey,
  logger,
  preferCache = true,
}) {
  const contractPath = trackingState?.contract?.path;
  if (!contractPath) {
    return { contractData: null, diagnostic: null };
  }

  try {
    const contractData = await readContractSnapshotByPath(contractPath, { preferCache });
    if (!contractData) {
      throw new Error("contract snapshot missing");
    }
    return { contractData, diagnostic: null };
  } catch (error) {
    const message = getErrorMessage(error);
    const diagnostic = {
      lane: "contract_read",
      contractPath,
      error: message,
      recoveredFromTrackingState: Boolean(trackingState?.contract),
      ts: Date.now(),
    };

    logger.warn(
      `[watchdog] failed to read tracking contract for ${sessionKey}: `
      + `${contractPath} (${message})`
      + `${trackingState?.contract ? " — falling back to in-memory tracking contract" : ""}`,
    );
    broadcast("alert", {
      type: EVENT_TYPE.RUNTIME_CONTRACT_READ_FAILED,
      agentId,
      sessionKey,
      contractId: trackingState?.contract?.id || null,
      contractPath,
      error: message,
      ts: diagnostic.ts,
    });

    return {
      contractData: trackingState?.contract || null,
      diagnostic,
    };
  }
}

export async function refreshEffectiveContractDataAfterTransport(context) {
  if (!context?.trackingState?.contract?.path) {
    return context?.effectiveContractData || context?.contractData || null;
  }

  const snapshot = await readTrackingContractSnapshot(context.trackingState, {
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    logger: context.logger,
    preferCache: false,
  });

  if (snapshot.contractData) {
    context.contractData = snapshot.contractData;
    context.effectiveContractData = snapshot.contractData;
  }
  if (snapshot.diagnostic) {
    context.contractReadDiagnostic = snapshot.diagnostic;
  }

  return context.effectiveContractData || null;
}

export function mergeRuntimeDiagnostics(existingDiagnostics, nextDiagnostics) {
  return {
    ...(existingDiagnostics && typeof existingDiagnostics === "object" ? existingDiagnostics : {}),
    ...(nextDiagnostics && typeof nextDiagnostics === "object" ? nextDiagnostics : {}),
  };
}

export { readTrackingContractSnapshot };
