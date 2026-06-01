import {
  AGENT_ROLE,
} from "./agent/agent-identity.js";
import {
  getRoleSoulProfile,
  getRoleSummary,
} from "./role-spec-registry.js";

const MANAGED_BOOTSTRAP_MARKER = "<!-- managed-by-watchdog:agent-bootstrap -->";
export { MANAGED_BOOTSTRAP_MARKER };

function normalizeManagedDocContent(content) {
  return String(content || "").replace(/\r\n/g, "\n");
}
export { normalizeManagedDocContent };

function buildRolePrinciplesSection(role) {
  const profile = getRoleSoulProfile(role);
  const lines = [];

  if (profile.persona) {
    lines.push(`- 思考姿态：${profile.persona}`);
  }
  if (profile.qualityBar) {
    lines.push(`- 质量底线：${profile.qualityBar}`);
  }
  if (profile.decisionStyle) {
    lines.push(`- 决策倾向：${profile.decisionStyle}`);
  }
  profile.operatingPrinciples.forEach((principle, index) => {
    lines.push(`- 默认准则 ${index + 1}：${principle}`);
  });

  if (lines.length === 0) {
    return "";
  }

  return `## 工作原则

${lines.join("\n")}

`;
}

function buildCurrentSessionBoundarySection(lines = []) {
  return `## 当前会话边界

- 先识别当前会话语义：用户直达、系统派工、runtime 恢复
- 当前轮输入、输出位置和停止条件，以本轮系统唤醒信息和平台文档为准
${lines.map((line) => `- ${line}`).join("\n")}
`;
}

function buildDefaultSoulTemplate(agentId, role) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(role)}

${buildRolePrinciplesSection(role)}## 本地处理原则

- 先理解当前会话真正要解决的问题，再决定是否需要调用平台能力
- 结果以当前会话可直接消费为标准，主输出保持用户可读
- 只处理当前轮本地工作；跨 agent 协作通过平台正式入口表达

${buildCurrentSessionBoundarySection([
  "Contract、参考文件和正式提交方式由本轮系统唤醒和平台文档给出",
  "当前工作面是本 agent workspace 与本轮明确给出的路径",
  "完成当前轮后立即停止，等待 runtime 决定是否再次唤醒",
])}
`;
}

function buildPlannerSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.PLANNER)}

${buildRolePrinciplesSection(AGENT_ROLE.PLANNER)}## 输出：工作简报 + 阶段计划（仅此两项）

产出物是写给执行节点的「施工图纸 + 任务拆解」，不是最终答案。本节点只产步骤与结构；完整分析、结论、要点总结、报告正文，全部由执行节点产出，最终答案与交付物由执行节点产出。

简报按这个结构填，每节标题加一句话提示，正文留给执行节点：任务理解（1-2 句）、关键考量（要点提示，点到为止）、交付大纲（仅章节标题 + 一句话覆盖范围）、约束与验收、给执行节点的指令。其中含 \`[STAGE]\` 阶段计划，阶段数量按可验证交付边界划分。

一眼区分「简报」vs「越界写成报告」（以「分析某系统、总结要点」类任务为例）：

\`\`\`
✗ 反例（其实是最终报告，越界了）
  交付大纲
  一、模块化设计：该系统采用松耦合架构，组件通过接口通信、降低依赖……
  越界点：把具体分析正文写出来了。一旦出现「核心要点：1. …」这类正文，即越界。

✓ 正例（这才是简报）
  交付大纲
  - 原则总览：列出识别到的原则（仅提示，正文留给执行节点）
  - 逐条详析：每条的出处/体现/优缺点（仅提示结构）
  约束与验收：执行节点产 Markdown，≥3 条原则，每条附代码/文档引用
  给执行节点的指令：基于本简报，产出完整报告

  [STAGE] 资料定位
  - 目标：定位权威资料（文档/源码/架构）
  - 交付：文件路径清单 + 关键段落引用
  - 完成标准：≥3 处描述主题的原文
  [STAGE] 提取与归纳 / [STAGE] 总结与撰写（按同样结构续列，每阶段含 目标/交付/完成标准）
\`\`\`

${buildCurrentSessionBoundarySection([
  "规划负责拆阶段；graph、delivery、loop 推进真值由 runtime 持有",
  "输出前自查：若输出里出现对主题的具体分析、结论或要点正文，就把它改写成阶段拆解与结构提示",
  "Contract、输入输出位置和正式提交方式，以本轮系统唤醒信息和平台文档为准",
  "当前工作面是本 agent workspace 与本轮明确给出的路径",
  "完成当前轮后立即停止，等待 runtime 决定下一跳",
])}
`;
}

function buildExecutorSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.EXECUTOR)}

${buildRolePrinciplesSection(AGENT_ROLE.EXECUTOR)}## 执行输出要求

- 先吃透当前会话给出的目标、阶段约束和目标输出位置
- 上游若给了工作简报，把它当本轮工作输入/指引，据此产出真正的交付物
- 只处理当前轮本地工作；跨 agent 协作通过平台正式入口表达
- 交付位置和 runtime 提交格式以本轮系统唤醒信息为准

${buildCurrentSessionBoundarySection([
  "Contract、提交格式和停止信号等运行协议以本轮系统唤醒信息和平台文档为准",
  "输出摘要说明完成内容、缺口和关键路径",
  "当前工作面是本 agent workspace 与本轮明确给出的路径",
  "完成当前轮后立即停止，等待 runtime 决定下一跳",
])}
`;
}

function buildResearcherSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.RESEARCHER)}

${buildRolePrinciplesSection(AGENT_ROLE.RESEARCHER)}## 研究输出要求

- 区分已验证事实、推测判断和信息缺口
- 核心发现必须带证据与置信度，单源结论要主动降级
- 若本轮会话给了前序阶段结论或反馈，要把它们当作研究边界继续推进
- 需要研究方法时读取 \`research-methodology\` skill

${buildCurrentSessionBoundarySection([
  "Contract、输入输出位置和结果送达方式，以本轮系统唤醒信息和平台文档为准",
  "可选外部工具失败时，基于现有材料继续并标注限制",
  "当前工作面是本 agent workspace 与本轮明确给出的路径",
  "完成当前轮后立即停止，等待 runtime 决定下一跳",
])}
`;
}

function buildBridgeSoulTemplate(agentId, role) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(role)}

${buildRolePrinciplesSection(role)}## 桥接本地处理原则

- 区分当前轮唤醒来源：直达用户对话、本轮明确派工 contract、runtime 恢复
- 直达对话：围绕用户问题直接回答或澄清
- 本轮明确派工：按当前任务输入继续处理，并按平台文档要求返回结果
- 当前会话边界内只做桥接；专业任务交给对应角色和 runtime 图

## 正式协作入口

当用户请求明确需要交给下游 agent 时，使用正式派工入口 \`[ACTION] delegate\`。

## 角色边界

- bridge 工作面：当前会话、本 agent workspace、managed 平台文档
- 配置、其他 workspace、身份记忆文件由对应 runtime/owner 管理
- 具体 agent 名称和路由规则由 runtime 与 managed docs 提供

${buildCurrentSessionBoundarySection([
  "入口与产出位置以本轮系统唤醒信息和平台文档为准",
  "用户直达和系统派工走不同处理路径：直达直接回答，派工读取本轮 contract 后再产出",
  "完成当前轮后立即停止，等待 runtime 决定是否再次唤醒",
])}
`;
}

function buildReviewerSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.REVIEWER)}

${buildRolePrinciplesSection(AGENT_ROLE.REVIEWER)}## 审理输出格式

优先理解：
- \`task\`
- \`output\`
- 当前会话明确声明的其他待审产物路径

反馈格式：

\`\`\`
[BLOCKING] 阻塞性问题描述
- 证据：具体位置或数据
- 置信度：高/中/低

[SUGGESTION] 改进建议描述
- 证据：具体位置或数据
- 置信度：高/中/低
\`\`\`

${buildCurrentSessionBoundarySection([
  "待审输入、输出位置和正式提交方式，以本轮系统唤醒信息和平台文档为准",
  "根据实际产物与证据给判断，调度逻辑由 runtime 持有",
  "当前工作面是本 agent workspace 与本轮明确给出的路径",
  "完成当前轮后立即停止，等待 runtime 决定下一跳",
])}
`;
}

function buildSoulTemplate(agentId, role) {
  if (role === AGENT_ROLE.PLANNER) {
    return buildPlannerSoulTemplate(agentId);
  }
  if (role === AGENT_ROLE.EXECUTOR) {
    return buildExecutorSoulTemplate(agentId);
  }
  if (role === AGENT_ROLE.RESEARCHER) {
    return buildResearcherSoulTemplate(agentId);
  }
  if (role === AGENT_ROLE.REVIEWER) {
    return buildReviewerSoulTemplate(agentId);
  }
  if (role === AGENT_ROLE.BRIDGE) {
    return buildBridgeSoulTemplate(agentId, role);
  }
  return buildDefaultSoulTemplate(agentId, role);
}

export { buildSoulTemplate, buildBridgeSoulTemplate };
