import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENT_ROLE,
  ROLE_SUGGESTIONS,
  normalizeAgentRoleDraft,
  renderAgentRoleInput,
} from "../dashboard-agent-role-input.js";

test("normalizeAgentRoleDraft falls back to default role for unsupported custom slugs", () => {
  assert.equal(normalizeAgentRoleDraft("federated_reviewer"), DEFAULT_AGENT_ROLE);
});

test("normalizeAgentRoleDraft falls back to the default role for empty placeholder values", () => {
  assert.equal(normalizeAgentRoleDraft("--"), DEFAULT_AGENT_ROLE);
  assert.equal(normalizeAgentRoleDraft("   "), DEFAULT_AGENT_ROLE);
  assert.equal(normalizeAgentRoleDraft(null), DEFAULT_AGENT_ROLE);
});

test("renderAgentRoleInput renders canonical role suggestions only", () => {
  const markup = renderAgentRoleInput({
    agentId: "agent-custom",
    value: "reviewer",
    compact: true,
  });

  assert.match(markup, /<input[^>]+type="text"/);
  assert.doesNotMatch(markup, /<select/);
  assert.match(markup, /value="reviewer"/);
  assert.doesNotMatch(markup, /federated_reviewer/);
  assert.match(markup, new RegExp(`list="agent-role-suggestions-agent-custom-compact"`));
  for (const role of ROLE_SUGGESTIONS) {
    assert.match(markup, new RegExp(`<option value="${role}">`));
  }
});
