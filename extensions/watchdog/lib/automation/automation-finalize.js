import {
  finalizeHarnessRun,
  normalizeHarnessRun,
} from "../harness/harness-run.js";
import {
  finalizeHarnessRunModules,
} from "../harness/harness-module-runner.js";
import { buildEvaluationResult } from "../harness/evaluator-result.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { getAutomationSpec } from "./automation-registry.js";
import {
  ensureAutomationRuntimeState,
  upsertAutomationRuntimeState,
} from "./automation-runtime.js";
import {
  normalizePositiveInteger,
  computeImprovementState,
  deriveDecision,
  buildRoundSummary,
} from "./automation-decision.js";
import { buildProfileLifecycle } from "./profile-lifecycle.js";
import {
  extractContractScore,
  extractContractArtifact,
  extractContractSummary,
  extractLoopRuntimeScore,
  extractLoopRuntimeArtifact,
  extractLoopRuntimeSummary,
  deriveLoopRuntimeTerminalStatus,
} from "./automation-result-extractors.js";
import {
  appendHarnessRun,
  buildActiveHarnessLifecycle,
  hasRecordedRound,
  resolveAutomationIdFromContext,
  resolveRoundFromContext,
} from "./automation-harness-lifecycle.js";
import { maybePrecipitateSkillFromRound } from "./automation-skill-precipitation.js";

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
  const evaluationResult = reviewerResult
    ? buildEvaluationResult({
        reviewerResultId: reviewerResult.contractId || reviewerResult.pipelineId || null,
        harnessRunId: prefinalizedHarness?.id || null,
        verdict: reviewerResult.verdict,
        continueHint: reviewerResult.continueHint,
        testsPassed: reviewerResult.verdict === "pass" || reviewerResult.verdict === "improved",
        score: reviewerResult.score,
        round: reviewerResult.round || round,
      })
    : null;

  const decision = deriveDecision(spec, runtime, {
    round,
    terminalStatus,
    score: improvement.lastScore,
    noImprovementStreak: improvement.noImprovementStreak,
    evaluationResult,
    reviewerResult,
    improvementState: improvement,
  }, now);

  const decoratedHarnessRun = normalizeHarnessRun({
    ...evaluatedHarness,
    decision: decision.decision,
    completionReason: decision.reason,
    runtimeStatus: decision.status,
  });
  const nextHarnessRun = decoratedHarnessRun || evaluatedHarness || prefinalizedHarness;

  // 治理隔离：testMode 运行（自检/TSP 等固定测试）不计入 operator 自改善——
  // 不派生 ProfileLifecycle、不落 governanceSnapshot、不沉淀 skill（见下）。
  // 与既有熔断 governanceSnapshotDisabled 语义一致（null snapshot = 不收紧）。
  const isTestRun = Boolean(spec?.harness?.testMode) || Boolean(runtime?.testMode);

  // P4 对象链尾段（死链 c 收口）：由 AutomationDecision + 证据派生 ProfileLifecycle。
  // 它算出的 governanceSnapshot 落进 runtime，下一轮经 resolveGovernance 被 deriveDecision 读到
  // （写了必被读 → 非死对象）。retired/frozen 时 snapshot=null（回 spec 默认，等待 operator）。
  const profileLifecycle = isTestRun ? null : buildProfileLifecycle({
    spec,
    runtime,
    profileId: spec?.harness?.profileId || null,
    profileTrustLevel: nextHarnessRun?.profileTrustLevel
      || runtime?.profileLifecycle?.trustLevel
      || null,
    lastDecision: decision,
    recentEvaluationResults: evaluationResult ? [evaluationResult] : [],
    recentDecisions: runtime?.lastAutomationDecision ? [runtime.lastAutomationDecision] : [],
    now,
  });

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
    // 修死链(a)：rework 决策时把上轮教训落进 runtime，下一轮 startAutomationRound
    // 读它拼进 spec.entry.message 后清空。非 rework（含 conclude/pause/abandon）清空，
    // 避免过时教训残留到无关下一轮。
    pendingReworkGuidance: decision.action === "rework" ? (decision.reworkGuidance || null) : null,
    // P4：尾段快照 + 收紧治理参数落 runtime。governanceSnapshot 下一轮经 resolveGovernance 被读。
    // 熔断标志（governanceSnapshotDisabled）保持 runtime 原值，仅 operator 经 apply 改。
    profileLifecycle,
    governanceSnapshot: profileLifecycle?.governanceSnapshot || null,
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

  // ④ skill 因果链自动沉淀：一轮结束、有 HarnessRun + EvaluationResult 时，
  // 代码判评判（EvaluationResult 阈值 + ProfileLifecycle streak + gate 过），
  // 抽验证后的因果对（Pro 挂成功 harnessRunId，Con 挂失败 failureClass），写 SKILL.md。
  // 沉淀失败不影响主流程（best-effort）。testMode 运行不沉淀(治理隔离)。
  if (evaluationResult && !isTestRun) {
    try {
      await maybePrecipitateSkillFromRound({
        spec,
        harnessRun: nextHarnessRun,
        evaluationResult,
        profileLifecycle,
        recentHarnessRuns: nextRuntime?.recentHarnessRuns || [],
        logger,
        onAlert,
      });
    } catch (error) {
      logger?.warn?.(`[watchdog] skill precipitation skipped: ${error.message}`);
    }
  }

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

export async function handleAutomationLoopRuntimeTerminal(loopRuntime, {
  logger,
  onAlert,
} = {}) {
  const source = normalizeRecord(loopRuntime, null);
  const automationId = resolveAutomationIdFromContext(source?.automationContext);
  if (!automationId) {
    return { handled: false, reason: "no_automation_context" };
  }
  if (source?.currentStage !== "concluded") {
    return { handled: false, reason: "loop_runtime_not_terminal" };
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
    terminalStatus: deriveLoopRuntimeTerminalStatus(source),
    score: extractLoopRuntimeScore(source),
    artifact: extractLoopRuntimeArtifact(source),
    summary: extractLoopRuntimeSummary(source),
    terminalSource: source,
  }, {
    logger,
    onAlert,
    pipelineId: normalizeString(source?.pipelineId),
    loopId: normalizeString(source?.loopId),
  });
}
