import { normalizeString } from "./core/normalize.js";
import { getCapabilityPreset } from "./capability/capability-preset-registry.js";

function normalizeLaneKey(value) {
  return normalizeString(value)?.toLowerCase() || null;
}

// Lanes are bound by skill rather than role, so any agent with the skill can
// receive the artifact regardless of its formal role name.
const ARTIFACT_LANE_DEFINITIONS = Object.freeze({
  code_review: Object.freeze({
    kind: "code_review",
    fileName: "code_review.json",
    skills: Object.freeze(["review-findings"]),
    stageId: "code_review",
    stageLabel: "代码审查",
  }),
});

function cloneLaneDefinition(definition) {
  if (!definition) return null;
  return {
    ...definition,
    skills: [...(definition.skills || [])],
  };
}

export function getArtifactLaneDefinition(kind) {
  return cloneLaneDefinition(ARTIFACT_LANE_DEFINITIONS[normalizeLaneKey(kind)]);
}

export function resolveArtifactLaneByFileName(fileName) {
  const normalizedFileName = normalizeLaneKey(fileName);
  if (!normalizedFileName) return null;
  for (const definition of Object.values(ARTIFACT_LANE_DEFINITIONS)) {
    if (normalizeLaneKey(definition.fileName) === normalizedFileName) {
      return cloneLaneDefinition(definition);
    }
  }
  return null;
}

// Returns lanes whose skill requirements overlap with the given skill.
export function listArtifactLaneBindingsForSkill(skill) {
  const normalizedSkill = normalizeLaneKey(skill);
  if (!normalizedSkill) return [];
  return Object.values(ARTIFACT_LANE_DEFINITIONS)
    .filter((definition) => definition.skills.includes(normalizedSkill))
    .map((definition) => cloneLaneDefinition(definition));
}

// Role-based lookup: resolves via the role's capability preset skill list so
// that heartbeat-gate and session-bootstrap work without knowing the agent's
// concrete role name.
export function listArtifactLaneBindingsForRole(role) {
  const normalizedRole = normalizeLaneKey(role);
  if (!normalizedRole) return [];
  const preset = getCapabilityPreset(normalizedRole);
  const roleSkills = Array.isArray(preset?.skills) ? preset.skills : [];
  return Object.values(ARTIFACT_LANE_DEFINITIONS)
    .filter((definition) => definition.skills.some((skill) => roleSkills.includes(skill)))
    .map((definition) => cloneLaneDefinition(definition));
}

export function resolveArtifactStageDefinition(artifactContext) {
  const definition = getArtifactLaneDefinition(artifactContext?.kind);
  if (!definition) return null;
  return {
    stageId: definition.stageId,
    stageLabel: definition.stageLabel,
  };
}
