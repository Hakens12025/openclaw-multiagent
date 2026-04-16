import {
  getArtifactLaneDefinition,
  resolveArtifactStageDefinition as resolveArtifactLaneStageDefinition,
} from "./artifact-lane-registry.js";

function normalizeTrackingString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTrackingObject(value) {
  return value && typeof value === "object" ? value : null;
}

function normalizeArtifactProtocolEnvelope(protocol, kind) {
  const transport = normalizeTrackingString(protocol?.transport);
  if (transport) {
    return transport.endsWith(".json") ? transport.slice(0, -5) : transport;
  }
  return normalizeTrackingString(kind);
}

function resolveWorkItemKind({
  hasContract = false,
  artifactKind = null,
  explicitKind = null,
} = {}) {
  if (hasContract) return "contract_backed";
  if (normalizeTrackingString(artifactKind)) return "artifact_backed";
  const normalizedExplicitKind = normalizeTrackingString(explicitKind);
  if (normalizedExplicitKind === "contract_backed") return "contract_backed";
  if (normalizedExplicitKind === "artifact_backed") return "artifact_backed";
  return null;
}

function buildArtifactTask(artifactContext) {
  const instruction = normalizeTrackingString(artifactContext?.request?.instruction);
  const definition = getArtifactLaneDefinition(artifactContext?.kind);
  if (definition?.kind === "code_review") {
    return instruction ? `${definition.stageLabel}: ${instruction}` : definition.stageLabel;
  }
  return instruction || normalizeTrackingString(artifactContext?.kind) || "artifact";
}

function buildArtifactTaskType(artifactContext) {
  return normalizeTrackingString(artifactContext?.protocol?.intentType)
    || normalizeTrackingString(artifactContext?.protocol?.source)
    || normalizeTrackingString(artifactContext?.kind)
    || null;
}

export function buildArtifactWorkItemId(trackingState, artifactContext) {
  const kind = normalizeTrackingString(artifactContext?.kind) || "artifact";
  const sessionKey = normalizeTrackingString(trackingState?.sessionKey)
    || normalizeTrackingString(trackingState?.agentId)
    || "unknown";
  return `artifact:${kind}:${sessionKey}`;
}

export function resolveArtifactStageDefinition(artifactContext) {
  return resolveArtifactLaneStageDefinition(artifactContext);
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
      artifactKind: null,
      artifactDomain: null,
      artifactSource: null,
      artifactRequest: null,
    };
  }

  const artifactContext = normalizeTrackingObject(trackingState?.artifactContext);
  if (artifactContext) {
    const requestedAt = Number.isFinite(artifactContext?.request?.requestedAt)
      ? artifactContext.request.requestedAt
      : null;
    return {
      kind: resolveWorkItemKind({ artifactKind: artifactContext.kind }),
      id: buildArtifactWorkItemId(trackingState, artifactContext),
      hasContract: false,
      task: buildArtifactTask(artifactContext),
      taskType: buildArtifactTaskType(artifactContext),
      assignee: trackingState?.agentId || null,
      replyTo: artifactContext.replyTo || null,
      upstreamReplyTo: artifactContext.upstreamReplyTo || null,
      createdAt: requestedAt || trackingState?.startMs || null,
      updatedAt: null,
      protocol: artifactContext.protocol || null,
      protocolEnvelope: normalizeArtifactProtocolEnvelope(artifactContext.protocol, artifactContext.kind),
      coordination: artifactContext.coordination || null,
      returnContext: artifactContext.returnContext || null,
      serviceSession: artifactContext.serviceSession || null,
      operatorContext: artifactContext.operatorContext || null,
      followUp: null,
      systemActionDelivery: null,
      systemActionDeliveryTicket: artifactContext.systemActionDeliveryTicket || null,
      terminalOutcome: null,
      executionObservation: null,
      systemAction: null,
      runtimeDiagnostics: artifactContext.runtimeDiagnostics || null,
      artifactKind: artifactContext.kind || null,
      artifactDomain: normalizeTrackingString(artifactContext.domain),
      artifactSource: artifactContext.source || null,
      artifactRequest: artifactContext.request || null,
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
    artifactKind: null,
    artifactDomain: null,
    artifactSource: null,
    artifactRequest: null,
  };
}

export function resolveProgressWorkItem(entry) {
  const artifactKind = normalizeTrackingString(entry?.artifactKind);
  const kind = resolveWorkItemKind({
    hasContract: entry?.hasContract === true,
    artifactKind,
    explicitKind: entry?.workItemKind,
  });
  return {
    kind,
    id: normalizeTrackingString(entry?.workItemId)
      || normalizeTrackingString(entry?.contractId)
      || normalizeTrackingString(entry?.sessionKey),
    hasContract: entry?.hasContract === true,
    task: normalizeTrackingString(entry?.task),
    taskType: normalizeTrackingString(entry?.taskType),
    assignee: normalizeTrackingString(entry?.assignee) || normalizeTrackingString(entry?.agentId),
    replyTo: normalizeTrackingObject(entry?.replyTo),
    upstreamReplyTo: normalizeTrackingObject(entry?.upstreamReplyTo),
    createdAt: Number.isFinite(entry?.createdAt) ? entry.createdAt : null,
    updatedAt: Number.isFinite(entry?.updatedAt) ? entry.updatedAt : null,
    protocol: normalizeTrackingObject(entry?.protocol),
    protocolEnvelope: normalizeTrackingString(entry?.protocolEnvelope),
    coordination: normalizeTrackingObject(entry?.coordination),
    returnContext: normalizeTrackingObject(entry?.returnContext),
    serviceSession: normalizeTrackingObject(entry?.serviceSession),
    operatorContext: normalizeTrackingObject(entry?.operatorContext),
    followUp: normalizeTrackingObject(entry?.followUp),
    systemActionDelivery: normalizeTrackingObject(entry?.systemActionDelivery),
    systemActionDeliveryTicket: normalizeTrackingObject(entry?.systemActionDeliveryTicket),
    terminalOutcome: normalizeTrackingObject(entry?.terminalOutcome),
    executionObservation: normalizeTrackingObject(entry?.executionObservation),
    systemAction: normalizeTrackingObject(entry?.systemAction),
    runtimeDiagnostics: normalizeTrackingObject(entry?.runtimeDiagnostics),
    artifactKind,
    artifactDomain: normalizeTrackingString(entry?.artifactDomain),
    artifactSource: normalizeTrackingObject(entry?.artifactSource),
    artifactRequest: normalizeTrackingObject(entry?.artifactRequest),
  };
}
