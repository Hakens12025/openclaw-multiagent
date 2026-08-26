// Template builder assembly for platform workspace docs.
// Graph helpers: platform-doc-graph.js
// Directory helpers: platform-doc-directory.js

import {
  composeDefaultCapabilityProjection,
} from "../agent/agent-capability-policy.js";
import { getSemanticSkillSpec, listAutoInjectedAgentSkillRefs } from "./semantic-skill-registry.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { AGENT_ROLE } from "../agent/agent-identity.js";
import { MANAGED_BOOTSTRAP_MARKER } from "./managed-doc-markers.js";
import { PROTOCOL_ID } from "../protocol/protocol-registry.js";
import {
  formatAgentIdList,
  getGraphCollaborationSummary,
} from "./platform-doc-graph.js";
import { buildOfficeDirectoryLines } from "./platform-doc-directory.js";

function buildHeartbeatTemplate() {
  return `${MANAGED_BOOTSTRAP_MARKER}
# HEARTBEAT.md

这是 runtime 唤起。目标是处理本轮待办。

按下面顺序执行：

1. 先识别本轮唤醒语义，优先以本轮系统唤醒信息为准
2. 若本轮明确是系统派工，按当前任务继续处理
3. 若本轮是直达会话恢复或普通唤醒，按当前会话继续处理
4. 以 \`Hook\` 开头的系统事件是其他节点运行的平台回执：其产物由平台在该节点自己的运行树采集归档，回执仅供知悉，此类轮次同样以 \`HEARTBEAT_OK\` 收尾
5. 空闲轮次以 \`HEARTBEAT_OK\` 收尾
`;
}

function buildAgentsTemplate(agentId, role, skills) {
  const normalizedSkills = uniqueStrings(skills || []);
  const skillSummary = normalizedSkills.length > 0 ? normalizedSkills.join("、") : "基础技能集";
  const hasSystemAction = normalizedSkills.includes("system-action");
  const actionLine = hasSystemAction
    ? "需要协作时调用协作工具（见 PLATFORM-GUIDE.md 协作动作）"
    : "协作方式：按当前会话和 `SOUL.md` 执行";
  return `${MANAGED_BOOTSTRAP_MARKER}
# AGENTS.md

你运行在 OpenClaw 平台里。

- Agent: \`${agentId}\`
- Role: \`${role}\`
- Loaded skills: ${skillSummary}

执行时先看：
1. \`SOUL.md\`：主循环和绝对规则
2. 当前会话输入：先看本轮系统唤醒和当前会话上下文；只有这轮明确是系统派工时，才读取对应 contract
3. \`PLATFORM-GUIDE.md\`：平台入口、出口、协作方式
4. 需要找协作者时再查 \`BUILDING-MAP.md\`
5. 准备显式协作时再查 \`COLLABORATION-GRAPH.md\`
6. 处理 delivery 语义时再查 \`DELIVERY.md\`
7. 已加载技能：遇到对应问题时按 skill 走

工作顺序：
- 先识别当前会话输入
- 只有本轮明确给出 contract 协议时，才按该协议读写对应文件
- ${actionLine}
- 当前工作面是本 agent workspace 与本轮明确给出的路径
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
      return `- \`${skillId}\`: 按该 skill 的说明执行。`;
  }
}

function buildBuildingMapTemplate(agentId, role, skills, agentEntries = []) {
  const directoryLines = buildOfficeDirectoryLines(agentId, role, skills, agentEntries);

  return `${MANAGED_BOOTSTRAP_MARKER}
# BUILDING-MAP.md

这是一份楼宇黄页，只回答"别人是谁、什么时候通常找谁"。

## 这栋楼的分工

- 前台（bridge）负责接待外部来客，并把外部请求送进楼内
- 办公室负责内容生产、研究、审查与决策；具体该找谁，以当前实际 agent 目录为准
- 固定管线见 \`COLLABORATION-GRAPH.md\`
- 结果自动送达语义见 \`DELIVERY.md\`

## 楼宇目录

${directoryLines}
`;
}

function buildCollaborationGraphTemplate(agentId, role, graph = { edges: [] }) {
  const {
    outgoingTargets,
    incomingSources,
    cycles,
  } = getGraphCollaborationSummary(graph, agentId);

  return `${MANAGED_BOOTSTRAP_MARKER}
# COLLABORATION-GRAPH.md

这份文档只回答：平台的固定管线怎么连，以及你在图上的位置。

## 你在固定管线上的位置

- 管线下游: ${formatAgentIdList(outgoingTargets, { emptyLabel: "出边集合: 空" })}
- 管线上游: ${formatAgentIdList(incomingSources, { emptyLabel: "入边集合: 空" })}
- 这张图定义**固定管线**：平台在没有显式目标时按它决定下一跳
- 你主动发起的协作（\`assign_task\` / \`wake_agent\`）自己指定目标，不受这张图约束
- 上面的“管线上游”只讲固定管线。**谁的产物会流进你的 inbox，看 \`inbox/contract.json\` 的 \`upstreamPackages\`** —— 那是本轮的真值，入边集合为空也照样可能有上游包
- 是否允许某个动作，遵守 \`SOUL.md\` 和对应 skill 的角色边界

## 当前显式回路

${cycles.length > 0 ? cycles.map((cycle) => `- ${cycle}`).join("\n") : "- 显式回路: 空"}

## 使用原则

- 用 \`BUILDING-MAP.md\` 选协作者；主动协作时把选中的 agent 填进工具参数即可
- 这份文档用来理解平台会把结果自动送去哪
`;
}

// L3 降级协作页。刻意独立成文件而不并进 PLATFORM-GUIDE:主提示词里只留一行指针,
// agent 在工具走得通时不必读这一页——教程与工具并排会形成竞争性指令。
function buildCollaborationFallbackTemplate() {
  return `${MANAGED_BOOTSTRAP_MARKER}
# COLLABORATION-FALLBACK.md

协作的主路是直接调用协作工具（\`assign_task\` / \`wake_agent\`）。工具在会话中途生效，结果当场返回受理凭证或结构化拒绝。

本页是**降级梯子**：当协作工具在本轮不可用时，按 L2 → L3 依次尝试。

## L2 · 结构化写法（自完善，优先用这一级）

在【产出文件末尾另起一行】写：

\`\`\`
[ACTION] {"type":"<intent>","params":{...}}
\`\`\`

示例：

\`\`\`
[ACTION] {"type":"assign_task","params":{"targetAgent":"<agentId>","message":"任务原文"}}
\`\`\`

## 唯一前提

**标记附在真实正文之后。** 只含标记的文件会被平台当控制载荷跳过。产出的采集不需要
任何提交令牌——写进 \`outbox/\` 就会被采集。任务只需一段答复时,直接回复即可:
平台把本轮回复正文当作交付内容采集,与文件产出同权。

## L3 · 动词简写（JSON 写不出来时的最后一级）

\`\`\`
[ACTION] delegate <目标> — <任务>
[ACTION] wake <目标> — <理由>
\`\`\`

平台先按 JSON 解析，解析不出再按这套动词表还原成同样的 intent。表达力弱于 L2（参数只有目标与一段文本），够用即可。

## 与主路的差别

标记在本轮结束后才被解析，因此拒绝理由要到下一轮才可见；协作工具在调用当场就返回结果，可以立即改正重试。
`;
}

function buildDeliveryTemplate() {
  return `${MANAGED_BOOTSTRAP_MARKER}
# DELIVERY.md

这份文档只回答：结果如何离开当前 contract，以及为什么会自动送到正确的下一跳。

## 两条 delivery 语义

- \`${PROTOCOL_ID.DELIVERY.TERMINAL}\`：contract 到终态后，把结果送到最终用户或前台入口（controller）
- \`delivery:system_action\`：文档里的概念家族；运行时落到具体的 system_action return variant

## 核心字段

- \`replyTo\`：这一跳先回给谁
- \`upstreamReplyTo\`：上一层处理完后，再继续回给谁
- \`systemActionDeliveryTicket\`：runtime 持有的 delivery 票据，用来把结果精确送回同一业务会话

## ${PROTOCOL_ID.DELIVERY.TERMINAL}

- 普通 contract 完成后，runtime 走 terminal delivery
- 若目标是 QQ / controller，这一跳直接送到最终用户侧
- 这是"任务结束后往外送"的出口

## delivery:system_action（概念家族）

- 子任务完成后，结果先按 \`replyTo\` 回给直接上游
- 直接上游处理完后，再按 \`upstreamReplyTo\` 继续往上回
- direct service 同会话恢复时，runtime 会结合 delivery ticket、sessionKey 和 wake 机制把结果送回原会话
- 叶子 agent 提交本轮结果；runtime 根据票据和 route metadata 负责回件

## 自动回件语义

- 图回答"平台在你没指定目标时把活自动交给谁"；你想主动找谁，由协作工具的 targetAgent 决定
- delivery 回答"你做完后结果自动送到哪"
- worker 做完后，结果可以按 delivery 票据自动退回上游

## 两类常见 system_action delivery

- \`${PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_ASSIGN_TASK_RESULT}\`：子任务委派完成后，把结果送回委派者
- \`${PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_RUNTIME_RESULT}\`：普通 runtime 子流程完成后，把结果送回发起该子流程的上游

## 使用原则

- 子任务结果交给 runtime 回送
- delivery 语义保留在 \`DELIVERY.md\`
- 理解 delivery 问题时，以这份文档为准
`;
}

function buildOutboxCommitExample(role) {
  switch (role) {
    case AGENT_ROLE.RESEARCHER:
    case AGENT_ROLE.PLANNER:
    default:
      return `\`\`\`json
{
  "version": 1,
  "status": "completed",
  "summary": "一句话总结本阶段完成了什么"
}
\`\`\``;
  }
}

function buildPlatformGuideTemplate(agentId, role, skills, graph = { edges: [] }) {
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
    : "- 基础技能集：按 `SOUL.md`、当前会话和本页入口语义执行。";
  const primaryResultRules = "- 主结果写到本轮会话明确给出的目标位置\n- 若本轮是系统派工，正式提交方式以本轮系统唤醒说明和对应平台文档为准\n- runtime 负责结果回送与 delivery";
  const platformOutboxRule = hasSystemAction
    ? "- 需要协作时调用协作工具（见下方协作节）"
    : "- 协作能力：basic";
  // 协作的主路是工具调用(L1):会话中途直接调,工具结果当场返回受理凭证或结构化
  // 拒绝,改错就在同一轮里完成。降级的文本标记路(L3)仍然可用,但**只在此处留一个
  // 指针**——把它的语法教程写进主提示词会与工具形成竞争性指令,实测 agent 会在已
  // 持有工具的情况下退回去写标记。需要时 agent 自己去读那一页。
  const platformActionSection = hasSystemAction
    ? [
      "需要协作时直接调用协作工具（如 `assign_task` / `wake_agent`，以本轮实际可用的工具为准）。",
      "工具结果即受理凭证：受理成功返回 accepted 与 contractId，参数或目标有问题会返回结构化拒绝，可在同一轮里改正重试。",
      "平台另有两级文本标记降级方式，写法见 `COLLABORATION-FALLBACK.md`（工具走不通时再看）。",
      "协作者见 `BUILDING-MAP.md`，固定管线见 `COLLABORATION-GRAPH.md`，delivery 语义见 `DELIVERY.md`。",
    ].join("\n")
    : "协作方式：本地完成，按当前会话和 `SOUL.md` 执行。";

  return `${MANAGED_BOOTSTRAP_MARKER}
# PLATFORM-GUIDE.md

## 平台默认

- Default tools: ${tools.join("、")}
- Output formats: ${outputs.join("、")}
- 楼宇黄页见 \`BUILDING-MAP.md\`
- 固定管线见 \`COLLABORATION-GRAPH.md\`
- delivery 语义见 \`DELIVERY.md\`

## 平台入口语义

- 用户直达：外部用户直接对话当前 agent，本轮输入以当前会话和直达请求为准
- 系统派工：runtime 派来 contract 或系统任务，本轮输入以系统唤醒说明为准；必要时会明确指向 contract 文件
- Contract、输出路径和正式提交方式，都以这轮系统唤醒和对应平台文档为准

空闲轮次以 \`HEARTBEAT_OK\` 收尾。

## 平台固定出口

${primaryResultRules}
${platformOutboxRule}

## 外部工具

- \`web_search\`、\`web_fetch\` 等外部工具用于补充证据
- 使用当前 context / contract / 本地文件持续推进；外部证据缺口写入产物

## 协作命令

${platformActionSection}

## 已加载技能

${guideLines}
`;
}

export { buildHeartbeatTemplate, buildAgentsTemplate, buildBuildingMapTemplate, buildCollaborationFallbackTemplate, buildCollaborationGraphTemplate, buildDeliveryTemplate, buildOutboxCommitExample, buildPlatformGuideTemplate };
