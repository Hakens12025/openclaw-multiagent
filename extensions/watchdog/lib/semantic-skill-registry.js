import { SYSTEM_ACTION_ENABLED_ROLES } from "./agent/agent-metadata.js";
import { normalizeString, uniqueStrings } from "./core/normalize.js";

const DEFAULT_PRIORITY = 7;

const SEMANTIC_SKILL_SPECS = Object.freeze({
  "platform-map": Object.freeze({
    id: "platform-map",
    name: "Platform Map",
    summary: "楼宇地图与平台硬路径说明，告诉 agent 这栋楼里有什么办公室、什么时候该找谁、哪些路径不能自造。",
    layer: "platform_semantics",
    audience: "all_agents",
    defaultInjection: "forced_platform",
    priority: 9,
    tags: Object.freeze(["platform-map", "地图", "大楼", "办公室", "协作", "协议", "workspace"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze([
      "BUILDING-MAP.md",
      "COLLABORATION-GRAPH.md",
      "DELIVERY.md",
      "PLATFORM-GUIDE.md",
      "inbox/contract.json",
      "outbox/stage_result.json",
      "outbox/contract_result.json",
    ]),
    guideLine: "平台楼宇地图，说明入口、出口、办公室分工和协作边界。",
    operatorUse: "楼宇地图技能：agent 应先查地图和 contract，不要自造协议、路径或跨 workspace 协作方式。",
  }),
  "platform-tools": Object.freeze({
    id: "platform-tools",
    name: "Platform Tools",
    summary: "平台工具使用说明，告诉 agent 如何使用本地 read/write/edit 与 runtime 硬路径，不把工具误用成通讯协议。",
    layer: "platform_semantics",
    audience: "all_agents",
    defaultInjection: "forced_platform",
    priority: 8,
    tags: Object.freeze(["platform-tools", "tools", "tooling", "read", "write", "edit", "runtime"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze(["read", "write", "edit", "outbox/stage_result.json", "outbox/_manifest.json"]),
    guideLine: "平台工具说明，定义本地工具怎么用、什么时候停手交给 runtime。",
    operatorUse: "平台工具技能：区分本地 read/write/edit 与 runtime 硬路径；普通 agent 不直接碰 admin surface 或其他 agent workspace。",
  }),
  "error-avoidance": Object.freeze({
    id: "error-avoidance",
    name: "Error Avoidance",
    summary: "全局错误回避知识库，汇总平台历史执行经验，帮助 agent 避开已知坑位。",
    layer: "platform_safety",
    audience: "all_agents",
    defaultInjection: "forced_platform",
    priority: 6,
    tags: Object.freeze(["error-avoidance", "safety", "pitfall", "memory"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze([]),
    guideLine: "全局错误回避知识库，基于全系统历史执行经验自动更新。所有 agent 共享。",
    operatorUse: "错误回避技能：遇到高频失败模式时优先参考历史坑位，不重复制造旧错误。",
  }),
  "system-action": Object.freeze({
    id: "system-action",
    name: "System Action",
    summary: "平台调度入口：在输出中用 [ACTION] 标记发起协作；复杂参数直接写成 JSON marker，运行时自动提取。",
    layer: "coordination_semantics",
    audience: "cooperative_roles",
    defaultInjection: "role_scoped",
    enabledRoles: Object.freeze([...SYSTEM_ACTION_ENABLED_ROLES]),
    priority: 8,
    tags: Object.freeze(["system-action", "assign_task", "request_review", "wake_agent", "loop", "graph-router"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze(["assign_task", "request_review", "wake_agent", "start_loop", "advance_loop"]),
    guideLine: "平台调度入口：在输出中写 [ACTION] 标记；复杂动作直接写 JSON marker。运行时自动提取，不需要写文件。",
    operatorUse: "平台调度技能：agent 需要委派、审查、唤醒或启动 loop 时应通过 system_action 交给 runtime；loop 推进本身由 graph-router + outbox 接管。",
  }),
  "review-findings": Object.freeze({
    id: "review-findings",
    name: "Review Findings",
    summary: "审理发现标记格式。教 agent 用 [BLOCKING]/[SUGGESTION] 写结构化审理结果，平台自动提取用于治理决策。",
    layer: "execution_semantics",
    audience: "review_capable",
    defaultInjection: "role_scoped",
    priority: 7,
    tags: Object.freeze(["review", "findings", "blocking", "suggestion", "verdict"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze([]),
    guideLine: "审理发现标记，用 [BLOCKING]/[SUGGESTION] 格式写审理结果，平台自动提取。",
    operatorUse: "审理标记技能：agent 审理产物时用标记格式写发现，平台提取后驱动 gate 和治理决策。",
  }),
  "plan-stages": Object.freeze({
    id: "plan-stages",
    name: "Plan Stages",
    summary: "阶段计划标记格式。教 agent 用 ### 阶段 N: 格式写执行计划，平台自动提取用于进度条显示。",
    layer: "execution_semantics",
    audience: "plan_capable",
    defaultInjection: "role_scoped",
    priority: 7,
    tags: Object.freeze(["plan", "stages", "progress", "planning"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze([]),
    guideLine: "阶段计划标记，用 ### 阶段 N: 格式写执行计划，平台自动提取并显示进度条。",
    operatorUse: "阶段计划技能：agent 用标记格式写执行计划，平台提取后更新前端进度条。",
  }),
  "operator-admin": Object.freeze({
    id: "operator-admin",
    name: "Operator Admin",
    summary: "Runtime operator 管理技能，说明 inspect/apply/verify、change-set、确认边界与平台前台职责。",
    layer: "operator_semantics",
    audience: "operator_only",
    defaultInjection: "operator_default",
    priority: 10,
    tags: Object.freeze(["operator", "admin", "surface", "change-set", "inspect", "apply", "verify"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze(["/watchdog/operator/plan", "/watchdog/operator/execute", "admin_change_sets", "admin_surfaces"]),
    guideLine: "Runtime 管理面操作指南，说明 inspect / apply / verify、change-set 与确认边界。",
    operatorUse: "Operator 管理技能：先 inspect，再 apply；优先 admin surface / change-set；structural 或 destructive 动作保持保守。",
  }),
  "operator-tooling": Object.freeze({
    id: "operator-tooling",
    name: "Operator Tooling",
    summary: "Operator 高级工具箱说明，覆盖 snapshot/graph/catalog/test/change-set 等高权限平台工具的组合使用方式。",
    layer: "operator_semantics",
    audience: "operator_only",
    defaultInjection: "operator_default",
    priority: 9,
    tags: Object.freeze(["operator-tooling", "snapshot", "graph", "catalog", "tests", "runtime", "tools"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze([
      "/watchdog/operator-snapshot",
      "/watchdog/graph",
      "/watchdog/admin-surfaces",
      "/watchdog/agents",
      "/watchdog/skills",
      "/watchdog/models",
      "/watchdog/work-items",
      "/watchdog/system-action-delivery-tickets",
      "test_runs.start",
      "test.inject",
    ]),
    guideLine: "Operator 高级工具箱，说明 snapshot / graph / surface / test / verification 这些工具如何组合使用。",
    operatorUse: "Operator 工具箱技能：用 snapshot、graph、catalog、test 与 change-set 拼出平台真相，不靠猜测做管理动作。",
  }),
});

function cloneSpec(spec) {
  if (!spec) return null;
  return {
    ...spec,
    tags: [...(spec.tags || [])],
    pluginRefs: [...(spec.pluginRefs || [])],
    toolRefs: [...(spec.toolRefs || [])],
    enabledRoles: [...(spec.enabledRoles || [])],
  };
}

function normalizeRole(role) {
  const normalized = normalizeString(role)?.toLowerCase();
  return normalized || null;
}

export function getSemanticSkillSpec(skillId) {
  return cloneSpec(SEMANTIC_SKILL_SPECS[normalizeString(skillId)] || null);
}

function listSemanticSkillSpecs() {
  return Object.values(SEMANTIC_SKILL_SPECS).map((spec) => cloneSpec(spec));
}

export function listForcedPlatformSkillRefs() {
  return listSemanticSkillSpecs()
    .filter((spec) => spec.defaultInjection === "forced_platform")
    .map((spec) => spec.id);
}

function listRoleSemanticSkillRefs(role) {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return [];
  return listSemanticSkillSpecs()
    .filter((spec) => spec.defaultInjection === "role_scoped")
    .filter((spec) => Array.isArray(spec.enabledRoles) && spec.enabledRoles.includes(normalizedRole))
    .map((spec) => spec.id);
}

export function listAutoInjectedAgentSkillRefs(role) {
  return uniqueStrings([
    ...listForcedPlatformSkillRefs(),
    ...listRoleSemanticSkillRefs(role),
  ]);
}

export function listReservedConfiguredDefaultSkillIds() {
  return listSemanticSkillSpecs()
    .filter((spec) => spec.defaultInjection === "forced_platform" || spec.defaultInjection === "role_scoped")
    .map((spec) => spec.id);
}

export function buildRoleInjectedSemanticSkillMap() {
  const matrix = {};
  for (const spec of listSemanticSkillSpecs()) {
    if (spec.defaultInjection !== "role_scoped") continue;
    matrix[spec.id] = Array.isArray(spec.enabledRoles) ? [...spec.enabledRoles] : [];
  }
  return matrix;
}

function listOperatorSemanticSkillRefs() {
  const operatorOnly = listSemanticSkillSpecs()
    .filter((spec) => spec.defaultInjection === "operator_default")
    .map((spec) => spec.id);

  return uniqueStrings([
    ...listForcedPlatformSkillRefs(),
    "system-action",
    ...operatorOnly,
  ]);
}

export function listOperatorKnowledgeSkillDocSpecs() {
  return listOperatorSemanticSkillRefs().map((skillId) => {
    const spec = getSemanticSkillSpec(skillId) || {};
    return {
      id: `skill:${skillId}`,
      title: spec.name || skillId,
      sourcePath: `skills/${skillId}/SKILL.md`,
      priority: Number.isFinite(spec.priority) ? spec.priority : DEFAULT_PRIORITY,
      tags: uniqueStrings([skillId, ...(spec.tags || [])]),
    };
  });
}
