// lib/cli-system/cli-surface-inspector.js — inspect family 读路径收口
//
// 与 cli-surface-executor.js（apply 写路径）对称：inspect surface 是只读
// 观测入口。此模块负责把 inspect surface 解析 + 校验后，分发到对应的
// runtime 数据源，使 operator 经正式 surface 读取，而非直读 store。
//
// 红线：operator 不准绕过 CLI-system 直读 runtime 真值。本模块是
// inspect surface 的唯一 dispatch 点，不改任何数据语义（行为等价于原直读）。

import { normalizeString } from "../core/normalize.js";
import { listRecentHarnessRuns } from "../harness/harness-run-store.js";
import { summarizeHarnessRegistry } from "../harness/harness-registry.js";
import { listResolvedGraphLoops } from "../loop/graph-loop-registry.js";
import { getActiveResolvedLoopSession, listResolvedLoopSessions } from "../loop/loop-session-store.js";
import { listResolvedGroupSessions } from "../agent/group-session-store.js";
import { summarizeScheduleRegistry } from "../schedule/schedule-registry.js";
import { summarizeAgentJoinRegistry } from "../agent/agent-join-registry.js";
import { listTestRuns } from "../test-runs.js";
import { loadGraph } from "../agent/agent-graph.js";
import { computeAgentWorkflows } from "../agent/agent-workflow-grouping.js";
import { listAgentSessions } from "../agent/agent-session-store.js";
import { readSessionTranscript } from "../agent/agent-session-transcript.js";
import { readSessionSystemPrompt } from "../agent/agent-session-system-prompt.js";
import { getGuidanceDriftState } from "../agent/agent-guidance-drift-state.js";
import { summarizeSystemActionDeliveryTickets } from "../routing/delivery-system-action-ticket.js";
import { summarizePendingSignalRegistry } from "../runtime/pending-signal-registry.js";
import { listLifecycleWorkItems } from "../contracts.js";
import { listAdminChangeSets } from "../admin/admin-change-sets.js";
import { listAutomationRuntimeStates, summarizeAutomationRuntimeRegistry } from "../automation/automation-runtime.js";
import { projectStructureAfter } from "../control-plane/structure-snapshot.js";
import { listTrackingStates } from "../store/tracker-store.js";
import { getRecentTaskHistory } from "../store/task-history-store.js";
import { loadCapabilityRegistry } from "../capability/capability-registry.js";
import { searchWiki } from "../operator/wiki-rag-search.js";
import { summarizeKnowledgeBases, searchKb, searchAgentKnowledge } from "../operator/knowledge-base.js";
import { listCharts } from "../control-plane/chart-registry.js";
import { listKnowledgeEvalSets } from "../operator/knowledge-eval-registry.js";
import { listKnowledgeEvalRuns } from "../operator/knowledge-eval-runner.js";
import { inspectCliRuntimeState } from "./cli-runtime-inspector.js";
import { getCliSystemSurface } from "./cli-surface-registry.js";

// Path-segment guard for inspect surfaces that build filesystem paths from agentId/sessionId. The HTTP
// /watchdog/inspect route forwards query params verbatim (routes/api.js), so an unchecked ".." or path
// separator could escape the agents/ or session-archive/ root (path traversal). Strict charset (no
// separators) + reject the "."/".." segments = the smallest single-source gate at the dispatch boundary.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;
function assertSafePathSegment(value, label) {
  const v = normalizeString(value);
  if (!v || !SAFE_PATH_SEGMENT.test(v) || v === "." || v === "..") {
    throw new Error(`invalid ${label}: must match [A-Za-z0-9._-] with no path traversal`);
  }
  return v;
}

const INSPECT_SOURCES = Object.freeze({
  // inspect.harness_runs → HarnessRun store 近期记录（收口 listRecentHarnessRuns 直读）
  "inspect.harness_runs": ({ limit } = {}) => listRecentHarnessRuns(limit),
  // inspect.harness_catalog → harness 模块+profile 目录（operator/UI 组装前发现可用模块与方案）
  "inspect.harness_catalog": () => summarizeHarnessRegistry(),
  // inspect.graph_loops → 已解析 graph loop（透传 { graph }）
  "inspect.graph_loops": ({ graph = null } = {}) => listResolvedGraphLoops({ graph }),
  // inspect.loop_sessions → 已解析 loop session（透传 { loops }）
  "inspect.loop_sessions": ({ loops = null } = {}) => listResolvedLoopSessions({ loops }),
  // inspect.active_loop_session → 当前活跃 loop session（透传 { loops }）
  "inspect.active_loop_session": ({ loops = null } = {}) => getActiveResolvedLoopSession({ loops }),
  // inspect.agent_groups → GroupSession 运行态（active + recent，组内成员完成状态）。
  // AgentGroup 是宏，runtime 真值只在 GroupSession——收口直读 group-session-store 旁路。
  "inspect.agent_groups": () => listResolvedGroupSessions(),
  // inspect.runtime_state → dispatch runtime + tracking + history/chain 计数（复用 cli-runtime-inspector，无参，同步源）
  "inspect.runtime_state": () => inspectCliRuntimeState(),
  // inspect.schedules → schedule registry 汇总（透传 options）
  "inspect.schedules": (options = {}) => summarizeScheduleRegistry(options),
  // inspect.agent_joins → agent-join registry 汇总（透传 options）
  "inspect.agent_joins": (options = {}) => summarizeAgentJoinRegistry(options),
  // inspect.test_runs → test-run registry 运行态（无参，同步源）
  "inspect.test_runs": () => listTestRuns(),
  // inspect.agent_graph → agent graph edge 拓扑（无参）
  "inspect.agent_graph": () => loadGraph(),
  // inspect.agent_workflows → agent-graph 无向连通分量（纯函数 computeAgentWorkflows，源经 loadGraph）
  "inspect.agent_workflows": async () => computeAgentWorkflows(await loadGraph()),
  // inspect.agent_sessions → 指定 agent 的 sessions.json 摘要列表（按 updatedAt 倒序；透传 agentId）
  "inspect.agent_sessions": ({ agentId } = {}) => listAgentSessions(assertSafePathSegment(agentId, "agentId")),
  // inspect.session_transcript → 指定 agent/session 的 .jsonl 解析（消息 + 引用文件）。
  // contractId 由 session 列表解析（sessionKey→contractId），用于 inbox contract 正本路径还原。
  "inspect.session_transcript": async ({ agentId, sessionId } = {}) => {
    const safeAgentId = assertSafePathSegment(agentId, "agentId");
    const safeSessionId = assertSafePathSegment(sessionId, "sessionId");
    const sessions = await listAgentSessions(safeAgentId);
    const matched = sessions.find((s) => s.sessionId === safeSessionId) || null;
    return readSessionTranscript(safeAgentId, safeSessionId, { contractId: matched?.contractId ?? null });
  },
  // inspect.session_system_prompt → 指定 agent/session 的系统提示词拼装报告（注入文件补 persistent；透传 agentId/sessionId）
  "inspect.session_system_prompt": ({ agentId, sessionId } = {}) =>
    readSessionSystemPrompt(assertSafePathSegment(agentId, "agentId"), assertSafePathSegment(sessionId, "sessionId")),
  // inspect.guidance_drift → guidance drift state（无参）
  "inspect.guidance_drift": () => getGuidanceDriftState(),
  // inspect.delivery_tickets → system_action delivery ticket 汇总（透传 options）
  "inspect.delivery_tickets": (options = {}) => summarizeSystemActionDeliveryTickets(options),
  // inspect.pending_signals → pending-signal registry 聚合快照（透传 options，同步源）
  "inspect.pending_signals": (options = {}) => summarizePendingSignalRegistry(options),
  // inspect.work_items → contract lifecycle work item（无参）
  "inspect.work_items": () => listLifecycleWorkItems(),
  // inspect.change_sets → admin change-set 草稿（无参）
  "inspect.change_sets": () => listAdminChangeSets(),
  // inspect.automation_runtime → automation runtime state 列表（无参）
  "inspect.automation_runtime": () => listAutomationRuntimeStates(),
  // inspect.automation_runtime_summary → automation runtime registry 汇总（透传 options）
  "inspect.automation_runtime_summary": (options = {}) => summarizeAutomationRuntimeRegistry(options),
  // inspect.profile_lifecycle → ProfileLifecycle 尾段只读投影（P4 死链 c / P5 接口补全）。
  // 复用既有 summarizeAutomationRuntimeRegistry 投影，只在读路径裁出 trustLevel/status/
  // streak/governance 熔断，供 operator 观测自治治理状态。不碰执行与决策路径。
  "inspect.profile_lifecycle": (options = {}) => projectProfileLifecycle(options),
  // inspect.structure_preview → 结构快照投影（projectStructureAfter）。给定待应用的 surface 改动
  // (options.surfaceId + options.payload)，非破坏性算出改动后结构(edgeDiff + projected)，供 apply 前
  // CLI 预览。只读不碰 live —— 守门方/operator 据此检测改动效果。
  "inspect.structure_preview": (options = {}) => projectStructureAfter(options),
  // inspect.tracking_states → tracker store 全量 tracking state（无参，同步源；SSE 初始快照读路径）
  "inspect.tracking_states": () => listTrackingStates(),
  // inspect.recent_task_history → task-history store 近期记录（透传 limit，默认 10；SSE 历史快照读路径）
  "inspect.recent_task_history": ({ limit = 10 } = {}) => getRecentTaskHistory(limit),
  // inspect.capability_registry → capability registry 组装快照（无参；route 观测读）
  "inspect.capability_registry": () => loadCapabilityRegistry(),
  // inspect.knowledge_search → wiki-RAG 语义检索（embed query → cosine top-K over wiki-only index）。
  // searchWiki 永不 throw（embed/index 不可用 → degraded），不污染 operator 路径。
  "inspect.knowledge_search": ({ query, topK } = {}) => searchWiki(query, { topK: Number(topK) || 5 }),
  // inspect.knowledge_bases → 多知识库注册表概览(库/chunk 数/源),供管理 UI + operator 发现可检索的库
  "inspect.knowledge_bases": () => summarizeKnowledgeBases(),
  // inspect.charts → chart 控制面注册表全量已规范化列表(非真值,charts.json)。收口直读 store 旁路。
  "inspect.charts": () => listCharts(),
  // inspect.knowledge_eval_sets → 某 KB(或全部)的召回评测集(query→expectedSourcePath 标注集),供评测面板 + operator
  "inspect.knowledge_eval_sets": async ({ kbId = null } = {}) => {
    const evalSets = await listKnowledgeEvalSets(kbId);
    return { kbId: kbId || null, counts: { total: evalSets.length }, evalSets };
  },
  // inspect.knowledge_eval_runs → 历史评测运行摘要(recall@k/MRR/byCategory),newest-first,供趋势对比
  "inspect.knowledge_eval_runs": ({ kbId = null, evalSetId = null, limit = 20 } = {}) =>
    listKnowledgeEvalRuns({ kbId, evalSetId, limit: Number(limit) || 20 }),
  // inspect.knowledge_kb_search → 对任意 KB 做 hybrid 检索(非仅 wiki),返回结果带 meta(source/time/fields);
  // 时态库还带 conflictHints(跨源分歧)。asOf=点时过滤(防未来泄漏)。operator/UI 检索任意库的正式入口。
  "inspect.knowledge_kb_search": ({ kbId, query, topK, asOf } = {}) =>
    searchKb(normalizeString(kbId), query, { topK: Number(topK) || 5, asOf: normalizeString(asOf) || null }),
  // inspect.knowledge_agent_search → 按 agentId 聚合该 agent 绑定库(可选 ∪global)做跨库 hybrid 检索,
  // 结果标注 kbId/byKb 分组。**operator/UI 验证+调试入口**(agentId 是 operator 指定的可信查询目标,
  // 非 belt agent 自报身份)——agent 运行时自动消费走 v155 hook 注入,不经此面。
  "inspect.knowledge_agent_search": ({ agentId, query, topK, asOf, includeGlobal } = {}) =>
    searchAgentKnowledge(normalizeString(agentId), query, {
      topK: Number(topK) || 5,
      asOf: normalizeString(asOf) || null,
      includeGlobal: includeGlobal === true || includeGlobal === "true",
    }),
});

// ProfileLifecycle 只读投影（读路径内裁出，复用 automation runtime summary 既有数据，
// 不跨域改 automation-governance 决策核心）。
async function projectProfileLifecycle(options = {}) {
  const registry = await summarizeAutomationRuntimeRegistry(options);
  const automations = Array.isArray(registry?.automations) ? registry.automations : [];
  const profiles = automations.map((entry) => ({
    automationId: entry?.summary?.id || entry?.id || null,
    runtimeStatus: entry?.summary?.runtimeStatus || null,
    governanceSnapshotDisabled: entry?.summary?.governanceSnapshotDisabled === true,
    profileLifecycle: entry?.summary?.profileLifecycle || null,
  }));
  const withLifecycle = profiles.filter((entry) => entry.profileLifecycle != null);
  const countByTrustLevel = (level) => withLifecycle
    .filter((entry) => entry.profileLifecycle?.trustLevel === level).length;
  return {
    profiles,
    counts: {
      total: profiles.length,
      withLifecycle: withLifecycle.length,
      retired: withLifecycle.filter((entry) => entry.profileLifecycle?.status === "retired").length,
      governanceDisabled: profiles.filter((entry) => entry.governanceSnapshotDisabled === true).length,
      byTrustLevel: {
        experimental: countByTrustLevel("experimental"),
        provisional: countByTrustLevel("provisional"),
        stable: countByTrustLevel("stable"),
      },
    },
  };
}

export async function inspectCliSystemSurface({
  surfaceId,
  params = {},
} = {}) {
  const normalizedSurfaceId = normalizeString(surfaceId);
  const surface = getCliSystemSurface(normalizedSurfaceId);
  if (!surface) {
    throw new Error(`unknown cli-system surface: ${normalizedSurfaceId || "unknown"}`);
  }
  if (surface.family !== "inspect") {
    throw new Error(`cli-system surface is not inspect family: ${normalizedSurfaceId}`);
  }
  const source = INSPECT_SOURCES[normalizedSurfaceId];
  if (typeof source !== "function") {
    throw new Error(`cli-system inspect surface has no data source: ${normalizedSurfaceId}`);
  }
  return source(params);
}
