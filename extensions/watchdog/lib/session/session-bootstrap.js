// lib/session/session-bootstrap.js — before_agent_start tracker/bootstrap helpers
// Implementation split into:
//   session-tracking-state.js  (createTrackingState, refreshTrackingInputIoObservation, toTrackingContract)
//   session-contract-binding.js (bindPendingWorkerContract, bindDirectInboxEnvelope, bindInboxContractEnvelope)

import { AGENT_ROLE, getAgentIdentitySnapshot } from "../agent/agent-identity.js";
import { getQQTarget, qqNotify, qqTypingStart, hasQQPassiveReplyTarget } from "../transport/channel-notify.js";

export {
  createTrackingState,
  refreshTrackingInputIoObservation,
  toTrackingContract,
} from "./session-tracking-state.js";

export {
  bindPendingWorkerContract,
  bindDirectInboxEnvelope,
  bindInboxContractEnvelope,
} from "./session-contract-binding.js";

function trimSingleLine(value, limit = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

export function buildDispatchTargetClaimMessage(agentId, contract) {
  const normalizedAgentId = trimSingleLine(agentId, 40) || "agent";
  const contractId = trimSingleLine(contract?.id, 64) || "unknown contract";
  const title = trimSingleLine(contract?.task || contract?.title || contract?.objective, 72);
  return [
    `🔧 ${normalizedAgentId} 开始处理 ${contractId}`,
    title ? `标题：${title}` : null,
  ].filter(Boolean).join("\n");
}

function notifyDispatchTargetClaim(agentId, contract) {
  const identity = getAgentIdentitySnapshot(agentId);
  if (identity.role !== AGENT_ROLE.EXECUTOR) {
    return;
  }

  const qqTarget = getQQTarget(contract);
  if (!qqTarget) {
    return;
  }
  if (hasQQPassiveReplyTarget(qqTarget)) {
    return;
  }

  void qqNotify(qqTarget, buildDispatchTargetClaimMessage(agentId, contract));
  qqTypingStart(contract.id, qqTarget);
}
