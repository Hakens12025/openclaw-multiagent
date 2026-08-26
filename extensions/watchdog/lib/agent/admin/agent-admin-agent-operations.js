// Re-export facade — keeps all callers stable after god-object split.
// Implementation lives in:
//   agent-admin-create-delete.js   (create / delete / hard-delete)
//   agent-admin-config.js          (model / role / skills / tools / heartbeat)
//   agent-admin-policies.js        (policies)

export {
  createAgentDefinition,
  deleteAgentDefinition,
  hardDeleteAgentDefinition,
} from "./agent-admin-create-delete.js";

export {
  changeAgentPrimaryModel,
  changeAgentRole,
  changeAgentSkills,
  changeAgentTools,
  changeAgentHeartbeat,
} from "./agent-admin-config.js";

export { changeAgentPolicies } from "./agent-admin-policies.js";
