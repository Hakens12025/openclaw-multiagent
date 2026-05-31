import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import {
  buildSoulTemplate,
  buildBridgeSoulTemplate,
  MANAGED_BOOTSTRAP_MARKER,
} from "../lib/soul-template-builder.js";

test("buildSoulTemplate(BRIDGE) returns bridge template, not default", () => {
  const soul = buildSoulTemplate("bridge-x", AGENT_ROLE.BRIDGE);
  assert.ok(soul.startsWith(MANAGED_BOOTSTRAP_MARKER), "bridge SOUL carries managed marker");
  assert.match(soul, /Bridge Local Handling Principles|# bridge-x/, "bridge SOUL mentions bridge role section or agent id");
});

test("bridge template keeps only a minimal formal dispatch entrypoint", () => {
  const soul = buildBridgeSoulTemplate("bridge-x", AGENT_ROLE.BRIDGE);
  assert.match(soul, /\[ACTION\] delegate/, "bridge SOUL exposes the formal dispatch entrypoint");
  assert.doesNotMatch(soul, /```[\s\S]*\[ACTION\] delegate/, "bridge SOUL should not include a protocol tutorial block");
  assert.doesNotMatch(soul, /\[DISPATCH\]/, "bridge SOUL should not teach [DISPATCH] tag");
  assert.doesNotMatch(soul, /IDENTITY\.md/, "bridge SOUL should not mention IDENTITY.md");
  assert.doesNotMatch(soul, /USER\.md/, "bridge SOUL should not mention USER.md");
});

test("bridge template describes scope boundaries instead of protocol tutorials", () => {
  const soul = buildBridgeSoulTemplate("bridge-x", AGENT_ROLE.BRIDGE);
  assert.match(soul, /Bridge working surface: the current session, this agent workspace, the managed platform docs/, "bridge SOUL should describe the positive work surface");
  assert.match(soul, /Config, other workspaces, and identity\/memory files are managed by the matching runtime\/owner/, "bridge SOUL should point owned surfaces to their runtime owner");
});

test("planner template does not encode simple or complex contract classes", () => {
  const soul = buildSoulTemplate("planner-x", AGENT_ROLE.PLANNER);
  assert.match(soul, /stages split by verifiable delivery boundaries/);
  assert.doesNotMatch(soul, /simple task|simple-task/i);
  assert.doesNotMatch(soul, /complex task|complex-task/i);
});

test("planner template produces a working brief (not the final deliverable)", () => {
  const soul = buildSoulTemplate("planner-x", AGENT_ROLE.PLANNER);
  assert.match(soul, /working brief/i, "planner should produce a working brief (input for the executor)");
  assert.match(soul, /the final answer and deliverable are the executor's/i, "planner should hand the final deliverable to the executor");
  assert.match(soul, /\[STAGE\]/, "keep [STAGE] markers (system progress tracking)");
});

test("executor template stays role-only without runtime_result protocol branches", () => {
  const soul = buildSoulTemplate("worker-x", AGENT_ROLE.EXECUTOR);
  assert.doesNotMatch(soul, /runtime_result\.json/);
  assert.doesNotMatch(soul, /单文件|多文件|single-file|multi-file/i);
  assert.doesNotMatch(soul, /stage_result\.json|contract_result\.json/);
});

test("executor template treats upstream brief as working input", () => {
  const soul = buildSoulTemplate("worker-x", AGENT_ROLE.EXECUTOR);
  assert.match(soul, /upstream gave a working brief/i, "executor should treat the upstream working brief as input");
  assert.match(soul, /produce the real deliverable from it/i, "executor should produce the real deliverable from the brief");
});
