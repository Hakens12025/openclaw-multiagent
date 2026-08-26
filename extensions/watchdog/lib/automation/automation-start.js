import {
  listLifecycleWorkItems,
} from "../contract/contracts.js";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { getErrorMessage, normalizeString } from "../core/normalize.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { getAutomationSpec } from "./automation-registry.js";
import {
  ensureAutomationRuntimeState,
  upsertAutomationRuntimeState,
} from "./automation-runtime.js";
import { buildNextWakeAt, normalizePositiveInteger } from "./automation-decision.js";
import {
  buildDefaultSystemActionDelivery,
  buildAutomationContext,
  resolveRoundFromContext,
  buildContractIndex,
  classifyStartResult,
  ensureRuntimeContext,
} from "./automation-round-context.js";
import { handleAutomationContractTerminal } from "./automation-finalize.js";

export async function startAutomationRound(automationId, {
  trigger = "manual",
  api,
  logger,
  onAlert,
  dispatchAcceptIngressMessageFn = dispatchAcceptIngressMessage,
} = {}) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }
  ensureRuntimeContext({ api });

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

  const workItems = await listLifecycleWorkItems();
  const contractIndex = buildContractIndex(workItems);
  const runtimeContract = normalizeString(runtime?.activeContractId)
    ? contractIndex.byId.get(runtime.activeContractId) || null
    : null;
  if (runtimeContract && isTerminalContractStatus(runtimeContract?.status)) {
    const recovered = await handleAutomationContractTerminal(runtimeContract, { logger, onAlert });
    runtime = recovered?.runtime || runtime;
  }
  // 在跑判据单源：合约。回路退役(2026-08-18)前这里还并了一条 loopRuntime 腿，
  // 但那条腿的门 `resolveAutomationIdFromContext(loopRuntime.automationContext)` 恒 null
  // （回路运行时从不携带 automationContext），生产上一次都没进过。
  const activeContract = contractIndex.activeByAutomationId.get(normalizedId) || null;

  if (activeContract) {
    const resolvedRound = Math.max(
      normalizePositiveInteger(runtime?.currentRound, 0),
      resolveRoundFromContext(activeContract.automationContext, 0),
    );
    const runningRuntime = await upsertAutomationRuntimeState({
      ...runtime,
      status: "running",
      activeContractId: activeContract.id || runtime?.activeContractId || null,
      currentRound: resolvedRound,
    });
    return {
      ok: true,
      skipped: true,
      reason: "automation_contract_running",
      automation: spec,
      runtime: runningRuntime,
      activeContractId: activeContract.id || null,
    };
  }

  const nextRound = normalizePositiveInteger(runtime?.currentRound, 0) + 1;
  const now = Date.now();
  const replyTo = buildDefaultSystemActionDelivery(spec);
  const automationContext = buildAutomationContext(spec, nextRound, trigger, now);

  // （rework 教训注入随评审链删除而退役——pendingReworkGuidance 的唯一生产者
  //  是 reviewerResult 派生段，备忘录150 后无源，v226 一并摘除。）
  const entryMessage = spec.entry.message;

  let triggerResult = null;
  try {
    triggerResult = await dispatchAcceptIngressMessageFn(entryMessage, {
      source: "automation",
      replyTo,
      deliveryTargets: spec.deliveryTargets,
      automationContext,
      api,
      logger,
    });
  } catch (error) {
    const nextRuntime = await upsertAutomationRuntimeState({
      ...runtime,
      status: "error",
      activeContractId: null,
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
      // 起跑未成功 → 按 wakePolicy 冷却退避重排下一次自唤醒。写 null 等于静默停摆：
      // executor 只轮询 `Number.isFinite(nextWakeAt)` 的 idle automation，
      // reconcile 的 onBoot 兜底又要求 `!Number.isFinite(lastWakeAt)`（跑过一轮后不再成立），
      // 于是一次起跑失败就永久失去唤醒源。退避沿用既有 buildNextWakeAt（wakePolicy.cooldownSeconds，
      // 默认 300s），不另造重试节流真值。
      nextWakeAt: buildNextWakeAt(spec, now),
    });
    return {
      ok: true,
      skipped: true,
      reason: startState.reason,
      automation: spec,
      runtime: idleRuntime,
      triggerResult,
    };
  }

  const nextRuntime = await upsertAutomationRuntimeState({
    ...runtime,
    status: "running",
    currentRound: nextRound,
    activeContractId: startState.contractId,
    lastWakeAt: now,
    nextWakeAt: null,
  });

  onAlert?.({
    type: EVENT_TYPE.AUTOMATION_ROUND_STARTED,
    automationId: normalizedId,
    round: nextRound,
    route: triggerResult?.route || null,
    contractId: startState.contractId,
    ts: now,
  });
  logger?.info?.(
    `[watchdog] automation round started: ${normalizedId} round=${nextRound}`
    + `${startState.contractId ? ` contract=${startState.contractId}` : ""}`,
  );

  return {
    ok: true,
    skipped: false,
    automation: spec,
    runtime: nextRuntime,
    triggerResult,
  };
}
