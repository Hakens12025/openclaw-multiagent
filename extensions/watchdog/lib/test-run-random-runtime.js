import { createHash, randomBytes } from "node:crypto";

import { dispatchAcceptIngressMessage } from "./ingress/dispatch-entry.js";
import { startRuntimeLoop } from "./admin/admin-surface-loop-operations.js";

function stableRandomIndex(seed, count) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const digest = createHash("sha256").update(String(seed || "")).digest();
  return digest.readUInt32BE(0) % count;
}

export function buildRandomPresetRuntime({
  preset,
  caseDef = null,
  candidateSet = [],
  seed = randomBytes(6).toString("hex"),
} = {}) {
  const sortedCandidates = [...candidateSet]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort();
  const chosenIndex = stableRandomIndex(seed, sortedCandidates.length);
  const chosenAgent = chosenIndex >= 0 ? sortedCandidates[chosenIndex] : null;
  return {
    family: preset?.family || null,
    seed,
    caseId: caseDef?.id || null,
    candidateSet: sortedCandidates,
    chosenAgent,
    chosenLoopMember: null,
    resolvedLoopId: null,
    actualPath: "unresolved",
    pathVerdict: "pending",
    pathVerdictReason: null,
  };
}

export function resolveRandomPresetCandidateSet({
  preset,
  runtimeAgentIds = [],
  graph = null,
  activeLoops = [],
} = {}) {
  const normalizedCandidates = [...new Set((Array.isArray(runtimeAgentIds) ? runtimeAgentIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];

  const activeLoopNodes = new Set((Array.isArray(activeLoops) ? activeLoops : [])
    .filter((loop) => loop?.active === true)
    .flatMap((loop) => Array.isArray(loop?.nodes) ? loop.nodes : [])
    .map((agentId) => String(agentId || "").trim())
    .filter(Boolean));

  if (preset?.family === "loop-random") {
    return normalizedCandidates.filter((agentId) => activeLoopNodes.has(agentId));
  }

  if (preset?.family !== "system-random") {
    return normalizedCandidates;
  }

  const outEdgeOwners = new Set((Array.isArray(graph?.edges) ? graph.edges : [])
    .map((edge) => String(edge?.from || "").trim())
    .filter(Boolean));

  return normalizedCandidates.filter((agentId) => (
    outEdgeOwners.has(agentId)
    && !activeLoopNodes.has(agentId)
  ));
}

export function resolveLoopRandomSelection({
  chosenAgent = null,
  activeLoops = [],
} = {}) {
  const chosenLoopMember = typeof chosenAgent === "string" && chosenAgent.trim()
    ? chosenAgent.trim()
    : null;
  if (!chosenLoopMember) {
    return {
      chosenLoopMember: null,
      resolvedLoopId: null,
      blockedReason: "loop-random has no active loop members in current graph",
    };
  }

  const matchingLoops = (Array.isArray(activeLoops) ? activeLoops : [])
    .filter((loop) => loop?.active === true)
    .filter((loop) => Array.isArray(loop?.nodes) && loop.nodes.includes(chosenLoopMember));

  if (matchingLoops.length === 1) {
    return {
      chosenLoopMember,
      resolvedLoopId: matchingLoops[0].id,
      blockedReason: null,
    };
  }
  if (matchingLoops.length > 1) {
    return {
      chosenLoopMember,
      resolvedLoopId: null,
      blockedReason: `loop-random start member ${chosenLoopMember} matches multiple active loops`,
    };
  }
  return {
    chosenLoopMember,
    resolvedLoopId: null,
    blockedReason: `loop-random start member ${chosenLoopMember} is not part of an active loop`,
  };
}

export function buildUnsupportedRandomPresetResult({
  testCase,
  family,
  reason,
}) {
  return {
    testCase,
    results: [],
    duration: "0.0",
    pass: false,
    blocked: true,
    contractId: null,
    outputInfo: null,
    errorCode: "E_RANDOM_CAPABILITY_BLOCKED",
    errorDetail: reason,
    randomRuntime: {
      family,
      seed: null,
      caseId: testCase?.id || null,
      candidateSet: [],
      chosenAgent: null,
      chosenLoopMember: null,
      resolvedLoopId: null,
      actualPath: "unresolved",
      pathVerdict: "blocked",
      pathVerdictReason: reason,
    },
  };
}

export function buildSystemRandomRunSingleOptions({
  replyTo,
  randomRuntime,
  runtimeContext,
  logger,
  dispatchAcceptIngressMessageFn = dispatchAcceptIngressMessage,
} = {}) {
  const chosenAgent = typeof randomRuntime?.chosenAgent === "string" && randomRuntime.chosenAgent.trim()
    ? randomRuntime.chosenAgent.trim()
    : null;
  if (!chosenAgent) {
    throw new TypeError("buildSystemRandomRunSingleOptions requires randomRuntime.chosenAgent");
  }
  if (!runtimeContext?.api || typeof runtimeContext.enqueue !== "function") {
    throw new TypeError("buildSystemRandomRunSingleOptions requires runtimeContext.api/enqueue");
  }
  if (typeof dispatchAcceptIngressMessageFn !== "function") {
    throw new TypeError("buildSystemRandomRunSingleOptions requires dispatchAcceptIngressMessageFn");
  }
  // wakePlanner is optional: graph handles dispatch, so absent/null degrades to no-op.
  const resolvedWakePlanner = typeof runtimeContext.wakePlanner === "function"
    ? runtimeContext.wakePlanner
    : () => {};

  return {
    transport: "isolated",
    replyTo,
    source: "system",
    ingressMode: "standard",
    chosenAgent,
    randomRuntime,
    sendMessageLabel: `system-random ingress to ${chosenAgent}`,
    sendMessage: (message) => dispatchAcceptIngressMessageFn(message, {
      source: "system",
      replyTo,
      dispatchOwnerAgentId: chosenAgent,
      api: runtimeContext.api,
      enqueue: runtimeContext.enqueue,
      wakePlanner: resolvedWakePlanner,
      logger,
    }),
  };
}

export function buildLoopRandomRunSingleOptions({
  randomRuntime,
  runtimeContext,
  logger,
  loopBudget = null,
  startRuntimeLoopFn = startRuntimeLoop,
} = {}) {
  const resolvedLoopId = typeof randomRuntime?.resolvedLoopId === "string" && randomRuntime.resolvedLoopId.trim()
    ? randomRuntime.resolvedLoopId.trim()
    : null;
  const chosenLoopMember = typeof randomRuntime?.chosenLoopMember === "string" && randomRuntime.chosenLoopMember.trim()
    ? randomRuntime.chosenLoopMember.trim()
    : null;
  if (!resolvedLoopId || !chosenLoopMember) {
    throw new TypeError("buildLoopRandomRunSingleOptions requires randomRuntime.resolvedLoopId/chosenLoopMember");
  }
  if (!runtimeContext?.api || typeof runtimeContext.enqueue !== "function") {
    throw new TypeError("buildLoopRandomRunSingleOptions requires runtimeContext.api/enqueue");
  }
  if (typeof startRuntimeLoopFn !== "function") {
    throw new TypeError("buildLoopRandomRunSingleOptions requires startRuntimeLoopFn");
  }

  return {
    transport: "isolated",
    source: "system",
    ingressMode: "standard",
    chosenAgent: chosenLoopMember,
    randomRuntime,
    sendMessageLabel: `loop-random runtime.loop.start ${resolvedLoopId}:${chosenLoopMember}`,
    sendMessage: async (message) => {
      const result = await startRuntimeLoopFn({
        payload: {
          loopId: resolvedLoopId,
          startAgent: chosenLoopMember,
          requestedTask: message,
          requestedSource: "watchdog.test.loop-random",
          ...(loopBudget && typeof loopBudget === "object" ? { budget: loopBudget } : {}),
        },
        logger,
        runtimeContext,
      });
      return {
        ok: result?.ok !== false,
        contractId: result?.contractId || null,
      };
    },
  };
}
