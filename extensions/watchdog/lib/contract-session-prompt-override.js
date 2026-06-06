import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeString } from "./core/normalize.js";
import { agentWorkspace } from "./state.js";
import { parseAgentContractSessionKey } from "./session-keys.js";
import { RUNTIME_RESULT_FILE } from "./protocol-primitives.js";
import { getRoleOutputDirectives } from "./role-spec-registry.js";

// 用户自定义派工补充：可选的 workspace 文件 WAKE.md。系统派工进 contract session 时，把它作为附加
// 指引追加到 agent-awake 提示词末尾。这是 wake-message 的「文件化」入口——用户/operator 在代理页编辑
// WAKE.md 即改派工指引。文件不存在则无影响（纯用户覆盖；平台不在 MANAGED_GUIDANCE_FILE_NAMES 里，
// 故不自动写/删它）。
const WAKE_OVERRIDE_FILE = "WAKE.md";

async function readWakeOverrideBlock(workspaceDir) {
  try {
    // Header stays English to match the agent-awake prompt convention; the user's WAKE.md body is
    // their own content (any language) appended verbatim.
    const raw = normalizeString(await readFile(join(workspaceDir, WAKE_OVERRIDE_FILE), "utf8"));
    return raw ? ["", "## Dispatch guidance (WAKE.md override)", "", raw] : [];
  } catch {
    return []; // no WAKE.md / unreadable → skip, default agent-awake prompt unchanged
  }
}

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
  const wakeOverrideBlock = await readWakeOverrideBlock(resolvedWorkspaceDir);

  // 系统提示词前缀只放 (agent, role) 稳定内容,保持 prompt-cache 友好。
  // contractId / output path 等每合约 volatile 值不内联(否则每个新合约都 cache miss),
  // 由 wake 消息 + inbox/contract.json 提供(下方 "Use the current wake message …" 已指引)。
  return [
    "You are running inside OpenClaw.",
    "",
    `Agent: \`${normalizedAgentId}\``,
    `Workspace: \`${resolvedWorkspaceDir}\``,
    "",
    "## Current Contract",
    "",
    "- First read `inbox/contract.json` as the contract truth.",
    "- Use the current wake message for wake metadata: contract id and output path.",
    "- Use `runtimeContext.currentTime` from that file for date/time questions.",
    ...getRoleOutputDirectives(role),
    `- Write \`outbox/${RUNTIME_RESULT_FILE}\` for runtime status metadata.`,
    "- Runtime consumes status metadata; the user-facing answer lives in the artifact.",
    "- `primaryArtifactPath` points to the main user-facing artifact.",
    "",
    "## Tools",
    "",
    "Tool schemas are provided by runtime. Common local tools: `read`, `write`, `edit`.",
    ...wakeOverrideBlock,
  ].join("\n");
}
