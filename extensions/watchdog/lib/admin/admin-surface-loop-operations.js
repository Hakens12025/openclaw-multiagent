import {
  findActiveGraphLoopsByMemberAgent,
  listResolvedGraphLoops,
} from "../loop/graph-loop-registry.js";
import {
  startLoopRound,
} from "../loop/loop-round-runtime.js";
import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";
import { normalizeString } from "../core/normalize.js";
import { normalizeOperatorContext } from "../operator/operator-context.js";

export function resolveLoopTargetId(payload) {
  return normalizeString(payload.loopId)
    || null;
}

export function buildAdminWakeup(runtimeContext, logger) {
  if (!runtimeContext?.api) {
    return null;
  }
  return async (targetAgentId, wakeOptions = {}) => runtimeWakeAgentDetailed(
    targetAgentId,
    "loop 控制唤醒: 请读取 inbox/contract.json 并执行当前阶段",
    runtimeContext.api,
    logger,
    {
      sessionKey: wakeOptions?.sessionKey || null,
    },
  );
}

function resolveLoopStartTarget({
  requestedLoopId = null,
  requestedStartAgent = null,
  loops,
}) {
  const resolvedLoops = Array.isArray(loops) ? loops : [];
  if (requestedLoopId) {
    const targetLoop = resolvedLoops.find((loop) => loop?.id === requestedLoopId) || null;
    return {
      targetLoop,
      resolution: targetLoop ? "loop_id" : "missing_loop_id",
      matchingLoopIds: targetLoop ? [targetLoop.id] : [],
    };
  }
  if (requestedStartAgent) {
    const matchingLoops = findActiveGraphLoopsByMemberAgent(resolvedLoops, requestedStartAgent);
    return {
      targetLoop: matchingLoops.length === 1 ? matchingLoops[0] : null,
      resolution: matchingLoops.length === 1
        ? "member_agent"
        : matchingLoops.length > 1
          ? "ambiguous_member_agent"
          : "missing_member_agent",
      matchingLoopIds: matchingLoops.map((loop) => loop.id),
    };
  }
  const activeLoops = resolvedLoops.filter((loop) => loop?.active === true);
  if (activeLoops.length === 1) {
    return {
      targetLoop: activeLoops[0],
      resolution: "single_active_loop",
      matchingLoopIds: [activeLoops[0].id],
    };
  }
  if (resolvedLoops.length === 1) {
    return {
      targetLoop: resolvedLoops[0],
      resolution: "single_registered_loop",
      matchingLoopIds: [resolvedLoops[0].id],
    };
  }
  return {
    targetLoop: null,
    resolution: "ambiguous_loop",
    matchingLoopIds: activeLoops.map((loop) => loop.id),
  };
}

export async function startRuntimeLoop({
  payload,
  logger,
  runtimeContext,
}) {
  if (!runtimeContext?.api) {
    throw new Error("missing runtime context for runtime.loop.start");
  }

  const requestedTask = normalizeString(payload.requestedTask)
    || null;
  if (!requestedTask) {
    throw new Error("missing requestedTask");
  }

  const requestedLoopId = resolveLoopTargetId(payload);
  const requestedStartAgent = normalizeString(payload.startAgent) || null;

  const loops = await listResolvedGraphLoops();
  const resolvedTarget = resolveLoopStartTarget({
    requestedLoopId,
    requestedStartAgent,
    loops,
  });
  const targetLoop = resolvedTarget.targetLoop;

  if (!targetLoop) {
    if (requestedLoopId) {
      return {
        ok: false,
        action: "missing_loop",
        error: `unknown loop id: ${requestedLoopId}`,
      };
    }
    if (requestedStartAgent) {
      if (resolvedTarget.resolution === "ambiguous_member_agent") {
        return {
          ok: false,
          action: "ambiguous_loop",
          error: `startAgent ${requestedStartAgent} matches multiple active loops`,
          matchingLoopIds: resolvedTarget.matchingLoopIds,
        };
      }
      return {
        ok: false,
        action: "missing_loop",
        error: `no active loop member found for startAgent ${requestedStartAgent}`,
      };
    }
    return {
      ok: false,
      action: "ambiguous_loop",
      error: "could not resolve a single loop to start",
      activeLoopIds: loops.filter((loop) => loop?.active === true).map((loop) => loop.id),
    };
  }

  const resolvedStartAgent = requestedStartAgent || targetLoop.entryAgentId;
  if (!Array.isArray(targetLoop.nodes) || !targetLoop.nodes.includes(resolvedStartAgent)) {
    return {
      ok: false,
      action: "invalid_stage",
      error: `startAgent ${resolvedStartAgent} is not part of loop ${targetLoop.id}`,
      loopId: targetLoop.id,
    };
  }

  if (targetLoop.active !== true) {
    return {
      ok: false,
      action: "loop_broken",
      error: "loop is not structurally active",
      loopId: targetLoop.id,
      missingEdges: Array.isArray(targetLoop.missingEdges) ? targetLoop.missingEdges : [],
    };
  }

  const operatorContext = normalizeOperatorContext({
    originDraftId: runtimeContext?.originDraftId,
    originExecutionId: runtimeContext?.originExecutionId,
    originSurfaceId: runtimeContext?.originSurfaceId,
  });

  const result = await startLoopRound(
    {
      pipelineId: targetLoop.id,
      loopId: targetLoop.id,
      startAgent: resolvedStartAgent,
      requestedTask,
      requestedSource: normalizeString(payload.requestedSource) || "runtime.loop.start",
      operatorContext,
    },
    buildAdminWakeup(runtimeContext, logger),
    runtimeContext.enqueue,
    null,
    logger,
  );

  return {
    ok: result?.action === "started",
    requestedTask,
    requestedLoopId,
    requestedStartAgent,
    resolvedLoopId: targetLoop.id,
    resolvedEntryAgent: targetLoop.entryAgentId,
    resolvedStartAgent,
    ...result,
  };
}
