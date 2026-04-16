import {
  composeEffectiveProfile,
  loadAgentCardProjection,
} from "../effective-profile-composer.js";

export async function buildAgentRegistry(config) {
  const agentsList = Array.isArray(config?.agents?.list) ? config.agents.list : [];

  return Promise.all(agentsList.map(async (agentConfig) => {
    const card = await loadAgentCardProjection(agentConfig);
    return composeEffectiveProfile({
      config,
      agentConfig,
      card,
    });
  }));
}
