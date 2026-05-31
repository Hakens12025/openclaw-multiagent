function normalizeHarnessScopeSegment(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveAgentEndHarnessAutomationId({
  agentId,
  contractStage,
} = {}) {
  const loopSessionId = normalizeHarnessScopeSegment(contractStage?.loopSessionId);
  if (loopSessionId) return `loop_session:${loopSessionId}`;

  const loopId = normalizeHarnessScopeSegment(contractStage?.loopId);
  if (loopId) return `loop:${loopId}`;

  const pipelineId = normalizeHarnessScopeSegment(contractStage?.pipelineId);
  if (pipelineId) return `loop:${pipelineId}`;

  return `agent_end:${normalizeHarnessScopeSegment(agentId) || "unknown"}`;
}
