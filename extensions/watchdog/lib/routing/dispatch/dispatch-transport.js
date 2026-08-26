// lib/dispatch-transport.js — Explicit runtime dispatch transport primitives
//
// Separates the two runtime-owned dispatch semantics:
// - direct envelope → write a concrete envelope into an agent inbox
// - shared contract → assign a shared contract, stage inbox, wake target
//
// Both paths share graph authorization + dispatch alert emission, but they are
// no longer hidden behind a mode-switching wrapper.

import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { apiRef } from "../../state.js";
import { canAutoWakeForTaskRuntime } from "../../agent/agent-activation-policy.js";
import { enqueueRuntimeDirectEnvelope } from "../runtime-direct-envelope-queue.js";
import { getContractPath, mutateContractSnapshot, persistContractById } from "../../contract/contracts.js";
import { wireContractCreated, wireDispatched } from "../../archive/run-event-wiring.js";
import { readContractSnapshotByPath } from "../../store/contract-store.js";
import { buildLifecycleStageTruth } from "../../stage/lifecycle-stage-truth.js";
import { hasDirectedEdge, loadGraph } from "../../agent/agent-graph.js";
import { getAgentIdentitySnapshot } from "../../agent/agent-identity.js";
import { normalizeWakeDiagnostic } from "../runtime-diagnostics.js";
import {
  buildRuntimeWakeReason,
  RUNTIME_WAKE_SEMANTICS,
  runtimeWakeAgentDetailed,
} from "../../transport/runtime-wake-transport.js";
import { routeInbox } from "../mailbox/runtime-mailbox.js";
import { buildAgentContractSessionKey } from "../../session/session-keys.js";
import { hasRuntimeGraphBypassAuthority } from "../runtime-authority.js";

// ── Graph authorization ─────────────────────────────────────────────────────

async function checkGraphAuthorization(from, to, logger, {
  runtimeAuthority = null,
} = {}) {
  if (hasRuntimeGraphBypassAuthority({ fromAgent: from, targetAgent: to, runtimeAuthority })) return true;
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
  isDirect = false,
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
  return buildRuntimeWakeReason(null, {
    wakeSemantic: isDirect
      ? RUNTIME_WAKE_SEMANTICS.DIRECT_REQUEST_RESUME
      : RUNTIME_WAKE_SEMANTICS.EXECUTION_CONTRACT,
    contractId: contract?.id || contractId || null,
    envelopeId: contract?.id || contractId || null,
  });
}

function resolveRuntimeWakeApi(api = null) {
  const candidate = api || apiRef || null;
  if (candidate?.runtime?.system && typeof candidate.runtime.system.requestHeartbeatNow === "function") {
    return candidate;
  }
  return null;
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

  const runtimeApi = resolveRuntimeWakeApi(api);
  if (!runtimeApi) {
    return normalizeWakeDiagnostic({
      ok: false,
      requested: false,
      reason: "missing_runtime_wake_transport",
      error: "dispatch requires runtime api or wakeupFunc",
    }, {
      lane: "runtime_dispatch",
      targetAgent,
    });
  }

  const reason = await buildWakeReason({
    buildWakeReason: wakeReasonBuilder,
    contract,
    contractId,
    targetAgent,
    wakePayload,
    isDirect,
  });
  const wakeOptions = wakePayload?.sessionKey
    ? { sessionKey: wakePayload.sessionKey }
    : {};
  if (isDirect) {
    wakeOptions.wakeSemantic = RUNTIME_WAKE_SEMANTICS.DIRECT_REQUEST_RESUME;
    wakeOptions.envelopeId = contract?.id || contractId || null;
  } else {
    wakeOptions.wakeSemantic = RUNTIME_WAKE_SEMANTICS.EXECUTION_CONTRACT;
    wakeOptions.contractId = contract?.id || contractId || null;
  }
  return runtimeWakeAgentDetailed(targetAgent, reason, runtimeApi, logger, wakeOptions);
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

function buildControlPlaneDispatchBlock({
  contractId = null,
  contract = null,
  targetAgent = null,
} = {}) {
  const blockReason = `ordinary task runtime cannot dispatch to ${targetAgent}`;
  return {
    ok: false,
    targetAgent,
    contractId: contract?.id || contractId || null,
    contract: contract || null,
    enqueueResult: null,
    wake: normalizeWakeDiagnostic({
      ok: false,
      requested: false,
      reason: "control_plane_activation_blocked",
      error: blockReason,
    }, {
      lane: "runtime_dispatch",
      targetAgent,
    }),
    blocked: true,
    blockReason,
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
  runtimeAuthority = null,
  skipWake = false,
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
  if (!canAutoWakeForTaskRuntime(getAgentIdentitySnapshot(targetAgent))) {
    return buildControlPlaneDispatchBlock({
      contract,
      targetAgent,
    });
  }

  const authorized = await checkGraphAuthorization(from, targetAgent, logger, { runtimeAuthority });
  if (!authorized) {
    return buildBlockedDispatchResult({
      contract,
      targetAgent,
      from,
    });
  }

  // 批② 信封落树:DIRECT 信封合约同样落树内共享正本(信封从此有家,备忘录142 §三)。
  // inbox 侧仍是传输载荷副本;泵的 contractSnapshot 兜底保留,但正本重读自动受益。
  // 正本写失败只 warn 不拦派发 —— 票据快照仍是投递兜底。
  try {
    await persistContractById(contract, logger);
  } catch (error) {
    logger?.warn?.(`[dispatch-transport] direct envelope canonical persist failed for ${contract.id}: ${error?.message || error}`);
  }
  // 事件接线(批② §八):信封工厂是同步纯函数无法落账,建约事件在此补记;
  // trigger="auto" — run 账面尚无事件(孤儿铸线)才落 run_triggered。
  void wireContractCreated({ contract, trigger: "auto", logger });

  const enqueueResult = await enqueueRuntimeDirectEnvelope({
    inboxDir,
    contract,
    agentId: targetAgent,
    logger,
  });
  void wireDispatched({ contract, from, to: targetAgent, logger });

  const wake = skipWake
    ? null
    : await requestDispatchWake({
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
    ok: wake?.ok !== false,
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
  runtimeAuthority = null,
  logger = null,
} = {}) {
  if (!targetAgent) {
    throw new Error("dispatchSendExecutionContract requires targetAgent");
  }
  if (!contractId) {
    throw new Error("dispatchSendExecutionContract requires contractId");
  }
  if (!canAutoWakeForTaskRuntime(getAgentIdentitySnapshot(targetAgent))) {
    return buildControlPlaneDispatchBlock({
      contractId,
      targetAgent,
    });
  }

  const authorized = await checkGraphAuthorization(from, targetAgent, logger, { runtimeAuthority });
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
    sessionKey: buildAgentContractSessionKey(targetAgent, contractId),
    contractIdHint: contractId,
    contractPathHint: contractPath,
  });
  // 事件接线(批② §八):合约已搬进目标 inbox = dispatched 时刻。fire-and-forget。
  void wireDispatched({ contract: resolvedContract, contractId, from, to: targetAgent, logger });

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
