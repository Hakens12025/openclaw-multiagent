import { saveStoredConfiguredDefaultAgentSkills } from "./agent-default-skills-store.js";
import { splitConfiguredDefaultSkillRefs } from "./agent-binding-policy.js";
import {
  buildAgentDefaultsSnapshot,
  ensureAgentDefaults,
  normalizeHeartbeatEveryInput,
  normalizeRequiredModelInput,
} from "./agent-admin-defaults.js";
import { validateRegisteredSkills } from "./agent-admin-context.js";
import {
  loadConfig,
  normalizeSkillPayload,
  runAgentAdminWrite,
  saveConfig,
} from "./agent-admin-store.js";

export async function readAgentDefaults() {
  const config = await loadConfig();
  return {
    ok: true,
    ...buildAgentDefaultsSnapshot(config),
  };
}

export async function changeDefaultAgentPrimaryModel({
  model,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedModel = normalizeRequiredModelInput(model);
    const config = await loadConfig();
    const defaults = ensureAgentDefaults(config);

    if (!defaults.model || typeof defaults.model !== "object") {
      defaults.model = typeof defaults.model === "string" && defaults.model.trim()
        ? { primary: defaults.model.trim() }
        : {};
    }
    defaults.model.primary = normalizedModel;

    await saveConfig(config);
    logger?.info?.(`[watchdog] default model changed: ${normalizedModel}`);
    onAlert?.({
      type: "default_model_changed",
      model: normalizedModel,
      ts: Date.now(),
    });

    return {
      ok: true,
      ...buildAgentDefaultsSnapshot(config),
    };
  });
}

export async function changeDefaultAgentHeartbeat({
  every,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedEvery = normalizeHeartbeatEveryInput(every);
    const config = await loadConfig();
    const defaults = ensureAgentDefaults(config);
    if (!defaults.heartbeat || typeof defaults.heartbeat !== "object") {
      defaults.heartbeat = {};
    }

    if (normalizedEvery == null) {
      delete defaults.heartbeat.every;
      if (Object.keys(defaults.heartbeat).length === 0) {
        delete defaults.heartbeat;
      }
    } else {
      defaults.heartbeat.every = normalizedEvery;
    }

    await saveConfig(config);
    const snapshot = buildAgentDefaultsSnapshot(config);
    logger?.info?.(
      `[watchdog] default heartbeat changed: configured=${snapshot.configuredHeartbeatEvery || "default"} `
      + `effective=${snapshot.effectiveHeartbeatEvery}`,
    );
    onAlert?.({
      type: "default_heartbeat_changed",
      configuredHeartbeatEvery: snapshot.configuredHeartbeatEvery,
      effectiveHeartbeatEvery: snapshot.effectiveHeartbeatEvery,
      ts: Date.now(),
    });

    return {
      ok: true,
      ...snapshot,
    };
  });
}

export async function changeDefaultAgentSkills({
  skills,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedSkills = normalizeSkillPayload(skills);
    await validateRegisteredSkills(normalizedSkills);

    const { configured, ignored } = splitConfiguredDefaultSkillRefs(normalizedSkills);
    const config = await loadConfig();
    const defaults = ensureAgentDefaults(config);
    if (configured.length > 0) {
      defaults.skills = configured;
    } else {
      delete defaults.skills;
    }

    await saveStoredConfiguredDefaultAgentSkills(configured);
    await saveConfig(config);
    const snapshot = buildAgentDefaultsSnapshot(config);
    logger?.info?.(
      `[watchdog] default skills changed: configured=[${snapshot.configuredDefaultSkills.join(", ")}] `
      + `ignored=[${ignored.join(", ")}]`,
    );
    onAlert?.({
      type: "default_skills_changed",
      configuredDefaultSkills: snapshot.configuredDefaultSkills,
      effectivePlatformDefaultSkills: snapshot.effectivePlatformDefaultSkills,
      ignoredSkills: ignored,
      ts: Date.now(),
    });

    return {
      ok: true,
      ignoredSkills: ignored,
      ...snapshot,
    };
  });
}
