import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStoredAgentConfig,
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../lib/agent/agent-binding-store.js";

test("writeStoredAgentBinding projects runtime-owned fields to top-level config", () => {
  const agent = { id: "worker-z" };

  writeStoredAgentBinding(agent, {
    roleRef: "executor",
    workspace: {
      configured: "~/.openclaw/workspaces/worker-z",
    },
    model: {
      ref: "demo/runtime-model",
    },
    heartbeat: {
      configuredEvery: "6h",
    },
    skills: {
      configured: ["model-switcher"],
    },
    capabilities: {
      configured: {
        tools: ["Read", "Write"],
        routerHandlerId: "executor_contract",
        outboxCommitKinds: ["execution_result"],
      },
    },
    policies: {
      protected: true,
      ingressSource: "webui",
    },
  });

  assert.equal(agent.role, "executor");
  assert.equal(agent.workspace, "~/.openclaw/workspaces/worker-z");
  assert.deepEqual(agent.model, { primary: "demo/runtime-model" });
  assert.deepEqual(agent.heartbeat, { every: "6h" });
  assert.deepEqual(agent.skills, ["model-switcher"]);
  assert.deepEqual(agent.tools, { allow: ["read", "write"] });
  assert.equal(agent.routerHandlerId, "executor_contract");
  assert.deepEqual(agent.outboxCommitKinds, ["execution_result"]);
  assert.equal(agent.protected, true);
  assert.equal(agent.ingressSource, "webui");

  assert.equal(agent.binding?.roleRef, undefined);
  assert.equal(agent.binding?.workspace, undefined);
  assert.equal(agent.binding?.model, undefined);
  assert.equal(agent.binding?.heartbeat, undefined);
  assert.deepEqual(agent.binding?.skills, { configured: ["model-switcher"] });
  assert.equal(agent.binding?.capabilities, undefined);
  assert.equal(agent.binding?.policies, undefined);

  const roundTrip = readStoredAgentBinding(agent);
  assert.equal(roundTrip.roleRef, "executor");
  assert.equal(roundTrip.workspace?.configured, "~/.openclaw/workspaces/worker-z");
  assert.equal(roundTrip.model?.ref, "demo/runtime-model");
  assert.equal(roundTrip.heartbeat?.configuredEvery, "6h");
});

test("normalizeStoredAgentConfig migrates runtime-owned binding fields to top-level truth", () => {
  const normalized = normalizeStoredAgentConfig({
    id: "planner",
    binding: {
      roleRef: "planner",
      workspace: {
        configured: "~/.openclaw/workspaces/planner",
      },
      model: {
        ref: "demo/planner-model",
      },
      heartbeat: {
        configuredEvery: "2h",
      },
      skills: {
        configured: ["system-action"],
      },
      capabilities: {
        configured: {
          tools: ["read", "write"],
        },
      },
      policies: {
        gateway: true,
        protected: true,
        ingressSource: "webui",
      },
    },
  });

  assert.equal(normalized.role, "planner");
  assert.equal(normalized.workspace, "~/.openclaw/workspaces/planner");
  assert.deepEqual(normalized.model, { primary: "demo/planner-model" });
  assert.deepEqual(normalized.heartbeat, { every: "2h" });
  assert.deepEqual(normalized.skills, ["system-action"]);
  assert.deepEqual(normalized.tools, { allow: ["read", "write"] });
  assert.equal(normalized.gateway, true);
  assert.equal(normalized.protected, true);
  assert.equal(normalized.ingressSource, "webui");

  assert.equal(normalized.binding?.roleRef, undefined);
  assert.equal(normalized.binding?.workspace, undefined);
  assert.equal(normalized.binding?.model, undefined);
  assert.equal(normalized.binding?.heartbeat, undefined);
  assert.deepEqual(normalized.binding?.skills, { configured: ["system-action"] });
  assert.equal(normalized.binding?.capabilities, undefined);
  assert.equal(normalized.binding?.policies, undefined);
});
