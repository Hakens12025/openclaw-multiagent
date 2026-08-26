import test from "node:test";
import assert from "node:assert/strict";

import {
  agentDedupesConcurrentTrackerForHeartbeat,
  agentRequiresContractForHeartbeat,
  canAgentReceiveRework,
  registerRuntimeAgents,
} from "../lib/agent/agent-identity.js";
import { runtimeAgentConfigs } from "../lib/state.js";

// P6-Phase1 (收窄版): 把 3 个真·role 劫持点迁到 policy（行为等价 + 可配置）。
//   #1 reviewer reworkTarget 回退      -> outputPolicy.canReceiveRework
//   #2 mailbox handler matchAgent      -> 死字段，已删（见 handler-registry 测试不需要它）
//   #3 heartbeat actionable-work       -> inboxPolicy.requiresContract / dedupeConcurrentTracker
// 红线：默认 policy 值必须等同迁移前的 role 判定（现有 agent 行为一字不变）。

function withAgents(list, fn) {
  try {
    registerRuntimeAgents({ agents: { list } });
    return fn();
  } finally {
    runtimeAgentConfigs.clear();
  }
}

// ── #1 canReceiveRework: 默认等价于 isSpecializedExecutor || isResearcherAgent ──

test("canReceiveRework default equals old role predicate (behaviour equivalence)", () => {
  withAgents([
    { id: "spec-exec", binding: { roleRef: "executor", policies: { specialized: true } } },
    { id: "plain-exec", binding: { roleRef: "executor" } },
    { id: "researcher-1", binding: { roleRef: "researcher" } },
    { id: "agent-x", binding: { roleRef: "agent" } },
  ], () => {
    assert.equal(canAgentReceiveRework("spec-exec"), true, "specialized executor was true");
    assert.equal(canAgentReceiveRework("plain-exec"), false, "plain executor was false (not specialized)");
    assert.equal(canAgentReceiveRework("researcher-1"), true, "researcher was true");
    assert.equal(canAgentReceiveRework("agent-x"), false, "generic agent was false");
  });
});

test("canReceiveRework is configurable via outputPolicy.canReceiveRework", () => {
  withAgents([
    { id: "yes-agent", binding: { roleRef: "agent", policies: { outputPolicy: { canReceiveRework: true } } } },
    { id: "no-spec", binding: { roleRef: "executor", policies: { specialized: true, outputPolicy: { canReceiveRework: false } } } },
  ], () => {
    assert.equal(canAgentReceiveRework("yes-agent"), true, "policy can grant rework to a non-specialized role");
    assert.equal(canAgentReceiveRework("no-spec"), false, "policy can revoke rework from a specialized executor");
  });
});

// ── #3 heartbeat actionable-work policy defaults ──────────────────────────────

test("requiresContract default equals old (role===EXECUTOR||RESEARCHER)", () => {
  withAgents([
    { id: "exec-1", binding: { roleRef: "executor" } },
    { id: "researcher-1", binding: { roleRef: "researcher" } },
    { id: "agent-x", binding: { roleRef: "agent" } },
  ], () => {
    assert.equal(agentRequiresContractForHeartbeat("exec-1"), true);
    assert.equal(agentRequiresContractForHeartbeat("researcher-1"), true);
    assert.equal(agentRequiresContractForHeartbeat("agent-x"), false);
  });
});

test("dedupeConcurrentTracker default equals old (role===EXECUTOR only)", () => {
  withAgents([
    { id: "exec-1", binding: { roleRef: "executor" } },
    { id: "researcher-1", binding: { roleRef: "researcher" } },
  ], () => {
    assert.equal(agentDedupesConcurrentTrackerForHeartbeat("exec-1"), true, "executor dedupes (old behaviour)");
    assert.equal(agentDedupesConcurrentTrackerForHeartbeat("researcher-1"), false, "researcher did not dedupe");
  });
});

test("heartbeat policies are configurable via inboxPolicy", () => {
  withAgents([
    { id: "exec-off", binding: { roleRef: "executor", policies: { inboxPolicy: { requiresContract: false } } } },
    { id: "agent-on", binding: { roleRef: "agent", policies: { inboxPolicy: { requiresContract: true, dedupeConcurrentTracker: true } } } },
  ], () => {
    assert.equal(agentRequiresContractForHeartbeat("exec-off"), false, "executor can opt out of contract gating");
    assert.equal(agentRequiresContractForHeartbeat("agent-on"), true, "generic agent can opt into contract gating");
    assert.equal(agentDedupesConcurrentTrackerForHeartbeat("agent-on"), true);
  });
});

// ── #2 dead field removal proof ───────────────────────────────────────────────

test("dead matchAgent field is removed from the mailbox handler registry", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../lib/routing/mailbox/runtime-mailbox-handler-registry.js", import.meta.url),
    "utf8",
  ));
  assert.doesNotMatch(source, /matchAgent\s*:/, "matchAgent dead field must be gone");
  assert.doesNotMatch(source, /isExecutorAgent/, "unused isExecutorAgent import must be gone");
});
