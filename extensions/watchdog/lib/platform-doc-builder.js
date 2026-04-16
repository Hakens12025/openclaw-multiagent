import { detectCycles, getEdgesFrom, getEdgesTo } from "./agent/agent-graph.js";
import {
  composeDefaultCapabilityProjection,
  getCapabilityDirectoryOrder,
} from "./agent/agent-capability-policy.js";
import { getSemanticSkillSpec, listAutoInjectedAgentSkillRefs } from "./semantic-skill-registry.js";
import { normalizeString, uniqueStrings } from "./core/normalize.js";
import { AGENT_ROLE, normalizeAgentRole } from "./agent/agent-identity.js";
import { MANAGED_BOOTSTRAP_MARKER } from "./soul-template-builder.js";
import { PROTOCOL_ID } from "../protocol-registry.js";

function buildHeartbeatTemplate() {
  return `${MANAGED_BOOTSTRAP_MARKER}
# HEARTBEAT.md

这是 runtime 唤起，不是自由闲聊。

严格按下面顺序执行：

1. 检查 \`inbox/contract.json\`（唯一任务输入）
2. 存在就按 \`SOUL.md\` 执行当前任务，不要只回复 \`HEARTBEAT_OK\`
3. 不存在时，回复 \`HEARTBEAT_OK\` 并停止
`;
}

function buildAgentsTemplate(agentId, role, skills) {
  const normalizedSkills = uniqueStrings(skills || []);
  const skillSummary = normalizedSkills.length > 0 ? normalizedSkills.join("、") : "无";
  const hasSystemAction = normalizedSkills.includes("system-action");
  const primaryResultRule = "主结果写 contract 的 `output`";
  return `${MANAGED_BOOTSTRAP_MARKER}
# AGENTS.md

你运行在 OpenClaw 平台里，不是裸跑在文件系统中。

- Agent: \`${agentId}\`
- Role: \`${role}\`
- Loaded skills: ${skillSummary}

执行时先看：
1. \`SOUL.md\`：主循环和绝对规则
2. \`inbox/contract.json\`：当前任务真值；若不存在通常应 \`HEARTBEAT_OK\`
3. \`PLATFORM-GUIDE.md\`：平台入口、出口、协作方式
4. 需要找协作者时再查 \`BUILDING-MAP.md\`
5. 准备显式协作时再查 \`COLLABORATION-GRAPH.md\`
6. 处理 delivery 语义时再查 \`DELIVERY.md\`
7. 已加载技能：遇到对应问题时按 skill 走

最低规则：
- 先读 \`inbox/contract.json\`，不要扫描整个 workspace
- ${primaryResultRule}
- ${hasSystemAction ? "需要协作时在产物里写 `[ACTION]` 标记（见 PLATFORM-GUIDE.md 协作动作）" : "当前未加载协作能力，不要自己伪造调度协议"}
- 不直接写别的 agent workspace
`;
}

function buildSkillGuideLine(skillId) {
  const semanticSpec = getSemanticSkillSpec(skillId);
  if (semanticSpec?.guideLine) {
    return `- \`${skillId}\`: ${semanticSpec.guideLine}`;
  }
  switch (skillId) {
    case "agent-bootstrap-designer":
      return "- `agent-bootstrap-designer`: 设计新 agent 的启动画像，说明 role、默认 skills 与本地引导文件如何生成。";
    case "model-switcher":
      return "- `model-switcher`: 需要切换模型时的标准做法。";
    case "skill-deployer":
      return "- `skill-deployer`: 创建或部署新 skill 的标准方式。";
    default:
      return `- \`${skillId}\`: 按该 skill 的说明执行，不要自己猜协议或参数。`;
  }
}

function getWorkspaceGuidanceSkills(agentId, role, fallbackSkills = [], agentEntries = []) {
  const entry = agentEntries.find((e) => e.id === agentId);
  const entrySkills = uniqueStrings(entry?.skills || []);
  return uniqueStrings([
    ...listAutoInjectedAgentSkillRefs(role),
    ...fallbackSkills,
    ...entrySkills,
  ]);
}

function describeAgentIngress(entry) {
  if (!entry.gateway) return "内部办公室";
  switch (entry.ingressSource) {
    case "webui":
      return "前台入口（WebUI）";
    case "qq":
      return "前台入口（QQ）";
    case "test":
      return "测试入口";
    default:
      return "网关入口";
  }
}

function describeAgentCallUse(entry) {
  switch (entry.role) {
    case AGENT_ROLE.BRIDGE:
      return entry.gateway
        ? "前台入口。适合接待外部来客，并把请求送进楼内。"
        : "桥接型节点，负责消息出入口，不承担重执行。";
    case AGENT_ROLE.PLANNER:
      return "复杂、多阶段、需要拆分或分工时找它规划。";
    case AGENT_ROLE.EXECUTOR:
      return entry.specialized
        ? "专项执行办公室。适合特化编码、实验、重执行或明确需要该专长的任务。"
        : "通用执行办公室。适合明确、边界清晰、可直接落地的子任务。";
    case AGENT_ROLE.RESEARCHER:
      return "研究检索办公室。适合资料搜集、研究方向探索、提出假设和研究路线。";
    case AGENT_ROLE.REVIEWER:
      return "审查评估办公室。适合代码审查、质量闸、研究方向评价与继续/收口判断。";
    default:
      return "通用节点。优先按 Contract 和已加载 skill 工作。";
  }
}

function buildWorkspaceAgentDirectory(agentId, role, skills, agentEntries = []) {
  const entries = [];
  for (const raw of agentEntries) {
    const entryRole = normalizeAgentRole(raw.role, raw.id);
    const entrySkills = getWorkspaceGuidanceSkills(raw.id, entryRole, [], agentEntries);
    entries.push({
      id: raw.id,
      role: entryRole,
      gateway: raw.gateway === true,
      ingressSource: normalizeString(raw.ingressSource)?.toLowerCase() || null,
      specialized: raw.specialized === true,
      skills: entrySkills,
    });
  }

  if (!entries.some((entry) => entry.id === agentId)) {
    entries.push({
      id: agentId,
      role,
      gateway: false,
      ingressSource: null,
      specialized: false,
      skills: getWorkspaceGuidanceSkills(agentId, role, skills, agentEntries),
    });
  }

  return entries.sort((left, right) => {
    if (left.id === agentId) return -1;
    if (right.id === agentId) return 1;
    const leftOrder = getCapabilityDirectoryOrder(left.role);
    const rightOrder = getCapabilityDirectoryOrder(right.role);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
  });
}

function formatAgentIdList(agentIds, {
  emptyLabel = "无",
} = {}) {
  return agentIds.length > 0
    ? agentIds.map((id) => `\`${id}\``).join("、")
    : emptyLabel;
}

function formatLoopNodePath(agentIds) {
  return uniqueStrings(agentIds || [])
    .map((id) => `\`${id}\``)
    .join(" → ");
}

function buildRegisteredLoopSection(agentId, loops = []) {
  const normalizedAgentId = normalizeString(agentId);
  const resolvedLoops = (Array.isArray(loops) ? loops : [])
    .filter((loop) => loop?.id)
    .slice()
    .sort((left, right) => {
      if ((left?.active === true) !== (right?.active === true)) {
        return left?.active === true ? -1 : 1;
      }
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    });

  if (resolvedLoops.length === 0) {
    return "- 当前无已登记 loop。";
  }

  return resolvedLoops.map((loop) => {
    const nodes = uniqueStrings(loop?.nodes || []);
    const flags = [];
    if (normalizeString(loop?.entryAgentId) === normalizedAgentId) flags.push("你是 entry");
    if (nodes.includes(normalizedAgentId)) flags.push("你在回路中");
    const flagSuffix = flags.length > 0 ? ` | ${flags.join(" | ")}` : "";
    const missingEdges = Array.isArray(loop?.missingEdges) ? loop.missingEdges : [];
    const missingText = missingEdges.length > 0
      ? `; missingEdges=${missingEdges.map((edge) => `\`${edge.from}->${edge.to}\``).join("、")}`
      : "";
    return `- \`${loop.id}\` [${loop?.active === true ? "active" : "inactive"}${flagSuffix}] entry=\`${normalizeString(loop?.entryAgentId) || "unknown"}\`; nodes=${formatLoopNodePath(nodes)}${missingText}`;
  }).join("\n");
}

function rotateCycleToStart(cycle, agentId) {
  const nodes = uniqueStrings(
    (Array.isArray(cycle) ? cycle : [])
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
  );
  if (nodes.length === 0) return [];
  const startIndex = nodes.indexOf(agentId);
  return startIndex >= 0
    ? [...nodes.slice(startIndex), ...nodes.slice(0, startIndex)]
    : nodes;
}

function getAgentCycleDescriptions(graph, agentId) {
  const descriptions = [];
  const seen = new Set();
  for (const cycle of detectCycles(graph)) {
    if (!Array.isArray(cycle) || !cycle.includes(agentId)) continue;
    const ordered = rotateCycleToStart(cycle, agentId);
    if (ordered.length === 0) continue;
    const closedLoop = [...ordered, ordered[0]];
    const key = closedLoop.join("->");
    if (seen.has(key)) continue;
    seen.add(key);
    descriptions.push(closedLoop.map((id) => `\`${id}\``).join(" → "));
  }
  return descriptions;
}

function getGraphCollaborationSummary(graph, agentId) {
  return {
    outgoingTargets: uniqueStrings(
      getEdgesFrom(graph, agentId)
        .map((edge) => normalizeString(edge?.to))
        .filter(Boolean),
    ),
    incomingSources: uniqueStrings(
      getEdgesTo(graph, agentId)
        .map((edge) => normalizeString(edge?.from))
        .filter(Boolean),
    ),
    cycles: getAgentCycleDescriptions(graph, agentId),
  };
}

function buildOfficeDirectoryLines(agentId, role, skills, agentEntries = []) {
  const directory = buildWorkspaceAgentDirectory(agentId, role, skills, agentEntries);
  return directory
    .filter((entry) => entry.id !== agentId)
    .map((entry) => {
      const flags = [];
      if (entry.gateway) flags.push(describeAgentIngress(entry));
      if (entry.specialized) flags.push("specialized");
      const flagText = flags.length > 0 ? ` [${flags.join(" | ")}]` : "";
      return [
        `### \`${entry.id}\`${flagText}`,
        `- Role: \`${entry.role}\``,
        `- 何时找它: ${describeAgentCallUse(entry)}`,
      ].join("\n");
    }).join("\n\n");
}

function buildBuildingMapTemplate(agentId, role, skills, agentEntries = []) {
  const directoryLines = buildOfficeDirectoryLines(agentId, role, skills, agentEntries);

  return `${MANAGED_BOOTSTRAP_MARKER}
# BUILDING-MAP.md

这是一份楼宇黄页，只回答“别人是谁、什么时候通常找谁”。

## 这栋楼的分工

- 前台（bridge）负责接待外部来客，并把外部请求送进楼内
- 办公室负责内容生产、研究、审查与决策；具体该找谁，以当前实际 agent 目录为准
- 图权限不在这里定义；需要确认“现在能主动找谁”，去看 \`COLLABORATION-GRAPH.md\`
- 结果如何自动逐层送达不在这里定义；需要确认 delivery 语义，去看 \`DELIVERY.md\`

## 楼宇目录

${directoryLines}
`;
}

function buildCollaborationGraphTemplate(agentId, role, graph = { edges: [] }, loops = []) {
  const {
    outgoingTargets,
    incomingSources,
    cycles,
  } = getGraphCollaborationSummary(graph, agentId);

  return `${MANAGED_BOOTSTRAP_MARKER}
# COLLABORATION-GRAPH.md

这份文档只回答：你现在能主动找谁，以及哪些显式协作动作受图约束。

## 当前图权限

- 你可直接调用: ${formatAgentIdList(outgoingTargets, { emptyLabel: "当前无显式出边" })}
- 可直接调用你: ${formatAgentIdList(incomingSources, { emptyLabel: "当前无显式入边" })}
- \`assign_task\` / \`wake_agent\` / \`request_review\` 这类显式点对点协作，都先看这份图权限
- 是否允许某个动作，还要同时遵守 \`SOUL.md\` 和对应 skill 的角色边界

## 当前显式回路

${cycles.length > 0 ? cycles.map((cycle) => `- ${cycle}`).join("\n") : "- 当前不在显式回路中"}

## 已登记回路

${buildRegisteredLoopSection(agentId, loops)}

## 使用原则

- 先用 \`BUILDING-MAP.md\` 选候选协作者，再用这份文档确认当前权限
- 没有图上的出边，不要主动发起显式 agent-to-agent 协作
- loop 是图上的推进结构，不是私有旁路协议
`;
}

function buildDeliveryTemplate() {
  return `${MANAGED_BOOTSTRAP_MARKER}
# DELIVERY.md

这份文档只回答：结果如何离开当前 contract，以及为什么会自动送到正确的下一跳。

## 两条 delivery 语义

- \`${PROTOCOL_ID.DELIVERY.TERMINAL}\`：contract 到终态后，把结果送到最终用户或前台入口（controller / QQ）
- \`delivery:system_action\`：文档里的概念家族；运行时不会写这个模糊 id，而是落到具体的 system_action return variant

## 核心字段

- \`replyTo\`：这一跳先回给谁
- \`upstreamReplyTo\`：上一层处理完后，再继续回给谁
- \`systemActionDeliveryTicket\`：runtime 持有的 delivery 票据，用来把结果精确送回同一业务会话

## ${PROTOCOL_ID.DELIVERY.TERMINAL}

- 普通 contract 完成后，runtime 走 terminal delivery
- 若目标是 QQ / controller，这一跳直接送到最终用户侧
- 这是“任务结束后往外送”的出口，不是 agent 间继续协作

## delivery:system_action（概念家族）

- 子任务完成后，结果先按 \`replyTo\` 回给直接上游
- 直接上游处理完后，再按 \`upstreamReplyTo\` 继续往上回
- direct service 同会话恢复时，runtime 会结合 delivery ticket、sessionKey 和 wake 机制把结果送回原会话
- 叶子 agent 不需要记整条祖先路线；runtime 根据票据和 route metadata 负责回件

## 为什么没出边也能回去

- 图权限回答“你能主动找谁”
- delivery 回答“你做完后结果自动送到哪”
- 所以即使某个 worker 没有显式出边，也可以把结果自动退回上游

## 两类常见 system_action delivery

- \`${PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_ASSIGN_TASK_RESULT}\`：子任务委派完成后，把结果送回委派者
- \`${PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_CONTRACT_RESULT}\`：普通 runtime 子流程完成后，把结果送回发起该子流程的上游
- \`${PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_REVIEW_VERDICT}\`：审查 verdict 送回发起审查的 agent / session

## 使用原则

- 不手工搬运子任务结果
- 不把 delivery 语义写回 \`BUILDING-MAP.md\`
- 要理解 delivery 问题时，看这份文档，不要靠猜图关系
`;
}

function buildOutboxManifestExample(role) {
  switch (role) {
    case AGENT_ROLE.RESEARCHER:
    case AGENT_ROLE.REVIEWER:
    case AGENT_ROLE.PLANNER:
    default:
      return `\`\`\`json
{
  "version": 1,
  "kind": "execution_result",
  "artifacts": [
    { "type": "text_output", "path": "<output文件名>.md", "required": true }
  ]
}
\`\`\``;
  }
}

function buildPlatformGuideTemplate(agentId, role, skills, graph = { edges: [] }, loops = []) {
  const normalizedSkills = uniqueStrings(skills || []);
  const defaultCapabilities = composeDefaultCapabilityProjection({
    role,
    skills: normalizedSkills,
  });
  const tools = uniqueStrings(defaultCapabilities.tools || []);
  const outputs = uniqueStrings(defaultCapabilities.outputFormats || []);
  const hasSystemAction = normalizedSkills.includes("system-action");
  const guideLines = normalizedSkills.length > 0
    ? normalizedSkills.map((skillId) => buildSkillGuideLine(skillId)).join("\n")
    : "- 当前无额外技能。若后续注入 skill，优先按 skill 说明执行。";
  const specialEntrances = [];
  const primaryResultRules = "- 主结果写到 contract 的 `output`";
  const platformOutboxRule = hasSystemAction
    ? "- 需要协作时在产物末尾写 `[ACTION]` 标记（系统自动提取并执行）"
    : "- 当前未加载协作能力，不要自己伪造调度协议";
  const platformActionSection = hasSystemAction
    ? [
        "需要协作时，在产物 markdown 里写 `[ACTION]` 标记。系统会自动提取并执行。",
        "",
        "简写命令：",
        "",
        "```",
        "[ACTION] wake <agentId> — <理由>          唤醒指定 agent",
        "[ACTION] delegate <agentId> — <任务描述>   触发 assign_task",
        "[ACTION] review <agentId> — <审理指示>     请求审理",
        "```",
        "",
        "复杂参数动作：",
        "",
        "```",
        "[ACTION] {\"type\":\"create_task\",\"params\":{...}}",
        "[ACTION] {\"type\":\"assign_task\",\"params\":{...}}",
        "[ACTION] {\"type\":\"request_review\",\"params\":{...}}",
        "[ACTION] {\"type\":\"advance_loop\",\"params\":{\"suggestedNext\":\"<stageId>\",\"reason\":\"<理由>\"}}",
        "```",
        "",
        "规则：",
        "- 自己能完成就自己完成，不要随意 wake 或 delegate",
        "- 先看 `COLLABORATION-GRAPH.md` 确认你有权调用的 agent",
        "- 一次最多写一个 [ACTION]（系统只执行第一个）",
        "- 协作结果默认由 runtime 自动送达；delivery 语义看 `DELIVERY.md`",
      ].join("\n")
    : "当前未加载协作能力，你的协作边界以现有角色硬路径和已加载技能为准。";

  return `${MANAGED_BOOTSTRAP_MARKER}
# PLATFORM-GUIDE.md

## 平台默认

- Default tools: ${tools.join("、")}
- Output formats: ${outputs.join("、")}
- 楼宇黄页见 \`BUILDING-MAP.md\`
- 图权限见 \`COLLABORATION-GRAPH.md\`
- delivery 语义见 \`DELIVERY.md\`

## 平台固定入口

- 第一入口永远是 \`inbox/contract.json\`
- Contract 会告诉你当前任务、阶段和主输出路径
${specialEntrances.join("\n")}

若这些入口都不存在，通常应直接 \`HEARTBEAT_OK\`，不要自己扫描整棵目录树。

## 平台固定出口

${primaryResultRules}
${platformOutboxRule}

## 外部工具降级规则

- \`web_search\`、\`web_fetch\` 等外部工具是增强能力，不是默认阻塞点
- 若外部工具因无 key、无网络、权限不足或服务异常而失败，只要当前任务还能基于现有 context / contract / 本地文件继续，就继续推进并在产物里注明限制
- 不要因为一次可选工具失败就停在中间，也不要把”工具不可用”误当成整个任务的终态

## 协作命令

${platformActionSection}

## 已加载技能

${guideLines}
`;
}

export { buildHeartbeatTemplate, buildAgentsTemplate, buildBuildingMapTemplate, buildCollaborationGraphTemplate, buildDeliveryTemplate, buildOutboxManifestExample, buildPlatformGuideTemplate };
