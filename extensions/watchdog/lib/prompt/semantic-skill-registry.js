import { SYSTEM_ACTION_ENABLED_ROLES } from "../agent/agent-metadata.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";

const DEFAULT_PRIORITY = 7;

const SEMANTIC_SKILL_SPECS = Object.freeze({
  "platform-map": Object.freeze({
    id: "platform-map",
    name: "Platform Map",
    summary: "楼宇地图与平台硬路径说明，告诉 agent 这栋楼里有什么办公室、什么时候该找谁、哪些路径由平台提供。",
    layer: "platform_semantics",
    audience: "all_agents",
    defaultInjection: "forced_platform",
    priority: 9,
    tags: Object.freeze(["platform-map", "地图", "大楼", "办公室", "协作", "协议", "workspace"]),
    pluginRefs: Object.freeze(["watchdog"]),
    // 只列全部角色都真实拥有的东西。BUILDING-MAP / COLLABORATION-GRAPH / DELIVERY /
    // PLATFORM-GUIDE 会被 workspace-guidance-writer 的 EXECUTION_LAYER_CLEANUP 从执行层
    // 四角色的工作区删掉,而本技能是 forced_platform 注给全体的——指过去必然扑空。
    toolRefs: Object.freeze([
      "inbox/contract.json",
      "outbox/",
    ]),
    guideLine: "平台楼宇地图，说明入口、出口、办公室分工和协作边界。",
    operatorUse: "楼宇地图技能：agent 先查地图和 contract，再按平台边界协作推进。",
  }),
  "platform-tools": Object.freeze({
    id: "platform-tools",
    name: "Platform Tools",
    summary: "平台工具使用说明，告诉 agent 如何使用本地 read/write/edit 与 runtime 硬路径，并把跨 agent 通讯交给平台协议。",
    layer: "platform_semantics",
    audience: "all_agents",
    defaultInjection: "forced_platform",
    priority: 8,
    tags: Object.freeze(["platform-tools", "tools", "tooling", "read", "write", "edit", "runtime"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze(["read", "write", "edit", "outbox/runtime_result.json"]),
    guideLine: "平台工具说明，定义本地工具怎么用、什么时候停手交给 runtime。",
    operatorUse: "平台工具技能：区分本地 read/write/edit 与 runtime 硬路径；admin surface 和跨 workspace 操作归 operator/runtime。",
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
    operatorUse: "错误回避技能：遇到高频失败模式时优先参考历史坑位，复用已验证路径。",
  }),
  "system-action": Object.freeze({
    id: "system-action",
    name: "System Action",
    summary: "平台协作入口。协作动作通过协作工具发起。",
    layer: "coordination_semantics",
    audience: "cooperative_roles",
    defaultInjection: "role_scoped",
    enabledRoles: Object.freeze([...SYSTEM_ACTION_ENABLED_ROLES]),
    priority: 8,
    tags: Object.freeze(["system-action", "assign_task", "wake_agent", "runtime-graph"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze(["assign_task", "wake_agent"]),
    // 不在这里指 COLLABORATION-FALLBACK.md:本技能注给全部五个角色,而执行层三角色的
    // 工作区根本不写那份文件(workspace-guidance-writer.js:193 的 isExecutionLayer 分支)。
    // 降级写法的可靠递送面是结构化拒绝回执本身——live 实测 agent 只凭拒绝就能写对。
    guideLine: "协作动作统一通过协作工具发起；工具走不通时，拒绝回执里会给出文本标记降级写法。",
    operatorUse: "平台调度技能：agent 需要委派或唤醒时直接调对应协作工具。",
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
    operatorUse: "Operator 工具箱技能：用 snapshot、graph、catalog、test 与 change-set 拼出平台真相，基于证据做管理动作。",
  }),
  "chart-build": Object.freeze({
    id: "chart-build",
    name: "Chart Build",
    summary: "viz-master 图表构建技能，说明声明式 chart-spec schema（line/bar/pie）、图表类型决策树，以及如何 emit 恰好一个 apply.chart_create 步骤。",
    layer: "operator_semantics",
    audience: "viz_master_only",
    defaultInjection: "viz_master_default",
    priority: 10,
    tags: Object.freeze(["chart", "图表", "line", "bar", "pie", "viz", "可视化", "spec"]),
    pluginRefs: Object.freeze(["watchdog"]),
    toolRefs: Object.freeze(["apply.chart_create", "apply.chart_move", "inspect.charts"]),
    guideLine: "图表构建技能，定义声明式 chart-spec（line/bar/pie），把静态数据装进 spec 并 emit 一个 apply.chart_create。",
    operatorUse: "viz-master 图表技能：读懂数据 → 选 line/bar/pie → 装进合法 chart-spec → emit 恰好一个 apply.chart_create（chart 家族无 verify）。",
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

export function listRoleSemanticSkillRefs(role) {
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

export function listOperatorSemanticSkillRefs() {
  const operatorOnly = listSemanticSkillSpecs()
    .filter((spec) => spec.defaultInjection === "operator_default")
    .map((spec) => spec.id);

  return uniqueStrings([
    ...listForcedPlatformSkillRefs(),
    "system-action",
    ...operatorOnly,
  ]);
}

