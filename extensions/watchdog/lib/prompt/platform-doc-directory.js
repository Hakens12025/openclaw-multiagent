// Agent directory and office map helpers for platform doc builder.
// Exports: buildOfficeDirectoryLines, buildWorkspaceAgentDirectory

import { getCapabilityDirectoryOrder } from "../security/capability-preset-registry.js";
import { listAutoInjectedAgentSkillRefs } from "./semantic-skill-registry.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { AGENT_ROLE, normalizeAgentRole } from "../agent/agent-identity.js";

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
        : "桥接型节点，负责消息出入口。";
    case AGENT_ROLE.PLANNER:
      return "复杂、多阶段、需要拆分或分工时找它规划。";
    case AGENT_ROLE.EXECUTOR:
      return entry.specialized
        ? "专项执行办公室。适合特化编码、实验、重执行或明确需要该专长的任务。"
        : "通用执行办公室。适合明确、边界清晰、可直接落地的子任务。";
    case AGENT_ROLE.RESEARCHER:
      return "研究检索办公室。适合资料搜集、研究方向探索、提出假设和研究路线。";
    default:
      return "通用节点。优先按 Contract 和已加载 skill 工作。";
  }
}

export function getWorkspaceGuidanceSkills(agentId, role, fallbackSkills = [], agentEntries = []) {
  const entry = agentEntries.find((e) => e.id === agentId);
  const entrySkills = uniqueStrings(entry?.skills || []);
  return uniqueStrings([
    ...listAutoInjectedAgentSkillRefs(role),
    ...fallbackSkills,
    ...entrySkills,
  ]);
}

export function buildWorkspaceAgentDirectory(agentId, role, skills, agentEntries = []) {
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

export function buildOfficeDirectoryLines(agentId, role, skills, agentEntries = []) {
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
