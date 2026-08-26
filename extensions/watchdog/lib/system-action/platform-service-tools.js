// platform-service-tools.js — 平台服务 FC 族的单一真值表。
//
// 这一族与协作族(assign_task / wake_agent)**平级、各自单源、
// 互不污染**。区别是方向:协作族是 agent **找人**(跨 agent、开票据、走
// systemActionConsume 汇合点),本族是 agent **向平台交付**(不跨 agent、不开票据、
// 不查图边,execute 直连本地 handler)。
//
// 刻意不做的三件事:
// - **不进 INTENT_TYPES,不进 collaboration-intent-policy**。那会一次性污染协作表的
//   四个消费点,并稀释"协作授权"这个词的语义。
// - **不接角色矩阵**。"声明我这轮的结果"是任何角色都该能做的事,给它接权限线等于
//   凭空造一条授权真值。协作族需要角色矩阵是因为它能动别人;本族只能动自己。
// - **不为它造 L2 fence**。层级只设 L1(工具)与 L3(`outbox/runtime_result.json` 文件)。
//
// 表一次成型、缓建行在场:该表要被 before_tool_call 的白名单并集对称消费,每动一次
// 表就是一次回归面。缓建行的处理与 collaboration-intent-policy 里 create_task 同款——
// 在词表里可被识别为"已知但未开放",而不是"未知"。

export const PLATFORM_SERVICE_TOOLS = Object.freeze([
  // 唯一已建。它扛的是平台自己观察不到的那三个状态。
  Object.freeze({
    tool: "submit_output",
    exposedAsTool: true,
  }),

  // 缓建(2026-08-09 用户裁定)。submit_plan 与 report_progress 是**同一功能的两半**:
  // plan 报 N 个 stage → agent 完成第 n 个报 progress → 前端实时给 stage 打勾。
  // 分开建会出现"有计划无进度"的中间态,因此成对。
  // 设计见 docs/superpowers/specs/2026-08-06-submit-plan-design.md。
  Object.freeze({
    tool: "submit_plan",
    exposedAsTool: false,
  }),
  Object.freeze({
    tool: "report_progress",
    exposedAsTool: false,
  }),
]);

export function listPlatformServiceToolNames() {
  return PLATFORM_SERVICE_TOOLS.map((row) => row.tool);
}

export function listExposedPlatformServiceTools() {
  return PLATFORM_SERVICE_TOOLS.filter((row) => row.exposedAsTool).map((row) => row.tool);
}

// before_tool_call 的角色工具白名单与本族的并集对称(与 isExposedCollabToolForRole 同位)。
// 本族无角色维度,所以判定只有一问:它是不是一个已暴露的平台服务工具。
export function isExposedPlatformServiceTool(toolName) {
  return listExposedPlatformServiceTools().includes(toolName);
}
