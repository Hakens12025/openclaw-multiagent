import { searchWiki } from "../knowledge/wiki-rag-search.js";
import { searchAgentKnowledge } from "../knowledge/knowledge-base.js";
import { AGENT_IDS } from "../agent/agent-metadata.js";
import { normalizeString } from "../core/normalize.js";
import { getSemanticSkillSpec } from "../prompt/semantic-skill-registry.js";

const MAX_SELECTED_FRAGMENTS = 6;

const STATIC_KNOWLEDGE_FRAGMENTS = Object.freeze([
  {
    id: "new-task-workflow",
    title: "New Task Handling Workflow",
    sourcePath: "skills/operator-new-task/SKILL.md",
    priority: 10,
    tags: ["新任务", "新项目", "项目", "task", "project", "建立", "搭建", "处理", "cycle", "回路", "环", "结构", "agent", "因子", "新建", "处理流程", "实战"],
    summary: "面对全新项目按 6 步设计(operator 只设计结构与 agent 内容, 不替用户跑具体任务): ①读项目(数据经 task/inbox 送达, agent 沙箱只读 inbox 不漫游文件系统) ②分析(需要哪些角色/单次还是迭代环/领域缺口) ③步骤分解(每阶段可验证交付物+完成标准) ④建结构(agents.create + graph.edge.add 连边; 迭代环就是把边连成环 a→b→c→a, 平台自动识别并高亮这个环; 需要并行成组时加 graph.group.compose) ⑤特色化(领域知识走 skills.create+agents.skills 注入, 配 agents.role/tools/description/constraints; SOUL/wake-message 由 role+skill 自动组装、不直接编辑, 工作目录平台按 agentId 派生、agent 用相对 inbox/outbox; 不硬编码领域进 SOUL) ⑥完成→用 inspect.structure_preview 给用户预览改动后结构(不要 emit 拍快照 step, 平台破坏性 apply 前自动拍)。⑦交付边界: operator 的交付物止于「结构 active + agent 内容(role/skill/tools) + inspect.structure_preview 预览」, 不携带也不注入用户的具体一次性任务。结构建成(不自己跑)就是正确终态——「跑」是用户的下游动作, 不是 operator 的 plan step: 由用户/ingress(webui/qq)把任务随 contract 投进入口 agent inbox, 传送带按图边逐跳推进; 边成环时自然一圈圈转下去。改系统一律经 CLI-system surface(plan→execute→apply→verify)。建好结构=设计交付完成; 跑由用户下游触发。",
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
    title: "Graph Is Pipeline Truth",
    sourcePath: "use guide/备忘录135_[主]_动态协作解绑图边与FC接线全通_2026-08-08-1621.md",
    priority: 9,
    tags: ["graph", "edge", "cycle", "环", "回路", "有向图", "连线", "协作", "worker"],
    summary: "有向图边定义固定管线（平台在没有显式目标时按它决定下一跳）、传送带投递许可与产物包入仓路径。agent 主动发起的协作自己指定目标，不查图边——协作授权单源是 collaboration-intent-policy 角色表。但目标若无图入边，上游产物包不会入仓。",
  },
  {
    id: "system-action-routing",
    title: "System Action Routing",
    sourcePath: "skills/system-action/SKILL.md",
    priority: 7,
    tags: ["system_action", "assign_task", "wake_agent", "委派", "唤醒"],
    summary: "当 agent 需要委派或唤醒同伴时，直接调用对应协作工具（assign_task / wake_agent），工具结果当场返回受理凭证或结构化拒绝。结果 delivery 和上下游传递属于平台硬路径。",
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
    summary: "测试系统统一入口为 watchdog formal test surface；test-runner.js 是 /watchdog/test-runs/* 的薄客户端。preset 清单真值收口到 formal-test-presets（以 test-runner.js --list 的 live 输出为准，不在别处复刻），case 真值内联在各 lib/formal-runtime/suite-*.js；每个检查产出 CheckResult（fail/blocked/skip 必带 E-* 错误码，注册表在 lib/formal-runtime/error-codes.js），failures-first 报告输出到 ~/.openclaw/test-reports/。",
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
    title: "Autonomy Loop & Governance Semantics",
    sourcePath: "docs/system-blocks/automation-governance.md",
    priority: 7,
    tags: ["automation", "回路", "自治", "profile", "lifecycle", "governance", "trust", "verify", "评分", "收敛", "treadmill"],
    summary: "自治回路：automation 跑 round，AutomationDecision→ProfileLifecycle 对象链派生治理（HarnessRun/EvaluationResult 两环已随 harness 全退役删除，v226）。ProfileLifecycle 尾段（trustLevel experimental/provisional/stable、successStreak/failureStreak、retired 状态、governanceSnapshot 收紧参数）经 inspect.profile_lifecycle 观测；governanceSnapshotDisabled 是安全阀熔断。operator 治理 automation 时先 inspect.profile_lifecycle / inspect.automation_runtime_summary 看自治状态，再经 automations.* apply，必要时 verify。",
  },
  {
    id: "operator-inspect-apply-verify",
    title: "Operator Inspect-Apply-Verify Loop",
    sourcePath: "docs/decision-verify-surface-and-commit-gate-2026-05-31.md",
    priority: 8,
    tags: ["operator", "inspect", "apply", "verify", "surface", "治理", "闭环", "test_runs", "回灌"],
    summary: "operator 主动治理走 inspect→apply→verify 闭环：先用 inspect.* surface 读真值（runtime/work_items/profile_lifecycle/automation 等），再经 apply surface 落地改动（P2.5 已通 cli-surface-executor 四道门），最后可用 verify surface（test_runs.start / test.inject）主动验证并回看结果。apply 类 change-set 经 commit 路径时受 P3 强制 verify 门（verify 不过不能 commit）。",
  },
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function tokenizeRequest(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return { normalized, tokens: [] };
  const tokens = normalized.split(/[^a-z0-9\u4e00-\u9fff_-]+/g).filter(Boolean);
  return { normalized, tokens };
}

export function scoreFragment(fragment, request) {
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
// {id[role] model · in-edges · out-edges}. This is the *only* place operator
// reads agents/edges, replacing the verbose per-agent dump (description + skills×12 + flags) — a
// small, sufficient reading cost to wire agents (符合 token 少量原则).
function buildAgentMapFragment(agents = [], graph = {}) {
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
    // per-agent attached skills (capped) — so operator sees what an agent already has and reuses
    // instead of re-authoring/re-attaching (the "优先复用" instruction needs this visibility).
    const skillList = Array.isArray(a?.effectiveSkills) ? a.effectiveSkills
      : (Array.isArray(a?.skills) ? a.skills : []);
    const skills = skillList.map((s) => normalizeString(s)).filter(Boolean).slice(0, 6);
    return `${id}[${role}] ${model} · in←${ins.length ? ins.join(",") : "—"} · out→${outs.length ? outs.join(",") : "—"} · skills:${skills.length ? skills.join(",") : "—"}`;
  });
  return {
    id: "agent-map",
    title: "Agent Map (live)",
    sourcePath: "runtime graph + config",
    priority: 9,
    tags: ["agent", "map", "graph", "edge", "in", "out", "入边", "出边", "role", "model", "cycle", "环", "回路", "结构", "协作", "worker", "controller"],
    summary: agentList.length
      ? `当前 agent 结构（每行 id[role] model · 入边 · 出边 · 已装 skills）：\n${lines.join("\n")}\n图边共 ${edges.length} 条。建结构=补缺的 graph.edge.add（迭代就把边连成环）/ graph.group.compose；优先复用已存在的 agent 与其已装 skill，不重复造。`
      : `当前没有已注册 agent；图边 ${edges.length} 条。先 agents.create，再用 graph.edge.add 连结构（迭代就把边连成环）。`,
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
  skills,
  surfaces,
} = {}) {
  const request = tokenizeRequest(requestText);
  const fragments = [
    ...STATIC_KNOWLEDGE_FRAGMENTS,
    buildAgentMapFragment(agents, graph),
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
    // Phase 5 — operator grounds its WHY retrieval on the compiled rationale (wiki + any user KB it
    // can see), NOT 备忘录 (memos = RAW past designs that mislead). Retrieval never throws: if
    // embeddings/index are unavailable it degrades → empty notes, and operator stays grounded by
    // selectedFragments + the live agent-map. selectedFragments (static fragments + live
    // agent-map :274 + capabilities) is runtime/structure truth and is intentionally left untouched.
    retrievedNotes: await retrieveGroundingNotes(requestText, 4, { agentId: AGENT_IDS.OPERATOR }),
  };
}

// Map RAG results into the { title, sourcePath, excerpt } note shape the brain context expects.
//
// agentId 给了 → per-agent 聚合检索(该 agent 绑定的 KB ∪ scope:'global' 的 KB)。wiki 是 global 种子库
// (knowledge-base.js SEED_KNOWLEDGE_BASES),所以 wiki grounding 必然仍在;新增的是「用户自建的知识库
// 也能被 meta-agent 读到」——此前用户建了库也没有任何运行时消费者。agentId 省略 → 纯 wiki(旧行为)。
// 零回归依据:无用户库时 bound=[wiki],round-robin 合并退化成单表,结果与 searchWiki 逐条一致。
// 绑定关系是 KB spec 的 scope/agentId 数据,此处不含任何 agent 名字面量分支(通用机)。
export async function retrieveGroundingNotes(requestText, limit = 4, { agentId = null } = {}) {
  const { results } = agentId
    ? await searchAgentKnowledge(agentId, requestText, { topK: limit, includeGlobal: true })
    : await searchWiki(requestText, { topK: limit });
  return (Array.isArray(results) ? results : []).map((r) => ({
    title: normalizeString(r.heading) || normalizeString(r.sourcePath) || normalizeString(r.kbId) || "wiki",
    sourcePath: normalizeString(r.sourcePath),
    excerpt: normalizeString(r.text).slice(0, 500),
    // 多库检索时标注出处(sourcePath 跨库可能重名);单 wiki 时无此字段 = 形状同旧。
    ...(r.kbId ? { kbId: normalizeString(r.kbId) } : {}),
  }));
}
