// lib/formal-runtime/suite-concurrent.js — concurrent 并发派工套件(竞态与排队,实例测试)
//
// 每 case:fullReset → prep(锚边+歧义边,钉死单跳终态链,照抄 system-action 的机关:
// caller 出边 ≥2 才不会被 graph_route 自动前送——单跳是"无双绑"判定成立的前提)
// → 几乎同时注入 N 份极简任务(顺序 await,响应序即创建序)→ 观测循环(轮询
// /watchdog/runtime 的 trackingSessions 采并发 running、dispatchRuntime.targets[caller]
// 采忙位/队列,轮询 /watchdog/work-items 采终态,SSE track_start 采会话认领与激活序)
// → 纯映射产出 CheckResult(checks/concurrent-chain.js,IO/逻辑分层照抄 system-action)。
// caller = planner 角色首位(复用 resolveSystemActionTopology,零写死 agent 名)。

import { markBlocked, runCheck } from "./checks/check-runner.js";
import {
  CONCURRENT_CASES,
  buildCaseDescriptors,
  buildConcurrentProbeMessage,
  buildConcurrentVerdicts,
  buildProbeMarker,
  mapConcurrentVerdictsToChecks,
} from "./checks/concurrent-chain.js";
import {
  SSEClient,
  fetchJSON,
  fullReset,
  loadConfig,
  postAdmin,
  sendTestInject,
  sleep,
} from "./infra.js";
import { resolveSystemActionTopology } from "./suite-collab.js";
import { parseAgentContractSessionKey } from "../session/session-keys.js";
import { CONTRACT_STATUS, isTerminalContractStatus } from "../core/runtime-status.js";

export { CONCURRENT_CASES };

const POLL_INTERVAL_MS = 1500;
const ACCEPTANCE_RESOLVE_ATTEMPTS = 10;
const ACCEPTANCE_RESOLVE_INTERVAL_MS = 2000;
const RELEASE_GRACE_MS = 20000;

// ── 受理兜底:inject 响应缺 contractId 时按 marker 从 work-items 对号(短窗)────
async function resolveMissingContractIds(probes, startMs) {
  for (let attempt = 0; attempt < ACCEPTANCE_RESOLVE_ATTEMPTS; attempt++) {
    if (probes.every((probe) => probe.contractId)) return;
    try {
      const items = await fetchJSON("/watchdog/work-items");
      for (const probe of probes) {
        if (probe.contractId) continue;
        const match = (Array.isArray(items) ? items : []).find((item) =>
          String(item?.task || "").includes(probe.marker) && Number(item?.createdAt || 0) >= startMs - 2000);
        if (match?.id) probe.contractId = match.id;
      }
    } catch {}
    if (probes.every((probe) => probe.contractId)) return;
    await sleep(ACCEPTANCE_RESOLVE_INTERVAL_MS);
  }
}

// ── 观测循环:只采信号,判定全部留给纯层 ─────────────────────────────────────
//
// 采样源:
//   running   = trackingSessions 里 status==="running" 且 sessionKey 解析出探针合约的
//               distinct 合约集(单字段 currentContract 天然只有一个,采 session 才能
//               看见"忙位被共享"的真violation)
//   queued    = dispatchRuntime.targets[caller].queue 里的探针合约
//   claims    = SSE track_start 的合约会话 sessionKey(跨 agent:双绑可能发生在别的 agent)
//   activation= 首见 running 时刻(SSE receivedAt 优先,轮询兜底)
async function observeConcurrency({ sse, probes, callerAgentId, startMs, timeoutMs }) {
  const probeIds = probes.map((probe) => probe.contractId).filter(Boolean);
  const probeSet = new Set(probeIds);
  const firstRunningAt = new Map();
  const claims = new Map();
  const observed = {
    samples: [],
    terminalStatuses: {},
    finalTargetState: null,
  };
  const noteActivation = (contractId, atMs) => {
    if (!firstRunningAt.has(contractId)) firstRunningAt.set(contractId, atMs);
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 1) SSE:认领 + 激活(track_start 的合约会话,跨 agent)
    for (const evt of sse.events) {
      if (evt.receivedAt < startMs || evt.type !== "track_start") continue;
      const parsed = parseAgentContractSessionKey(evt.data?.sessionKey);
      if (!parsed || !probeSet.has(parsed.contractId)) continue;
      if (!claims.has(parsed.contractId)) claims.set(parsed.contractId, new Set());
      claims.get(parsed.contractId).add(evt.data.sessionKey);
      noteActivation(parsed.contractId, evt.receivedAt - startMs);
    }

    // 2) dispatch-state 采样(忙位/队列)
    try {
      const runtime = await fetchJSON("/watchdog/runtime");
      const nowElapsed = Date.now() - startMs;
      const runningIds = new Set();
      for (const [sessionKey, session] of Object.entries(runtime?.trackingSessions || {})) {
        if (session?.status !== "running") continue;
        const parsed = parseAgentContractSessionKey(sessionKey);
        if (parsed && probeSet.has(parsed.contractId)) runningIds.add(parsed.contractId);
      }
      const target = runtime?.dispatchRuntime?.targets?.[callerAgentId] || null;
      const queuedIds = (Array.isArray(target?.queue) ? target.queue : [])
        .map((entry) => entry?.contractId)
        .filter((contractId) => probeSet.has(contractId));
      observed.samples.push({
        elapsedMs: nowElapsed,
        runningContractIds: [...runningIds],
        queuedContractIds: queuedIds,
      });
      for (const contractId of runningIds) noteActivation(contractId, nowElapsed);
      if (target?.currentContract && probeSet.has(target.currentContract)) {
        noteActivation(target.currentContract, nowElapsed);
      }
    } catch {}

    // 3) 终态
    try {
      const items = await fetchJSON("/watchdog/work-items");
      for (const contractId of probeIds) {
        if (observed.terminalStatuses[contractId]) continue;
        const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === contractId);
        if (item && isTerminalContractStatus(item.status)) {
          observed.terminalStatuses[contractId] = item.status;
        }
      }
    } catch {}

    if (probeIds.length > 0 && probeIds.every((contractId) => observed.terminalStatuses[contractId])) break;
    await sleep(POLL_INTERVAL_MS);
  }

  observed.activationOrder = [...firstRunningAt.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([contractId]) => contractId);
  observed.claims = Object.fromEntries([...claims].map(([contractId, keys]) => [contractId, [...keys]]));
  return observed;
}

// 全终态后给释放一个短窗:轮询至 caller 无残留或窗尽,快照留给纯层判定。
async function observeReleaseSettlement(observed, callerAgentId) {
  const graceDeadline = Date.now() + RELEASE_GRACE_MS;
  while (Date.now() < graceDeadline) {
    try {
      const runtime = await fetchJSON("/watchdog/runtime");
      const target = runtime?.dispatchRuntime?.targets?.[callerAgentId] || null;
      observed.finalTargetState = target;
      const settled = target
        && target.busy !== true
        && !target.currentContract
        && (!Array.isArray(target.queue) || target.queue.length === 0);
      if (settled) return;
    } catch {}
    await sleep(2000);
  }
}

// 超时清场:卡死的探针合约强制终态化(沿用 suite-link 的请求形状),不影响判定
// (allTerminal 的 fail 已按观测事实落账)。
async function terminalizeStuckProbes(probes, observed) {
  for (const probe of probes) {
    const contractId = probe.contractId;
    if (!contractId || observed.terminalStatuses[contractId]) continue;
    try {
      await postAdmin("/watchdog/tests/terminalize", {
        contractId,
        status: CONTRACT_STATUS.FAILED,
        source: "test_runner",
        reason: "case_timeout",
        summary: `concurrent probe ${probe.marker} not terminal within budget`,
        retryable: false,
      });
    } catch {}
  }
}

// ── 单 case 驱动 ─────────────────────────────────────────────────────────────
async function runConcurrentCase(context, sse, probeCase) {
  const topology = resolveSystemActionTopology();
  const [injectDescriptor, ...stageDescriptors] = buildCaseDescriptors(probeCase);
  const allDescriptors = [injectDescriptor, ...stageDescriptors];

  const missing = !topology.callerAgentId
    ? "no planner-role agent registered (caller missing)"
    : !topology.upstreamAgentId
      ? "no bridge-role agent registered (distinct upstream replyTo missing)"
      : null;
  if (missing) {
    markBlocked(context, allDescriptors, "E-RUNNER-005", `topology prerequisite missing: ${missing}`);
    return;
  }

  try {
    await fullReset();
  } catch (error) {
    markBlocked(context, allDescriptors, "E-RUNNER-005", `runtime reset failed: ${error?.message || error}`);
    return;
  }
  await sleep(1500);
  sse.resetBaseline();

  try {
    const startMs = Date.now();
    const nonce = startMs.toString(36);
    const probes = Array.from({ length: probeCase.injectCount }, (_, index) => ({
      marker: buildProbeMarker(probeCase.id, index, nonce),
      contractId: null,
    }));

    // 顺序 await:每个 inject 在响应(合约已铸)后才发下一个 → 响应序即创建序,
    // 全程 <1s,对 caller 而言仍是并发(首任务刚起步,其余必然进队)。
    const injectCheck = await runCheck(context, { ...injectDescriptor, code: "E-DISPATCH-001" }, async () => {
      for (let index = 0; index < probes.length; index++) {
        const probe = probes[index];
        const injectResult = await sendTestInject(
          buildConcurrentProbeMessage({ marker: probe.marker, index, total: probes.length }),
          "webui",
          { agentId: topology.upstreamAgentId, sessionKey: `agent:${topology.upstreamAgentId}:main` },
        );
        if (!injectResult?.ok) {
          return { status: "fail", evidence: `inject ${probe.marker} refused: ${JSON.stringify(injectResult).slice(0, 200)}` };
        }
        if (injectResult.targetAgent && injectResult.targetAgent !== topology.callerAgentId) {
          return {
            status: "fail",
            evidence: `ingress first hop ${injectResult.targetAgent} != expected caller ${topology.callerAgentId} for ${probe.marker}`,
          };
        }
        probe.contractId = injectResult.contractId || null;
      }
      return `${probes.length} tasks injected to caller=${topology.callerAgentId} within ${Date.now() - startMs}ms (upstream=${topology.upstreamAgentId})`;
    });
    if (injectCheck.status !== "pass") {
      markBlocked(context, stageDescriptors, "E-RUNNER-005", `prerequisite check ${injectDescriptor.id} failed`);
      return;
    }

    await resolveMissingContractIds(probes, startMs);
    const observed = await observeConcurrency({
      sse, probes, callerAgentId: topology.callerAgentId, startMs, timeoutMs: probeCase.timeoutMs,
    });
    observed.accepted = probes;

    const probeIds = probes.map((probe) => probe.contractId).filter(Boolean);
    if (probeIds.length > 0 && probeIds.every((contractId) => observed.terminalStatuses[contractId])) {
      await observeReleaseSettlement(observed, topology.callerAgentId);
    } else {
      await terminalizeStuckProbes(probes, observed);
    }

    const verdicts = buildConcurrentVerdicts(probeCase, observed);
    const checks = mapConcurrentVerdictsToChecks(probeCase, verdicts, { caseElapsedMs: Date.now() - startMs });
    for (const check of checks) context.addCheck(check);
  } finally {
    // 图夹具拆除后本套件零外部副作用,无需 cleanup(留空 finally 只为保住 try 的作用域)
  }
}

function noteRunCase(run, probeCase) {
  if (!run || typeof run !== "object") return;
  run.currentCaseId = probeCase.id;
  run.currentCaseMessage = probeCase.title;
}

// ── 套件入口(契约:runXxxSuite(run, context),只 addCheck,不写报告)─────────
export async function runConcurrentSuite(run, context) {
  await loadConfig();
  const sse = new SSEClient();
  const allCaseDescriptors = CONCURRENT_CASES.flatMap(buildCaseDescriptors);

  const sseCheck = await runCheck(context, {
    id: "concurrent.sse-stream", subsystem: "concurrent", title: "SSE stream connected", code: "E-SSE-001",
  }, async () => {
    await sse.connect();
    return `connected to /watchdog/stream (${sse.events.length} replay events)`;
  });
  if (sseCheck.status !== "pass") {
    markBlocked(context, allCaseDescriptors, "E-RUNNER-005", "SSE stream unavailable: claim/activation signals cannot be observed");
    sse.close();
    return;
  }

  try {
    for (const probeCase of CONCURRENT_CASES) {
      noteRunCase(run, probeCase);
      await runConcurrentCase(context, sse, probeCase);
    }
  } finally {
    sse.close();
  }
}
