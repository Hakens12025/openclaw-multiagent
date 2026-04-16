import { detectCycles } from "../agent/agent-graph.js";
import { retrieveOperatorKnowledgeNotes } from "./operator-knowledge-library.js";
import { normalizeString } from "../core/normalize.js";
import { getSemanticSkillSpec } from "../semantic-skill-registry.js";

const MAX_SELECTED_FRAGMENTS = 6;

const STATIC_KNOWLEDGE_FRAGMENTS = Object.freeze([
  {
    id: "operator-boundary",
    title: "Operator Boundary",
    sourcePath: "skills/operator-admin/SKILL.md",
    priority: 10,
    tags: ["operator", "admin", "平台", "管理", "前台", "权限", "协议", "runtime", "kernel", "代码"],
    summary: "Operator 是平台前台，不进入 agent graph。它应该优先使用 admin surface / change-set，不能绕开 runtime 去改协议、kernel 或代码文件。",
  },
  {
    id: "building-map",
    title: "Building Map Semantics",
    sourcePath: "skills/platform-map/SKILL.md",
    priority: 8,
    tags: ["agent", "building", "map", "skill", "办公室", "大楼", "地图", "协作", "厕所", "协议", "workspace"],
    summary: "OpenClaw 是多 agent 大楼。agent 应先找地图、入口和出口，不自己发明 schema、路径、跨 workspace 协议或结果 delivery 方式。",
  },
  {
    id: "graph-truth",
    title: "Graph Is Cooperation Truth",
    sourcePath: "use guide/备忘录55_[主]_Operator本地知识检索层落地_2026-03-19-1237.md",
    priority: 9,
    tags: ["graph", "edge", "loop", "pipeline", "回路", "有向图", "连线", "协作", "reviewer", "worker"],
    summary: "skill 只提供认知指导，不直接创造协作路径。真正的 agent-to-agent 协作权限由有向图边定义；没有边，就没有自然协作。",
  },
  {
    id: "system-action-routing",
    title: "System Action Routing",
    sourcePath: "skills/system-action/SKILL.md",
    priority: 7,
    tags: ["system_action", "assign_task", "request_review", "wake_agent", "review", "委派", "审查", "唤醒"],
    summary: "当 agent 需要委派、请求审查、唤醒同伴或启动 loop 时，应写 system_action 交给 runtime。结果 delivery 和上下游传递属于平台硬路径。",
  },
  {
    id: "loop-runtime",
    title: "Loop Runtime Rule",
    sourcePath: "skills/system-action/SKILL.md",
    priority: 7,
    tags: ["loop", "cycle", "回路", "循环", "advance_loop", "start_loop", "graph-router"],
    summary: "loop runtime 只有在图上的有向边真的形成回路时才参与。没有 cycle 时，协作只是单次有向委派，不是 loop。",
  },
  {
    id: "controller-front-desk",
    title: "Controller Front Desk Default",
    sourcePath: "use guide/备忘录55_[主]_Operator本地知识检索层落地_2026-03-19-1237.md",
    priority: 7,
    tags: ["controller", "front desk", "前台", "report", "汇报", "delivery", "新建", "agent"],
    summary: "如果新 agent 的职责是接入前台或向 controller 汇报，默认楼宇语义是 controller -> agent 与 agent -> controller 双向接待/结果送达，除非用户明确 opt-out。",
  },
  {
    id: "role-semantics",
    title: "Role Semantics",
    sourcePath: "skills/platform-map/SKILL.md",
    priority: 7,
    tags: ["role", "agent", "controller", "gateway", "semantic", "语义层"],
    summary: "Agent 角色语义分层：controller 负责编排与调度，gateway 负责外部接入与消息桥接，专业 agent 拥有领域技能并在各自 workspace 内执行。角色边界决定了谁能做什么、谁该找谁。",
  },
  {
    id: "test-harness",
    title: "Test Harness System",
    sourcePath: "extensions/watchdog/test-runner.js",
    priority: 6,
    tags: ["test", "harness", "preset", "suite", "报告", "test-runner"],
    summary: "测试系统统一入口为 watchdog formal test surface；test-runner.js 现已退化为 /watchdog/test-runs/* 的薄客户端，不再自带第二执行器。formal case 真值收口到 formal-test-case-catalog，formal preset 真值收口到 formal-test-presets，报告输出到 ~/.openclaw/test-reports/。禁止手写 curl 冒充测试。",
  },
  {
    id: "agent-bootstrap-system",
    title: "Agent Bootstrap System",
    sourcePath: "skills/platform-map/SKILL.md",
    priority: 6,
    tags: ["bootstrap", "workspace", "guidance", "BOOTSTRAP.md", "agent"],
    summary: "Agent workspace 引导自动生成机制：框架启动时自动加载 AGENTS.md、SOUL.md、TOOLS.md、IDENTITY.md、USER.md、HEARTBEAT.md、BOOTSTRAP.md 以及 memory/*.md，为 agent 提供角色定义、行为规范与上下文记忆。",
  },
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenizeRequest(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return { normalized, tokens: [] };
  const tokens = normalized.split(/[^a-z0-9\u4e00-\u9fff_-]+/g).filter(Boolean);
  return { normalized, tokens };
}

function scoreFragment(fragment, request) {
  let score = Number.isFinite(fragment?.priority) ? fragment.priority : 0;
  const normalized = request.normalized;
  for (const tag of Array.isArray(fragment?.tags) ? fragment.tags : []) {
    const needle = normalizeString(tag)?.toLowerCase();
    if (!needle) continue;
    if (normalized.includes(needle)) {
      score += needle.length >= 3 ? 4 : 2;
    }
  }
  return score;
}

function summarizeExecutableCapabilities(surfaces) {
  const ids = new Set((Array.isArray(surfaces) ? surfaces : [])
    .map((surface) => normalizeString(surface?.id))
    .filter(Boolean));
  const capabilities = [];
  if (ids.has("agents.create")) capabilities.push("create agent");
  if (ids.has("agents.name")) capabilities.push("rename agent");
  if (ids.has("agents.description")) capabilities.push("rewrite agent description");
  if (ids.has("agents.skills")) capabilities.push("change agent skills");
  if (ids.has("agents.policy")) capabilities.push("change agent policy");
  if (ids.has("graph.edge.add")) capabilities.push("add graph edge");
  if (ids.has("graph.edge.delete")) capabilities.push("delete graph edge");
  if (ids.has("graph.loop.compose")) capabilities.push("compose graph loop");
  if (ids.has("graph.loop.repair")) capabilities.push("repair graph loop");
  if (ids.has("runtime.loop.interrupt")) capabilities.push("interrupt loop runtime");
  if (ids.has("runtime.loop.resume")) capabilities.push("resume loop runtime");
  return capabilities;
}

function buildDynamicGraphFragment(graph, loops = []) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const cycles = detectCycles(graph);
  const registeredLoops = Array.isArray(loops) ? loops : [];
  const activeLoops = registeredLoops.filter((loop) => loop?.active === true);
  if (edges.length === 0) {
    return {
      id: "live-graph-state",
      title: "Live Graph State",
      sourcePath: "runtime graph",
      priority: 9,
      tags: ["graph", "edge", "loop", "协作", "回路", "reviewer", "worker", "controller"],
      summary: registeredLoops.length > 0
        ? `当前 live graph 没有任何有向边；已登记 ${registeredLoops.length} 个 LoopSpec，但都未激活。任何“自然去找别的 agent 帮忙”的行为都还不能成立。`
        : "当前 live graph 没有任何有向边，所以 agent 之间还不存在显式协作路径。任何“自然去找别的 agent 帮忙”的行为都还不能成立。",
    };
  }
  if (activeLoops.length === 0) {
    return {
      id: "live-graph-state",
      title: "Live Graph State",
      sourcePath: "runtime graph",
      priority: 8,
      tags: ["graph", "edge", "loop", "协作", "回路"],
      summary: registeredLoops.length > 0
        ? `当前 live graph 有 ${edges.length} 条有向边，并登记了 ${registeredLoops.length} 个 LoopSpec，但当前没有 active loop。现阶段的 agent 协作仍属于单次有向委派。`
        : `当前 live graph 有 ${edges.length} 条有向边，但还没有 cycle。现阶段的 agent 协作属于单次有向委派，不属于 loop。`,
    };
  }
  return {
    id: "live-graph-state",
    title: "Live Graph State",
    sourcePath: "runtime graph",
    priority: 8,
    tags: ["graph", "edge", "loop", "协作", "回路", "cycle", "pipeline"],
    summary: `当前 live graph 有 ${edges.length} 条有向边，登记了 ${registeredLoops.length} 个 LoopSpec，其中 ${activeLoops.length} 个处于 active。原始 cycle 检测数为 ${cycles.length}；已登记且成环的 loop 才应该交给 loop / pipeline engine 管。`,
  };
}

function buildLoopRuntimeFragment(loopSessions = []) {
  const sessions = Array.isArray(loopSessions) ? loopSessions : [];
  if (sessions.length === 0) {
    return null;
  }

  const activeSession = sessions.find((session) => session?.active === true) || null;
  if (activeSession) {
    const missingEdgeCount = Array.isArray(activeSession.missingEdges) ? activeSession.missingEdges.length : 0;
    const runtimeStatus = normalizeString(activeSession.runtimeStatus) || normalizeString(activeSession.status) || "active";
    return {
      id: "live-loop-runtime",
      title: "Live Loop Runtime",
      sourcePath: "runtime loop session",
      priority: 9,
      tags: ["loop", "loop-session", "runtime", "pipeline", "round", "回路", "轮次", "状态"],
      summary: `当前存在 active loop session：loop=${activeSession.loopId || "unknown"} stage=${activeSession.currentStage || "unknown"} round=${activeSession.round || 1} runtimeStatus=${runtimeStatus}。${missingEdgeCount > 0 ? `该 session 当前缺失 ${missingEdgeCount} 条 loop edge。` : "当前 loop session 结构完整。"}`,
    };
  }

  const latestSession = sessions[0];
  return {
    id: "live-loop-runtime",
    title: "Live Loop Runtime",
    sourcePath: "runtime loop session",
    priority: 7,
    tags: ["loop", "loop-session", "runtime", "pipeline", "回路", "状态"],
    summary: `当前没有 active loop session。最近一次 loop session 属于 ${latestSession?.loopId || "unknown"}，状态为 ${latestSession?.runtimeStatus || latestSession?.status || "unknown"}。`,
  };
}

function buildDynamicCapabilityFragment(surfaces) {
  const capabilities = summarizeExecutableCapabilities(surfaces);
  if (capabilities.length === 0) return null;
  return {
    id: "live-operator-capabilities",
    title: "Live Operator Capabilities",
    sourcePath: "runtime admin surfaces",
    priority: 8,
    tags: ["operator", "surface", "执行", "修改", "创建", "连线", "graph", "agent", "skill"],
    summary: `当前 operator 直接可执行的动作只有：${capabilities.join("、")}。如果用户要求超出这些 surface 的能力，应该回答 advice_only，而不是假执行。`,
  };
}

function buildNotableSkillGuidance(skills) {
  return (Array.isArray(skills) ? skills : [])
    .map((skill) => {
      const skillId = normalizeString(skill?.id);
      const semanticSpec = getSemanticSkillSpec(skillId);
      if (!skillId || !semanticSpec?.operatorUse) return null;
      return {
        id: skillId,
        name: normalizeString(skill?.name) || skillId,
        description: normalizeString(skill?.description) || null,
        operatorUse: semanticSpec.operatorUse,
        audience: normalizeString(semanticSpec.audience) || null,
        defaultInjection: normalizeString(semanticSpec.defaultInjection) || null,
        pluginRefs: Array.isArray(semanticSpec.pluginRefs) ? semanticSpec.pluginRefs : [],
        toolRefs: Array.isArray(semanticSpec.toolRefs) ? semanticSpec.toolRefs : [],
      };
    })
    .filter(Boolean);
}

export async function buildOperatorKnowledgeContext({
  requestText,
  graph,
  loops,
  loopSessions,
  skills,
  surfaces,
} = {}) {
  const request = tokenizeRequest(requestText);
  const fragments = [
    ...STATIC_KNOWLEDGE_FRAGMENTS,
    buildDynamicGraphFragment(graph, loops),
    buildLoopRuntimeFragment(loopSessions),
    buildDynamicCapabilityFragment(surfaces),
  ].filter(Boolean);

  const selectedFragments = fragments
    .map((fragment) => ({
      ...fragment,
      score: scoreFragment(fragment, request),
    }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, MAX_SELECTED_FRAGMENTS)
    .map(({ score, tags, priority, ...fragment }) => fragment);

  return {
    notableSkills: buildNotableSkillGuidance(skills),
    selectedFragments,
    retrievedNotes: await retrieveOperatorKnowledgeNotes({
      requestText,
      limit: 4,
    }),
  };
}
