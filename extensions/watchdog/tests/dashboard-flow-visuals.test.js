import test from "node:test";
import assert from "node:assert/strict";

import { FLOW_VISUAL_ID, PROTOCOL_ID } from "../protocol-registry.js";
import {
  resolveFlowProtocolId,
  resolveFlowVisualClasses,
  resolveFlowVisualLabel,
  resolveFlowVisualType,
  resolveSystemActionDeliveryAlertFlow,
} from "../dashboard-flow-visuals.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WATCHDOG_ROOT = dirname(fileURLToPath(new URL("../dashboard-flow-visuals.js", import.meta.url)));
const REMOVED_FLOW_PROTOCOL_TOKENS = [
  "dashboard-flow-" + "protocols",
  "resolveFlow" + "TypeClasses",
  "DASHBOARD_" + "FLOW_TYPE",
  "GRAPH_ROUTE_" + "FAST",
  "PIPELINE_" + "PROGRESS",
];

function listSourceFiles(dir) {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests") continue;
      entries.push(...listSourceFiles(fullPath));
      continue;
    }
    if ([".js", ".html", ".css"].includes(extname(entry.name))) {
      entries.push(fullPath);
    }
  }
  return entries;
}

test("dashboard flow visuals map dispatch envelopes to protocol and visual ids", () => {
  assert.equal(
    resolveFlowProtocolId("dispatch_alert", { protocolEnvelope: "direct_request" }),
    PROTOCOL_ID.DISPATCH.DIRECT_REQUEST,
  );
  assert.equal(
    resolveFlowVisualType("dispatch_alert", { protocolEnvelope: "direct_request" }),
    FLOW_VISUAL_ID.DISPATCH_DIRECT,
  );
  assert.equal(resolveFlowVisualLabel("dispatch_alert", { protocolEnvelope: "direct_request" }), "DIRECT");
  assert.equal(resolveFlowVisualClasses(FLOW_VISUAL_ID.DISPATCH_DIRECT), " flow-direct-dispatch");
});

test("dashboard flow visuals map terminal and loop flows without legacy fast-route types", () => {
  assert.equal(resolveFlowProtocolId("reply"), PROTOCOL_ID.DELIVERY.TERMINAL);
  assert.equal(resolveFlowVisualType("reply"), FLOW_VISUAL_ID.DELIVERY_TERMINAL);
  assert.equal(resolveFlowVisualLabel("reply"), "DELIVERY");

  assert.equal(resolveFlowProtocolId("loop_progress", { type: "loop_started" }), PROTOCOL_ID.SYSTEM_ACTION.START_LOOP);
  assert.equal(resolveFlowVisualType("loop_progress", { type: "loop_started" }), FLOW_VISUAL_ID.WORKFLOW_PROGRESS);
  assert.equal(resolveFlowVisualLabel("loop_progress", { type: "loop_started" }), "LOOP");
  assert.equal(resolveFlowVisualClasses(FLOW_VISUAL_ID.WORKFLOW_PROGRESS), " flow-loop-progress");
});

test("dashboard flow visuals resolve system-action return alerts", () => {
  assert.deepEqual(resolveSystemActionDeliveryAlertFlow({
    type: "system_action_runtime_result_delivered",
    source: "worker",
    targetAgent: "controller",
  }), {
    from: "worker",
    to: "controller",
    label: "RETURN",
    protocolId: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_RUNTIME_RESULT,
    type: FLOW_VISUAL_ID.DELIVERY_RETURN,
  });

  assert.equal(resolveSystemActionDeliveryAlertFlow({
    type: "system_action_runtime_result_delivered",
    source: "worker",
    targetAgent: "worker",
  }), null);
});

test("dashboard production resources no longer reference the removed flow protocol shell", () => {
  const offenders = [];
  for (const filePath of listSourceFiles(WATCHDOG_ROOT)) {
    const source = readFileSync(filePath, "utf8");
    for (const token of REMOVED_FLOW_PROTOCOL_TOKENS) {
      if (source.includes(token)) {
        offenders.push(`${relative(WATCHDOG_ROOT, filePath)}:${token}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
