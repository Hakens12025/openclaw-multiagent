/**
 * stage-marker-parser.js — Extract stage plan from agent output markdown
 *
 * Parses "### 阶段 N: label" headings from markdown content and
 * produces a stages array compatible with materializeTaskStagePlan().
 *
 * Rule 12.2: agent writes content (markdown), system extracts structure (stages).
 */

/**
 * Extract stages from markdown content.
 * Supports two formats:
 *   [STAGE] label          ← primary (bracket marker, consistent with [BLOCKING]/[ACTION])
 *   ### 阶段 N: label      ← legacy (markdown heading)
 * Returns array of { label, objective, deliverable, completionCriteria } objects.
 */
// Shared regex: matches [STAGE] label, [STAGE 1] label, ### [STAGE N] label
const STAGE_BRACKET_RE = /^(?:#{1,3}\s+)?\[STAGE(?:\s*\d+)?\]\s+(.+)$/m;

export function extractStageMarkers(markdownContent) {
  if (typeof markdownContent !== "string") return [];

  const stages = [];
  const lines = markdownContent.split("\n");
  let currentStage = null;

  for (const line of lines) {
    const trimmed = line.trim();

    const bracketMatch = STAGE_BRACKET_RE.exec(trimmed);
    // Legacy: ### 阶段 N: label  or  ### Stage N: label
    const cnMatch = !bracketMatch ? /^###\s+阶段\s*(\d+)\s*[:：]\s*(.+)$/.exec(trimmed) : null;
    const enMatch = !bracketMatch && !cnMatch ? /^###\s+Stage\s*(\d+)\s*[:：]\s*(.+)$/i.exec(trimmed) : null;

    if (bracketMatch || cnMatch || enMatch) {
      if (currentStage) stages.push(currentStage);
      const label = bracketMatch ? bracketMatch[1].trim()
        : cnMatch ? cnMatch[2].trim()
          : enMatch[2].trim();
      currentStage = {
        index: stages.length + 1,
        label,
        objective: null,
        deliverable: null,
        completionCriteria: null,
      };
      continue;
    }

    // If inside a stage, look for detail lines
    if (currentStage && trimmed.startsWith("-")) {
      const detailMatch = /^-\s*(目标|交付|完成标准|Goal|Deliverable|Completion)\s*[:：]\s*(.+)$/i.exec(trimmed);
      if (detailMatch) {
        const key = detailMatch[1].toLowerCase();
        const value = detailMatch[2].trim();
        if (key === "目标" || key === "goal") currentStage.objective = value;
        else if (key === "交付" || key === "deliverable") currentStage.deliverable = value;
        else if (key === "完成标准" || key === "completion") currentStage.completionCriteria = value;
      }
    }

    // A heading or another marker breaks the current stage
    if (currentStage && trimmed && !trimmed.startsWith("-") && /^(#{1,3}\s+|\[STAGE\])/.test(trimmed) && !bracketMatch) {
      stages.push(currentStage);
      currentStage = null;
    }
  }

  if (currentStage) stages.push(currentStage);

  return stages;
}

/**
 * Convert extracted stage markers into format compatible with materializeTaskStagePlan().
 * Returns { stages: [{label, ...}] } or null if no stages found.
 */
export function buildStagePlanFromMarkers(markdownContent) {
  const markers = extractStageMarkers(markdownContent);
  if (markers.length === 0) return null;

  return {
    stages: markers.map((m) => ({
      label: m.label,
      semanticLabel: m.label,
      objective: m.objective || null,
      deliverable: m.deliverable || null,
      completionCriteria: m.completionCriteria || null,
    })),
  };
}

/**
 * Check if markdown contains any stage headings.
 */
export function hasStageMarkers(markdownContent) {
  if (typeof markdownContent !== "string") return false;
  return STAGE_BRACKET_RE.test(markdownContent) || /^###\s+(阶段|Stage)\s*\d+\s*[:：]/im.test(markdownContent);
}
