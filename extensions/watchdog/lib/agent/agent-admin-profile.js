import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeRequiredDescriptionInput, normalizeRequiredNameInput } from "./agent-admin-defaults.js";
import { composeDefaultCapabilityProjection } from "./agent-capability-policy.js";
import { composeAgentCardBase } from "./agent-card-composer.js";
import { getRuntimeAgentConfig, normalizeAgentRole } from "./agent-identity.js";
import { invalidateCapabilityRegistryCache } from "../capability/capability-registry.js";
import { normalizeString, uniqueStrings, uniqueTools } from "../core/normalize.js";
import { agentWorkspace, atomicWriteFile, withLock } from "../state.js";
import { setAgentCard } from "../store/agent-card-store.js";
import { syncAgentWorkspaceGuidance } from "../workspace-guidance-writer.js";

function withAgentProfileLock(agentId, fn) {
  const normalizedAgentId = normalizeString(agentId);
  return normalizedAgentId
    ? withLock(`agent-profile:${normalizedAgentId}`, fn)
    : fn();
}

export async function readAgentCard(agentId) {
  const cardPath = join(agentWorkspace(agentId), "agent-card.json");
  try {
    const raw = await readFile(cardPath, "utf8");
    const card = JSON.parse(raw);
    return card && typeof card === "object" ? card : null;
  } catch {
    return null;
  }
}

export async function resolveStoredAgentRole(agentId) {
  const configuredRole = normalizeString(getRuntimeAgentConfig(agentId)?.role);
  if (configuredRole) {
    return normalizeAgentRole(configuredRole, agentId);
  }
  const card = await readAgentCard(agentId);
  return normalizeAgentRole(card?.role, agentId);
}

function normalizedListsEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function resolveSyncedCapabilityList({
  currentValue,
  currentBaseValue,
  nextBaseValue,
  normalizer = uniqueStrings,
}) {
  const currentList = normalizer(currentValue || []);
  if (!currentList.length) {
    return normalizer(nextBaseValue || []);
  }

  const currentBaseList = normalizer(currentBaseValue || []);
  if (normalizedListsEqual(currentList, currentBaseList)) {
    return normalizer(nextBaseValue || []);
  }

  return currentList;
}

function resolveSyncedCapabilityValue({
  currentValue,
  currentBaseValue,
  nextBaseValue,
  normalizer = normalizeString,
}) {
  const normalizedCurrent = normalizer(currentValue);
  if (normalizedCurrent == null) {
    return normalizer(nextBaseValue);
  }

  const normalizedCurrentBase = normalizer(currentBaseValue);
  if (Object.is(normalizedCurrent, normalizedCurrentBase)) {
    return normalizer(nextBaseValue);
  }

  return normalizedCurrent;
}

function resolveSyncedConstraintValue({
  currentValue,
  currentBaseValue,
  nextBaseValue,
}) {
  if (currentValue === undefined) {
    return nextBaseValue;
  }
  if (Object.is(currentValue, currentBaseValue)) {
    return nextBaseValue;
  }
  return currentValue;
}

function resolveSyncedConstraints({
  currentValue,
  currentBaseValue,
  nextBaseValue,
}) {
  const currentConstraints = currentValue && typeof currentValue === "object" ? currentValue : {};
  const currentBaseConstraints = currentBaseValue && typeof currentBaseValue === "object" ? currentBaseValue : {};
  const nextBaseConstraints = nextBaseValue && typeof nextBaseValue === "object" ? nextBaseValue : {};
  const keys = new Set([
    ...Object.keys(currentConstraints),
    ...Object.keys(currentBaseConstraints),
    ...Object.keys(nextBaseConstraints),
  ]);
  const nextConstraints = {};
  for (const key of keys) {
    const value = resolveSyncedConstraintValue({
      currentValue: currentConstraints[key],
      currentBaseValue: currentBaseConstraints[key],
      nextBaseValue: nextBaseConstraints[key],
    });
    if (value !== undefined) {
      nextConstraints[key] = value;
    }
  }
  return nextConstraints;
}

export async function syncAgentWorkspaceProfile(agentId, {
  role = null,
  effectiveSkills = null,
  name = undefined,
  description = undefined,
} = {}) {
  return withAgentProfileLock(agentId, async () => {
    const workspaceDir = agentWorkspace(agentId);
    const cardPath = join(workspaceDir, "agent-card.json");
    const card = await readAgentCard(agentId);
    const currentCard = card && typeof card === "object" ? card : {};
    const currentCapabilities = currentCard.capabilities && typeof currentCard.capabilities === "object"
      ? currentCard.capabilities
      : {};
    const currentConstraints = currentCard.constraints && typeof currentCard.constraints === "object"
      ? currentCard.constraints
      : {};
    const currentRole = normalizeAgentRole(currentCard.role, agentId);
    const nextRole = normalizeAgentRole(role || currentCard.role, agentId);
    const nextEffectiveSkills = Array.isArray(effectiveSkills)
      ? uniqueStrings(effectiveSkills)
      : uniqueStrings(currentCapabilities.skills || []);
    const currentBaseCard = composeAgentCardBase({
      agentId,
      role: currentRole,
    });
    const currentBaseCapabilities = composeDefaultCapabilityProjection({
      role: currentRole,
      skills: uniqueStrings(currentCapabilities.skills || []),
    });
    const baseCard = composeAgentCardBase({
      agentId,
      role: nextRole,
    });
    const baseCapabilities = composeDefaultCapabilityProjection({
      role: nextRole,
      skills: nextEffectiveSkills,
    });
    const currentName = normalizeString(currentCard.name);
    const currentDescription = normalizeString(currentCard.description);
    const explicitName = name === undefined ? undefined : normalizeRequiredNameInput(name);
    const explicitDescription = description === undefined ? undefined : normalizeRequiredDescriptionInput(description);
    const nextName = explicitName || currentName || baseCard.name;
    const nextDescription = explicitDescription
      || (currentDescription && currentDescription !== currentBaseCard.description
        ? currentDescription
        : baseCard.description);
    const nextTools = resolveSyncedCapabilityList({
      currentValue: currentCapabilities.tools,
      currentBaseValue: currentBaseCapabilities.tools,
      nextBaseValue: baseCapabilities.tools,
      normalizer: uniqueTools,
    });
    const nextInputFormats = resolveSyncedCapabilityList({
      currentValue: currentCapabilities.inputFormats,
      currentBaseValue: currentBaseCapabilities.inputFormats,
      nextBaseValue: baseCapabilities.inputFormats,
    });
    const nextOutputFormats = resolveSyncedCapabilityList({
      currentValue: currentCapabilities.outputFormats,
      currentBaseValue: currentBaseCapabilities.outputFormats,
      nextBaseValue: baseCapabilities.outputFormats,
    });
    const nextOutboxCommitKinds = resolveSyncedCapabilityList({
      currentValue: currentCapabilities.outboxCommitKinds,
      currentBaseValue: currentBaseCapabilities.outboxCommitKinds,
      nextBaseValue: baseCapabilities.outboxCommitKinds,
    });
    const nextRouterHandlerId = resolveSyncedCapabilityValue({
      currentValue: currentCapabilities.routerHandlerId,
      currentBaseValue: currentBaseCapabilities.routerHandlerId,
      nextBaseValue: baseCapabilities.routerHandlerId,
    });
    const nextConstraints = resolveSyncedConstraints({
      currentValue: currentConstraints,
      currentBaseValue: currentBaseCard.constraints,
      nextBaseValue: baseCard.constraints,
    });
    const nextCapabilities = {
      ...baseCapabilities,
      ...currentCapabilities,
      tools: nextTools,
      inputFormats: nextInputFormats,
      outputFormats: nextOutputFormats,
      skills: nextEffectiveSkills,
    };
    if (nextOutboxCommitKinds.length > 0) {
      nextCapabilities.outboxCommitKinds = nextOutboxCommitKinds;
    } else {
      delete nextCapabilities.outboxCommitKinds;
    }
    if (nextRouterHandlerId) {
      nextCapabilities.routerHandlerId = nextRouterHandlerId;
    } else {
      delete nextCapabilities.routerHandlerId;
    }
    const nextCard = {
      ...baseCard,
      ...currentCard,
      id: baseCard.id,
      name: nextName,
      description: nextDescription,
      capabilities: nextCapabilities,
      constraints: {
        ...nextConstraints,
      },
      role: nextRole,
    };
    await mkdir(workspaceDir, { recursive: true });
    await atomicWriteFile(cardPath, JSON.stringify(nextCard, null, 2));
    setAgentCard(agentId, nextCard);
    await syncAgentWorkspaceGuidance({
      agentId,
      role: nextRole,
      skills: nextEffectiveSkills,
      workspaceDir,
    });
    invalidateCapabilityRegistryCache();
    return {
      name: nextName,
      description: nextDescription,
      role: nextRole,
      effectiveSkills: nextEffectiveSkills,
    };
  });
}

export async function writeAgentCardProfile(agentId, {
  role,
  effectiveSkills,
  name = undefined,
  description = undefined,
  capabilitiesPatch = undefined,
  constraintsPatch = undefined,
}) {
  return withAgentProfileLock(agentId, async () => {
    const workspaceDir = agentWorkspace(agentId);
    const cardPath = join(workspaceDir, "agent-card.json");
    const currentCard = await readAgentCard(agentId);
    const nextRole = normalizeAgentRole(role, agentId);
    const nextEffectiveSkills = uniqueStrings(effectiveSkills || []);
    const baseCard = composeAgentCardBase({
      agentId,
      role: nextRole,
    });
    const baseCapabilities = composeDefaultCapabilityProjection({
      role: nextRole,
      skills: nextEffectiveSkills,
    });
    const nextCard = currentCard && typeof currentCard === "object"
      ? { ...currentCard }
      : { ...baseCard };

    nextCard.id = baseCard.id;
    nextCard.role = nextRole;
    nextCard.name = name === undefined
      ? (normalizeString(nextCard.name) || baseCard.name)
      : normalizeRequiredNameInput(name);
    nextCard.description = description === undefined
      ? (normalizeString(nextCard.description) || baseCard.description)
      : normalizeRequiredDescriptionInput(description);
    if (!normalizeString(nextCard.url)) nextCard.url = baseCard.url;
    if (!normalizeString(nextCard.version)) nextCard.version = baseCard.version;
    if (!nextCard.capabilities || typeof nextCard.capabilities !== "object") {
      nextCard.capabilities = { ...baseCapabilities };
    } else {
      nextCard.capabilities = { ...nextCard.capabilities };
    }
    if (capabilitiesPatch && typeof capabilitiesPatch === "object") {
      for (const [key, value] of Object.entries(capabilitiesPatch)) {
        if (value == null) {
          delete nextCard.capabilities[key];
          continue;
        }
        nextCard.capabilities[key] = value;
      }
    }
    nextCard.capabilities.skills = nextEffectiveSkills;
    if (!nextCard.constraints || typeof nextCard.constraints !== "object") {
      nextCard.constraints = { ...baseCard.constraints };
    } else {
      nextCard.constraints = { ...nextCard.constraints };
    }
    if (constraintsPatch && typeof constraintsPatch === "object") {
      for (const [key, value] of Object.entries(constraintsPatch)) {
        if (value === undefined) continue;
        if (value == null) {
          if (Object.prototype.hasOwnProperty.call(baseCard.constraints, key)) {
            nextCard.constraints[key] = baseCard.constraints[key];
          } else {
            delete nextCard.constraints[key];
          }
          continue;
        }
        nextCard.constraints[key] = value;
      }
    }

    await mkdir(workspaceDir, { recursive: true });
    await atomicWriteFile(cardPath, JSON.stringify(nextCard, null, 2));
    setAgentCard(agentId, nextCard);
    await syncAgentWorkspaceGuidance({
      agentId,
      role: nextRole,
      skills: nextEffectiveSkills,
      workspaceDir,
    });
    invalidateCapabilityRegistryCache();
    return {
      name: nextCard.name,
      description: nextCard.description,
      role: nextRole,
      effectiveSkills: nextEffectiveSkills,
      capabilities: nextCard.capabilities,
      constraints: nextCard.constraints,
    };
  });
}
