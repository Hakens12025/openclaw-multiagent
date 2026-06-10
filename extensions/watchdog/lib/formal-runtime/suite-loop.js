// lib/formal-runtime/suite-loop.js — loop preset 驱动器（compose → start → 预算收敛 → 清理）
//
// 前置条件：graph 已有可跑的环 —— 注册 loop（active=true）或检测到的 cycle（成员都是
// 已知节点）。两者都没有 → 全部检查 skip（E-LOOP-SKIP，evidence 带当前 edges），绝不为了
// 测试凭空造边（边 = 授权）。选中环后以固定 loopId 重新 compose 并声明 maxRounds:1：
//   compose            E-LOOP-001（响应须 ok）
//   budget-echo        E-LOOP-002（budgetSource.maxRounds=declared / resolvedBudget.maxRounds=1）
//   registered-active  E-LOOP-003（loop.active=true，missingEdges=[]）
//   start              E-LOOP-007（runtime.loop.start action=started；loop_started SSE 记入证据）
//   terminal-converged E-LOOP-004（loop-session 真值收敛：status=concluded；超时则 interrupt 清场）
//   rounds-in-budget   E-LOOP-005（session.round / budget.usedRounds ≤ maxRounds）
//   cleanup-delete     E-LOOP-006（finally 删除 composed loop）
// 注：loop_concluded/loop_advanced 在 event-types.js 有定义但当前无发射点（已核实），
// 终态判定只信 loop-session 真值（GET /watchdog/graph/loop-sessions）。
// 兜底保险：graph / loop-registry / loop-session 三个文件由 test-runs.js 的
// withPreservedRuntimeGraph（RUNTIME_CONTROL_STATE_FILES）整体快照并在 run 结束恢复。

import {
  fetchJSON,
  loadConfig,
  postAdmin,
  sleep,
} from "./infra.js";
import { runCheck, markBlocked } from "./checks/check-runner.js";
import { resolveSuiteSse } from "./suite-link.js";

const LOOP_CHECK_LOOP_ID = "formal-loop-check";
const LOOP_MAX_ROUNDS = 1;
const LOOP_TERMINAL_WAIT_MS = 480000;
const LOOP_SESSION_POLL_MS = 3000;
const LOOP_STARTED_EVENT_WAIT_MS = 20000;
const LOOP_TASK = "回路自检：请用一句话说明你收到了这个回路任务，然后照常完成你的环节并停止。";

export const LOOP_STAGE_DESCRIPTORS = Object.freeze([
  { id: "loop.compose", subsystem: "loop", title: "compose check loop with declared maxRounds=1", code: "E-LOOP-001" },
  { id: "loop.budget-echo", subsystem: "loop", title: "compose response echoes declared budget", code: "E-LOOP-002" },
  { id: "loop.registered-active", subsystem: "loop", title: "registered loop active with no missing edges", code: "E-LOOP-003" },
  { id: "loop.start", subsystem: "loop", title: "runtime loop start accepted", code: "E-LOOP-007" },
  { id: "loop.terminal-converged", subsystem: "loop", title: "loop session converged under budget governance", code: "E-LOOP-004" },
  { id: "loop.rounds-within-budget", subsystem: "loop", title: "round count within declared maxRounds", code: "E-LOOP-005" },
  { id: "loop.cleanup-delete", subsystem: "loop", title: "composed check loop deleted (registry restored)", code: "E-LOOP-006" },
].map(Object.freeze));

// ── 纯逻辑（单测覆盖）────────────────────────────────────────────────────────────

// 选环：优先注册且 active 的 loop（顺其 nodes/entry），否则 graph cycle（成员均为已知节点）。
// 选不出 → null（→ 全部 skip）。永不指名具体 agent —— 全部来自 graph 真值。
export function selectLoopTarget({ loops = [], cycles = [], graphNodeIds = [] } = {}) {
  const nodeSet = new Set(Array.isArray(graphNodeIds) ? graphNodeIds : []);
  const activeLoop = (Array.isArray(loops) ? loops : []).find((loop) => (
    loop?.active === true && Array.isArray(loop.nodes) && loop.nodes.length >= 2
  ));
  if (activeLoop) {
    return {
      source: `registered_loop:${activeLoop.id}`,
      agents: [...activeLoop.nodes],
      entryAgentId: activeLoop.entryAgentId || activeLoop.nodes[0],
    };
  }
  const cycle = (Array.isArray(cycles) ? cycles : []).find((members) => (
    Array.isArray(members) && members.length >= 2
    && (nodeSet.size === 0 || members.every((agentId) => nodeSet.has(agentId)))
  ));
  if (cycle) {
    return { source: "graph_cycle", agents: [...cycle], entryAgentId: cycle[0] };
  }
  return null;
}

// 预算回显断言（v141 透明度面：compose 响应必须让有效上限可见）。
export function evaluateBudgetEcho(response, expectedMaxRounds) {
  const resolved = response?.resolvedBudget?.maxRounds;
  const source = response?.budgetSource?.maxRounds;
  const evidence = `resolvedBudget.maxRounds=${resolved ?? "missing"}; budgetSource.maxRounds=${source ?? "missing"}`;
  return { ok: resolved === expectedMaxRounds && source === "declared", evidence };
}

// 收敛判定：concluded 即收敛（reason 进证据；预算治理路径为 loop_budget_exhausted:*）。
export function evaluateLoopConvergence(session) {
  if (!session) {
    return { converged: false, evidence: "no loop session found for the composed loop" };
  }
  const evidence = `status=${session.status || "?"}; reason=${session.concludeReason || "--"}; round=${Number.isFinite(session.round) ? session.round : "--"}; stage=${session.currentStage || "--"}`;
  return { converged: session.status === "concluded", evidence };
}

// 轮次断言：session.round 与 budget.usedRounds 都不得超过声明上限。
export function evaluateLoopRounds(session, maxRounds) {
  const round = Number.isFinite(session?.round) ? session.round : null;
  const usedRounds = Number.isFinite(session?.budget?.usedRounds) ? session.budget.usedRounds : null;
  const evidence = `round=${round ?? "--"}; budget.usedRounds=${usedRounds ?? "--"}; declared maxRounds=${maxRounds}`;
  const overrun = (round != null && round > maxRounds) || (usedRounds != null && usedRounds > maxRounds);
  return { ok: session != null && !overrun, evidence };
}

export function summarizeGraphEdges(edges, limit = 8) {
  const list = Array.isArray(edges) ? edges : [];
  const sample = list.slice(0, limit).map((edge) => `${edge?.from}->${edge?.to}`).join(", ");
  return `graph has ${list.length} edges${sample ? `: ${sample}` : ""}${list.length > limit ? ", …" : ""}`;
}

// ── 默认 deps（单测可整体 stub）──────────────────────────────────────────────────

export function buildDefaultLoopDeps() {
  return {
    now: Date.now,
    sleep,
    prepare: () => loadConfig(),
    readGraph: () => fetchJSON("/watchdog/graph"),
    compose: (payload) => postAdmin("/watchdog/graph/loop/compose", payload),
    start: (payload) => postAdmin("/watchdog/runtime/loop/start", payload),
    interrupt: (loopId) => postAdmin("/watchdog/runtime/loop/interrupt", { loopId, reason: "formal_loop_check_cleanup" }),
    deleteLoop: (loopId) => postAdmin("/watchdog/graph/loop/delete", { loopId }),
    readLoopSessions: () => fetchJSON("/watchdog/graph/loop-sessions"),
  };
}

// 找属于本次 compose loop 的最新 session（活跃优先，其次 recent 列表头部）。
function pickLoopSession(view, loopId) {
  if (view?.activeSession?.loopId === loopId) return { session: view.activeSession, active: true };
  const recent = (Array.isArray(view?.sessions) ? view.sessions : []).find((session) => session?.loopId === loopId) || null;
  return { session: recent, active: false };
}

// 轮询 loop-session 真值直到 concluded/failed 或超时。
async function waitForLoopTerminal(d, loopId, waitMs) {
  const deadline = d.now() + waitMs;
  let lastSeen = null;
  while (d.now() < deadline) {
    try {
      const view = await d.readLoopSessions();
      const { session, active } = pickLoopSession(view, loopId);
      if (session) lastSeen = session;
      if (session && !active && (session.status === "concluded" || session.status === "failed")) {
        return { session, timedOut: false };
      }
    } catch {}
    await d.sleep(LOOP_SESSION_POLL_MS);
  }
  return { session: lastSeen, timedOut: true };
}

// ── suite 驱动 ────────────────────────────────────────────────────────────────

export async function runLoopSuite(run, context, { deps = null } = {}) {
  const d = { ...buildDefaultLoopDeps(), ...(deps || {}) };

  let graphView;
  try {
    await d.prepare();
    graphView = await d.readGraph();
  } catch (error) {
    markBlocked(context, LOOP_STAGE_DESCRIPTORS, "E-RUNNER-003", `gateway prerequisite failed: ${error.message}`);
    return;
  }

  const target = selectLoopTarget({
    loops: graphView?.loops,
    cycles: graphView?.cycles,
    graphNodeIds: (Array.isArray(graphView?.nodes) ? graphView.nodes : []).map((node) => node?.id).filter(Boolean),
  });
  if (!target) {
    const evidence = `no registered active loop and no composable cycle; ${summarizeGraphEdges(graphView?.edges)}`;
    for (const descriptor of LOOP_STAGE_DESCRIPTORS) {
      context.addCheck({ ...descriptor, status: "skip", code: "E-LOOP-SKIP", evidence, durationMs: 0 });
    }
    return;
  }

  const loopId = LOOP_CHECK_LOOP_ID;
  const [composeStage, echoStage, activeStage, startStage, convergeStage, roundsStage, cleanupStage] = LOOP_STAGE_DESCRIPTORS;
  const { sse, owned } = await resolveSuiteSse(run, context);
  let composed = false;
  let composeResponse = null;
  let terminalSession = null;
  let loopStillActive = false;

  try {
    const composeCheck = await runCheck(context, composeStage, async () => {
      composeResponse = await d.compose({
        loopId,
        agents: target.agents,
        entryAgentId: target.entryAgentId,
        maxRounds: LOOP_MAX_ROUNDS,
        label: "formal loop check",
      });
      if (composeResponse?.ok !== true) {
        return { status: "fail", evidence: `compose rejected: ${JSON.stringify(composeResponse)?.slice(0, 200)}` };
      }
      composed = true;
      return `composed ${target.agents.join(" -> ")} (entry=${target.entryAgentId}, source=${target.source}); registry/session files restored by withPreservedRuntimeGraph`;
    });
    if (composeCheck.status !== "pass") {
      markBlocked(context, LOOP_STAGE_DESCRIPTORS.slice(1), "E-RUNNER-005", `prerequisite ${composeCheck.id} failed (${composeCheck.code})`);
      return;
    }

    await runCheck(context, echoStage, () => {
      const verdict = evaluateBudgetEcho(composeResponse, LOOP_MAX_ROUNDS);
      return verdict.ok ? verdict.evidence : { status: "fail", evidence: verdict.evidence };
    });

    await runCheck(context, activeStage, () => {
      const loop = composeResponse?.loop || null;
      const missing = Array.isArray(loop?.missingEdges) ? loop.missingEdges : [];
      if (loop?.active === true && missing.length === 0) {
        return `loop ${loop.id} active; missingEdges=[]`;
      }
      return { status: "fail", evidence: `active=${loop?.active}; missingEdges=${JSON.stringify(missing)}` };
    });

    const startCheck = await runCheck(context, startStage, async () => {
      const startResponse = await d.start({
        loopId,
        startAgent: target.entryAgentId,
        requestedTask: LOOP_TASK,
        requestedSource: "watchdog.formal.loop-check",
      });
      if (startResponse?.ok === false || startResponse?.action !== "started") {
        return { status: "fail", evidence: `start refused: ${JSON.stringify(startResponse)?.slice(0, 200)}` };
      }
      loopStillActive = true;
      let eventNote = "sse unavailable (poll-only)";
      if (sse) {
        const evt = await sse.waitFor(
          (e) => e.type === "alert" && e.data?.type === "loop_started" && e.data?.loopId === loopId,
          LOOP_STARTED_EVENT_WAIT_MS,
        );
        eventNote = evt ? "loop_started observed via SSE" : `loop_started not seen within ${LOOP_STARTED_EVENT_WAIT_MS}ms (session store remains truth)`;
      }
      return `started (session=${startResponse.loopSessionId || "?"}, contract=${startResponse.contractId || "?"}); ${eventNote}`;
    });
    if (startCheck.status !== "pass") {
      markBlocked(context, [convergeStage, roundsStage], "E-RUNNER-005", `prerequisite ${startCheck.id} failed (${startCheck.code})`);
      return;
    }

    const convergeCheck = await runCheck(context, convergeStage, async () => {
      const { session, timedOut } = await waitForLoopTerminal(d, loopId, LOOP_TERMINAL_WAIT_MS);
      terminalSession = session;
      if (timedOut) {
        try { await d.interrupt(loopId); } catch {}
        const snapshot = session ? `last session: status=${session.status}; round=${session.round}; stage=${session.currentStage || "--"}` : "no session observed";
        return { status: "fail", evidence: `loop not terminal within ${LOOP_TERMINAL_WAIT_MS}ms; ${snapshot}; interrupted for cleanup` };
      }
      loopStillActive = false;
      const verdict = evaluateLoopConvergence(session);
      return verdict.converged ? verdict.evidence : { status: "fail", evidence: verdict.evidence };
    });
    if (convergeCheck.status !== "pass") {
      markBlocked(context, [roundsStage], "E-RUNNER-005", `prerequisite ${convergeCheck.id} failed (${convergeCheck.code})`);
      return;
    }

    await runCheck(context, roundsStage, () => {
      const verdict = evaluateLoopRounds(terminalSession, LOOP_MAX_ROUNDS);
      return verdict.ok ? verdict.evidence : { status: "fail", evidence: verdict.evidence };
    });
  } finally {
    if (loopStillActive) {
      try { await d.interrupt(loopId); } catch {}
    }
    // compose 没成功时无物可删：cleanup 检查已在 compose 失败的 blocked 级联中标记。
    if (composed) {
      await runCheck(context, cleanupStage, async () => {
        const deleteResponse = await d.deleteLoop(loopId);
        if (deleteResponse?.ok !== true) {
          return { status: "fail", evidence: `delete rejected: ${JSON.stringify(deleteResponse)?.slice(0, 200)}` };
        }
        return `loop ${loopId} deleted; underlying files also restored by withPreservedRuntimeGraph (lib/test-runs.js)`;
      });
    }
    if (owned && sse) sse.close();
  }
}
