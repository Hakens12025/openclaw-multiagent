import {
  normalizeConstraintPatchInput,
  normalizeRequiredDescriptionInput,
  normalizeRequiredNameInput,
} from "./agent-admin-defaults.js";
import { writeExistingAgentCardProfile } from "./agent-admin-context.js";
import {
  loadExistingAgentConfig,
  normalizeOverrideListInput,
  runAgentAdminWrite,
} from "./agent-admin-store.js";
import { uniqueStrings, uniqueTools } from "../core/normalize.js";

export async function changeAgentName({
  agentId,
  name,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedName = normalizeRequiredNameInput(name);
    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const { profile } = await writeExistingAgentCardProfile({
      config,
      agent,
      agentId: normalizedAgentId,
      name: normalizedName,
    });

    logger?.info?.(`[watchdog] agent name changed: ${normalizedAgentId} → ${profile.name}`);
    onAlert?.({
      type: "agent_name_changed",
      agentId: normalizedAgentId,
      name: profile.name,
      description: profile.description,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      name: profile.name,
      description: profile.description,
      role: profile.role,
      effectiveSkills: profile.effectiveSkills,
    };
  });
}

export async function changeAgentDescription({
  agentId,
  description,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedDescription = normalizeRequiredDescriptionInput(description);
    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const { profile } = await writeExistingAgentCardProfile({
      config,
      agent,
      agentId: normalizedAgentId,
      description: normalizedDescription,
    });

    logger?.info?.(`[watchdog] agent description changed: ${normalizedAgentId}`);
    onAlert?.({
      type: "agent_description_changed",
      agentId: normalizedAgentId,
      name: profile.name,
      description: profile.description,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      name: profile.name,
      description: profile.description,
      role: profile.role,
      effectiveSkills: profile.effectiveSkills,
    };
  });
}

export async function changeAgentCardTools({
  agentId,
  tools,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const configuredTools = normalizeOverrideListInput(tools, uniqueTools);
    const {
      profile,
      baseCapabilities,
    } = await writeExistingAgentCardProfile({
      config,
      agent,
      agentId: normalizedAgentId,
      capabilitiesPatch: {
        tools: configuredTools,
      },
    });
    const effectiveTools = Array.isArray(profile.capabilities?.tools) && profile.capabilities.tools.length
      ? uniqueTools(profile.capabilities.tools)
      : uniqueTools(agent?.tools?.allow || baseCapabilities.tools);

    logger?.info?.(
      `[watchdog] agent card tools changed: ${normalizedAgentId} `
      + `configured=[${(configuredTools || []).join(", ")}] effective=[${effectiveTools.join(", ")}]`,
    );
    onAlert?.({
      type: "agent_card_tools_changed",
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
      role: profile.role,
      effectiveSkills: profile.effectiveSkills,
      capabilities: profile.capabilities,
    };
  });
}

export async function changeAgentCardFormats({
  agentId,
  inputFormats,
  outputFormats,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const configuredInputFormats = normalizeOverrideListInput(inputFormats);
    const configuredOutputFormats = normalizeOverrideListInput(outputFormats);
    const { profile, baseCapabilities } = await writeExistingAgentCardProfile({
      config,
      agent,
      agentId: normalizedAgentId,
      capabilitiesPatch: {
        inputFormats: configuredInputFormats,
        outputFormats: configuredOutputFormats,
      },
    });
    const effectiveInputFormats = Array.isArray(profile.capabilities?.inputFormats) && profile.capabilities.inputFormats.length
      ? uniqueStrings(profile.capabilities.inputFormats)
      : uniqueStrings(baseCapabilities.inputFormats);
    const effectiveOutputFormats = Array.isArray(profile.capabilities?.outputFormats) && profile.capabilities.outputFormats.length
      ? uniqueStrings(profile.capabilities.outputFormats)
      : uniqueStrings(baseCapabilities.outputFormats);

    logger?.info?.(
      `[watchdog] agent card formats changed: ${normalizedAgentId} `
      + `input=[${effectiveInputFormats.join(", ")}] output=[${effectiveOutputFormats.join(", ")}]`,
    );
    onAlert?.({
      type: "agent_card_formats_changed",
      agentId: normalizedAgentId,
      configuredInputFormats,
      configuredOutputFormats,
      effectiveInputFormats,
      effectiveOutputFormats,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      configuredInputFormats,
      configuredOutputFormats,
      effectiveInputFormats,
      effectiveOutputFormats,
      role: profile.role,
      effectiveSkills: profile.effectiveSkills,
      capabilities: profile.capabilities,
    };
  });
}

export async function changeAgentConstraints({
  agentId,
  serialExecution = undefined,
  maxConcurrent = undefined,
  timeoutSeconds = undefined,
  maxRetry = undefined,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const constraintsPatch = normalizeConstraintPatchInput({
      serialExecution,
      maxConcurrent,
      timeoutSeconds,
      maxRetry,
    });

    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const { profile, baseCard } = await writeExistingAgentCardProfile({
      config,
      agent,
      agentId: normalizedAgentId,
      constraintsPatch,
    });
    const effectiveConstraints = profile.constraints && typeof profile.constraints === "object"
      ? { ...profile.constraints }
      : { ...baseCard.constraints };

    logger?.info?.(
      `[watchdog] agent constraints changed: ${normalizedAgentId} `
      + `patch=${JSON.stringify(constraintsPatch)} effective=${JSON.stringify(effectiveConstraints)}`,
    );
    onAlert?.({
      type: "agent_constraints_changed",
      agentId: normalizedAgentId,
      appliedPatch: constraintsPatch,
      constraints: effectiveConstraints,
      defaultConstraints: baseCard.constraints,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      role: profile.role,
      effectiveSkills: profile.effectiveSkills,
      appliedPatch: constraintsPatch,
      constraints: effectiveConstraints,
      defaultConstraints: baseCard.constraints,
    };
  });
}
