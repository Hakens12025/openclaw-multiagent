import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  annotateCoordinationSnapshot,
  normalizeReplyTarget,
  normalizeReturnContext,
} from "./coordination-primitives.js";
import { normalizeRecord, normalizeString } from "./core/normalize.js";
import { CONTRACT_STATUS } from "./core/runtime-status.js";
import { normalizeServiceSession } from "./service-session.js";
import {
  buildInitialTaskStageRuntime,
  deriveDisplayPhases,
  deriveDisplayTotal,
} from "./task-stage-plan.js";
import { buildTaskStagePlanFromTask } from "./task-stage-planner.js";

export const PROTOCOL_VERSION = 1;
export const RUNTIME_RESULT_FILE = "runtime_result.json";

const ENVELOPE_TYPES = Object.freeze({
  DIRECT_REQUEST: "direct_request",
  EXECUTION_CONTRACT: "execution_contract",
  WORKFLOW_SIGNAL: "workflow_signal",
});

export const INTENT_TYPES = Object.freeze({
  RESUME_FINALIZATION: "resume_finalization",
  WAKE_AGENT: "wake_agent",
  CREATE_TASK: "create_task",
  REQUEST_REVIEW: "request_review",
  ASSIGN_TASK: "assign_task",
  START_LOOP: "start_loop",
  ADVANCE_LOOP: "advance_loop",
});

export const ARTIFACT_TYPES = Object.freeze({
  RUNTIME_RESULT: "runtime_result",
  CONTRACT_UPDATE: "contract_update",
  RESEARCH_DIRECTION: "research_direction",
  RESEARCH_CONCLUSION: "research_conclusion",
  SEARCH_SPACE: "search_space",
  WORKFLOW_CONCLUSION: "workflow_conclusion",
  TEXT_OUTPUT: "text_output",
  DELIVERY: "delivery",
  CLARIFICATION_REQUEST: "clarification_request",
  EVALUATION_VERDICT: "evaluation_verdict",
  WORKFLOW_DECISION: "workflow_decision",
  NOTES: "notes",
});

export const OUTBOX_COMMIT_KINDS = Object.freeze({
  EXECUTION_RESULT: "execution_result",
});

const DEFAULT_RUNTIME_TIME_ZONE = "Asia/Shanghai";

function resolveRuntimeTimeZone(explicitTimeZone = null) {
  return normalizeString(explicitTimeZone)
    || normalizeString(process.env.OPENCLAW_RUNTIME_TIME_ZONE)
    || normalizeString(Intl.DateTimeFormat().resolvedOptions().timeZone)
    || DEFAULT_RUNTIME_TIME_ZONE;
}

function formatRuntimeCurrentTime(unixMs, timeZone) {
  const instant = new Date(unixMs);
  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(instant);
  const weekdayZh = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    weekday: "long",
  }).format(instant);
  const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const time = `${dateParts.hour}:${dateParts.minute}:${dateParts.second}`;

  return {
    unixMs,
    iso: instant.toISOString(),
    timeZone,
    date,
    time,
    weekday,
    weekdayZh,
    text: `Current time: ${date} ${time} ${timeZone} (${weekday} / ${weekdayZh}).`,
  };
}

export function buildRuntimeContext({ now = Date.now(), timeZone = null } = {}) {
  const unixMs = Number.isFinite(now) ? Number(now) : Date.now();
  const resolvedTimeZone = resolveRuntimeTimeZone(timeZone);
  let currentTime;
  try {
    currentTime = formatRuntimeCurrentTime(unixMs, resolvedTimeZone);
  } catch {
    currentTime = formatRuntimeCurrentTime(unixMs, DEFAULT_RUNTIME_TIME_ZONE);
  }

  return {
    version: PROTOCOL_VERSION,
    currentTime,
  };
}

function normalizeIngressPhaseEntry(entry) {
  if (typeof entry === "string" && entry.trim()) {
    return entry.trim();
  }
  if (entry && typeof entry === "object" && typeof entry.name === "string" && entry.name.trim()) {
    return {
      ...entry,
      name: entry.name.trim(),
      ...(typeof entry.description === "string" && entry.description.trim()
        ? { description: entry.description.trim() }
        : {}),
    };
  }
  return null;
}

function normalizeIngressPhases(entries) {
  if (!Array.isArray(entries)) return null;
  const phases = entries.map(normalizeIngressPhaseEntry).filter(Boolean);
  return phases.length > 0 ? phases : null;
}

export function normalizeIngressDirective(rawDirective) {
  const directive = normalizeRecord(rawDirective, null);
  if (!directive) {
    return {
      targetAgent: null,
      intentType: null,
      phases: null,
    };
  }

  const intent = normalizeRecord(directive.intent);
  const params = normalizeRecord(directive.params);

  const targetAgent = normalizeString(directive.targetAgent)
    || normalizeString(directive.target)
    || normalizeString(params.targetAgent)
    || normalizeString(params.target)
    || normalizeString(intent.params?.targetAgent)
    || normalizeString(intent.params?.target)
    || null;

  const intentType = normalizeString(directive.intentType)
    || normalizeString(intent.type)
    || normalizeString(params.intentType)
    || normalizeString(params.type)
    || null;

  const phases = normalizeIngressPhases(directive.phases)
    || normalizeIngressPhases(params.phases)
    || normalizeIngressPhases(intent.params?.phases)
    || null;

  return {
    targetAgent,
    intentType,
    phases,
  };
}

function annotateEnvelope(payload, {
  envelopeType,
  transport,
  source,
} = {}) {
  const currentProtocol = normalizeRecord(payload?.protocol);
  return {
    ...payload,
    protocol: {
      version: currentProtocol.version || PROTOCOL_VERSION,
      envelope: normalizeString(currentProtocol.envelope) || envelopeType || null,
      transport: normalizeString(currentProtocol.transport) || transport || null,
      ...(normalizeString(currentProtocol.source) || source
        ? { source: normalizeString(currentProtocol.source) || source }
        : {}),
    },
  };
}

export function createDirectRequestEnvelope({
  agentId,
  sessionKey,
  replyTo,
  upstreamReplyTo = null,
  returnContext = null,
  serviceSession = null,
  defaultReplyToSelf = true,
  message,
  stagePlan = null,
  phases = null,
  revisionPolicy = null,
  outputDir,
  source = "direct_intake",
  now = Date.now(),
  timeZone = null,
  nonce = randomBytes(3).toString("hex"),
}) {
  const normalizedAgentId = normalizeString(agentId);
  const normalizedSessionKey = normalizeString(sessionKey);
  const normalizedMessage = typeof message === "string" ? message.trim() : null;
  const normalizedOutputDir = normalizeString(outputDir);
  const normalizedSource = normalizeString(source) || "direct_intake";
  if (!normalizedAgentId) {
    throw new TypeError("createDirectRequestEnvelope requires agentId");
  }
  if (!normalizedSessionKey) {
    throw new TypeError("createDirectRequestEnvelope requires sessionKey");
  }
  if (!normalizedMessage) {
    throw new TypeError("createDirectRequestEnvelope requires message");
  }
  if (!normalizedOutputDir) {
    throw new TypeError("createDirectRequestEnvelope requires outputDir");
  }

  const directId = `DIRECT-${now}-${nonce}`;
  const normalizedReplyTo = replyTo === undefined
    ? (defaultReplyToSelf ? { agentId: normalizedAgentId, sessionKey: normalizedSessionKey } : null)
    : normalizeReplyTarget(replyTo);
  const normalizedUpstreamReplyTo = normalizeReplyTarget(upstreamReplyTo);
  const normalizedReturn = normalizeReturnContext(returnContext);
  const normalizedServiceSession = normalizeServiceSession(serviceSession);
  const canonicalStagePlan = buildTaskStagePlanFromTask({
    contractId: directId,
    task: normalizedMessage,
    stagePlan,
    phases,
    revisionPolicy,
  });
  const stageRuntime = canonicalStagePlan
    ? buildInitialTaskStageRuntime({ stagePlan: canonicalStagePlan })
    : null;
  const displayPhases = canonicalStagePlan ? deriveDisplayPhases(canonicalStagePlan) : null;
  const displayTotal = canonicalStagePlan ? deriveDisplayTotal(canonicalStagePlan) : null;
  const envelope = annotateEnvelope({
    id: directId,
    taskType: ENVELOPE_TYPES.DIRECT_REQUEST,
    task: normalizedMessage,
    assignee: normalizedAgentId,
    ...(normalizedReplyTo ? { replyTo: normalizedReplyTo } : {}),
    ...(normalizedUpstreamReplyTo ? { upstreamReplyTo: normalizedUpstreamReplyTo } : {}),
    ...(normalizedReturn ? { returnContext: normalizedReturn } : {}),
    ...(normalizedServiceSession ? { serviceSession: normalizedServiceSession } : {}),
    ...(canonicalStagePlan ? { stagePlan: canonicalStagePlan } : {}),
    ...(stageRuntime ? { stageRuntime } : {}),
    ...(displayPhases ? { phases: displayPhases } : {}),
    ...(displayTotal != null ? { total: displayTotal } : {}),
    runtimeContext: buildRuntimeContext({ now, timeZone }),
    output: join(normalizedOutputDir, `${directId}.md`),
    projectDir: join(normalizedOutputDir, directId),
    status: CONTRACT_STATUS.RUNNING,
    createdAt: now,
  }, {
    envelopeType: ENVELOPE_TYPES.DIRECT_REQUEST,
    transport: "contract.json",
    source: normalizedSource,
  });
  return annotateCoordinationSnapshot(envelope, {
    ownerAgentId: normalizedAgentId,
    intentType: normalizedSource,
  });
}

export function annotateExecutionContract(contract, { source } = {}) {
  const envelope = annotateEnvelope(contract, {
    envelopeType: ENVELOPE_TYPES.EXECUTION_CONTRACT,
    transport: "contracts/*.json",
    source,
  });
  return annotateCoordinationSnapshot(envelope, {
    ownerAgentId: contract?.assignee || null,
  });
}

export function normalizeSystemIntent(rawAction) {
  const action = normalizeRecord(rawAction);
  const protocol = normalizeRecord(action.protocol);
  const intent = normalizeRecord(action.intent);
  const params = normalizeRecord(action.params);
  const intentParams = normalizeRecord(intent.params);
  const intentType = normalizeString(intent.type)
    || normalizeString(protocol.intentType)
    || normalizeString(action.type)
    || normalizeString(action.action);
  const mergedParams = {
    ...intentParams,
    ...params,
  };
  if (intentType === INTENT_TYPES.WAKE_AGENT && "context" in mergedParams) {
    delete mergedParams.context;
  }

  return {
    ...action,
    type: intentType,
    params: mergedParams,
    protocol: {
      version: protocol.version || PROTOCOL_VERSION,
      transport: normalizeString(protocol.transport) || "system_action",
      intentType,
    },
  };
}

export function isKnownIntentType(type) {
  return Object.values(INTENT_TYPES).includes(type);
}

export function getEnvelopeType(payload) {
  const protocol = normalizeRecord(payload?.protocol);
  return normalizeString(protocol.envelope)
    || normalizeString(payload?.taskType)
    || null;
}

function isEnvelopeType(payload, envelopeType) {
  return getEnvelopeType(payload) === envelopeType;
}

export function isDirectRequestEnvelope(payload) {
  return isEnvelopeType(payload, ENVELOPE_TYPES.DIRECT_REQUEST);
}

export function resolveDirectRequestEnvelopeSessionKey(payload) {
  if (!isDirectRequestEnvelope(payload)) {
    return null;
  }

  const serviceSession = normalizeServiceSession(payload?.serviceSession);
  return normalizeString(serviceSession?.entrySessionKey)
    || normalizeString(payload?.returnContext?.sourceSessionKey)
    || normalizeString(payload?.coordination?.caller?.sessionKey)
    || null;
}
