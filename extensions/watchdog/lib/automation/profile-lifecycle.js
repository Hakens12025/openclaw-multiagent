/**
 * profile-lifecycle.js — ProfileLifecycle 对象链尾段（第 11 概念，概念预算上限）
 *
 * 对象链：HarnessRun → EvaluationResult → AutomationDecision → ProfileLifecycle。
 * 备忘录114 §5.1 + cli-chain-e2e.test.js:400 标注的预留扩展点，本轮（P4）建成。
 *
 * 红线：
 * - 派生量：successStreak/failureStreak 从历史现算，不存 durable。
 * - 不造第二真值：只写 runtime.governanceSnapshot（经 resolve-governance 白名单校验），绝不改 spec。
 * - 概念预算已满：不分裂为 ResolvedGovernance/ProfileSnapshot/LifecycleState 多对象，统一在此持有。
 * - trustLevel 复用 harness-registry 的档位理念（experimental/provisional/stable），不新增 enum 泄漏。
 *
 * 所有权：profile:automation = 1:N。streak 归 automation（per-automation），故 ProfileLifecycle
 * 由 (automationId, profileId) 联合标识；多 automation 共享同一 profile 时 streak 各自独立。
 */

import {
  normalizeFiniteNumber,
  normalizePositiveInteger,
  normalizeRecord,
  normalizeString,
} from "../core/normalize.js";
import { normalizeGovernanceSnapshot } from "./resolve-governance.js";

// 信任阶梯：低 → 高。stable = 最硬化 = 治理最紧。
// 不含 "unknown"：harness-registry enum 无此值；未知 profile 以 experimental（最低）为种子。
export const TRUST_LADDER = Object.freeze(["experimental", "provisional", "stable"]);

const VALID_LIFECYCLE_STATUS = new Set(["active", "retired"]);

const PROMOTE_SUCCESS_THRESHOLD = 3; // 连 3 pass → 升一级
const RETIRE_FAILURE_THRESHOLD = 2;  // 连 2 fail → retired

// 每升一级，相对 spec 收紧的比例（trust 越高越紧）。stable 比 provisional 更紧。
// 仅在 spec 有正值基线可收紧时生效；保底各留 >=1。
const TIGHTEN_FACTOR_BY_LEVEL = Object.freeze({
  experimental: 1.0,   // 不收紧
  provisional: 0.7,
  stable: 0.5,
});

function ladderIndex(level) {
  const idx = TRUST_LADDER.indexOf(normalizeString(level)?.toLowerCase());
  return idx < 0 ? 0 : idx;
}

function ladderLevel(index) {
  const clamped = Math.max(0, Math.min(TRUST_LADDER.length - 1, index));
  return TRUST_LADDER[clamped];
}

// 单个证据（round / decision / evaluationResult）→ "pass" | "fail" | "neutral"。
// pass：明确通过结论；fail：明确失败/放弃；其余（continue/idle/pause/inconclusive）= neutral（不影响 streak）。
function classifyOutcome({ verdict, decision, status }) {
  const v = normalizeString(verdict)?.toLowerCase();
  if (v === "pass" || v === "improved") return "pass";
  if (v === "fail" || v === "regressed") return "fail";

  const d = normalizeString(decision)?.toLowerCase();
  if (d === "abandon" || d === "error") return "fail";
  if (d === "conclude" || d === "completed") return "pass";

  const s = normalizeString(status)?.toLowerCase();
  if (s === "failed" || s === "error") return "fail";
  if (s === "completed") return "pass";

  return "neutral";
}

// 从最近优先的证据序列计算连续 streak（遇 neutral 跳过，遇相反结果中断）。
function computeStreaks(orderedOutcomes) {
  let successStreak = 0;
  let failureStreak = 0;
  let sawSuccess = false;
  let sawFailure = false;

  for (const outcome of orderedOutcomes) {
    if (outcome === "neutral") continue;
    if (outcome === "pass") {
      if (sawFailure) break;
      sawSuccess = true;
      successStreak += 1;
    } else if (outcome === "fail") {
      if (sawSuccess) break;
      sawFailure = true;
      failureStreak += 1;
    }
  }
  return { successStreak, failureStreak };
}

// 把异构证据源（lastDecision + recentEvaluationResults + recentDecisions + runtime.recentRounds）
// 归一成「最近优先」的 outcome 序列。lastDecision 排首（本轮刚算出的最新结论）。
//
// 单源不变量（real[12]）：每条 round 至多贡献一次 outcome。即便未来调用方重新引入
// 重叠证据源，按 round 去重也能防止 streak 双计（带 round 的源 dedup；无 round 的源保留）。
function collectOrderedOutcomes({ lastDecision, recentDecisions, recentEvaluationResults, runtime }) {
  const outcomes = [];
  const seenRounds = new Set();

  // 带 round 字段的源按 round 去重；无 round（如缺字段）的源不去重，原样计入。
  const pushOutcome = (outcome, round) => {
    const key = normalizePositiveInteger(round, 0);
    if (key > 0) {
      if (seenRounds.has(key)) return;
      seenRounds.add(key);
    }
    outcomes.push(outcome);
  };

  const last = normalizeRecord(lastDecision, null);
  if (last) {
    pushOutcome(
      classifyOutcome({ verdict: last.verdict, decision: last.action || last.decision, status: last.status }),
      last.round,
    );
  }

  // 显式传入的历史（调用方可提供）；缺则回退 runtime.recentRounds（普查：runtime 无 recentDecisions/recentEvaluationResults）。
  const evalResults = Array.isArray(recentEvaluationResults) ? recentEvaluationResults : [];
  for (const er of evalResults) {
    const r = normalizeRecord(er, null);
    if (r) pushOutcome(classifyOutcome({ verdict: r.verdict }), r.round);
  }

  const decisions = Array.isArray(recentDecisions) ? recentDecisions : [];
  for (const dec of decisions) {
    const r = normalizeRecord(dec, null);
    if (r) pushOutcome(classifyOutcome({ verdict: r.verdict, decision: r.action || r.decision, status: r.status }), r.round);
  }

  const rounds = (Array.isArray(runtime?.recentRounds) ? runtime.recentRounds : [])
    .slice()
    .sort((a, b) => Number(b?.round || 0) - Number(a?.round || 0));
  for (const round of rounds) {
    const r = normalizeRecord(round, null);
    if (r) pushOutcome(classifyOutcome({ verdict: r.verdict, decision: r.decision, status: r.status }), r.round);
  }

  return outcomes;
}

// 根据 trustLevel 算出收紧的 governanceSnapshot（仅在有正值基线可收紧时产出）。
// 经 normalizeGovernanceSnapshot 白名单校验，非法/无收紧 → null。
function deriveGovernanceSnapshot(spec, trustLevel) {
  const factor = TIGHTEN_FACTOR_BY_LEVEL[trustLevel] ?? 1.0;
  if (factor >= 1.0) return null; // experimental 不收紧

  const governance = normalizeRecord(spec?.governance, {});
  const specMaxRounds = normalizePositiveInteger(governance.maxRounds, 0);
  const specEarlyStop = normalizePositiveInteger(governance.earlyStopPatience, 0);

  const candidate = {};
  if (specMaxRounds > 0) {
    candidate.maxRounds = Math.max(1, Math.floor(specMaxRounds * factor));
  }
  if (specEarlyStop > 0) {
    candidate.earlyStopPatience = Math.max(1, Math.floor(specEarlyStop * factor));
  }

  return normalizeGovernanceSnapshot(candidate);
}

/**
 * buildProfileLifecycle — 由对象链上游（AutomationDecision + 证据）派生尾段。
 * 纯函数：不改 spec、不改 runtime、不做 IO。
 */
export function buildProfileLifecycle({
  spec,
  runtime,
  profileId = null,
  profileTrustLevel = null,
  lastDecision = null,
  recentDecisions = [],
  recentEvaluationResults = [],
  now = Date.now(),
} = {}) {
  const automationId = normalizeString(runtime?.automationId) || normalizeString(spec?.id) || null;
  const resolvedProfileId = normalizeString(profileId)
    || normalizeString(spec?.harness?.profileId)
    || null;

  const outcomes = collectOrderedOutcomes({ lastDecision, recentDecisions, recentEvaluationResults, runtime });
  const { successStreak, failureStreak } = computeStreaks(outcomes);

  // 种子档位：profileTrustLevel（静态标签）→ ladder；未知 → experimental（最低）。
  const seedIndex = profileTrustLevel ? ladderIndex(profileTrustLevel) : 0;

  // 渐进硬化：连 3 pass 升一级；连 2 fail → retired。
  let nextIndex = seedIndex;
  let status = "active";
  if (failureStreak >= RETIRE_FAILURE_THRESHOLD) {
    status = "retired";
    nextIndex = Math.max(0, seedIndex - 1); // 退役同时降一级
  } else if (successStreak >= PROMOTE_SUCCESS_THRESHOLD) {
    nextIndex = Math.min(TRUST_LADDER.length - 1, seedIndex + 1);
  }
  const trustLevel = ladderLevel(nextIndex);

  // conclude → 冻结 governance：不再产出收紧 snapshot（保持 spec 默认，由 operator 决定后续）。
  const action = normalizeString(normalizeRecord(lastDecision, {})?.action)?.toLowerCase() || null;
  const frozen = action === "conclude";

  // retired 或 frozen → 不写收紧 snapshot（retired 应回 spec 默认等待复活；frozen 冻结）。
  const governanceSnapshot = (frozen || status === "retired")
    ? null
    : deriveGovernanceSnapshot(spec, trustLevel);

  return normalizeProfileLifecycle({
    automationId,
    profileId: resolvedProfileId,
    trustLevel,
    status,
    frozen,
    successStreak,
    failureStreak,
    evidenceWindow: outcomes.length,
    lastDecisionRef: normalizeString(normalizeRecord(lastDecision, {})?.reason) || action,
    governanceSnapshot,
    updatedAt: now,
  });
}

/**
 * normalizeProfileLifecycle — 归一/校验 ProfileLifecycle 记录（幂等）。
 */
export function normalizeProfileLifecycle(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const trustLevel = TRUST_LADDER.includes(normalizeString(source.trustLevel)?.toLowerCase())
    ? normalizeString(source.trustLevel).toLowerCase()
    : "experimental";
  const status = VALID_LIFECYCLE_STATUS.has(normalizeString(source.status)?.toLowerCase())
    ? normalizeString(source.status).toLowerCase()
    : "active";

  return {
    automationId: normalizeString(source.automationId) || null,
    profileId: normalizeString(source.profileId) || null,
    trustLevel,
    status,
    frozen: source.frozen === true,
    successStreak: normalizePositiveInteger(source.successStreak, 0),
    failureStreak: normalizePositiveInteger(source.failureStreak, 0),
    evidenceWindow: normalizePositiveInteger(source.evidenceWindow, 0),
    lastDecisionRef: normalizeString(source.lastDecisionRef) || null,
    governanceSnapshot: normalizeGovernanceSnapshot(source.governanceSnapshot),
    updatedAt: normalizeFiniteNumber(source.updatedAt, null),
  };
}
