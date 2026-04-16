// lib/dispatch-transport.js — Explicit runtime dispatch transport primitives
//
// Separates the two runtime-owned dispatch semantics:
// - direct envelope → write a concrete envelope into an agent inbox
// - shared contract → assign a shared contract, stage inbox, wake target
//
// Both paths share graph authorization + dispatch alert emission, but they are
// no longer hidden behind a mode-switching wrapper.

import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { enqueueRuntimeDirectEnvelope } from "../runtime-direct-envelope-queue.js";
import { getContractPath, mutateContractSnapshot } from "../contracts.js";
import { readContractSnapshotByPath } from "../store/contract-store.js";
import { buildLifecycleStageTruth } from "../lifecycle-stage-truth.js";
import { hasDirectedEdge, loadGraph } from "../agent/agent-graph.js";
import { isBridgeAgent } from "../agent/agent-identity.js";
import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";
import { SYSTEM_ACTION_DELIVERY_IDS } from "./delivery-protocols.js";
import { routeInbox } from "../../runtime-mailbox.js";

// ── Graph authorization ─────────────────────────────────────────────────────

const EXEMPT_SOURCES = new Set([
  null, undefined, "", "system", "worker-runtime", "pipeline-engine",
  // Unified system_action delivery lanes are runtime-owned return paths.
  SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
  SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
  SYSTEM_ACTION_DELIVERY_IDS.CONTRACT_RESULT,
  "system_action.assign_task",
]);

async function checkGraphAuthorization(from, to, logger) {
  if (EXEMPT_SOURCES.has(from) || isBridgeAgent(from)) return true;
  try {
    const graph = await loadGraph();
    if (hasDirectedEdge(graph, from, to)) return true;
    logger?.warn?.(`[dispatch] blocked: no edge ${from} -> ${to}`);
    return false;
  } catch (err) {
    logger?.error?.(`[dispatch] graph authorization failed (from=${from}, to=${to}): ${err?.message || err}`);
    return false;
  }
}

// ── Dispatch alert normalization ────────────────────────────────────────────

function normalizeDispatchAlert({
  contract,
  from = null,
  targetAgent = null,
  dispatchAlert = null,
} = {}) {
  const extras = dispatchAlert && typeof dispatchAlert === "object"
    ? dispatchAlert
    : {};
  const stageTruth = buildLifecycleStageTruth(contract);
  return {
    ...extras,
    type: EVENT_TYPE.INBOX_DISPATCH,
    contractId: contract?.id || null,
    task: typeof contract?.task === "string" ? contract.task.slice(0, 100) : "",
    from,
    assignee: targetAgent,
    protocolEnvelope: contract?.protocol?.envelope || null,
    ...stageTruth,
    ts: extras.ts || Date.now(),
  };
}

async function buildWakeReason({
  buildWakeReason = null,
  contract = null,
  contractId = null,
  targetAgent = null,
  wakePayload = null,
} = {}) {
  if (typeof buildWakeReason === "function") {
    const message = await buildWakeReason({
      contract,
      contractId: contract?.id || contractId || null,
      targetAgent,
      wakePayload,
    });
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  if (typeof wakePayload?.message === "string" && wakePayload.message.trim()) {
    return wakePayload.message.trim();
  }
  if (typeof wakePayload?.reason === "string" && wakePayload.reason.trim()) {
    return wakePayload.reason.trim();
  }
  return "唤醒: 请读取 inbox/ 中的文件并执行任务";
}

async function requestDispatchWake({
  targetAgent = null,
  contractId = null,
  contract = null,
  wakeupFunc = null,
  wakePayload = null,
  api = null,
  buildWakeReason: wakeReasonBuilder = null,
  isDirect = false,
  enqueueResult = null,
  logger = null,
} = {}) {
  if (isDirect && enqueueResult?.promoted !== true) {
    return null;
  }

  if (typeof wakeupFunc === "function") {
    return wakeupFunc(targetAgent, wakePayload || {});
  }

  if (!api) {
    return null;
  }

  const reason = await buildWakeReason({
    buildWakeReason: wakeReasonBuilder,
    contract,
    contractId,
    targetAgent,
    wakePayload,
  });
  const wakeOptions = wakePayload?.sessionKey
    ? { sessionKey: wakePayload.sessionKey }
    : {};
  return runtimeWakeAgentDetailed(targetAgent, reason, api, logger, wakeOptions);
}

function buildBlockedDispatchResult({
  contractId = null,
  contract = null,
  targetAgent = null,
  from = null,
} = {}) {
  return {
    ok: false,
    targetAgent,
    contractId: contract?.id || contractId || null,
    contract: contract || null,
    enqueueResult: null,
    wake: null,
    blocked: true,
    blockReason: `no graph edge from ${from} to ${targetAgent}`,
  };
}

function buildDispatchResult({
  ok = true,
  targetAgent = null,
  contractId = null,
  contract = null,
  enqueueResult = null,
  wake = null,
} = {}) {
  return {
    ok,
    targetAgent,
    contractId: contract?.id || contractId || null,
    contract: contract || null,
    enqueueResult,
    wake,
    blocked: false,
    blockReason: null,
  };
}

function resolveSharedContractSnapshot({
  mutation = null,
  contractId = null,
  targetAgent = null,
} = {}) {
  if (mutation?.contract?.id) {
    return mutation.contract;
  }
  if (!contractId) {
    return null;
  }
  return {
    id: contractId,
    assignee: targetAgent,
    task: "",
    protocol: null,
  };
}

// ── Direct envelope dispatch ────────────────────────────────────────────────

export async function dispatchSendDirectRequest({
  contract = null,
  inboxDir = null,
  targetAgent = null,
  from = null,
  wakeupFunc = null,
  wakePayload = null,
  api = null,
  buildWakeReason = null,
  broadcastDispatch = true,
  dispatchAlert = null,
  logger = null,
} = {}) {
  if (!targetAgent) {
    throw new Error("dispatchSendDirectRequest requires targetAgent");
  }
  if (!contract?.id) {
    throw new Error("dispatchSendDirectRequest requires contract.id");
  }
  if (!inboxDir) {
    throw new Error("dispatchSendDirectRequest requires inboxDir");
  }

  const authorized = await checkGraphAuthorization(from, targetAgent, logger);
  if (!authorized) {
    return buildBlockedDispatchResult({
      contract,
      targetAgent,
      from,
    });
  }

  const enqueueResult = await enqueueRuntimeDirectEnvelope({
    inboxDir,
    contract,
    agentId: targetAgent,
    logger,
  });

  const wake = await requestDispatchWake({
    targetAgent,
    contractId: contract.id,
    contract,
    wakeupFunc,
    wakePayload,
    api,
    buildWakeReason,
    isDirect: true,
    enqueueResult,
    logger,
  });

  if (broadcastDispatch !== false) {
    broadcast("alert", normalizeDispatchAlert({
      contract,
      from,
      targetAgent,
      dispatchAlert,
    }));
  }

  return buildDispatchResult({
    ok: true,
    targetAgent,
    contractId: contract.id,
    contract,
    enqueueResult,
    wake,
  });
}

// ── Shared contract dispatch ────────────────────────────────────────────────

export async function dispatchSendExecutionContract({
  contractId = null,
  contractPathHint = null,
  updateContract = null,
  targetAgent = null,
  from = null,
  wakeupFunc = null,
  wakePayload = null,
  api = null,
  buildWakeReason = null,
  broadcastDispatch = true,
  dispatchAlert = null,
  logger = null,
} = {}) {
  if (!targetAgent) {
    throw new Error("dispatchSendExecutionContract requires targetAgent");
  }
  if (!contractId) {
    throw new Error("dispatchSendExecutionContract requires contractId");
  }

  const authorized = await checkGraphAuthorization(from, targetAgent, logger);
  if (!authorized) {
    return buildBlockedDispatchResult({
      contractId,
      targetAgent,
      from,
    });
  }

  const contractPath = contractPathHint || getContractPath(contractId);
  const mutation = typeof updateContract === "function"
    ? await mutateContractSnapshot(
        contractPath,
        logger,
        updateContract,
        { touchUpdatedAt: true },
      )
    : null;
  const resolvedContract = mutation?.contract?.id
    ? mutation.contract
    : typeof updateContract === "function"
      ? resolveSharedContractSnapshot({ mutation, contractId, targetAgent })
      : await readContractSnapshotByPath(contractPath, { preferCache: false });

  if (!resolvedContract?.id) {
    throw new Error(`dispatchSendExecutionContract missing contract snapshot: ${contractPath}`);
  }

  await routeInbox(targetAgent, logger, {
    contractIdHint: contractId,
    contractPathHint: contractPath,
  });

  const wake = await requestDispatchWake({
    targetAgent,
    contractId,
    contract: resolvedContract,
    wakeupFunc,
    wakePayload,
    api,
    buildWakeReason,
    logger,
  });

  if (broadcastDispatch !== false && wake?.ok !== false) {
    broadcast("alert", normalizeDispatchAlert({
      contract: resolvedContract,
      from,
      targetAgent,
      dispatchAlert,
    }));
  }

  return buildDispatchResult({
    ok: wake?.ok !== false,
    targetAgent,
    contractId,
    contract: resolvedContract,
    enqueueResult: null,
    wake,
  });
}
