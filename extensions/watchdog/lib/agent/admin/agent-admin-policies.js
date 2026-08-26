import {
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../agent-binding-store.js";
import { normalizeAgentRole } from "../agent-identity.js";
import {
  normalizeOptionalBooleanInput,
  normalizeOptionalStringTokenInput,
} from "./agent-admin-defaults.js";
import { normalizeString } from "../../core/normalize.js";
import {
  loadExistingAgentConfig,
  runAgentAdminWrite,
  saveConfig,
} from "./agent-admin-store.js";
import { syncAllRuntimeWorkspaceGuidance } from "../../workspace-guidance-writer.js";

function applyOptionalPolicyField(policies, key, value) {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    delete policies[key];
    return;
  }
  policies[key] = value;
}

export async function changeAgentPolicies({
  agentId,
  gateway = undefined,
  protected: protectedAgent = undefined,
  ingressSource = undefined,
  specialized = undefined,
  executionPolicy = undefined,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedGateway = normalizeOptionalBooleanInput(gateway, "gateway");
    const normalizedProtected = normalizeOptionalBooleanInput(protectedAgent, "protected");
    const normalizedIngressSource = normalizeOptionalStringTokenInput(ingressSource, "ingressSource");
    const normalizedSpecialized = normalizeOptionalBooleanInput(specialized, "specialized");
    const hasExecutionPolicyPatch = executionPolicy !== undefined && executionPolicy !== null
      && typeof executionPolicy === "object" && Object.keys(executionPolicy).length > 0;
    if (
      normalizedGateway === undefined
      && normalizedProtected === undefined
      && normalizedIngressSource === undefined
      && normalizedSpecialized === undefined
      && !hasExecutionPolicyPatch
    ) {
      throw new Error("missing agent policy patch");
    }

    const {
      config,
      agent,
      agentId: normalizedAgentId,
    } = await loadExistingAgentConfig(agentId);
    const binding = readStoredAgentBinding(agent);
    const effectiveRole = normalizeAgentRole(binding.roleRef, normalizedAgentId);
    const nextPolicies = binding.policies && typeof binding.policies === "object"
      ? { ...binding.policies }
      : {};

    if (normalizedSpecialized === true && effectiveRole !== "executor") {
      throw new Error("specialized policy only applies to executor agents");
    }

    applyOptionalPolicyField(nextPolicies, "gateway", normalizedGateway);
    applyOptionalPolicyField(nextPolicies, "protected", normalizedProtected);
    applyOptionalPolicyField(nextPolicies, "ingressSource", normalizedIngressSource);
    applyOptionalPolicyField(nextPolicies, "specialized", normalizedSpecialized);
    if (hasExecutionPolicyPatch) {
      nextPolicies.executionPolicy = {
        ...(nextPolicies.executionPolicy || {}),
        ...executionPolicy,
      };
    }

    const nextBinding = {
      ...binding,
      policies: nextPolicies,
    };
    if (Object.keys(nextPolicies).length === 0) {
      delete nextBinding.policies;
    }
    writeStoredAgentBinding(agent, nextBinding);
    await saveConfig(config);
    await syncAllRuntimeWorkspaceGuidance(config, logger);

    const appliedPolicies = readStoredAgentBinding(agent)?.policies || {};
    logger?.info?.(
      `[watchdog] agent policies changed: ${normalizedAgentId} `
      + `gateway=${String(appliedPolicies.gateway)} protected=${String(appliedPolicies.protected)} `
      + `ingress=${appliedPolicies.ingressSource || "default"} specialized=${String(appliedPolicies.specialized)}`,
    );
    onAlert?.({
      type: "agent_policies_changed",
      agentId: normalizedAgentId,
      policies: appliedPolicies,
      ts: Date.now(),
    });

    return {
      ok: true,
      agentId: normalizedAgentId,
      policies: appliedPolicies,
    };
  });
}
