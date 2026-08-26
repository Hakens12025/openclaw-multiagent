// lib/formal-runtime/checks/health-gateway.js — health suite TIER-1：对 LIVE gateway 的 HTTP 检查。
//
// 入口前提：/watchdog/runtime 可达；不可达 → 其余 gateway 检查全部 markBlocked（E-RUNNER-003）。
// 范围：auth 401 探针 / inspect 家族全量扫（带代表参数）/ admin-source 干净失败 /
//   路径穿越守卫 / graph HTTP↔file 一致性 / SSE connected / 8 个 explicit-confirm 闸探针
//   （绝不发 confirm:true）/ schedules 列表 / guidance drift / prompt 投影 /
//   operator-snapshot 内部一致性 / knowledge_bases + 检索 / 守护式 MUTATION 往返
//   （graph edge add→verify→delete→verify；schedule create(disabled)→disable→delete(confirm)，
//    try/finally 还原状态）。
//
// 协议注记：/watchdog/inspect 对数据源抛错回 500（routes/api.js）。「干净失败」在本套件
// 的判定 = 受控拒绝（JSON error 指名原因），而非 4xx——与现行 route 实现对齐。

import {
  BASE,
  tokens,
  httpFetch,
  loadConfig,
  addGraphEdgeViaSurface,
  deleteGraphEdgeViaSurface,
  SSEClient,
} from "../infra.js";
import { listCliSystemSurfaces } from "../../cli-system/cli-surface-registry.js";
import { isReservedControlLayerAgentId } from "../../agent/agent-plane-policy.js";
import { loadGraph } from "../../agent/agent-graph.js";
import { runCheck, markBlocked } from "./check-runner.js";

const PROBE_SESSION_ID = "health-probe-session";
const PROBE_TREE_ID = "health-probe-nonexistent";
const PROBE_SCHEDULE_ID = "health-probe-schedule";

// ── HTTP helpers（带 status；infra.fetchJSON/postAdmin 丢 status，闸探针需要 400）──
// jsonOk 区分「body 是合法 JSON（含字面量 null —— 空态 surface 的合法响应）」与「解析失败」：
// 只看 json===null 两者无法分辨，inspect 全量扫的 200 判据必须靠 jsonOk 才不误判空态为坏响应。
async function getRaw(path) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await httpFetch(`${BASE}${path}${sep}token=${encodeURIComponent(tokens.gateway)}`);
  let json = null;
  let jsonOk = false;
  try { json = JSON.parse(res.body); jsonOk = true; } catch {}
  return { status: res.status, body: res.body, json, jsonOk };
}

async function postRaw(path, payload) {
  const res = await httpFetch(`${BASE}${path}?token=${encodeURIComponent(tokens.gateway)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  return { status: res.status, body: res.body, json };
}

function inspectPath(surfaceId, params = {}) {
  const query = new URLSearchParams({ surface: surfaceId, ...params });
  return `/watchdog/inspect?${query.toString()}`;
}

// ── 代表参数表：需要参数的 inspect 数据源（2026-06-10 对照 cli-surface-inspector.js 实测）──
export function buildInspectSweepParams(probeAgentId) {
  return {
    "inspect.agent_sessions": { agentId: probeAgentId },
    "inspect.session_transcript": { agentId: probeAgentId, sessionId: PROBE_SESSION_ID },
    "inspect.session_system_prompt": { agentId: probeAgentId, sessionId: PROBE_SESSION_ID },
    "inspect.structure_preview": { surfaceId: "graph.edge.add" },
    "inspect.knowledge_search": { query: "传送带", topK: "5" },
    "inspect.knowledge_kb_search": { kbId: "wiki", query: "harness", topK: "3" },
    "inspect.knowledge_agent_search": { agentId: probeAgentId, query: "harness", topK: "3" },
    // 树读面四带参表面:合法 charset 的不存在 id → found:false 是设计内合法态,200 即通
    "inspect.run": { threadId: PROBE_TREE_ID, runId: PROBE_TREE_ID },
    "inspect.run_events": { threadId: PROBE_TREE_ID, runId: PROBE_TREE_ID },
    "inspect.run_causality": { threadId: PROBE_TREE_ID, runId: PROBE_TREE_ID },
    "inspect.contract_seal": { contractId: PROBE_TREE_ID },
  };
}

// ── explicit-confirm 闸探针：8 条破坏性路由；payload 即使闸坏被执行也无害（指向不存在的目标；
//    reset 无目标参数——闸先于动作执行，闸坏本身即是要暴露的最高级回归）。绝不发 confirm:true。──
export const CONFIRM_GATED_ROUTES = Object.freeze([
  { path: "/watchdog/agents/delete", payload: { agentId: "health-probe-nonexistent" } },
  { path: "/watchdog/agents/hard-delete", payload: { agentId: "health-probe-nonexistent" } },
  { path: "/watchdog/reset", payload: {} },
  { path: "/watchdog/schedules/delete", payload: { scheduleId: "health-probe-nonexistent" } },
  { path: "/watchdog/automations/delete", payload: { automationId: "health-probe-nonexistent" } },
  { path: "/watchdog/agent-joins/delete", payload: { joinId: "health-probe-nonexistent" } },
  { path: "/watchdog/knowledge/remove", payload: { kbId: "health-probe-nonexistent" } },
  { path: "/watchdog/charts/delete", payload: { chartId: "health-probe-nonexistent" } },
]);

function pickProbeAgent(cfg) {
  const agents = (cfg?.agents?.list || []).filter((a) => a?.id && !isReservedControlLayerAgentId(a.id));
  const entry = agents.find((a) => a.role === "bridge" || a.gateway === true || a.ingressSource);
  return (entry || agents[0])?.id || null;
}

function edgeKeySet(edges) {
  return new Set((Array.isArray(edges) ? edges : []).map((e) => `${e.from}→${e.to}`));
}

// ── 检查计划（descriptor 先建全量——reachability 失败时整体 markBlocked 保持同步）────
function buildGatewayCheckPlan({ cfg, probeAgentId }) {
  const plan = [];
  const add = (descriptor, fn) => plan.push({ descriptor, fn });

  add({ id: "gateway.auth-reject", subsystem: "gateway", title: "wrong token rejected with 401", code: "E-GW-003" }, async () => {
    const res = await httpFetch(`${BASE}/watchdog/runtime?token=health-probe-wrong-token`);
    if (res.status !== 401) return { status: "fail", evidence: `expected 401, got HTTP ${res.status} (auth gate hole)` };
    return "401 Unauthorized as expected";
  });

  // inspect 家族全量扫：注册表里 source=runtime_inspect 的每个 id（34+，数据驱动非硬编码）。
  const paramMap = buildInspectSweepParams(probeAgentId);
  const sweepIds = listCliSystemSurfaces({ family: "inspect" })
    .filter((s) => s.source === "runtime_inspect")
    .map((s) => s.id);
  for (const surfaceId of sweepIds) {
    const shortName = surfaceId.replace(/^inspect\./, "");
    add({ id: `inspect.sweep-${shortName}`, subsystem: "inspect", title: `GET ${surfaceId} returns 200 JSON`, code: "E-INSPECT-001" }, async () => {
      const params = paramMap[surfaceId] || {};
      const res = await getRaw(inspectPath(surfaceId, params));
      if (res.status !== 200 || !res.jsonOk) {
        const mapNote = paramMap[surfaceId] ? "" : " (if this surface now needs params, register one in buildInspectSweepParams, checks/health-gateway.js)";
        return { status: "fail", evidence: `HTTP ${res.status}: ${String(res.body).slice(0, 140)}${mapNote}` };
      }
      return `200 (${res.body.length}B)`;
    });
  }

  add({ id: "inspect.admin-source-clean", subsystem: "inspect", title: "admin-sourced inspect id fails cleanly with 'no data source'", code: "E-INSPECT-005" }, async () => {
    const res = await getRaw(inspectPath("agents.list"));
    if (res.status === 200) return { status: "fail", evidence: "agents.list served data via /watchdog/inspect (admin-sourced ids must have no data source there)" };
    if (!/no data source/.test(String(res.json?.error || res.body))) {
      return { status: "fail", evidence: `HTTP ${res.status} but unexpected error: ${String(res.body).slice(0, 120)}` };
    }
    return `HTTP ${res.status} with controlled 'no data source' error`;
  });

  add({ id: "inspect.path-traversal-guard", subsystem: "inspect", title: "agentId='..' rejected by path-segment guard", code: "E-INSPECT-006" }, async () => {
    const res = await getRaw(inspectPath("inspect.agent_sessions", { agentId: ".." }));
    if (res.status === 200) return { status: "fail", evidence: "traversal agentId '..' was served (guard hole in cli-surface-inspector.js)" };
    if (!/invalid agentId/.test(String(res.json?.error || res.body))) {
      return { status: "fail", evidence: `rejected but not by the segment guard: HTTP ${res.status} ${String(res.body).slice(0, 120)}` };
    }
    return `HTTP ${res.status}, guard rejected '..'`;
  });

  const graphConsistencyHint = "GET /watchdog/graph serves inspect.agent_graph -> loadGraph(); diff against ~/.openclaw/control-plane/agent-graph.json — a mismatch means the route projection diverged from the truth file";
  add({ id: "graph.http-file-consistency", subsystem: "graph", title: "GET /watchdog/graph edges match agent-graph.json", code: "E-INSPECT-003" }, async () => {
    const http = await getRaw("/watchdog/graph");
    if (http.status !== 200) return { status: "fail", evidence: `GET /watchdog/graph HTTP ${http.status}`, hint: graphConsistencyHint };
    const file = await loadGraph();
    const httpSet = edgeKeySet(http.json?.edges);
    const fileSet = edgeKeySet(file.edges);
    const onlyHttp = [...httpSet].filter((k) => !fileSet.has(k));
    const onlyFile = [...fileSet].filter((k) => !httpSet.has(k));
    if (onlyHttp.length > 0 || onlyFile.length > 0) {
      return { status: "fail", evidence: `mismatch — only-http: [${onlyHttp.join(",")}] only-file: [${onlyFile.join(",")}]`, hint: graphConsistencyHint };
    }
    return `${httpSet.size} edges identical over HTTP and file`;
  });

  add({ id: "sse.connect", subsystem: "sse", title: "SSE /watchdog/stream sends 'connected' within 5s", code: "E-SSE-001" }, async () => {
    const sse = new SSEClient();
    let timer = null;
    try {
      await Promise.race([
        sse.connect(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); }),
      ]);
      return "connected event received";
    } catch (error) {
      if (error?.message === "timeout") {
        return { status: "fail", code: "E-SSE-002", evidence: "stream open but no 'connected' event within 5000ms" };
      }
      return { status: "fail", evidence: `connect failed: ${error?.message || error}` };
    } finally {
      if (timer) clearTimeout(timer);
      sse.close();
    }
  });

  for (const route of CONFIRM_GATED_ROUTES) {
    const shortName = route.path.replace("/watchdog/", "").replace(/\//g, "-");
    add({ id: `confirm.gate-${shortName}`, subsystem: "confirm", title: `${route.path} refuses without explicitConfirm`, code: "E-CONFIRM-001" }, async () => {
      const res = await postRaw(route.path, route.payload);
      if (res.status === 200) return { status: "fail", evidence: `accepted WITHOUT explicitConfirm (HTTP 200): ${String(res.body).slice(0, 100)}` };
      if (res.status !== 400 || !/explicit confirmation/.test(String(res.json?.error || res.body))) {
        return { status: "fail", evidence: `expected 400 'explicit confirmation required', got HTTP ${res.status}: ${String(res.body).slice(0, 100)}` };
      }
      return "400 'explicit confirmation required'";
    });
  }

  add({ id: "schedule.list-surface", subsystem: "schedule", title: "GET /watchdog/schedules returns registry summary", code: "E-SCHEDULE-001" }, async () => {
    const res = await getRaw("/watchdog/schedules");
    if (res.status !== 200 || !Array.isArray(res.json?.schedules) || !res.json?.counts) {
      return { status: "fail", evidence: `HTTP ${res.status}: ${String(res.body).slice(0, 120)}` };
    }
    return `total=${res.json.counts.total} enabled=${res.json.counts.enabled}`;
  });

  add({ id: "guidance.drift-surface", subsystem: "guidance", title: "inspect.guidance_drift scan state available", code: "E-GUIDANCE-002" }, async () => {
    const res = await getRaw(inspectPath("inspect.guidance_drift"));
    if (res.status !== 200 || !Number.isFinite(res.json?.lastScanAt) || !Array.isArray(res.json?.driftedFiles)) {
      return { status: "fail", evidence: `HTTP ${res.status}: ${String(res.body).slice(0, 120)}` };
    }
    const drift = res.json.driftCount || 0;
    return `scan '${res.json.label}' driftCount=${drift}${drift > 0 ? ` [${res.json.driftedFiles.join(", ")}]` : ""} (drift = user takeover, allowed; missing-file truth is the TIER-0 marker scan)`;
  });

  add({ id: "prompt.projection-surface", subsystem: "prompt", title: "session_system_prompt projection available", code: "E-PROMPT-001" }, async () => {
    const candidates = (cfg?.agents?.list || [])
      .filter((a) => a?.id && !isReservedControlLayerAgentId(a.id))
      .map((a) => a.id);
    let agentId = probeAgentId;
    let sessionId = null;
    let mode = "reconstructed";
    for (const candidate of candidates.slice(0, 4)) {
      const sessions = await getRaw(inspectPath("inspect.agent_sessions", { agentId: candidate }));
      if (sessions.status === 200 && Array.isArray(sessions.json) && sessions.json.length > 0 && sessions.json[0]?.sessionId) {
        agentId = candidate;
        sessionId = sessions.json[0].sessionId;
        mode = "live-session";
        break;
      }
    }
    if (!sessionId) sessionId = PROBE_SESSION_ID;
    const res = await getRaw(inspectPath("inspect.session_system_prompt", { agentId, sessionId }));
    if (res.status !== 200 || res.json?.available !== true || !res.json?.report) {
      return { status: "fail", evidence: `agent=${agentId} session=${sessionId}: HTTP ${res.status} available=${res.json?.available}` };
    }
    return `${mode} agent=${agentId} chars=${res.json.report?.systemPrompt?.chars ?? "?"}`;
  });

  const snapshotConsistencyHint = "lib/operator/operator-snapshot.js buildOperatorSnapshot aggregates the same stores the inspect surfaces read; a count mismatch means one side drifted";
  add({ id: "operator.snapshot-consistency", subsystem: "operator", title: "operator-snapshot counts agree with inspect surfaces", code: "E-INSPECT-003" }, async () => {
    const snap = await getRaw("/watchdog/operator-snapshot?limit=5");
    if (snap.status !== 200) return { status: "fail", evidence: `operator-snapshot HTTP ${snap.status}`, hint: snapshotConsistencyHint };
    const problems = [];
    const runtimeCount = (cfg?.agents?.list || []).filter((a) => a?.id && !isReservedControlLayerAgentId(a.id)).length;
    const agentsTotal = snap.json?.agents?.counts?.total;
    if (agentsTotal !== runtimeCount) problems.push(`agents.total=${agentsTotal} vs configured runtime agents=${runtimeCount}`);
    if (problems.length > 0) return { status: "fail", evidence: problems.join("; "), hint: snapshotConsistencyHint };
    return `agents.total=${agentsTotal} consistent`;
  });

  add({ id: "knowledge.bases-wiki", subsystem: "knowledge", title: "wiki knowledge base registered with chunks", code: "E-KNOWLEDGE-001" }, async () => {
    const res = await getRaw(inspectPath("inspect.knowledge_bases"));
    const bases = Array.isArray(res.json?.knowledgeBases) ? res.json.knowledgeBases : [];
    const wiki = bases.find((b) => b?.id === "wiki");
    if (res.status !== 200 || !wiki) return { status: "fail", evidence: `HTTP ${res.status}, wiki KB missing (bases: ${bases.map((b) => b?.id).join(",") || "none"})` };
    if (!(wiki.chunkCount > 0)) return { status: "fail", evidence: `wiki KB present but chunkCount=${wiki.chunkCount}` };
    return `wiki KB chunkCount=${wiki.chunkCount} model=${wiki.model || "?"}`;
  });

  add({ id: "knowledge.search-results", subsystem: "knowledge", title: "knowledge_search returns results (lexical floor even if degraded)", code: "E-KNOWLEDGE-003" }, async () => {
    const res = await getRaw(inspectPath("inspect.knowledge_search", { query: "传送带 原则", topK: "5" }));
    const results = Array.isArray(res.json?.results) ? res.json.results : [];
    if (res.status !== 200 || results.length === 0) {
      return { status: "fail", evidence: `HTTP ${res.status}, ${results.length} results, degraded=${res.json?.degraded === true}` };
    }
    return `${results.length} results, degraded=${res.json?.degraded === true} (degraded=lexical-only fallback)`;
  });

  // ── MUTATION ROUND-TRIP（守护式写探针：每一步失败都在 finally 还原状态）──────────
  add({ id: "graph.mutation-edge-roundtrip", subsystem: "graph", title: "[MUTATION] graph edge add -> verify -> delete -> verify gone", code: "E-GRAPH-004" }, async () => {
    const before = await getRaw("/watchdog/graph");
    if (before.status !== 200) return { status: "fail", evidence: `baseline GET /watchdog/graph HTTP ${before.status}` };
    const baseline = edgeKeySet(before.json?.edges);
    const candidates = (cfg?.agents?.list || [])
      .filter((a) => a?.id && !isReservedControlLayerAgentId(a.id))
      .map((a) => a.id);
    let from = null;
    let to = null;
    outer: for (const a of candidates) {
      for (const b of candidates) {
        if (a !== b && !baseline.has(`${a}→${b}`)) { from = a; to = b; break outer; }
      }
    }
    if (!from) {
      return { status: "blocked", code: "E-RUNNER-005", evidence: "no free directed agent pair available to probe (graph complete or <2 runtime agents)" };
    }
    let added = false;
    try {
      const addRes = await addGraphEdgeViaSurface(from, to, { label: "health-probe" });
      if (addRes?.ok !== true || addRes?.skipped === true) {
        return { status: "fail", evidence: `add ${from}->${to} not applied: ${JSON.stringify(addRes).slice(0, 120)}` };
      }
      added = true;
      const mid = await getRaw("/watchdog/graph");
      if (!edgeKeySet(mid.json?.edges).has(`${from}→${to}`)) {
        return { status: "fail", evidence: `edge ${from}->${to} added but absent from GET /watchdog/graph` };
      }
      const delRes = await deleteGraphEdgeViaSurface(from, to);
      if (delRes?.ok !== true) {
        return { status: "fail", evidence: `delete ${from}->${to} failed: ${JSON.stringify(delRes).slice(0, 120)}` };
      }
      added = false;
      const after = await getRaw("/watchdog/graph");
      const afterSet = edgeKeySet(after.json?.edges);
      if (afterSet.has(`${from}→${to}`) || afterSet.size !== baseline.size) {
        return { status: "fail", evidence: `state not restored: edge present=${afterSet.has(`${from}→${to}`)} count ${afterSet.size} vs baseline ${baseline.size}` };
      }
      return `probe edge ${from}->${to} added, observed, deleted; baseline ${baseline.size} edges restored`;
    } finally {
      if (added) {
        try { await deleteGraphEdgeViaSurface(from, to); } catch {}
      }
    }
  });

  add({ id: "schedule.mutation-roundtrip", subsystem: "schedule", title: "[MUTATION] schedule create(disabled) -> disable -> delete(confirm)", code: "E-SCHEDULE-001" }, async () => {
    // 自愈：上一轮崩溃残留的同 id 探针先删（只删本套件自己的 probe id，confirm 仅用于自建对象）。
    await postRaw("/watchdog/schedules/delete", { scheduleId: PROBE_SCHEDULE_ID, explicitConfirm: true }).catch(() => {});
    let created = false;
    try {
      const createRes = await postRaw("/watchdog/schedules/create", {
        scheduleId: PROBE_SCHEDULE_ID,
        label: "health probe (auto-deleted by health suite)",
        // schedule-registry 要求 trigger.type==='cron' + entry.message 非空；created disabled = 永不触发
        entry: { targetAgent: probeAgentId, message: "[health-probe] inert: created disabled and deleted by the health suite" },
        trigger: { type: "cron", expr: "0 0 1 1 *" },
        enabled: false,
      });
      if (createRes.status !== 200 || createRes.json?.ok !== true) {
        return { status: "fail", evidence: `create: HTTP ${createRes.status} ${String(createRes.body).slice(0, 240)}` };
      }
      created = true;
      const listed = await getRaw("/watchdog/schedules");
      const entry = (listed.json?.schedules || []).find((s) => s?.id === PROBE_SCHEDULE_ID);
      if (!entry) return { status: "fail", evidence: "created schedule missing from GET /watchdog/schedules" };
      if (entry.enabled === true) return { status: "fail", evidence: "probe schedule created enabled despite enabled:false" };
      const disableRes = await postRaw("/watchdog/schedules/disable", { scheduleId: PROBE_SCHEDULE_ID });
      if (disableRes.status !== 200 || disableRes.json?.ok !== true) {
        return { status: "fail", evidence: `disable: HTTP ${disableRes.status} ${String(disableRes.body).slice(0, 240)}` };
      }
      const delRes = await postRaw("/watchdog/schedules/delete", { scheduleId: PROBE_SCHEDULE_ID, explicitConfirm: true });
      if (delRes.status !== 200 || delRes.json?.ok !== true || delRes.json?.deleted !== true) {
        return { status: "fail", evidence: `delete: HTTP ${delRes.status} ${String(delRes.body).slice(0, 240)}` };
      }
      created = false;
      const after = await getRaw("/watchdog/schedules");
      if ((after.json?.schedules || []).some((s) => s?.id === PROBE_SCHEDULE_ID)) {
        return { status: "fail", evidence: "probe schedule still listed after delete" };
      }
      return "create(disabled) -> listed -> disable -> delete(confirm) -> gone";
    } finally {
      if (created) {
        try { await postRaw("/watchdog/schedules/delete", { scheduleId: PROBE_SCHEDULE_ID, explicitConfirm: true }); } catch {}
      }
    }
  });

  return plan;
}

// ── 入口：runHealthGatewayChecks(run, context, { cfg })。cfg=null → 全部 block。──
export async function runHealthGatewayChecks(run, context, { cfg = null } = {}) {
  const probeAgentId = pickProbeAgent(cfg);
  const plan = buildGatewayCheckPlan({ cfg, probeAgentId });
  const reachabilityDescriptor = {
    id: "gateway.reachability",
    subsystem: "gateway",
    title: "GET /watchdog/runtime reachable with sane payload",
    code: "E-GW-001",
  };

  if (!cfg || !probeAgentId) {
    markBlocked(context, [reachabilityDescriptor, ...plan.map((p) => p.descriptor)], "E-RUNNER-005",
      "config.parse failed or no runtime agent configured — gateway checks need tokens + a probe agent");
    return;
  }

  try {
    await loadConfig(); // 复用 infra：装 tokens + 注册 runtime agents（幂等）
  } catch (error) {
    markBlocked(context, [reachabilityDescriptor, ...plan.map((p) => p.descriptor)], "E-RUNNER-005",
      `infra loadConfig failed: ${error?.message || error}`);
    return;
  }

  const reachability = await runCheck(context, reachabilityDescriptor, async () => {
    const res = await getRaw("/watchdog/runtime");
    if (res.status !== 200) return { status: "fail", evidence: `HTTP ${res.status}` };
    if (!res.json || typeof res.json.trackingSessions !== "object" || !res.json.dispatchQueue || !res.json.dispatchRuntime) {
      return { status: "fail", code: "E-GW-005", evidence: `payload malformed: keys=${Object.keys(res.json || {}).join(",")}` };
    }
    return `200, queue=${res.json.dispatchQueue.entries?.length ?? 0} tracking=${Object.keys(res.json.trackingSessions).length}`;
  });

  const bootLedgerDescriptor = {
    id: "kernel.boot-ledger",
    subsystem: "kernel",
    title: "boot dependency ledger sealed with provided count at floor (>=4)",
    code: "E-BOOT-001",
  };

  if (reachability.status !== "pass") {
    markBlocked(context, [bootLedgerDescriptor, ...plan.map((p) => p.descriptor)], "E-RUNNER-003",
      `gateway unreachable/unhealthy: ${reachability.evidence}`);
    return;
  }

  // RX-02:经 /watchdog/runtime 的 bootDeps 字段读网关进程真实封账态。
  // 下界断言(>=4 而非 ===4):接线增加不红,符合 health 计数惯例。
  await runCheck(context, bootLedgerDescriptor, async () => {
    const res = await getRaw("/watchdog/runtime");
    const bootDeps = res.json?.bootDeps;
    if (!bootDeps || bootDeps.sealed !== true || bootDeps.providedCount < 4) {
      return {
        status: "fail",
        evidence: `bootDeps=${JSON.stringify(bootDeps ?? null)} (expected sealed + provided>=4; assertComplete 未跑、种子接线缩水,或 /watchdog/runtime 未暴露 bootDeps)`,
      };
    }
    return `boot deps sealed, provided=${bootDeps.providedCount} required=${bootDeps.requiredCount}`;
  });

  for (const entry of plan) {
    await runCheck(context, entry.descriptor, entry.fn);
  }
}
