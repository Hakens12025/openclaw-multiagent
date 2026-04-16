import { AGENT_ROLE } from "../agent/agent-metadata.js";
import { normalizeString } from "../core/normalize.js";

const CAPABILITY_OUTBOX_COMMIT_KINDS = Object.freeze({
  EXECUTION_RESULT: "execution_result",
});

// Role-level tool and path restrictions enforced by before_tool_call.
// These are HARD limits — agent cannot bypass via prompt or skill.
const TOOL_RESTRICTIONS = Object.freeze({
  [AGENT_ROLE.PLANNER]: Object.freeze({
    allowedTools: Object.freeze(["read", "Read", "write", "Write"]),
    readPathScope: "inbox",
  }),
  [AGENT_ROLE.REVIEWER]: Object.freeze({
    allowedTools: Object.freeze(["read", "Read", "write", "Write"]),
    readPathScope: "contract",
  }),
  // executor, researcher, bridge, agent — no restrictions (null)
});

const CAPABILITY_PRESETS = Object.freeze({
  [AGENT_ROLE.BRIDGE]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit"]),
    outputFormats: Object.freeze(["text"]),
    outboxCommitKinds: Object.freeze([]),
    routerHandlerId: null,
    directoryOrder: 10,
  }),
  [AGENT_ROLE.PLANNER]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit"]),
    outputFormats: Object.freeze(["markdown", "system-action-json"]),
    outboxCommitKinds: Object.freeze([CAPABILITY_OUTBOX_COMMIT_KINDS.EXECUTION_RESULT]),
    routerHandlerId: "executor_contract",
    skills: Object.freeze(["error-avoidance", "plan-stages"]),
    directoryOrder: 20,
  }),
  [AGENT_ROLE.EXECUTOR]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit", "web_search", "web_fetch"]),
    outputFormats: Object.freeze(["markdown", "stage-result-json", "contract-result-json", "system-action-json"]),
    outboxCommitKinds: Object.freeze([CAPABILITY_OUTBOX_COMMIT_KINDS.EXECUTION_RESULT]),
    routerHandlerId: "executor_contract",
    directoryOrder: 30,
  }),
  [AGENT_ROLE.RESEARCHER]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit", "web_search", "web_fetch"]),
    outputFormats: Object.freeze(["markdown", "contract-result-json", "system-action-json"]),
    outboxCommitKinds: Object.freeze([CAPABILITY_OUTBOX_COMMIT_KINDS.EXECUTION_RESULT]),
    routerHandlerId: "executor_contract",
    directoryOrder: 40,
  }),
  [AGENT_ROLE.REVIEWER]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit"]),
    outputFormats: Object.freeze(["markdown", "system-action-json"]),
    outboxCommitKinds: Object.freeze([CAPABILITY_OUTBOX_COMMIT_KINDS.EXECUTION_RESULT]),
    routerHandlerId: "executor_contract",
    skills: Object.freeze(["error-avoidance", "review-findings"]),
    directoryOrder: 50,
  }),
  [AGENT_ROLE.AGENT]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit"]),
    outputFormats: Object.freeze(["markdown", "contract-result-json", "system-action-json"]),
    outboxCommitKinds: Object.freeze([]),
    routerHandlerId: null,
    directoryOrder: 60,
  }),
});

function readCapabilityPreset(role) {
  return CAPABILITY_PRESETS[role] || CAPABILITY_PRESETS[AGENT_ROLE.AGENT];
}

export function getCapabilityPreset(role) {
  const preset = readCapabilityPreset(role);
  return {
    ...preset,
    tools: [...preset.tools],
    outputFormats: [...preset.outputFormats],
    outboxCommitKinds: [...preset.outboxCommitKinds],
  };
}

export function getToolRestrictions(role) {
  return TOOL_RESTRICTIONS[role] || null;
}

export function getCapabilityToolPreset(role) {
  return [...readCapabilityPreset(role).tools];
}

export function getCapabilityOutputPreset(role) {
  return [...readCapabilityPreset(role).outputFormats];
}

export function getCapabilityOutboxCommitKinds(role) {
  return [...readCapabilityPreset(role).outboxCommitKinds];
}

export function getCapabilityRouterHandlerId(role) {
  return normalizeString(readCapabilityPreset(role).routerHandlerId) || null;
}

export function getCapabilityDirectoryOrder(role) {
  return readCapabilityPreset(role).directoryOrder || readCapabilityPreset(AGENT_ROLE.AGENT).directoryOrder;
}
