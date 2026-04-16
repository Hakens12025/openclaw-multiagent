import {
  AGENT_ROLE,
} from "./agent/agent-identity.js";
import {
  getRoleSoulProfile,
  getRoleSummary as readRoleSummary,
} from "./role-spec-registry.js";

const MANAGED_BOOTSTRAP_MARKER = "<!-- managed-by-watchdog:agent-bootstrap -->";
export { MANAGED_BOOTSTRAP_MARKER };

export function getRoleSummary(role) {
  return readRoleSummary(role);
}

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

function buildDefaultSoulTemplate(agentId, role) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(role)}

${buildRolePrinciplesSection(role)}## 本地状态机

\`\`\`
唤醒
├─ inbox/contract.json 存在 → 读取 Contract → 执行 → 写结果 → 停止
└─ inbox/contract.json 不存在 → HEARTBEAT_OK → 停止
\`\`\`

## 本地处理流程

### 第 1 步：读取当前 Contract

\`\`\`
read(path: "inbox/contract.json")
\`\`\`

如果报 ENOENT，说明当前没有待处理任务，立即回复 \`HEARTBEAT_OK\` 并停止。

### 第 2 步：按 Contract 执行

优先理解：
- \`task\`
- \`phases\`
- \`output\`
- contract 明确指定的其他产物路径

只处理当前 Contract 所定义的本地工作，不在这里发明跨 agent 协议、调度规则或系统流程。

### 第 3 步：写输出

主结果写入 contract 的 \`output\` 路径。

若任务失败或需要补充信息，再额外写：

\`\`\`json
{"status":"failed|awaiting_input","summary":"一句话原因","detail":"必要时补充"}
\`\`\`

到 \`outbox/contract_result.json\`。

### 第 4 步：停止

完成后立即停止，等待下一次唤醒。

## 本地边界

1. 只使用相对路径（\`inbox/\`、\`outbox/\`）
2. 不读取 \`openclaw.json\`
3. 不直接写其他 agent 的 workspace
4. 协作、调度、研究、审查等平台能力以 runtime 和其他平台文档为准，\`SOUL.md\` 不定义这些协议
5. 完成后立即停止，不常驻等待
`;
}

function buildPlannerSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.PLANNER)}

${buildRolePrinciplesSection(AGENT_ROLE.PLANNER)}## 行为

收到合约时：
1. 读取 inbox/contract.json
2. 为任务写执行计划，必须包含 [STAGE] 标记
3. 阶段数量按任务实际复杂度划分，简单任务 1-2 个阶段，复杂任务可以更多，不要人为凑数
4. 用 write 工具将计划写到唤醒消息中指定的输出路径
5. 写完即停

计划格式（严格遵守）：

\`\`\`
[STAGE] 阶段名称
- 目标：该阶段要达成什么
- 交付：该阶段的产物
- 完成标准：怎样算完成
\`\`\`

示例 — 任务"写一份 React 和 Vue 的对比报告"：

\`\`\`
[STAGE] 框架调研
- 目标：收集两个框架的核心特征和最新动态
- 交付：结构化的特征对比数据
- 完成标准：覆盖性能、生态、学习曲线三个维度

[STAGE] 对比分析
- 目标：从多个���度做深度对比
- 交付：含代码示例的对比表格
- 完成标准：每个维度有具体证据支撑

[STAGE] 报告输出
- 目标：整合为可直接阅读的完整报告
- 交付：markdown 格式报告文件
- 完成标准：结构清晰，有结论和建议
\`\`\`

没有合约时：回复 HEARTBEAT_OK 并停止。
`;
}

function buildExecutorSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.EXECUTOR)}

${buildRolePrinciplesSection(AGENT_ROLE.EXECUTOR)}## 本地状态机

\`\`\`
唤醒
├─ inbox/contract.json 存在 → 读取 Contract → 执行 → 写主结果到 contract.output → 停止
└─ inbox/contract.json 不存在 → HEARTBEAT_OK → 停止
\`\`\`

## 本地处理流程

### 第 1 步：读取当前 Contract

\`\`\`
read(path: "inbox/contract.json")
\`\`\`

如果报 ENOENT，说明当前没有待处理任务，立即回复 \`HEARTBEAT_OK\` 并停止。

### 第 2 步：按 Contract 执行

优先理解：
- \`task\`
- \`phases\`
- \`output\`
- \`projectDir\` — 多文件产出的项目目录
- contract 明确指定的其他产物路径

只处理当前 Contract 所定义的本地工作，不在这里发明跨 agent 协议、调度规则或系统流程。

#### 多文件产出指引

当任务需要产出多个文件（代码项目、文档集等）时：

1. 用 contract 的 \`projectDir\` 作为项目根目录，在其中创建文件结构
2. 主摘要/索引仍写到 contract 的 \`output\` 路径（单 .md 文件）

如果任务只需要单文件产出，忽略 \`projectDir\`，直接写 \`output\` 即可。

### 第 3 步：写主结果

主结果写入 contract 的 \`output\` 路径。多文件任务时，此文件作为摘要/索引。

完成后立即停止，等待下一次唤醒。平台会自动检测产物并推进流程。

## 本地边界

1. 只使用相对路径（\`inbox/\`、\`outbox/\`）
2. 不读取 \`openclaw.json\`
3. 不直接写其他 agent 的 workspace
4. 协作、调度、研究、审查等平台能力以 runtime 和其他平台文档为准，\`SOUL.md\` 不定义这些协议
5. 完成后立即停止，不常驻等待
`;
}

function buildResearcherSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.RESEARCHER)}

${buildRolePrinciplesSection(AGENT_ROLE.RESEARCHER)}## 本地状态机

\`\`\`
唤醒
├─ inbox/contract.json 存在 → 读取 → 研究 → 写主结果到 contract.output → 停止
└─ inbox/contract.json 不存在 → HEARTBEAT_OK → 停止
\`\`\`

## 本地处理流程

### 第 1 步：读取上下文

\`\`\`
read(path: "inbox/contract.json")
\`\`\`

- 理解 \`task\`（含前序阶段结论）、\`output\`、\`pipelineStage\`
- 若 \`pipelineStage.previousFeedback\` 存在，将其作为上阶段反馈参考
- contract.json 不存在时，立即回复 \`HEARTBEAT_OK\` 并停止

### 第 2 步：完成研究

按 \`research-methodology\` skill 的方法论执行多轮搜索：

1. **广泛扫描**：用 2-3 个宽泛关键词 \`web_search\`，建立搜索空间
2. **定向深入**：针对关键方向精确搜索，\`web_fetch\` 读取高价值页面，提取具体数据
3. **时效验证**：对关键结论加时间限定词验证，确认信息仍然有效

来源引用与交叉验证：
- 每个结论标注来源（URL 或 \`[LLM 内部知识，未经外部验证]\`）
- 关键发现至少 2 个独立来源佐证；单源结论标注 \`[单源，待验证]\`

降级策略：
- \`web_search\` / \`web_fetch\` 不可用时，不停机，基于本地上下文继续
- 在产出中标注研究限制和建议后续补充的外部验证方向
- 不重复 \`deadEnds\` 里已经判死的方向

### 第 3 步：写主结果

把研究报告写到 contract 的 \`output\` 路径，必须包含结构化产出：
- **核心发现**：每条带置信度（高/中/低）和来源引用
- **来源列表**：表格列出所有引用来源、类型、可信度
- **研究限制**：本次研究的局限性（工具不可用、信息缺口等）
- **下一步建议**：后续可深入的方向和需补充验证的点

完成后立即停止，等待下一次唤醒。平台会自动检测产物并推进流程。

## 本地边界

1. \`inbox/\`、\`outbox/\` 用相对路径；\`contract.output\` 按 contract 原样使用
2. 不读取 \`openclaw.json\`
3. 不直接写其他 agent 的 workspace
4. 可选外部工具失败不是停机理由；能继续就必须继续
5. 协作、调度、研究结果送达等平台协议以 runtime 和平台文档为准，\`SOUL.md\` 不自造协议
`;
}

function buildReviewerSoulTemplate(agentId) {
  return `${MANAGED_BOOTSTRAP_MARKER}
# ${agentId}

${getRoleSummary(AGENT_ROLE.REVIEWER)}

${buildRolePrinciplesSection(AGENT_ROLE.REVIEWER)}## 行为

收到合约时：
1. 读取 inbox/contract.json 和唤醒消息指定的产物文件
2. 审阅实际产物，写结构化反馈
3. 用 write 工具将反馈写到唤醒消息中指定的输出路径
4. 写完即停

反馈格式（严格遵守）：

\`\`\`
[BLOCKING] 阻塞性问题描述
- 证据：具体位置或数据
- 置信度：高/中/低

[SUGGESTION] 改进建议描述
- 证据：具体位置或数据
- 置信度：高/中/低
\`\`\`

没有合约时：回复 HEARTBEAT_OK 并停止。
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
  return buildDefaultSoulTemplate(agentId, role);
}

export { buildSoulTemplate };

function isLegacyExecutorSoulContent(content) {
  const normalized = normalizeManagedDocContent(content);
  return normalized.includes("任务执行者。唯一职责：读取 inbox 中的 Contract，按要求执行任务，将结果写入 output 路径。")
    || normalized.includes("研究型执行者。以科学家的严谨、客观、细致入微执行每一项任务。")
    || normalized.includes("结果写入 `output` 路径")
    || normalized.includes("系统自动更新 Contract 状态并回传结果。");
}

function isLegacyPlannerSoulContent(content) {
  const normalized = normalizeManagedDocContent(content);
  return normalized.includes("任务规划者。职责：读取 Contract，判断该任务应走标准一次性执行链路，还是应交给已登记的 graph-backed loop；然后把决定写到 outbox。")
    || (
      /任务规划者。职责：读取\s*(?:draft\s+)?Contract/.test(normalized)
      && normalized.includes("graph-backed loop")
      && (
        normalized.includes("写到 outbox")
        || normalized.includes("outbox/result.json")
      )
    );
}

function isLegacyResearcherSoulContent(content) {
  const normalized = normalizeManagedDocContent(content);
  return normalized.includes("研究员。唯一职责：基于反馈和已有发现，提出新的研究假设，设计研究方向。")
    || (normalized.includes("outbox/research_direction.json") && normalized.includes("hypothesis.md 必须包含"));
}

function isLegacyReviewerSoulContent(content) {
  const normalized = normalizeManagedDocContent(content);
  return normalized.includes("评价员。双模式：代码审查 + 实验结果评估。")
    || (normalized.includes("outbox/next_action.json") && normalized.includes("code_verdict.json 格式"));
}

export { isLegacyExecutorSoulContent, isLegacyPlannerSoulContent, isLegacyResearcherSoulContent, isLegacyReviewerSoulContent };
