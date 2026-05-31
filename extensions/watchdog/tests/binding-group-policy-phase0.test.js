import test from "node:test";
import assert from "node:assert/strict";

import {
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../lib/agent/agent-binding-store.js";
import {
  sanitizeInboxPolicy,
  sanitizeOutputPolicy,
} from "../lib/agent/agent-binding-store-read.js";
import {
  getInboxPolicy,
  getOutputPolicy,
  hasInboxPolicy,
  registerRuntimeAgents,
} from "../lib/agent/agent-identity.js";
import { composeAgentBinding } from "../lib/effective-profile-composer.js";
import { runtimeAgentConfigs } from "../lib/state.js";

// P6-Phase0: 通用 binding policy 机制（outputPolicy / inboxPolicy）。
// 纯增量 schema + validate + round-trip。本阶段无运行时消费者（Phase1 才接入），
// 但每个新字段必须有 schema+validate+测试，且不改 contractor 任何现有行为。

function cleanup() {
  runtimeAgentConfigs.clear();
}

// ── validate ────────────────────────────────────────────────────────────────

test("sanitizeOutputPolicy validates format enum + aggregateGroup string", () => {
  assert.deepEqual(
    sanitizeOutputPolicy({ format: "contract-json", aggregateGroup: "team-x" }),
    { format: "contract-json", aggregateGroup: "team-x" },
  );
  assert.deepEqual(sanitizeOutputPolicy({ format: "passthrough" }), { format: "passthrough" });
  // 非法 enum 被丢弃；空对象/无效全部回 null（不落空对象）
  assert.equal(sanitizeOutputPolicy({ format: "nope" }), null);
  assert.equal(sanitizeOutputPolicy({ aggregateGroup: "" }), null);
  assert.equal(sanitizeOutputPolicy({}), null);
  assert.equal(sanitizeOutputPolicy(null), null);
  // 未知字段不入 schema
  assert.deepEqual(
    sanitizeOutputPolicy({ format: "contract-json", bogus: 123 }),
    { format: "contract-json" },
  );
});

test("sanitizeInboxPolicy validates preserveDrafts boolean", () => {
  assert.deepEqual(sanitizeInboxPolicy({ preserveDrafts: true }), { preserveDrafts: true });
  assert.deepEqual(sanitizeInboxPolicy({ preserveDrafts: false }), { preserveDrafts: false });
  // 非布尔被丢弃 → null
  assert.equal(sanitizeInboxPolicy({ preserveDrafts: "yes" }), null);
  assert.equal(sanitizeInboxPolicy({}), null);
  assert.equal(sanitizeInboxPolicy(null), null);
});

// ── round-trip through the binding store ──────────────────────────────────────

test("output/inbox policy round-trips through read -> write -> read (nested binding)", () => {
  const agentConfig = {
    id: "grp-a",
    binding: {
      roleRef: "executor",
      policies: {
        outputPolicy: { format: "contract-json", aggregateGroup: "team-x" },
        inboxPolicy: { preserveDrafts: true },
      },
    },
  };
  const binding = readStoredAgentBinding(agentConfig);
  assert.deepEqual(binding.policies.outputPolicy, { format: "contract-json", aggregateGroup: "team-x" });
  assert.deepEqual(binding.policies.inboxPolicy, { preserveDrafts: true });

  const written = writeStoredAgentBinding({ id: "grp-a" }, binding);
  assert.deepEqual(written.binding.policies.outputPolicy, { format: "contract-json", aggregateGroup: "team-x" });
  assert.deepEqual(written.binding.policies.inboxPolicy, { preserveDrafts: true });

  const reread = readStoredAgentBinding(written);
  assert.deepEqual(reread.policies.outputPolicy, binding.policies.outputPolicy);
  assert.deepEqual(reread.policies.inboxPolicy, binding.policies.inboxPolicy);
});

test("invalid output/inbox policy values are dropped on read (validate at the boundary)", () => {
  const binding = readStoredAgentBinding({
    id: "grp-b",
    binding: {
      roleRef: "executor",
      policies: {
        outputPolicy: { format: "garbage" },
        inboxPolicy: { preserveDrafts: "nope" },
      },
    },
  });
  assert.equal(binding.policies?.outputPolicy, undefined, "invalid outputPolicy dropped");
  assert.equal(binding.policies?.inboxPolicy, undefined, "invalid inboxPolicy dropped");
});

// ── exposure through effective profile + runtime helpers ──────────────────────

test("composeAgentBinding exposes outputPolicy/inboxPolicy on the effective profile", () => {
  const binding = composeAgentBinding({
    config: { agents: { list: [] } },
    agentConfig: {
      id: "grp-c",
      binding: {
        roleRef: "executor",
        policies: {
          outputPolicy: { format: "passthrough", aggregateGroup: "g9" },
          inboxPolicy: { preserveDrafts: true },
        },
      },
    },
  });
  assert.deepEqual(binding.policies.outputPolicy, { format: "passthrough", aggregateGroup: "g9" });
  assert.deepEqual(binding.policies.inboxPolicy, { preserveDrafts: true });
});

test("runtime helpers resolve output/inbox policy after registerRuntimeAgents", () => {
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "grp-d",
            binding: {
              roleRef: "executor",
              policies: {
                outputPolicy: { format: "contract-json", aggregateGroup: "team-d" },
                inboxPolicy: { preserveDrafts: true },
              },
            },
          },
          { id: "grp-e", binding: { roleRef: "executor" } },
        ],
      },
    });
    assert.deepEqual(getOutputPolicy("grp-d"), { format: "contract-json", aggregateGroup: "team-d" });
    assert.deepEqual(getInboxPolicy("grp-d"), { preserveDrafts: true });
    assert.equal(hasInboxPolicy("grp-d", "preserveDrafts"), true);
    // agent without policy → null/false (no consumer-side surprises)
    assert.equal(getOutputPolicy("grp-e"), null);
    assert.equal(getInboxPolicy("grp-e"), null);
    assert.equal(hasInboxPolicy("grp-e", "preserveDrafts"), false);
  } finally {
    cleanup();
  }
});

// ── zero behaviour change: contractor/executionPolicy paths untouched ──────────

test("existing executionPolicy schema still round-trips alongside the new policies", () => {
  const binding = readStoredAgentBinding({
    id: "grp-f",
    binding: {
      roleRef: "evaluator",
      policies: {
        executionPolicy: { noDirectIntake: true, planRequired: true },
        outputPolicy: { format: "contract-json" },
      },
    },
  });
  // executionPolicy 行为不变（既有字段照常）
  assert.deepEqual(binding.policies.executionPolicy, { noDirectIntake: true, planRequired: true });
  // 新字段与旧字段共存，互不干扰
  assert.deepEqual(binding.policies.outputPolicy, { format: "contract-json" });
});

test("agent with no group policies produces no policy noise (no empty containers)", () => {
  const binding = readStoredAgentBinding({ id: "grp-g", binding: { roleRef: "executor" } });
  assert.equal(binding.policies?.outputPolicy, undefined);
  assert.equal(binding.policies?.inboxPolicy, undefined);
});
