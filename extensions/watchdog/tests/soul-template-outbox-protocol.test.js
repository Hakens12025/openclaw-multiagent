import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import { buildSoulTemplate } from "../lib/soul-template-builder.js";

function assertExecutionSoulUsesCanonicalOutbox(role, agentId) {
  const soul = buildSoulTemplate(agentId, role);
  assert.match(soul, /当前会话边界/, `${agentId} soul should teach current-session boundary`);
  assert.doesNotMatch(soul, /inbox\/contract\.json/, `${agentId} soul should not hardcode shared-contract input`);
  assert.doesNotMatch(soul, /outbox\/stage_result\.json/, `${agentId} soul should not teach legacy stage_result commit`);
  assert.doesNotMatch(soul, /outbox\/contract_result\.json/, `${agentId} soul should not teach legacy contract_result commit`);
  assert.doesNotMatch(soul, /HEARTBEAT_OK/, `${agentId} soul should not hardcode heartbeat stop protocol`);
  assert.doesNotMatch(soul, /outbox\/_manifest\.json/, `${agentId} soul should not mention legacy outbox manifest`);
}

test("executor soul keeps role semantics while leaving shared-contract IO to wake layer", () => {
  assertExecutionSoulUsesCanonicalOutbox(AGENT_ROLE.EXECUTOR, "worker-x");
});

test("researcher soul keeps role semantics while leaving shared-contract IO to wake layer", () => {
  assertExecutionSoulUsesCanonicalOutbox(AGENT_ROLE.RESEARCHER, "researcher-x");
});
