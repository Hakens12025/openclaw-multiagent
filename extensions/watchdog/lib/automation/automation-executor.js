import { listLifecycleWorkItems } from "../contracts.js";
import {
  buildHarnessSpec,
  finalizeHarnessRun,
  normalizeHarnessRun,
  startHarnessRun,
} from "../harness/harness-run.js";
import {
  finalizeHarnessRunModules,
  initializeHarnessRunModules,
} from "../harness/harness-module-runner.js";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { getErrorMessage, normalizeRecord, normalizeString } from "../core/normalize.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { getActiveLoopRuntime } from "../loop/loop-round-runtime.js";
import {
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { getAutomationSpec, listAutomationSpecs } from "./automation-registry.js";
import {
  ensureAutomationRuntimeState,
  upsertAutomationRuntimeState,
} from "./automation-runtime.js";

// Extracted modules
import {
  normalizePositiveInteger,
  buildNextWakeAt,
  computeImprovementState,
  deriveDecision,
  buildRoundSummary,
} from "./automation-decision.js";
import {
  extractContractScore,
  extractContractArtifact,
  extractContractSummary,
  extractPipelineScore,
  extractPipelineArtifact,
  extractPipelineSummary,
  derivePipelineTerminalStatus,
} from "./automation-result-extractors.js";
import {
  buildDefaultSystemActionDelivery,
  buildAutomationContext,
  isPipelineActive,
  resolveAutomationIdFromContext,
  resolveRoundFromContext,
  resolveTriggerFromContext,
  resolveRequestedAtFromContext,
  buildContractIndex,
  hasRecordedRound,
  appendHarnessRun,
  buildActiveHarnessLifecycle,
  classifyStartResult,
  ensureRuntimeContext,
} from "./automation-harness-lifecycle.js";

export async function startAutomationRound(automationId, {
  trigger = "manual",
  api,
  enqueue,
  wakePlanner,
  logger,
  onAlert,
  dispatchAcceptIngressMessageFn = dispatchAcceptIngressMessage,
} = {}) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }
  ensureRuntimeContext({ api, enqueue, wakePlanner });

  const spec = await getAutomationSpec(normalizedId);
  if (!spec) {
    throw new Error(`unknown automation id: ${normalizedId}`);
  }

  let runtime = await ensureAutomationRuntimeState(spec);
  if (spec.enabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: "automation_disabled",
      automation: spec,
      runtime,
    };
  }

  const [workItems, pipeline] = await Promise.all([
    listLifecycleWorkItems(),
    getActiveLoopRuntime(),
  ]);
  const contractIndex = buildContractIndex(workItems);
  const runtimeContract = normalizeString(runtime?.activeContractId)
    ? contractIndex.byId.get(runtime.activeContractId) || null
    : null;
  if (runtimeContract && isTerminalContractStatus(runtimeContract?.status)) {
    const recovered = await handleAutomationContractTerminal(runtimeContract, { logger, onAlert });
    runtime = recovered?.runtime || runtime;
  }
  if (normalizeString(runtime?.activePipelineId)
    && normalizeString(pipeline?.pipelineId) === normalizeString(runtime.activePipelineId)
    && pipeline?.currentStage === "concluded"
    && resolveAutomationIdFromContext(pipeline?.automationContext) === normalizedId) {
    const recovered = await handleAutomationPipelineTerminal(pipeline, { logger, onAlert });
    runtime = recovered?.runtime || runtime;
  }

  const activePipeline = isPipelineActive(pipeline)
    && resolveAutomationIdFromContext(pipeline?.automationContext) === normalizedId
    ? pipeline
    : null;
  const activeContract = contractIndex.activeByAutomationId.get(normalizedId) || null;

  if (activeContract || activePipeline) {
    const activeContext = normalizeRecord(
      activeContract?.automationContext || activePipeline?.automationContext,
      null,
    );
    const resolvedRound = Math.max(
      normalizePositiveInteger(runtime?.currentRound, 0),
      resolveRoundFromContext(activeContract?.automationContext, 0),
      resolveRoundFromContext(activePipeline?.automationContext, 0),
    );
    const harnessState = await buildActiveHarnessLifecycle(spec, runtime, {
      round: resolvedRound,
      trigger: resolveTriggerFromContext(activeContext, normalizeString(trigger) || "manual"),
      requestedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || Date.now()),
      startedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || Date.now()),
      contractId: activeContract?.id || null,
      pipelineId: activePipeline?.pipelineId || null,
      loopId: activePipeline?.loopId || null,
    });
    const runningRuntime = await upsertAutomationRuntimeState({
      ...runtime,
      status: "running",
      activeContractId: activeContract?.id || runtime?.activeContractId || null,
      activePipelineId: activePipeline?.pipelineId || runtime?.activePipelineId || null,
      activeLoopId: activePipeline?.loopId || runtime?.activeLoopId || null,
      currentRound: resolvedRound,
      activeHarnessSpec: harnessState.activeHarnessSpec,
      activeHarnessRun: harnessState.activeHarnessRun,
    });
    return {
      ok: true,
      skipped: true,
      reason: activeContract ? "automation_contract_running" : "automation_pipeline_running",
      automation: spec,
      runtime: runningRuntime,
      activeContractId: activeContract?.id || null,
      activePipelineId: activePipeline?.pipelineId || null,
      activeLoopId: activePipeline?.loopId || null,
    };
  }

  const nextRound = normalizePositiveInteger(runtime?.currentRound, 0) + 1;
  const now = Date.now();
  const replyTo = buildDefaultSystemActionDelivery(spec);
  const requestedHarnessSpec = buildHarnessSpec(spec, {
    round: nextRound,
    trigger,
    requestedAt: now,
  });
  const requestedHarnessRun = startHarnessRun(requestedHarnessSpec, {
    startedAt: now,
  });
  const automationContext = buildAutomationContext(spec, nextRound, trigger, now, {
    harnessSpec: requestedHarnessSpec,
    harnessRunId: requestedHarnessRun.id,
  });

  let triggerResult = null;
  try {
    triggerResult = await dispatchAcceptIngressMessageFn(spec.entry.message, {
      source: "automation",
      replyTo,
      deliveryTargets: spec.deliveryTargets,
      automationContext,
      ingressDirective: {
        routeHint: spec.entry?.routeHint || null,
      },
      api,
      enqueue,
      wakePlanner,
      logger,
    });
  } catch (error) {
    const nextRuntime = await upsertAutomationRuntimeState({
      ...runtime,
      status: "error",
      activeContractId: null,
      activePipelineId: null,
      activeLoopId: null,
      activeHarnessSpec: null,
      activeHarnessRun: null,
      nextWakeAt: null,
    });
    onAlert?.({
      type: "automation_round_start_failed",
      automationId: normalizedId,
      round: nextRound,
      error: getErrorMessage(error),
      ts: now,
    });
    return {
      ok: false,
      automation: spec,
      runtime: nextRuntime,
      error: getErrorMessage(error),
    };
  }

  const startState = classifyStartResult(triggerResult);
  if (!startState.started) {
    const idleRuntime = await upsertAutomationRuntimeState({
      ...runtime,
      status: "idle",
      activeContractId: null,
      activePipelineId: null,
      activeLoopId: null,
      activeHarnessSpec: null,
      activeHarnessRun: null,
      nextWakeAt: startState.busy ? buildNextWakeAt(spec, now) : null,
    });
    return {
      ok: true,
      skipped: true,
      busy: startState.busy,
      reason: startState.reason,
      automation: spec,
      runtime: idleRuntime,
      triggerResult,
    };
  }

  const activeHarnessRun = await initializeHarnessRunModules(normalizeHarnessRun({
    ...requestedHarnessRun,
    contractId: startState.contractId,
    pipelineId: startState.pipelineId,
    loopId: startState.loopId,
  }), {
    automationSpec: spec,
  });
  const nextRuntime = await upsertAutomationRuntimeState({
    ...runtime,
    status: "running",
    currentRound: nextRound,
    activeContractId: startState.contractId,
    activePipelineId: startState.pipelineId,
    activeLoopId: startState.loopId,
    activeHarnessSpec: requestedHarnessSpec,
    activeHarnessRun,
    lastWakeAt: now,
    nextWakeAt: null,
  });

  onAlert?.({
    type: EVENT_TYPE.AUTOMATION_ROUND_STARTED,
    automationId: normalizedId,
    round: nextRound,
    route: triggerResult?.route || null,
    contractId: startState.contractId,
    pipelineId: startState.pipelineId,
    loopId: startState.loopId,
    ts: now,
  });
  logger?.info?.(
    `[watchdog] automation round started: ${normalizedId} round=${nextRound}`
    + `${startState.contractId ? ` contract=${startState.contractId}` : ""}`
    + `${startState.pipelineId ? ` pipeline=${startState.pipelineId}` : ""}`,
  );

  return {
    ok: true,
    skipped: false,
    automation: spec,
    runtime: nextRuntime,
    triggerResult,
  };
}

async function finalizeAutomationRound(spec, runtime, {
  round,
  terminalStatus,
  score,
  artifact,
  summary,
  terminalSource = null,
}, {
  logger,
  onAlert,
  contractId = null,
  pipelineId = null,
  loopId = null,
} = {}) {
  const now = Date.now();
  const improvement = computeImprovementState(spec, runtime, score, artifact, round);
  const harnessState = await buildActiveHarnessLifecycle(spec, runtime, {
    round,
    trigger: runtime?.activeHarnessRun?.trigger || runtime?.activeHarnessSpec?.trigger || "automation_terminal",
    requestedAt: runtime?.activeHarnessRun?.requestedAt
      || runtime?.activeHarnessSpec?.requestedAt
      || runtime?.lastWakeAt
      || now,
    startedAt: runtime?.activeHarnessRun?.startedAt || runtime?.lastWakeAt || now,
    contractId,
    pipelineId,
    loopId,
  });
  const prefinalizedHarness = finalizeHarnessRun(harnessState.activeHarnessRun, {
    terminalStatus,
    decision: null,
    completionReason: null,
    runtimeStatus: null,
    score: improvement.lastScore,
    artifact,
    summary,
    contractId,
    pipelineId,
    loopId,
    finalizedAt: now,
  });
  const evaluatedHarness = await finalizeHarnessRunModules(prefinalizedHarness, {
    automationSpec: spec,
    terminalSource,
    terminalStatus,
    score: improvement.lastScore,
    artifact,
    summary,
    finalizedAt: now,
  });

  const reviewerResult = evaluatedHarness?.reviewerResult || null;

  const decision = deriveDecision(spec, runtime, {
    round,
    terminalStatus,
    score: improvement.lastScore,
    noImprovementStreak: improvement.noImprovementStreak,
    reviewerResult,
    improvementState: improvement,
  }, now);

  const decoratedHarnessRun = normalizeHarnessRun({
    ...evaluatedHarness,
    decision: decision.decision,
    completionReason: decision.reason,
    runtimeStatus: decision.status,
  });
  const nextHarnessRun = decoratedHarnessRun || evaluatedHarness;

  const nextRuntime = await upsertAutomationRuntimeState({
    ...runtime,
    status: decision.status,
    currentRound: Math.max(normalizePositiveInteger(runtime?.currentRound, 0), round),
    activeContractId: null,
    activePipelineId: null,
    activeLoopId: null,
    lastResultAt: now,
    nextWakeAt: decision.nextWakeAt,
    bestRound: improvement.bestRound,
    bestScore: improvement.bestScore,
    bestArtifact: improvement.bestArtifact,
    lastScore: improvement.lastScore,
    noImprovementStreak: improvement.noImprovementStreak,
    activeHarnessSpec: null,
    activeHarnessRun: null,
    lastHarnessRun: nextHarnessRun,
    lastReviewerResult: reviewerResult,
    lastAutomationDecision: decision,
    recentHarnessRuns: appendHarnessRun(runtime, nextHarnessRun),
    recentRounds: [
      buildRoundSummary({
        round,
        score: improvement.lastScore,
        decision: decision.decision,
        status: terminalStatus,
        artifact,
        summary,
        ts: now,
      }),
      ...((Array.isArray(runtime?.recentRounds) ? runtime.recentRounds : [])
        .filter((entry) => Number(entry?.round) !== round)),
    ].sort((left, right) => Number(right?.round || 0) - Number(left?.round || 0)).slice(0, 20),
  });

  onAlert?.({
    type: EVENT_TYPE.AUTOMATION_ROUND_CONCLUDED,
    automationId: spec.id,
    round,
    terminalStatus,
    decision: decision.decision,
    runtimeStatus: nextRuntime.status,
    score: improvement.lastScore,
    bestScore: nextRuntime.bestScore,
    harnessGateVerdict: nextHarnessRun?.gateSummary?.verdict || "none",
    harnessFailedModuleCount: nextHarnessRun?.gateSummary?.failed || 0,
    reviewerVerdict: reviewerResult?.verdict || null,
    contractId,
    pipelineId,
    loopId,
    ts: now,
  });
  logger?.info?.(
    `[watchdog] automation round concluded: ${spec.id} round=${round}`
    + ` status=${terminalStatus} decision=${decision.decision}`,
  );

  return {
    handled: true,
    automation: spec,
    runtime: nextRuntime,
    decision,
  };
}

export async function handleAutomationContractTerminal(contract, {
  logger,
  onAlert,
} = {}) {
  const source = normalizeRecord(contract, null);
  const automationId = resolveAutomationIdFromContext(source?.automationContext);
  if (!automationId) {
    return { handled: false, reason: "no_automation_context" };
  }

  const terminalStatus = normalizeString(source?.status)?.toLowerCase() || null;
  if (!isTerminalContractStatus(terminalStatus)) {
    return { handled: false, reason: "contract_not_terminal" };
  }

  const spec = await getAutomationSpec(automationId);
  if (!spec) {
    return { handled: false, reason: "unknown_automation" };
  }

  const runtime = await ensureAutomationRuntimeState(spec);
  const round = resolveRoundFromContext(source?.automationContext, normalizePositiveInteger(runtime?.currentRound, 0));
  if (!round) {
    return { handled: false, reason: "missing_automation_round" };
  }
  if (hasRecordedRound(runtime, round) && runtime?.activeContractId !== source?.id) {
    return { handled: false, reason: "round_already_recorded" };
  }

  return finalizeAutomationRound(spec, runtime, {
    round,
    terminalStatus,
    score: extractContractScore(source),
    artifact: extractContractArtifact(source),
    summary: extractContractSummary(source),
    terminalSource: source,
  }, {
    logger,
    onAlert,
    contractId: normalizeString(source?.id),
  });
}

export async function handleAutomationPipelineTerminal(pipeline, {
  logger,
  onAlert,
} = {}) {
  const source = normalizeRecord(pipeline, null);
  const automationId = resolveAutomationIdFromContext(source?.automationContext);
  if (!automationId) {
    return { handled: false, reason: "no_automation_context" };
  }
  if (source?.currentStage !== "concluded") {
    return { handled: false, reason: "pipeline_not_terminal" };
  }

  const spec = await getAutomationSpec(automationId);
  if (!spec) {
    return { handled: false, reason: "unknown_automation" };
  }

  const runtime = await ensureAutomationRuntimeState(spec);
  const round = resolveRoundFromContext(source?.automationContext, normalizePositiveInteger(runtime?.currentRound, 0));
  if (!round) {
    return { handled: false, reason: "missing_automation_round" };
  }
  if (hasRecordedRound(runtime, round) && runtime?.activePipelineId !== source?.pipelineId) {
    return { handled: false, reason: "round_already_recorded" };
  }

  return finalizeAutomationRound(spec, runtime, {
    round,
    terminalStatus: derivePipelineTerminalStatus(source),
    score: extractPipelineScore(source),
    artifact: extractPipelineArtifact(source),
    summary: extractPipelineSummary(source),
    terminalSource: source,
  }, {
    logger,
    onAlert,
    pipelineId: normalizeString(source?.pipelineId),
    loopId: normalizeString(source?.loopId),
  });
}

export async function reconcileAutomationRuntimeStates({
  logger,
  onAlert,
} = {}) {
  const [specs, contracts, pipeline] = await Promise.all([
    listAutomationSpecs(),
    listLifecycleWorkItems(),
    getActiveLoopRuntime(),
  ]);
  const contractIndex = buildContractIndex(contracts);
  const now = Date.now();
  const updates = [];

  for (const spec of specs) {
    const runtime = await ensureAutomationRuntimeState(spec);
    const activeContract = contractIndex.activeByAutomationId.get(spec.id) || null;
    const activePipeline = isPipelineActive(pipeline)
      && resolveAutomationIdFromContext(pipeline?.automationContext) === spec.id
      ? pipeline
      : null;

    const runtimeContract = normalizeString(runtime?.activeContractId)
      ? contractIndex.byId.get(runtime.activeContractId) || null
      : null;
    if (runtimeContract && isTerminalContractStatus(runtimeContract?.status)) {
      const recovered = await handleAutomationContractTerminal(runtimeContract, { logger, onAlert });
      updates.push({ automationId: spec.id, action: "recovered_contract_terminal", recovered });
      continue;
    }

    if (normalizeString(runtime?.activePipelineId)
      && normalizeString(pipeline?.pipelineId) === normalizeString(runtime?.activePipelineId)
      && pipeline?.currentStage === "concluded") {
      const recovered = await handleAutomationPipelineTerminal(pipeline, { logger, onAlert });
      updates.push({ automationId: spec.id, action: "recovered_pipeline_terminal", recovered });
      continue;
    }

    let nextRuntime = runtime;
    if (activeContract || activePipeline) {
      const activeContext = normalizeRecord(
        activeContract?.automationContext || activePipeline?.automationContext,
        null,
      );
      const resolvedRound = Math.max(
        normalizePositiveInteger(runtime?.currentRound, 0),
        resolveRoundFromContext(activeContract?.automationContext, 0),
        resolveRoundFromContext(activePipeline?.automationContext, 0),
      );
      const harnessState = await buildActiveHarnessLifecycle(spec, runtime, {
        round: resolvedRound,
        trigger: resolveTriggerFromContext(activeContext, "reconcile"),
        requestedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || now),
        startedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || now),
        contractId: activeContract?.id || null,
        pipelineId: activePipeline?.pipelineId || null,
        loopId: activePipeline?.loopId || null,
      });
      nextRuntime = {
        ...runtime,
        status: "running",
        currentRound: resolvedRound,
        activeContractId: activeContract?.id || null,
        activePipelineId: activePipeline?.pipelineId || null,
        activeLoopId: activePipeline?.loopId || null,
        activeHarnessSpec: harnessState.activeHarnessSpec,
        activeHarnessRun: harnessState.activeHarnessRun,
      };
    } else if (spec.enabled !== true) {
      nextRuntime = {
        ...runtime,
        status: "paused",
        activeContractId: null,
        activePipelineId: null,
        activeLoopId: null,
        activeHarnessSpec: null,
        activeHarnessRun: null,
        nextWakeAt: null,
      };
    } else if (runtime?.status === "running") {
      nextRuntime = {
        ...runtime,
        status: "idle",
        activeContractId: null,
        activePipelineId: null,
        activeLoopId: null,
        activeHarnessSpec: null,
        activeHarnessRun: null,
      };
    } else if (runtime?.activeHarnessSpec || runtime?.activeHarnessRun) {
      nextRuntime = {
        ...runtime,
        activeHarnessSpec: null,
        activeHarnessRun: null,
      };
    }

    if (spec.enabled === true
      && spec?.wakePolicy?.onBoot === true
      && !activeContract
      && !activePipeline
      && !Number.isFinite(nextRuntime?.nextWakeAt)
      && !Number.isFinite(nextRuntime?.lastWakeAt)
      && nextRuntime?.status === "idle") {
      nextRuntime = {
        ...nextRuntime,
        nextWakeAt: now,
      };
    }

    if (JSON.stringify(nextRuntime) !== JSON.stringify(runtime)) {
      const saved = await upsertAutomationRuntimeState(nextRuntime);
      updates.push({ automationId: spec.id, action: "runtime_reconciled", runtime: saved });
    }
  }

  return {
    ok: true,
    updates,
  };
}

export async function pollDueAutomations({
  api,
  enqueue,
  wakePlanner,
  logger,
  onAlert,
  limit = 4,
} = {}) {
  ensureRuntimeContext({ api, enqueue, wakePlanner });

  const specs = await listAutomationSpecs({ enabled: true });
  const now = Date.now();
  const results = [];

  for (const spec of specs) {
    if (results.length >= limit) break;
    const runtime = await ensureAutomationRuntimeState(spec);
    if (runtime?.status !== "idle") continue;
    if (!Number.isFinite(runtime?.nextWakeAt) || runtime.nextWakeAt > now) continue;
    results.push(await startAutomationRound(spec.id, {
      trigger: "due_poll",
      api,
      enqueue,
      wakePlanner,
      logger,
      onAlert,
    }));
  }

  return {
    ok: true,
    due: results.length,
    results,
  };
}
