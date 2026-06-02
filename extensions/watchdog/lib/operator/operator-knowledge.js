import { retrieveOperatorKnowledgeNotes } from "./operator-knowledge-library.js";
import { normalizeString } from "../core/normalize.js";
import { getSemanticSkillSpec } from "../semantic-skill-registry.js";

const MAX_SELECTED_FRAGMENTS = 6;

const STATIC_KNOWLEDGE_FRAGMENTS = Object.freeze([
  {
    id: "new-task-workflow",
    title: "New Task Handling Workflow",
    sourcePath: "skills/operator-new-task/SKILL.md",
    priority: 10,
    tags: ["新任务", "新项目", "项目", "task", "project", "建立", "搭建", "处理", "loop", "回路", "结构", "agent", "因子", "新建", "处理流程", "实战"],
    summary: "面对全新项目按 6 步设计(operator 只设计结构与 agent 内容, 不替用户跑具体任务): ①读项目(数据经 task/inbox 送达, agent 沙箱只读 inbox 不漫游文件系统) ②分析(需要哪些角色/单次还是迭代环/领域缺口) ③步骤分解(每阶段可验证交付物+完成标准) ④建结构(agents.create + graph.edge.add 线性/graph.loop.compose 回路带 maxRounds/graph.group.compose 组) ⑤特色化(领域知识走 skills.create+agents.skills 注入, 配 agents.role/tools/description/constraints; SOUL/wake-message 由 role+skill 自动组装、不直接编辑, 工作目录平台按 agentId 派生、agent 用相对 inbox/outbox; 不硬编码领域进 SOUL) ⑥完成→用 inspect.structure_preview 给用户预览改动后结构(不要 emit 拍快照 step, 平台破坏性 apply 前自动拍)。⑦交付边界: operator 的交付物止于「结构 active + agent 内容(role/skill/tools) + inspect.structure_preview 预览」, 不携带也不注入用户的具体一次性任务。loop 结构 active(不自己跑)是正确终态——「跑」是用户的下游动作, 不是 operator 的 plan step: 线性管线由用户/ingress(webui/qq)把任务随 contract 投进入口 agent inbox, 传送带逐跳推进; 回路由用户在下游显式触发 runtime.loop.start(requestedTask=用户真实任务)。operator 绝不在 build plan 末尾 emit runtime.loop.start 携带用户具体任务(该 surface 仅用于治理已建好的 loop)。改系统一律经 CLI-system surface(plan→execute→apply→verify)。建好结构=设计交付完成; 跑由用户下游触发。",
  },
  {
    id: "operator-boundary",
    title: "Operator Boundary",
    sourcePath: "skills/operator-admin/SKILL.md",
    priority: 10,
    tags: ["operator", "admin", "平台", "管理", "前台", "权限", "协议", "runtime", "kernel", "代码"],
    summary: "Operator 是隐藏 runtime control agent，入口在 runtime operator surface。管理动作优先使用 cli-system surface / change-set，协议、kernel 和代码文件改动需要对应 surface。",
  },
  {
    id: "building-map",
    title: "Building Map Semantics",
    sourcePath: "skills/platform-map/SKILL.md",
    priority: 8,
    tags: ["agent", "building", "map", "skill", "办公室", "大楼", "地图", "协作", "厕所", "协议", "workspace"],
    summary: "OpenClaw 是多 agent 大楼。agent 先找地图、入口和出口，schema、路径、跨 workspace 协议和 delivery 方式由平台提供。",
  },
  {
    id: "graph-truth",
    title: "Graph Is Cooperation Truth",
    sourcePath: "use guide/备忘录55_[主]_Operator本地知识检索层落地_2026-03-19-1237.md",
    priority: 9,
    tags: ["graph", "edge", "loop", "回路", "有向图", "连线", "协作", "reviewer", "worker"],
    summary: "skill 提供认知指导。agent-to-agent 协作权限由有向图边定义；边缺失时先补图真相。",
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
    tags: ["loop", "cycle", "回路", "循环", "advance_loop", "start_loop", "dispatch-graph-policy"],
    summary: "loop runtime 在图上的有向边形成回路时参与。cycle 数量为 0 时，协作属于单次有向委派。",
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
    summary: "测试系统统一入口为 watchdog formal test surface；test-runner.js 是 /watchdog/test-runs/* 的薄客户端。formal case 真值收口到 formal-test-case-catalog，formal preset 真值收口到 formal-test-presets，报告输出到 ~/.openclaw/test-reports/。",
  },
  {
    id: "agent-bootstrap-system",
    title: "Agent Bootstrap System",
    sourcePath: "skills/platform-map/SKILL.md",
    priority: 6,
    tags: ["bootstrap", "workspace", "guidance", "BOOTSTRAP.md", "agent"],
    summary: "Agent workspace 引导自动生成机制：框架启动时自动加载 AGENTS.md、SOUL.md、TOOLS.md、IDENTITY.md、USER.md、HEARTBEAT.md、BOOTSTRAP.md 以及 memory/*.md，为 agent 提供角色定义、行为规范与上下文记忆。",
  },
  {
    id: "autonomy-loop-semantics",
    title: "Autonomy Loop & Harness Semantics",
    sourcePath: "docs/system-blocks/automation-governance.md",
    priority: 7,
    tags: ["harness", "automation", "回路", "自治", "profile", "lifecycle", "governance", "trust", "verify", "评分", "收敛", "treadmill"],
    summary: "自治回路：automation 经 harness 跑 round，HarnessRun→EvaluationResult→AutomationDecision→ProfileLifecycle 对象链派生治理。ProfileLifecycle 尾段（trustLevel experimental/provisional/stable、successStreak/failureStreak、retired 状态、governanceSnapshot 收紧参数）经 inspect.profile_lifecycle 观测；governanceSnapshotDisabled 是安全阀熔断。operator 治理 automation 时先 inspect.profile_lifecycle / inspect.automation_runtime_summary 看自治状态，再经 automations.* / runtime.loop.* apply，必要时 verify。",
  },
  {
    id: "operator-inspect-apply-verify",
    title: "Operator Inspect-Apply-Verify Loop",
    sourcePath: "docs/decision-verify-surface-and-commit-gate-2026-05-31.md",
    priority: 8,
    tags: ["operator", "inspect", "apply", "verify", "surface", "治理", "闭环", "test_runs", "回灌"],
    summary: "operator 主动治理走 inspect→apply→verify 闭环：先用 inspect.* surface 读真值（runtime/work_items/profile_lifecycle/automation 等），再经 apply surface 落地改动（P2.5 已通 cli-surface-executor 四道门），最后可用 verify surface（test_runs.start / test.inject）主动验证并回看结果。apply 类 change-set 经 commit 路径时受 P3 强制 verify 门（verify 不过不能 commit）。",
  },
  {
    id: "harness-build",
    title: "Harness Build (装 harness 到迭代 loop)",
    sourcePath: "skills/harness-build/SKILL.md",
    priority: 8,
    tags: ["harness", "harness化", "迭代", "质量", "门控", "gate", "guard", "collector", "normalizer", "review", "判别", "GAN", "收敛", "module", "automations", "test门", "schema"],
    summary: "迭代/质量门控 loop 需要 harness(纯线性一次性管线不需要)。harness=平台提供的治理模块包住每个 round, 4 kind 共 10 个: guard(budget/tool_access/scope) collector(artifact/trace) gate(artifact/schema/test) normalizer(eval_input/failure)。选模块=基线(4 kind 各一: guard.budget+collector.artifact+gate.artifact+normalizer.failure)+按需补强(有测试加 gate.test, 结构化产物加 gate.schema, 调试加 collector.trace, 不可信工具加 guard.tool_access/scope)。组装=先 graph.loop.compose 建结构, 再 automations.create 挂 harness(entry.targetAgent=loop入口/entry.message=任务/harness.moduleRefs 或 harness.profileId); 不手设 mode/assuranceLevel(harness-registry 自动派生)。红线: operator 只挑 moduleRef 粒度, 不写模块实现、不当第二 planner。",
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

// 数据驱动地从 live surfaces 列出 operator 当前可直接执行的动作（每条以
// "surfaceId: summary" 呈现）。不硬编码 surface 白名单——新增 operatorExecutable
// surface 自动入列，旧的退役自动出列（红线：禁止硬编码可执行面清单）。
function summarizeExecutableCapabilities(surfaces) {
  return (Array.isArray(surfaces) ? surfaces : [])
    .map((surface) => {
      const id = normalizeString(surface?.id);
      if (!id) return null;
      const summary = normalizeText(surface?.summary);
      return summary ? `${id}（${summary}）` : id;
    })
    .filter(Boolean);
}

// Agent Map — the compact, system-generated view of the live structure operator plans against.
// Head (id/title/tags) is fixed; body is generated from live config + graph: per agent
// {id[role] model · in-edges · out-edges} + active-loop status. This is the *only* place operator
// reads agents/edges, replacing the verbose per-agent dump (description + skills×12 + flags) — a
// small, sufficient reading cost to wire agents (符合 token 少量原则).
function buildAgentMapFragment(agents = [], graph = {}, loops = []) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const agentList = Array.isArray(agents) ? agents : [];
  const inEdges = (id) => edges.filter((e) => normalizeString(e?.to) === id).map((e) => normalizeString(e?.from)).filter(Boolean);
  const outEdges = (id) => edges.filter((e) => normalizeString(e?.from) === id).map((e) => normalizeString(e?.to)).filter(Boolean);
  const lines = agentList.map((a) => {
    const id = normalizeString(a?.id) || "?";
    const role = normalizeString(a?.role) || "agent";
    const model = normalizeString(a?.model) || "默认模型";
    const ins = inEdges(id);
    const outs = outEdges(id);
    return `${id}[${role}] ${model} · in←${ins.length ? ins.join(",") : "—"} · out→${outs.length ? outs.join(",") : "—"}`;
  });
  const registeredLoops = Array.isArray(loops) ? loops : [];
  const activeLoops = registeredLoops.filter((loop) => loop?.active === true);
  const loopLine = activeLoops.length
    ? `active loop: ${activeLoops.map((l) => `${normalizeString(l?.id)}(entry:${normalizeString(l?.entryAgentId) || "?"})`).join("; ")}`
    : (registeredLoops.length ? `已登记 ${registeredLoops.length} 个 loop，0 个 active` : "无 active loop");
  return {
    id: "agent-map",
    title: "Agent Map (live)",
    sourcePath: "runtime graph + config",
    priority: 9,
    tags: ["agent", "map", "graph", "edge", "in", "out", "入边", "出边", "role", "model", "loop", "回路", "结构", "协作", "reviewer", "worker", "controller"],
    summary: agentList.length
      ? `当前 agent 结构（每行 id[role] model · 入边 · 出边）：\n${lines.join("\n")}\n${loopLine}。图边共 ${edges.length} 条。建结构=补缺的 graph.edge.add / graph.loop.compose；优先复用已存在的 agent，不重复造。`
      : `当前没有已注册 agent；图边 ${edges.length} 条。先 agents.create，再用 graph.edge.add / graph.loop.compose 连结构。`,
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
      tags: ["loop", "loop-session", "runtime", "round", "回路", "轮次", "状态"],
      summary: `当前存在 active loop session：loop=${activeSession.loopId || "unknown"} stage=${activeSession.currentStage || "unknown"} round=${activeSession.round || 1} runtimeStatus=${runtimeStatus}。${missingEdgeCount > 0 ? `该 session 当前缺失 ${missingEdgeCount} 条 loop edge。` : "当前 loop session 结构完整。"}`,
    };
  }

  const latestSession = sessions[0];
  return {
    id: "live-loop-runtime",
    title: "Live Loop Runtime",
    sourcePath: "runtime loop session",
    priority: 7,
    tags: ["loop", "loop-session", "runtime", "回路", "状态"],
    summary: `当前没有 active loop session。最近一次 loop session 属于 ${latestSession?.loopId || "unknown"}，状态为 ${latestSession?.runtimeStatus || latestSession?.status || "unknown"}。`,
  };
}

function buildDynamicCapabilityFragment(surfaces) {
  const capabilities = summarizeExecutableCapabilities(surfaces);
  if (capabilities.length === 0) return null;
  // 控制片段长度：列出 surface id 便于 LLM 选面，超出部分以数量收口。
  const ids = (Array.isArray(surfaces) ? surfaces : [])
    .map((surface) => normalizeString(surface?.id))
    .filter(Boolean);
  const shownIds = ids.slice(0, 20);
  const overflow = ids.length - shownIds.length;
  return {
    id: "live-operator-capabilities",
    title: "Live Operator Capabilities",
    sourcePath: "runtime cli-system surfaces",
    priority: 8,
    tags: ["operator", "surface", "执行", "修改", "创建", "连线", "graph", "agent", "skill", "verify", "schedule", "automation"],
    summary: `当前 operator 直接可执行的 surface 共 ${ids.length} 个（含 inspect/apply/verify）：${shownIds.join("、")}${overflow > 0 ? `，以及另外 ${overflow} 个` : ""}。仅当用户要求确实没有对应 surface 时才回答 advice_only。`,
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
  agents,
  graph,
  loops,
  loopSessions,
  skills,
  surfaces,
} = {}) {
  const request = tokenizeRequest(requestText);
  const fragments = [
    ...STATIC_KNOWLEDGE_FRAGMENTS,
    buildAgentMapFragment(agents, graph, loops),
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
