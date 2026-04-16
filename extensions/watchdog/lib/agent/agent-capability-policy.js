import { normalizeString, uniqueStrings, uniqueTools } from "../core/normalize.js";
import {
  getCapabilityDirectoryOrder as readCapabilityDirectoryOrder,
  getCapabilityPreset,
} from "../capability/capability-preset-registry.js";

const DEFAULT_INPUT_FORMATS = Object.freeze(["contract-json", "direct-request"]);

export function composeDefaultCapabilityProjection({
  role,
  skills = [],
} = {}) {
  const preset = getCapabilityPreset(role);
  const normalizedSkills = uniqueStrings(skills || []);
  const routerHandlerId = normalizeString(preset?.routerHandlerId) || null;
  const outboxCommitKinds = uniqueStrings(preset?.outboxCommitKinds || []);

  return {
    tools: uniqueTools(preset?.tools || []),
    inputFormats: [...DEFAULT_INPUT_FORMATS],
    outputFormats: uniqueStrings(preset?.outputFormats || []),
    ...(outboxCommitKinds.length > 0 ? { outboxCommitKinds } : {}),
    ...(routerHandlerId ? { routerHandlerId } : {}),
    ...(normalizedSkills.length > 0 ? { skills: normalizedSkills } : {}),
  };
}

export function getCapabilityDirectoryOrder(role) {
  return readCapabilityDirectoryOrder(role);
}
