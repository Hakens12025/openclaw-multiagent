export const MANAGED_GUIDANCE_FILE_NAMES = Object.freeze([
  "IDENTITY.md",
  "AGENTS.md",
  "BUILDING-MAP.md",
  "COLLABORATION-GRAPH.md",
  "DELIVERY.md",
  "PLATFORM-GUIDE.md",
  "HEARTBEAT.md",
]);

const MANAGED_GUIDANCE_FILE_NAME_SET = new Set(MANAGED_GUIDANCE_FILE_NAMES);

export function isManagedGuidanceFileName(fileName) {
  return MANAGED_GUIDANCE_FILE_NAME_SET.has(String(fileName || "").trim());
}
