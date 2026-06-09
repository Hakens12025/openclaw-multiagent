import { normalizeString } from "../core/normalize.js";
import { META_AGENT_IDS } from "./agent-metadata.js";

export const ACTOR_PLANE = Object.freeze({
  RUNTIME: "runtime",
  CONTROL_PLANE: "control_plane",
  TOOLING: "tooling",
  AUTOMATION: "automation",
});

const CONTROL_PLANE_AGENT_IDS = new Set([
  ...META_AGENT_IDS,
  "harness",
  "cli-system",
  "automation",
]);

export function isReservedControlLayerAgentId(agentId) {
  const id = normalizeString(agentId) || "";
  return CONTROL_PLANE_AGENT_IDS.has(id);
}

export function assertRuntimeAgentIdIsNotReserved(agentId) {
  if (!isReservedControlLayerAgentId(agentId)) return;
  throw new Error(`reserved control-layer id: ${normalizeString(agentId)}`);
}

export function resolveActorPlanePolicy({
  agentId,
  configuredPlane = null,
  configuredMainViewVisible = null,
  configuredFormalTimelineVisible = null,
  configuredAutoWakeEligible = null,
  role,
  gateway = false,
  ingressSource = null,
} = {}) {
  const id = normalizeString(agentId) || "";
  const explicitPlane = normalizeString(configuredPlane)?.toLowerCase() || null;
  const normalizedRole = normalizeString(role)?.toLowerCase() || "agent";
  const source = normalizeString(ingressSource)?.toLowerCase() || null;

  if (isReservedControlLayerAgentId(id)) {
    return {
      plane: ACTOR_PLANE.CONTROL_PLANE,
      mainViewVisible: false,
      formalTimelineVisible: false,
      autoWakeEligible: false,
    };
  }

  if (explicitPlane && explicitPlane !== ACTOR_PLANE.RUNTIME) {
    return {
      plane: explicitPlane,
      mainViewVisible: configuredMainViewVisible === true,
      formalTimelineVisible: configuredFormalTimelineVisible === true,
      autoWakeEligible: configuredAutoWakeEligible === true,
    };
  }

  if (normalizedRole === "bridge" || gateway === true || source) {
    return {
      plane: ACTOR_PLANE.RUNTIME,
      mainViewVisible: configuredMainViewVisible !== false,
      formalTimelineVisible: configuredFormalTimelineVisible !== false,
      autoWakeEligible: configuredAutoWakeEligible !== false,
    };
  }

  return {
    plane: ACTOR_PLANE.RUNTIME,
    mainViewVisible: configuredMainViewVisible !== false,
    formalTimelineVisible: configuredFormalTimelineVisible !== false,
    autoWakeEligible: configuredAutoWakeEligible !== false,
  };
}
