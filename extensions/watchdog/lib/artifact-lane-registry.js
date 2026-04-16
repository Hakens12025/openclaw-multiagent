import { AGENT_ROLE } from "./agent/agent-metadata.js";
import { normalizeString } from "./core/normalize.js";

function normalizeLaneKey(value) {
  return normalizeString(value)?.toLowerCase() || null;
}

const ARTIFACT_LANE_DEFINITIONS = Object.freeze({
  code_review: Object.freeze({
    kind: "code_review",
    fileName: "code_review.json",
    roles: Object.freeze([AGENT_ROLE.REVIEWER]),
    stageId: "code_review",
    stageLabel: "代码审查",
  }),
});

function cloneLaneDefinition(definition) {
  if (!definition) return null;
  return {
    ...definition,
    roles: [...(definition.roles || [])],
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

export function listArtifactLaneBindingsForRole(role) {
  const normalizedRole = normalizeLaneKey(role);
  if (!normalizedRole) return [];
  return Object.values(ARTIFACT_LANE_DEFINITIONS)
    .filter((definition) => definition.roles.includes(normalizedRole))
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
