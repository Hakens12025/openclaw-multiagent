import { isBridgeAgent } from "./agent/agent-identity.js";
import { normalizeRecord, normalizeString } from "./core/normalize.js";

export function normalizeReplyTarget(target) {
  const value = normalizeRecord(target, null);
  if (!value) return null;

  const agentId = normalizeString(value.agentId);
  const sessionKey = normalizeString(value.sessionKey);
  const channel = normalizeString(value.channel);
  const output = {
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(channel ? { channel } : {}),
  };

  for (const key of ["target", "kind", "runId"]) {
    const normalized = normalizeString(value[key]);
    if (normalized) output[key] = normalized;
  }

  return Object.keys(output).length > 0 ? output : null;
}

export function normalizeReturnContext(context) {
  const value = normalizeRecord(context, null);
  if (!value) return null;

  const output = {};
  for (const key of ["sourceAgentId", "sourceContractId", "sourceSessionKey", "intentType"]) {
    const normalized = normalizeString(value[key]);
    if (normalized) output[key] = normalized;
  }

  return Object.keys(output).length > 0 ? output : null;
}

export function isAgentReplyTarget(replyTo) {
  const normalized = normalizeReplyTarget(replyTo);
  return Boolean(normalized?.agentId && !isBridgeAgent(normalized.agentId));
}

export function hasDistinctUpstreamReply(replyTo, upstreamReplyTo) {
  const current = normalizeReplyTarget(replyTo);
  const upstream = normalizeReplyTarget(upstreamReplyTo);
  return Boolean(
    current?.agentId
    && upstream?.agentId
    && upstream.agentId !== current.agentId,
  );
}

export function hasResumableSourceSession(replyTo, returnContext) {
  const current = normalizeReplyTarget(replyTo);
  const normalizedReturnContext = normalizeReturnContext(returnContext);
  return Boolean(
    current?.agentId
    && current?.sessionKey
    && normalizedReturnContext?.sourceSessionKey
    && normalizedReturnContext.sourceSessionKey === current.sessionKey,
  );
}

export function shouldUseSystemActionDelivery({
  currentAgentId,
  replyTo,
  upstreamReplyTo,
  returnContext = null,
  canReceiveSystemActionDelivery = null,
}) {
  const current = normalizeReplyTarget(replyTo);
  const normalizedAgentId = normalizeString(currentAgentId);
  if (!normalizedAgentId || current?.agentId !== normalizedAgentId) {
    return false;
  }
  if (!hasDistinctUpstreamReply(current, upstreamReplyTo) && !hasResumableSourceSession(current, returnContext)) {
    return false;
  }
  if (typeof canReceiveSystemActionDelivery === "function") {
    return canReceiveSystemActionDelivery(normalizedAgentId) === true;
  }
  return true;
}

export function buildCoordinationSnapshot({
  ownerAgentId = null,
  replyTo = null,
  upstreamReplyTo = null,
  returnContext = null,
  intentType = null,
} = {}) {
  const normalizedReplyTo = normalizeReplyTarget(replyTo);
  const normalizedUpstreamReplyTo = normalizeReplyTarget(upstreamReplyTo);
  const normalizedReturnContext = normalizeReturnContext(returnContext);

  const callerAgentId = normalizedReturnContext?.sourceAgentId || normalizedReplyTo?.agentId || null;
  const callerSessionKey = normalizedReturnContext?.sourceSessionKey
    || (callerAgentId && callerAgentId === normalizedReplyTo?.agentId
      ? normalizedReplyTo.sessionKey || null
      : null);
  const returnMode = hasDistinctUpstreamReply(normalizedReplyTo, normalizedUpstreamReplyTo)
    ? "delivery"
    : normalizedReplyTo?.agentId
      ? "direct_delivery"
      : "none";

  return {
    owner: normalizeString(ownerAgentId) ? { agentId: normalizeString(ownerAgentId) } : null,
    caller: callerAgentId
      ? {
          agentId: callerAgentId,
          ...(callerSessionKey ? { sessionKey: callerSessionKey } : {}),
        }
      : null,
    replyTo: normalizedReplyTo,
    upstreamReplyTo: normalizedUpstreamReplyTo,
    return: {
      mode: returnMode,
      intentType: normalizedReturnContext?.intentType || normalizeString(intentType) || null,
      sourceAgentId: normalizedReturnContext?.sourceAgentId || null,
      sourceContractId: normalizedReturnContext?.sourceContractId || null,
    },
  };
}

export function annotateCoordinationSnapshot(payload, {
  ownerAgentId = null,
  intentType = null,
} = {}) {
  const value = normalizeRecord(payload);
  if (!value) return payload;

  return {
    ...value,
    coordination: buildCoordinationSnapshot({
      ownerAgentId: ownerAgentId || value.assignee || value.agentId || null,
      replyTo: value.replyTo,
      upstreamReplyTo: value.upstreamReplyTo,
      returnContext: value.returnContext,
      intentType,
    }),
  };
}
