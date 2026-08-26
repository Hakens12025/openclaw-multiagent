import { getAgentRole } from "../lib/agent/agent-identity.js";
import { buildContractSessionSystemPrompt } from "../lib/prompt/contract-session-prompt-override.js";

export function register(api, logger) {
  api.on("before_prompt_build", async (_event, ctx) => {
    const agentId = ctx?.agentId || null;
    const sessionKey = ctx?.sessionKey || null;
    const workspaceDir = ctx?.workspaceDir || null;
    const systemPrompt = await buildContractSessionSystemPrompt({
      agentId,
      role: agentId ? getAgentRole(agentId) : null,
      workspaceDir,
      sessionKey,
    });

    if (!systemPrompt) return;
    logger?.debug?.(`[watchdog] using minimal contract prompt for ${sessionKey}`);
    return { systemPrompt };
  });
}
