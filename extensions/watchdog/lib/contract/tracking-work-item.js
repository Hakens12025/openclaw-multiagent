function normalizeTrackingString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTrackingObject(value) {
  return value && typeof value === "object" ? value : null;
}

function resolveWorkItemKind({
  hasContract = false,
  explicitKind = null,
} = {}) {
  if (hasContract) return "contract_backed";
  const normalizedExplicitKind = normalizeTrackingString(explicitKind);
  if (normalizedExplicitKind === "contract_backed") return "contract_backed";
  return null;
}

export function resolveTrackingWorkItem(trackingState) {
  const contract = normalizeTrackingObject(trackingState?.contract);
  if (contract) {
    return {
      kind: resolveWorkItemKind({ hasContract: true }),
      id: normalizeTrackingString(contract.id) || normalizeTrackingString(trackingState?.sessionKey),
      hasContract: true,
      task: contract.task || null,
      taskType: contract.taskType || null,
      assignee: contract.assignee || trackingState?.agentId || null,
      replyTo: contract.replyTo || null,
      upstreamReplyTo: contract.upstreamReplyTo || null,
      createdAt: contract.createdAt || trackingState?.startMs || null,
      updatedAt: contract.updatedAt || null,
      protocol: contract.protocol || null,
      protocolEnvelope: null,
      coordination: contract.coordination || null,
      returnContext: contract.returnContext || null,
      serviceSession: contract.serviceSession || null,
      operatorContext: contract.operatorContext || null,
      followUp: contract.followUp || null,
      systemActionDelivery: contract.systemActionDelivery || null,
      systemActionDeliveryTicket: contract.systemActionDeliveryTicket || null,
      terminalOutcome: contract.terminalOutcome || null,
      executionObservation: contract.executionObservation || null,
      systemAction: contract.systemAction || null,
      runtimeDiagnostics: contract.runtimeDiagnostics || null,
      ioObservation: trackingState?.ioObservation || contract?.runtimeDiagnostics?.ioObservation || null,
    };
  }

  return {
    kind: null,
    id: normalizeTrackingString(trackingState?.sessionKey),
    hasContract: false,
    task: null,
    taskType: null,
    assignee: trackingState?.agentId || null,
    replyTo: null,
    upstreamReplyTo: null,
    createdAt: trackingState?.startMs || null,
    updatedAt: null,
    protocol: null,
    protocolEnvelope: null,
    coordination: null,
    returnContext: null,
    serviceSession: null,
    operatorContext: null,
    followUp: null,
    systemActionDelivery: null,
    systemActionDeliveryTicket: null,
    terminalOutcome: null,
    executionObservation: null,
    systemAction: null,
    runtimeDiagnostics: null,
  };
}
