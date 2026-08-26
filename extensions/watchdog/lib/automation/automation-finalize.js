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
} from "./automation-result-extractors.js";
import {
  hasRecordedRound,
  resolveAutomationIdFromContext,
  resolveRoundFromContext,
} from "./automation-round-context.js";

async function finalizeAutomationRound(spec, runtime, {
  round,
  terminalStatus,
  score,
  artifact,
  summary,
}, {
  logger,
  onAlert,
  contractId = null,
} = {}) {
  const now = Date.now();
  const improvement = computeImprovementState(spec, runtime, score, artifact, round);

  // harness 判定链已全退役（v226 / 2026-08-23，备忘录149/150）：HarnessRun 归一、
  // 模块评估、reviewerResult 派生全部移除。deriveDecision 的 evaluationResult
  // 死评价臂已随之整删（2026-08-26），决策由 terminalStatus/预算/指纹守卫驱动。
  const decision = deriveDecision(spec, runtime, {
    round,
    terminalStatus,
    score: improvement.lastScore,
    noImprovementStreak: improvement.noImprovementStreak,
    improvementState: improvement,
  }, now);

  // 治理隔离：testMode 运行（自检等固定测试）不计入 operator 自改善——
  // 不派生 ProfileLifecycle、不落 governanceSnapshot。
  // 与既有熔断 governanceSnapshotDisabled 语义一致（null snapshot = 不收紧）。
  const isTestRun = Boolean(spec?.harness?.testMode) || Boolean(runtime?.testMode);

  // P4 对象链尾段（死链 c 收口）：由 AutomationDecision + 证据派生 ProfileLifecycle。
  // 它算出的 governanceSnapshot 落进 runtime，下一轮经 resolveGovernance 被 deriveDecision 读到
  // （写了必被读 → 非死对象）。retired/frozen 时 snapshot=null（回 spec 默认，等待 operator）。
  const profileLifecycle = isTestRun ? null : buildProfileLifecycle({
    spec,
    runtime,
    profileId: spec?.harness?.profileId || null,
    profileTrustLevel: runtime?.profileLifecycle?.trustLevel || null,
    lastDecision: decision,
    // streak 单源化（修 real[12] 双计）：每轮恰好贡献一次证据。
    // recentEvaluationResults / recentDecisions 刻意不传：
    //   - recentEvaluationResults 与 lastDecision 同轮同 verdict（重复本轮）；
    //   - recentDecisions(runtime.lastAutomationDecision) 与 runtime.recentRounds[prev] 同为上一轮（重复历史）。
    // runtime.recentRounds 已携带每条历史轮 verdict，lastDecision 携带本轮，合起来每轮唯一。
    now,
  });

  const nextRuntime = await upsertAutomationRuntimeState({
    ...runtime,
    status: decision.status,
    currentRound: Math.max(normalizePositiveInteger(runtime?.currentRound, 0), round),
    activeContractId: null,
    lastResultAt: now,
    nextWakeAt: decision.nextWakeAt,
    bestRound: improvement.bestRound,
    bestScore: improvement.bestScore,
    bestArtifact: improvement.bestArtifact,
    lastScore: improvement.lastScore,
    noImprovementStreak: improvement.noImprovementStreak,
    repeatStreak: improvement.repeatStreak,
    lastArtifactFingerprint: improvement.lastArtifactFingerprint,
    lastAutomationDecision: decision,
    // P4：尾段快照 + 收紧治理参数落 runtime。governanceSnapshot 下一轮经 resolveGovernance 被读。
    // 熔断标志（governanceSnapshotDisabled）保持 runtime 原值，仅 operator 经 apply 改。
    profileLifecycle,
    governanceSnapshot: profileLifecycle?.governanceSnapshot || null,
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
    contractId,
    ts: now,
  });
  logger?.info?.(
    `[watchdog] automation round concluded: ${spec.id} round=${round}`
    + ` status=${terminalStatus} decision=${decision.decision}`,
  );

  // （skill 因果链自动沉淀随 harness 退役删除：它的评判原料全部来自
  //  HarnessRun/EvaluationResult/moduleRuns evidence，判定账没了即无源，v226 整删。）

  return {
    handled: true,
    automation: spec,
    runtime: nextRuntime,
    decision,
  };
}

// automation 轮次终态回收的唯一入口。回路退役(2026-08-18)前还并存
// `handleAutomationLoopRuntimeTerminal`（读 loopRuntime.feedbackOutput / conclusionArtifact），
// 它的第一道门 `resolveAutomationIdFromContext(source.automationContext)` 恒 null
// —— 回路运行时对象从不携带 automationContext —— 故生产上一次都没跑过，随之整删。
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
  }, {
    logger,
    onAlert,
    contractId: normalizeString(source?.id),
  });
}
