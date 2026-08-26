// Plan hints for all stage:inspect (read-only) admin surfaces.

export const INSPECT_PLAN_HINTS = {
  "operator.snapshot": {
    reads: [
      "agents.list",
      "admin_surfaces.list",
      "admin_change_sets.list",
      "work_items.list",
      "system_action_delivery_tickets.list",
      "test_runs.list",
      "runtime.read",
    ],
    apiChecks: ["GET /watchdog/operator-snapshot"],
    expectedSignals: [],
  },
  "agents.list": {
    reads: ["openclaw.json", "workspaces/*/agent-card.json"],
    apiChecks: ["GET /watchdog/agents"],
    expectedSignals: [],
  },
  "agents.discovery": {
    reads: [
      "openclaw.json",
      "workspaces/*/agent-card.json",
      "workspaces/*/AGENTS.md",
      "workspaces/*/BUILDING-MAP.md",
      "workspaces/*/COLLABORATION-GRAPH.md",
      "workspaces/*/DELIVERY.md",
      "workspaces/*/PLATFORM-GUIDE.md",
    ],
    apiChecks: ["GET /watchdog/agents/discovery"],
    expectedSignals: [],
  },
  "skills.list": {
    reads: ["skills/*/SKILL.md", "openclaw.json"],
    apiChecks: ["GET /watchdog/skills"],
    expectedSignals: [],
  },
  "admin_surfaces.list": {
    reads: ["admin-surface-registry"],
    apiChecks: ["GET /watchdog/admin-surfaces", "GET /watchdog/admin-surfaces?includeTemplates=1"],
    expectedSignals: [],
  },
  "admin_change_sets.list": {
    reads: ["control-plane/admin-change-sets/*.json", "admin_surfaces.list"],
    apiChecks: ["GET /watchdog/admin-change-sets"],
    expectedSignals: [],
  },
  "admin_change_sets.detail": {
    reads: ["control-plane/admin-change-sets/*.json", "admin_surfaces.list"],
    apiChecks: ["GET /watchdog/admin-change-sets/detail?id=<draft-id>"],
    expectedSignals: [],
  },
  "admin_change_sets.preview": {
    reads: ["admin_change_sets.detail"],
    apiChecks: ["GET /watchdog/admin-change-sets/preview?id=<draft-id>"],
    expectedSignals: [],
  },
  "work_items.list": {
    reads: ["control-plane/threads/*/runs/*/contracts/*.json"],
    apiChecks: ["GET /watchdog/work-items"],
    expectedSignals: [],
  },
  "system_action_delivery_tickets.list": {
    reads: ["control-plane/system-action-delivery-tickets.json"],
    apiChecks: ["GET /watchdog/system-action-delivery-tickets"],
    expectedSignals: [],
  },
  "runtime.read": {
    reads: ["tracker", "dispatch_runtime_state"],
    apiChecks: ["GET /watchdog/runtime"],
    expectedSignals: [],
  },
  "models.list": {
    reads: ["openclaw.json"],
    apiChecks: ["GET /watchdog/models"],
    expectedSignals: [],
  },
  "agents.defaults.read": {
    reads: ["openclaw.json", "control-plane/agent-default-skills.json"],
    apiChecks: ["GET /watchdog/agents/defaults"],
    expectedSignals: [],
  },
  "test_runs.list": {
    reads: ["watchdog test run store"],
    apiChecks: ["GET /watchdog/test-runs"],
    expectedSignals: [],
  },
  "test_runs.detail": {
    reads: ["watchdog test run detail store", "contractRuntime snapshots"],
    apiChecks: ["GET /watchdog/test-runs/detail?id=<run-id>"],
    expectedSignals: [],
  },
};
