import { normalizeString } from "./core/normalize.js";
import { agentWorkspace } from "./state.js";
import { parseAgentContractSessionKey } from "./session-keys.js";
import { RUNTIME_RESULT_FILE } from "./protocol-primitives.js";
import {
  getRoleSoulProfile,
  getRoleOutputDirectives,
  renderRolePersonaLines,
} from "./role-spec-registry.js";

function resolveContractSession({ agentId, sessionKey } = {}) {
  const normalizedAgentId = normalizeString(agentId);
  const parsed = parseAgentContractSessionKey(sessionKey);
  if (!normalizedAgentId || parsed?.agentId !== normalizedAgentId || !parsed?.contractId) {
    return null;
  }
  return parsed;
}

export function shouldOverrideContractSessionPrompt({ agentId, sessionKey } = {}) {
  return resolveContractSession({ agentId, sessionKey }) != null;
}

// contract session(系统派工)实际跑的系统提示词，替代 SOUL。role 个性（## Role）与产出指令
// （## Current Contract 的产出 bullet）都从 role-spec 数据驱动派生，与 SOUL 模板同源 —— 真值唯一。
// 全英文、正向措辞（过 contract-session 守卫）。
export async function buildContractSessionSystemPrompt({
  agentId,
  role = null,
  workspaceDir = null,
  sessionKey,
} = {}) {
  const contractSession = resolveContractSession({ agentId, sessionKey });
  if (!contractSession) return null;

  const normalizedAgentId = normalizeString(agentId);
  const resolvedWorkspaceDir = normalizeString(workspaceDir) || agentWorkspace(normalizedAgentId);
  const profile = getRoleSoulProfile(role);

  return [
    "You are running inside OpenClaw.",
    "",
    `Agent: \`${normalizedAgentId}\``,
    `Contract: \`${contractSession.contractId}\``,
    `Workspace: \`${resolvedWorkspaceDir}\``,
    "",
    "## Role",
    "",
    profile.summary,
    ...renderRolePersonaLines(role),
    "",
    "## Current Contract",
    "",
    "- First read `inbox/contract.json` as the contract truth.",
    "- When `inbox/contract.json` lists `upstreamPackages`, read those upstream packages under `inbox/` as your brief and input for this contract.",
    "- Use the current wake message for wake metadata: contract id and output path.",
    "- Use `runtimeContext.currentTime` from that file for date/time questions.",
    ...getRoleOutputDirectives(role).map((directive) => `- ${directive}`),
    `- Write \`outbox/${RUNTIME_RESULT_FILE}\` for runtime status metadata.`,
    "- Runtime consumes status metadata; the user-facing answer lives in the artifact.",
    "- `primaryArtifactPath` points to the main user-facing artifact.",
    "",
    "## Tools",
    "",
    "Tool schemas are provided by runtime. Common local tools: `read`, `write`, `edit`.",
  ].join("\n");
}
