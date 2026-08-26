import { AGENT_ROLE } from "../agent/agent-metadata.js";
import { normalizeString } from "../core/normalize.js";

const CAPABILITY_OUTBOX_COMMIT_KINDS = Object.freeze({
  EXECUTION_RESULT: "execution_result",
});

// Role-level tool and path restrictions enforced by before_tool_call.
// These are HARD limits — agent cannot bypass via prompt or skill.
// NOTE(P4): 协作 FC 工具(assign_task/wake_agent)的放行不在本表——
// before_tool_call 在消费点用 isExposedCollabToolForRole(授权单源
// collaboration-intent-policy)与本表做并集;此处静态引策略链会与
// protocol-primitives 成环(TDZ),故本表只保留本地工具。
const TOOL_RESTRICTIONS = Object.freeze({
  // ls/grep 是**发现**能力,不是新的读权限:before_tool_call 的 DISCOVERY_TOOL_PATTERN
  // 让它们与 read 走同一片 readPathScope 路径域(2b),scope=workspace 的角色列目录/搜索
  // 出不了自己的工作区。本注释在 D-G 实装前是错的——那时 ls/grep 是幽灵声明,宿主从未组装
  // 这两个工具,2b 也只判 read;D-G 后才成真。
  // 不给 ls/grep 的后果实测过——agent 拿到 inbox/upstream/<producer>/ 这个目录却
  // 没有列目录的手段,只能猜文件名(日志里连着四次 ENOENT,还有一次拿 read 去读
  // 目录得到 EISDIR)。
  [AGENT_ROLE.PLANNER]: Object.freeze({
    allowedTools: Object.freeze(["read", "Read", "write", "Write", "ls", "grep"]),
    // workspace(2026-08-26 用户裁决 inbox→workspace):planner 可读自己整个工作区
    // (含 inbox/ + outbox/ + upstream 链目标 + 自己落的文件),但读不到工作区外的系统面
    // (openclaw.json 密钥、别的 agent)。executor(worker)照旧无限制、需读目标代码库,不动。
    readPathScope: "workspace",
  }),
  // executor, researcher, bridge, agent — no restrictions (null)
});

const CAPABILITY_PRESETS = Object.freeze({
  [AGENT_ROLE.BRIDGE]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit", "ls", "grep"]),
    outputFormats: Object.freeze(["text", "system-action-json"]),
    outboxCommitKinds: Object.freeze([]),
    routerHandlerId: null,
    directoryOrder: 10,
  }),
  [AGENT_ROLE.PLANNER]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit", "ls", "grep"]),
    outputFormats: Object.freeze(["markdown", "system-action-json"]),
    outboxCommitKinds: Object.freeze([CAPABILITY_OUTBOX_COMMIT_KINDS.EXECUTION_RESULT]),
    routerHandlerId: "executor_contract",
    skills: Object.freeze(["error-avoidance", "plan-stages"]),
    directoryOrder: 20,
  }),
  [AGENT_ROLE.EXECUTOR]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit", "ls", "grep", "web_search", "web_fetch"]),
    outputFormats: Object.freeze(["markdown", "runtime-result-json", "system-action-json"]),
    outboxCommitKinds: Object.freeze([CAPABILITY_OUTBOX_COMMIT_KINDS.EXECUTION_RESULT]),
    routerHandlerId: "executor_contract",
    directoryOrder: 30,
  }),
  [AGENT_ROLE.RESEARCHER]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit", "ls", "grep", "web_search", "web_fetch"]),
    outputFormats: Object.freeze(["markdown", "runtime-result-json", "system-action-json"]),
    outboxCommitKinds: Object.freeze([CAPABILITY_OUTBOX_COMMIT_KINDS.EXECUTION_RESULT]),
    routerHandlerId: "executor_contract",
    directoryOrder: 40,
  }),
  [AGENT_ROLE.AGENT]: Object.freeze({
    tools: Object.freeze(["read", "write", "edit", "ls", "grep"]),
    outputFormats: Object.freeze(["markdown", "runtime-result-json", "system-action-json"]),
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

export function getCapabilityDirectoryOrder(role) {
  return readCapabilityPreset(role).directoryOrder || readCapabilityPreset(AGENT_ROLE.AGENT).directoryOrder;
}
