// operator-auto-propose.js — ⑤ Phase4: operator 自动生成提案（suggest-only）。
//
// 读 ProfileLifecycle 投影（trustLevel/status/streak/frozen/governanceSnapshot）→ 派生分级提案。
//
// 红线（备忘录 120 §92 + 用户拍板）：
//   - **只产建议（advisory）**：operator 不自动 apply。提案进 #40 控制面右栏，
//     人审批后经既有 change-set apply→verify 落地。
//   - 复用 change-set 表达 + 既有 surface，不新建 OperatorProposal runtime 概念（概念预算已满）。
//   - 纯函数、无 IO：输入快照投影，输出 proposals[]。便于单测 + 不引副作用。
//
// riskLevel 对接 #40 右栏 tierOf（safe/guarded/structural/destructive → T1-4）。

import { normalizeString } from "../core/normalize.js";
import { recommendHarnessModules } from "./operator-harness-recommend.js";

const PROMOTE_SUCCESS_THRESHOLD = 3;
const RETIRE_FAILURE_THRESHOLD = 2;

function buildProposalId(automationId, kind, now) {
  return `OP-${kind}-${automationId}-${now}`;
}

/**
 * 从 ProfileLifecycle 投影派生 operator 自动提案。
 * @param {{ profiles?: Array<{automationId, profileLifecycle}>, now?: number }} input
 * @returns {Array<{proposalId, automationId, category, riskLevel, reason, confidence, proof, suggestedSurface, suggestedPayload, origin, generatedAt}>}
 */
export function operatorAutoPropose({ profiles = [], now = Date.now() } = {}) {
  const proposals = [];
  for (const entry of Array.isArray(profiles) ? profiles : []) {
    const automationId = normalizeString(entry?.automationId);
    const lifecycle = entry?.profileLifecycle;
    if (!automationId || !lifecycle || typeof lifecycle !== "object") continue;

    const trustLevel = normalizeString(lifecycle.trustLevel)?.toLowerCase() || null;
    const status = normalizeString(lifecycle.status)?.toLowerCase() || null;
    const successStreak = Number.isFinite(lifecycle.successStreak) ? lifecycle.successStreak : 0;
    const failureStreak = Number.isFinite(lifecycle.failureStreak) ? lifecycle.failureStreak : 0;
    const frozen = lifecycle.frozen === true;
    const governanceSnapshot = lifecycle.governanceSnapshot && typeof lifecycle.governanceSnapshot === "object"
      ? lifecycle.governanceSnapshot
      : null;

    // 规则①治理收紧：stable + 连 ≥3 pass + 有收紧 snapshot → 建议把治理参数固化进 spec。
    if (status === "active" && trustLevel === "stable" && successStreak >= PROMOTE_SUCCESS_THRESHOLD && governanceSnapshot) {
      proposals.push({
        proposalId: buildProposalId(automationId, "harden", now),
        automationId,
        category: "governance_hardening",
        riskLevel: "guarded",
        reason: `自治回路连续 ${successStreak} 轮通过、信任档升至 stable；建议把运行时收紧的治理参数固化进 spec。`,
        confidence: successStreak >= PROMOTE_SUCCESS_THRESHOLD + 2 ? "high" : "medium",
        proof: [
          { kind: "trustLevel", value: trustLevel },
          { kind: "successStreak", value: successStreak },
          { kind: "governanceSnapshot", value: governanceSnapshot },
        ],
        suggestedSurface: "automations.update",
        suggestedPayload: { automationId, governance: governanceSnapshot },
        origin: "operator-auto",
        generatedAt: now,
      });
    }

    // 规则②人工介入：retired 或 连 ≥2 fail → 建议人工排查（暂停/改 spec/复活前评估）。
    if (status === "retired" || failureStreak >= RETIRE_FAILURE_THRESHOLD) {
      proposals.push({
        proposalId: buildProposalId(automationId, "troubleshoot", now),
        automationId,
        category: "troubleshooting",
        riskLevel: "guarded",
        reason: status === "retired"
          ? "自治回路已退役（连续失败触发）；建议人工评估根因后再决定复活或改 spec。"
          : `自治回路连续 ${failureStreak} 轮失败；建议人工介入排查，避免继续空耗。`,
        confidence: "high",
        proof: [
          { kind: "status", value: status },
          { kind: "failureStreak", value: failureStreak },
        ],
        suggestedSurface: "automations.update",
        suggestedPayload: { automationId },
        origin: "operator-auto",
        generatedAt: now,
      });
    }

    // 规则④harness 重塑(#47 提案层): harness 模块失败 → 建议重塑/调参 harness 模块组合。
    // 注: 这是 suggest-only 提案层(operator 标记 harness 需重做 + 给失败证据); operator-brain
    // 据失败信号自动派生新 moduleRefs(harness 生成层)+ harness-as-skill 是更深的后续(待静/动开关定)。
    const harness = entry?.harness && typeof entry.harness === "object" ? entry.harness : null;
    const failedModuleCount = Number.isFinite(harness?.failedModuleCount) ? harness.failedModuleCount : 0;
    if (failedModuleCount > 0) {
      const failedModules = Array.isArray(harness?.failedModules) ? harness.failedModules.filter(Boolean) : [];
      // 生成层(#47): 据失败信号 + 模块库 派生具体 harness 定义(混合静/动)。operator 只产 module 粒度。
      const reco = recommendHarnessModules({
        failedModules,
        pastSuccessfulCombos: Array.isArray(harness?.pastSuccessfulCombos) ? harness.pastSuccessfulCombos : [],
      });
      proposals.push({
        proposalId: buildProposalId(automationId, "harness", now),
        automationId,
        category: "harness_authoring",
        riskLevel: "guarded",
        reason: `自治回路 harness 有 ${failedModuleCount} 个模块失败${failedModules.length ? `（${failedModules.join(", ")}）` : ""}；建议改用 harness 模块组合 [${reco.moduleRefs.join(", ")}]。${reco.rationale}`,
        confidence: failedModuleCount >= 2 ? "high" : "medium",
        proof: [
          { kind: "failedHarnessModuleCount", value: failedModuleCount },
          ...(failedModules.length ? [{ kind: "failedModules", value: failedModules }] : []),
          { kind: "recommendedSource", value: reco.source },
        ],
        suggestedSurface: "automations.update",
        suggestedPayload: { automationId, harnessNeedsReshape: true, suggestedModuleRefs: reco.moduleRefs },
        origin: "operator-auto",
        generatedAt: now,
      });
    }

    // 规则③技能沉淀：stable + frozen(conclude) → 建议把收敛成果沉淀为可复用 skill。
    if (frozen && trustLevel === "stable") {
      proposals.push({
        proposalId: buildProposalId(automationId, "precipitate", now),
        automationId,
        category: "skill_precipitation",
        riskLevel: "safe",
        reason: "自治回路已收敛（conclude）且信任 stable；建议把成功模式沉淀为可复用 skill。",
        confidence: "medium",
        proof: [
          { kind: "trustLevel", value: trustLevel },
          { kind: "frozen", value: true },
        ],
        suggestedSurface: "skills.create",
        suggestedPayload: { automationId },
        origin: "operator-auto",
        generatedAt: now,
      });
    }
  }
  return proposals;
}
