// SSE event query helpers and checkpoint utilities for direct-service probes

export function summarizeEvent(evt) {
  return {
    type: evt.type,
    receivedAt: evt.receivedAt,
    data: {
      agentId: evt.data?.agentId ?? null,
      sessionKey: evt.data?.sessionKey ?? null,
      status: evt.data?.status ?? null,
      contractId: evt.data?.contractId ?? null,
      childContractId: evt.data?.childContractId ?? null,
      targetAgent: evt.data?.targetAgent ?? null,
      source: evt.data?.source ?? null,
      alertType: evt.data?.type ?? null,
      task: evt.data?.task ?? null,
      verdict: evt.data?.verdict ?? null,
      artifactCount: evt.data?.artifactCount ?? null,
      delegatedContractId: evt.data?.delegatedContractId ?? null,
    },
  };
}

export function findTrackStart(events, {
  agentId,
  afterMs = 0,
  sessionKey = null,
  hookOnly = false,
}) {
  return events.find((evt) => (
    evt.type === "track_start"
    && evt.receivedAt >= afterMs
    && evt.data?.agentId === agentId
    && typeof evt.data?.sessionKey === "string"
    && (!sessionKey || evt.data.sessionKey === sessionKey)
    && (!hookOnly || evt.data.sessionKey.includes(":hook:"))
  )) || null;
}

export function findTrackEnd(events, {
  agentId,
  sessionKey,
  afterMs = 0,
}) {
  return events.find((evt) => (
    evt.type === "track_end"
    && evt.receivedAt >= afterMs
    && evt.data?.agentId === agentId
    && evt.data?.sessionKey === sessionKey
  )) || null;
}

export function findAlert(events, {
  type,
  afterMs = 0,
  source = null,
  targetAgent = null,
}) {
  return events.find((evt) => (
    evt.type === "alert"
    && evt.receivedAt >= afterMs
    && evt.data?.type === type
    && (!source || evt.data?.source === source)
    && (!targetAgent || evt.data?.targetAgent === targetAgent)
  )) || null;
}

export function interestingEvents(events, topology = null) {
  const trackedAgentIds = new Set([
    topology?.callerAgentId,
    topology?.delegateAgentId,
    topology?.reviewerAgentId,
  ].filter(Boolean));
  return events
    .filter((evt) => (
      (evt.type === "track_start" || evt.type === "track_end")
      && trackedAgentIds.has(evt.data?.agentId)
    ) || (
      evt.type === "alert"
      && [
        "agent_task_assigned",
        "system_action_assign_task_result_delivered",
        "code_review_requested",
        "system_action_runtime_result_delivered",
        "system_action_review_verdict_delivered",
        "runtime_wake_failed",
      ].includes(evt.data?.type)
    ))
    .map(summarizeEvent);
}

export function makeCheckpoint(results, {
  id,
  name,
  status,
  elapsed,
  detail = null,
  errorCode = null,
}) {
  const entry = { id, name, status, elapsed };
  if (detail) entry.detail = detail;
  if (errorCode) entry.errorCode = errorCode;
  results.push(entry);
}

export function buildStepIds(config) {
  const steps = ["reset"];
  if (config.beforeWakeLabel) steps.push("beforeWake");
  steps.push("wake", "firstStart");
  if (config.intermediateStepName) steps.push("intermediate");
  steps.push("firstEnd", "bridge", "resume", "resumeEnd", "bridgeContractTerminal");
  return Object.fromEntries(steps.map((step, index) => [step, index + 1]));
}
