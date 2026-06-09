import {
  listLifecycleWorkItems,
} from "../contracts.js";
import {
  buildHarnessSpec,
  normalizeHarnessRun,
  startHarnessRun,
} from "../harness/harness-run.js";
import {
  initializeHarnessRunModules,
} from "../harness/harness-module-runner.js";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { getErrorMessage, normalizeRecord, normalizeString } from "../core/normalize.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { getActiveLoopRuntime } from "../loop/loop-round-runtime.js";
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
  buildNextWakeAt,
} from "./automation-decision.js";
import {
  buildDefaultSystemActionDelivery,
  buildAutomationContext,
  isLoopRuntimeActive,
  resolveAutomationIdFromContext,
  resolveRoundFromContext,
  resolveTriggerFromContext,
  resolveRequestedAtFromContext,
  buildContractIndex,
  buildActiveHarnessLifecycle,
  classifyStartResult,
  ensureRuntimeContext,
} from "./automation-harness-lifecycle.js";
import {
  handleAutomationContractTerminal,
  handleAutomationLoopRuntimeTerminal,
} from "./automation-finalize.js";

// 把 runtime.pendingReworkGuidance 拼进任务文本（LLM 管内容的合法注入点：entry.message
// 是任务文本，非 transport）。让小模型知道上轮哪错、别从零重做。无教训则原样返回。
export function composeEntryMessageWithRework(baseMessage, pendingReworkGuidance) {
  const guidance = normalizeRecord(pendingReworkGuidance, null);
  const base = normalizeString(baseMessage) || "";
  if (!guidance) return base;

  const failureClass = normalizeString(guidance.failureClass);
  const reworkTarget = normalizeString(guidance.reworkTarget);
  const strategy = normalizeString(guidance.strategy);
  const findings = (Array.isArray(guidance.actionableFindings) ? guidance.actionableFindings : [])
    .map((f) => normalizeString(f?.message))
    .filter(Boolean);

  if (!failureClass && !reworkTarget && findings.length === 0) return base;

  const lines = ["", "──", "【上轮未通过 / Previous round did not pass — 在此基础上修正，勿从零重做】"];
  if (failureClass) lines.push(`failureClass: ${failureClass}`);
  if (reworkTarget) lines.push(`reworkTarget（重点修这里）: ${reworkTarget}`);
  if (strategy) lines.push(`strategy: ${strategy}`);
  if (findings.length > 0) {
    lines.push("具体问题 / findings:");
    findings.forEach((msg, i) => lines.push(`  ${i + 1}. ${msg}`));
  }
  return `${base}${lines.join("\n")}`;
}

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

  const [workItems, loopRuntime] = await Promise.all([
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
    && normalizeString(loopRuntime?.pipelineId) === normalizeString(runtime.activePipelineId)
    && loopRuntime?.currentStage === "concluded"
    && resolveAutomationIdFromContext(loopRuntime?.automationContext) === normalizedId) {
    const recovered = await handleAutomationLoopRuntimeTerminal(loopRuntime, { logger, onAlert });
    runtime = recovered?.runtime || runtime;
  }

  const activeLoopRuntime = isLoopRuntimeActive(loopRuntime)
    && resolveAutomationIdFromContext(loopRuntime?.automationContext) === normalizedId
    ? loopRuntime
    : null;
  const activeContract = contractIndex.activeByAutomationId.get(normalizedId) || null;

  if (activeContract || activeLoopRuntime) {
    const activeContext = normalizeRecord(
      activeContract?.automationContext || activeLoopRuntime?.automationContext,
      null,
    );
    const resolvedRound = Math.max(
      normalizePositiveInteger(runtime?.currentRound, 0),
      resolveRoundFromContext(activeContract?.automationContext, 0),
      resolveRoundFromContext(activeLoopRuntime?.automationContext, 0),
    );
    const harnessState = await buildActiveHarnessLifecycle(spec, runtime, {
      round: resolvedRound,
      trigger: resolveTriggerFromContext(activeContext, normalizeString(trigger) || "manual"),
      requestedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || Date.now()),
      startedAt: resolveRequestedAtFromContext(activeContext, runtime?.lastWakeAt || Date.now()),
      contractId: activeContract?.id || null,
      pipelineId: activeLoopRuntime?.pipelineId || null,
      loopId: activeLoopRuntime?.loopId || null,
    });
    const runningRuntime = await upsertAutomationRuntimeState({
      ...runtime,
      status: "running",
      activeContractId: activeContract?.id || runtime?.activeContractId || null,
      activePipelineId: activeLoopRuntime?.pipelineId || runtime?.activePipelineId || null,
      activeLoopId: activeLoopRuntime?.loopId || runtime?.activeLoopId || null,
      currentRound: resolvedRound,
      activeHarnessSpec: harnessState.activeHarnessSpec,
      activeHarnessRun: harnessState.activeHarnessRun,
    });
    return {
      ok: true,
      skipped: true,
      reason: activeContract ? "automation_contract_running" : "automation_loop_runtime_running",
      automation: spec,
      runtime: runningRuntime,
      activeContractId: activeContract?.id || null,
      activePipelineId: activeLoopRuntime?.pipelineId || null,
      activeLoopId: activeLoopRuntime?.loopId || null,
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

  // 修死链(a)：把上轮 rework 教训拼进本轮任务文本（内容层注入，不碰 transport）。
  const entryMessage = composeEntryMessageWithRework(spec.entry.message, runtime?.pendingReworkGuidance);

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
    // 教训已注入本轮 entryMessage 并成功起跑 → 清 pending，避免重复注入下下轮。
    // 仅在真正起跑（startState.started）的此路径清；skip/error 路径不清，保留到下次尝试。
    pendingReworkGuidance: null,
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
    + `${startState.pipelineId ? ` loop=${startState.pipelineId}` : ""}`,
  );

  return {
    ok: true,
    skipped: false,
    automation: spec,
    runtime: nextRuntime,
    triggerResult,
  };
}
