import {
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../agent-binding-store.js";
import {
  isSupportedAgentRole,
  syncExistingAgentWorkspaceProfile,
  validateRegisteredSkills,
  writeExistingAgentCardProfile,
  resolveAgentProfileContext,
} from "./agent-admin-context.js";
import { normalizeAgentRole, registerRuntimeAgents } from "../agent-identity.js";
import {
  normalizeHeartbeatEveryInput,
  resolveDefaultHeartbeatEvery,
  resolveDefaultModel,
} from "./agent-admin-defaults.js";
import { normalizeString, uniqueTools } from "../../core/normalize.js";
import {
  loadExistingAgentConfig,
  normalizeOverrideListInput,
  normalizeSkillPayload,
  runAgentAdminWrite,
  saveConfig,
  stripUnsupportedAgentConfigKeys,
} from "./agent-admin-store.js";
import { composeDefaultCapabilityProjection } from "../agent-capability-policy.js";

export async function changeAgentPrimaryModel({
  agentId,
  model,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedModel = normalizeString(model);
    if (!normalizedModel) {
      throw new Error("missing agentId or model");
    }

    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const binding = readStoredAgentBinding(agent);
    writeStoredAgentBinding(agent, {
      ...binding,
      model: { ref: normalizedModel },
    });

    await saveConfig(config);
    logger?.info?.(`[watchdog] model changed: ${normalizedAgentId} → ${normalizedModel}`);
    onAlert?.({ type: "model_changed", agentId: normalizedAgentId, model: normalizedModel, ts: Date.now() });

    return {
      ok: true,
      agentId: normalizedAgentId,
      model: normalizedModel,
    };
  });
}

export async function changeAgentRole({
  agentId,
  role,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedAgentId = normalizeString(agentId);
    if (!normalizedAgentId) {
      throw new Error("missing agentId");
    }
    const normalizedRole = normalizeAgentRole(role, normalizedAgentId);
    if (!isSupportedAgentRole(normalizedRole)) {
      throw new Error(`unsupported role: ${role}`);
    }

    const { config, agent } = await loadExistingAgentConfig(normalizedAgentId);
    const binding = readStoredAgentBinding(agent);
    writeStoredAgentBinding(agent, {
      ...binding,
      roleRef: normalizedRole,
    });

    stripUnsupportedAgentConfigKeys(config);
    await saveConfig(config);

    const { configuredSkills, effectiveSkills } = await syncExistingAgentWorkspaceProfile({
      config,
      agent,
      agentId: normalizedAgentId,
      role: normalizedRole,
    });

    logger?.info?.(
      `[watchdog] agent role changed: ${normalizedAgentId} → ${normalizedRole} (effective=[${effectiveSkills.join(", ")}])`,
    );
    onAlert?.({
      type: "agent_role_changed",
      agentId: normalizedAgentId,
      role: normalizedRole,
      effectiveSkills,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      role: normalizedRole,
      configuredSkills,
      effectiveSkills,
    };
  });
}

export async function changeAgentSkills({
  agentId,
  skills,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedSkills = normalizeSkillPayload(skills);
    await validateRegisteredSkills(normalizedSkills);

    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const binding = readStoredAgentBinding(agent);
    writeStoredAgentBinding(agent, {
      ...binding,
      skills: {
        configured: normalizedSkills,
      },
    });
    await saveConfig(config);

    const { effectiveSkills } = await writeExistingAgentCardProfile({
      config,
      agent,
      agentId: normalizedAgentId,
    });

    logger?.info?.(
      `[watchdog] agent skills changed: ${normalizedAgentId} → configured=[${normalizedSkills.join(", ")}] effective=[${effectiveSkills.join(", ")}]`,
    );
    onAlert?.({
      type: "agent_skills_changed",
      agentId: normalizedAgentId,
      configuredSkills: normalizedSkills,
      effectiveSkills,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      configuredSkills: normalizedSkills,
      effectiveSkills,
    };
  });
}

export async function changeAgentTools({
  agentId,
  tools,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const configuredTools = normalizeOverrideListInput(tools, uniqueTools);
    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const nextBinding = readStoredAgentBinding(agent);
    const nextConfiguredCapabilities = nextBinding.capabilities?.configured
      && typeof nextBinding.capabilities.configured === "object"
      ? { ...nextBinding.capabilities.configured }
      : {};

    if (configuredTools == null) {
      delete nextConfiguredCapabilities.tools;
    } else {
      nextConfiguredCapabilities.tools = configuredTools;
    }

    if (configuredTools == null) {
      nextBinding.capabilities = { configured: nextConfiguredCapabilities };
    } else if (Object.keys(nextConfiguredCapabilities).length > 0) {
      nextBinding.capabilities = {
        configured: nextConfiguredCapabilities,
      };
    } else {
      delete nextBinding.capabilities;
    }

    writeStoredAgentBinding(agent, nextBinding);
    await saveConfig(config);

    const context = await resolveAgentProfileContext({
      config,
      agentId: normalizedAgentId,
      agent,
    });
    const effectiveTools = Array.isArray(agent?.tools?.allow) && agent.tools.allow.length > 0
      ? uniqueTools(agent.tools.allow)
      : uniqueTools(composeDefaultCapabilityProjection({
        role: context.role,
        skills: context.effectiveSkills,
      }).tools);

    await writeExistingAgentCardProfile({
      config,
      agent,
      agentId: normalizedAgentId,
      capabilitiesPatch: {
        tools: effectiveTools.length > 0 ? effectiveTools : null,
      },
    });
    registerRuntimeAgents(config);

    logger?.info?.(
      `[watchdog] agent tools changed: ${normalizedAgentId} `
      + `configured=[${(configuredTools || []).join(", ")}] effective=[${effectiveTools.join(", ")}]`,
    );
    onAlert?.({
      type: "agent_tools_changed",
      agentId: normalizedAgentId,
      configuredTools,
      effectiveTools,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      configuredTools,
      effectiveTools,
    };
  });
}

export async function changeAgentHeartbeat({
  agentId,
  every,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedEvery = normalizeHeartbeatEveryInput(every);
    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const nextBinding = readStoredAgentBinding(agent);
    if (normalizedEvery == null) {
      delete nextBinding.heartbeat;
    } else {
      nextBinding.heartbeat = {
        configuredEvery: normalizedEvery,
      };
    }
    writeStoredAgentBinding(agent, nextBinding);

    await saveConfig(config);

    const defaultHeartbeatEvery = resolveDefaultHeartbeatEvery(config);
    const configuredHeartbeatEvery = normalizeString(readStoredAgentBinding(agent)?.heartbeat?.configuredEvery);
    const effectiveHeartbeatEvery = configuredHeartbeatEvery || defaultHeartbeatEvery;

    logger?.info?.(
      `[watchdog] agent heartbeat changed: ${normalizedAgentId} `
      + `configured=${configuredHeartbeatEvery || "default"} effective=${effectiveHeartbeatEvery}`,
    );
    onAlert?.({
      type: "agent_heartbeat_changed",
      agentId: normalizedAgentId,
      configuredHeartbeatEvery,
      effectiveHeartbeatEvery,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      configuredHeartbeatEvery,
      effectiveHeartbeatEvery,
    };
  });
}
