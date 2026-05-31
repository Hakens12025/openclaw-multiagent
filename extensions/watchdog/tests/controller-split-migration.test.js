import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_IDS,
  AGENT_WORKSPACE_OVERRIDES,
  BRIDGE_AGENT_IDS,
  GATEWAY_AGENT_IDS,
  PROTECTED_AGENT_IDS,
} from "../lib/agent/agent-metadata.js";
import { buildOperatorPlanningFocus } from "../lib/operator/operator-brain.js";

test("controller remains the first-class WebUI bridge id", () => {
  assert.equal(AGENT_IDS.CONTROLLER, "controller");
  assert.equal(AGENT_IDS.OPERATOR, "operator");
});

test("controller + operator carry workspace overrides", () => {
  assert.equal(AGENT_WORKSPACE_OVERRIDES[AGENT_IDS.CONTROLLER], "workspaces/controller");
  assert.equal(AGENT_WORKSPACE_OVERRIDES[AGENT_IDS.OPERATOR], "workspaces/operator");
});

test("controller is registered as the bridge + gateway agent", () => {
  assert.ok(BRIDGE_AGENT_IDS.has(AGENT_IDS.CONTROLLER));
  assert.ok(GATEWAY_AGENT_IDS.has(AGENT_IDS.CONTROLLER));
});

test("operator is NOT a bridge or gateway (runtime admin only)", () => {
  assert.equal(BRIDGE_AGENT_IDS.has(AGENT_IDS.OPERATOR), false);
  assert.equal(GATEWAY_AGENT_IDS.has(AGENT_IDS.OPERATOR), false);
});

test("controller and operator are protected", () => {
  assert.ok(PROTECTED_AGENT_IDS.has(AGENT_IDS.CONTROLLER));
  assert.ok(PROTECTED_AGENT_IDS.has(AGENT_IDS.OPERATOR));
});

test("operator planning focus prefers controller as the WebUI gateway id", () => {
  const focus = buildOperatorPlanningFocus({
    agents: [
      { id: "controller", gateway: true },
      { id: AGENT_IDS.OPERATOR, gateway: false },
    ],
  });

  assert.equal(focus.defaults?.webuiGatewayAgentId, "controller");
  assert.equal(focus.defaults?.preferWebuiGatewayLinksForReporting, true);
});
