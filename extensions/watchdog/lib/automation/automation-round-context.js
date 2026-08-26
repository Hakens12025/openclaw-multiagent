// lib/automation/automation-round-context.js — automation 轮次上下文与终态回收的共享纯逻辑。
//
// 前身是 automation-harness-lifecycle.js 里与 harness 无关的那一半（harness 全退役
// v226 / 2026-08-23，备忘录149 batch3：HarnessRun 生命周期函数随 lib/harness 整删，
// 合约索引/上下文解析/起跑判据这些承重纯函数迁到本模块）。

import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { isActiveContractStatus } from "../core/runtime-status.js";
import { buildAgentMainSessionKey } from "../session/session-keys.js";
import { normalizePositiveInteger } from "./automation-decision.js";

export function buildDefaultSystemActionDelivery(spec) {
  const targetAgent = normalizeString(spec?.systemActionDelivery?.agentId || spec?.entry?.targetAgent);
  if (!targetAgent) return null;
  return {
    agentId: targetAgent,
    sessionKey: normalizeString(spec?.systemActionDelivery?.sessionKey) || buildAgentMainSessionKey(targetAgent),
  };
}

// harness 字段保留透传：declared-sandbox-guard 的配置面读
// contract.automationContext.harness.moduleConfig（D-F 迁移后的数据形状不变）。
// harness 判定账本身（harnessSpec/harnessRunId）已随退役删除。
export function buildAutomationContext(spec, round, trigger, ts) {
  return {
    automationId: spec.id,
    round,
    trigger: normalizeString(trigger) || "manual",
    requestedAt: ts,
    objective: normalizeRecord(spec.objective, null),
    entry: normalizeRecord(spec.entry, null),
    adapters: normalizeRecord(spec.adapters, null),
    wakePolicy: normalizeRecord(spec.wakePolicy, null),
    governance: normalizeRecord(spec.governance, null),
    systemActionDelivery: normalizeRecord(spec.systemActionDelivery, null),
    harness: normalizeRecord(spec.harness, null),
  };
}

export function resolveAutomationIdFromContext(value) {
  const context = normalizeRecord(value, null);
  if (!context) return null;
  return normalizeString(context.automationId || context.id);
}

export function resolveRoundFromContext(value, fallback = 0) {
  const context = normalizeRecord(value, null);
  if (!context) return fallback;
  return normalizePositiveInteger(context.round, fallback);
}

export function resolveTriggerFromContext(value, fallback = "manual") {
  const context = normalizeRecord(value, null);
  if (!context) return fallback;
  return normalizeString(context.trigger)?.toLowerCase() || fallback;
}

export function resolveRequestedAtFromContext(value, fallback = Date.now()) {
  const context = normalizeRecord(value, null);
  if (!context) return fallback;
  return Number.isFinite(context.requestedAt) ? context.requestedAt : fallback;
}

function selectLatestContract(left, right) {
  const leftTs = Number(left?.updatedAt) || Number(left?.createdAt) || 0;
  const rightTs = Number(right?.updatedAt) || Number(right?.createdAt) || 0;
  return leftTs >= rightTs ? left : right;
}

export function buildContractIndex(contracts) {
  const byId = new Map();
  const activeByAutomationId = new Map();

  for (const contract of Array.isArray(contracts) ? contracts : []) {
    const contractId = normalizeString(contract?.id);
    if (contractId) {
      byId.set(contractId, contract);
    }

    if (!isActiveContractStatus(contract?.status)) continue;
    const automationId = resolveAutomationIdFromContext(contract?.automationContext);
    if (!automationId) continue;

    const existing = activeByAutomationId.get(automationId);
    activeByAutomationId.set(
      automationId,
      existing ? selectLatestContract(existing, contract) : contract,
    );
  }

  return { byId, activeByAutomationId };
}

export function hasRecordedRound(runtime, round) {
  return (Array.isArray(runtime?.recentRounds) ? runtime.recentRounds : [])
    .some((entry) => Number(entry?.round) === Number(round));
}

// 唯一的 triggerResult 生产者是 `dispatchAcceptIngressMessage`
// （automation 走 ingress 起跑，不经任何回路运行时），
// 它的返回形状只有 {ok, contractId, error, queued, targetAgent, route}。
// 回路退役(2026-08-18)前这里还看 pipelineId / loopAction / reason==="loop_busy"，
// 三者的唯一写入方都是已删除的回路推进腿，ingress 一个都不产。
// 起跑判据：合约铸出 **且** ingress 没报失败。只看 contractId 不够：
// `dispatch-execution-contract-entry.js` 的派工失败分支返回
// `{ok:false, contractId, error:"dispatch_failed"}`——合约已铸出(PENDING 落盘)但没人接手，
// 记成起跑成功会让 runtime 停在 status:"running"，reconcile 又因该 PENDING 合约仍 active
// 持续判 running，executor 只在 idle 起跑 → 永久卡死(无超时、无 sweeper)。
// 回路退役(2026-08-18)前，跨轮硬上限还有回路预算兜底；现在本函数是唯一起跑判据，必须自守。
export function classifyStartResult(triggerResult) {
  const source = normalizeRecord(triggerResult, {});
  const contractId = normalizeString(source.contractId) || null;
  return {
    started: Boolean(contractId) && source.ok !== false,
    // 失败原因优先透出 ingress 的 error（`dispatch_failed` 等），别把它压成 "not_started"。
    reason: normalizeString(source.reason) || normalizeString(source.error) || "not_started",
    contractId,
  };
}

export function ensureRuntimeContext({
  api,
}) {
  if (!api) {
    throw new Error("missing runtime context for automation executor");
  }
}
