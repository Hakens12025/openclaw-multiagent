import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { runtimeAgentConfigs } from "../lib/state.js";
import {
  resolveDirectServiceProbeTopology,
} from "../lib/formal-runtime/suite-direct-service.js";
import {
  resolveLoopPlatformTopology,
} from "../lib/formal-runtime/suite-loop-platform.js";

function setRuntimeAgents(agents) {
  runtimeAgentConfigs.clear();
  for (const agent of agents) {
    runtimeAgentConfigs.set(agent.id, { ...agent });
  }
}

test("direct-service topology resolves live executor agents instead of legacy worker ids", () => {
  setRuntimeAgents([
    { id: "controller", role: "bridge", gateway: true, ingressSource: "webui" },
    { id: "planner", role: "planner" },
    { id: "worker", role: "executor" },
    { id: "worker2", role: "executor" },
  ]);

  const topology = resolveDirectServiceProbeTopology();

  assert.equal(topology.callerAgentId, "worker");
  assert.equal(topology.delegateAgentId, "worker2");
  assert.equal(topology.reviewerAgentId, null);
  assert.deepEqual(topology.executorAgentIds, ["worker", "worker2"]);
});

test("direct-service topology exposes reviewer lane from current runtime truth", () => {
  setRuntimeAgents([
    { id: "controller", role: "bridge", gateway: true, ingressSource: "webui" },
    { id: "worker", role: "executor" },
    { id: "worker2", role: "executor" },
    { id: "review-alpha", role: "reviewer" },
  ]);

  const topology = resolveDirectServiceProbeTopology();

  assert.equal(topology.reviewerAgentId, "review-alpha");
});

test("loop-platform topology composes a live loop from current non-bridge runtime agents", () => {
  setRuntimeAgents([
    { id: "controller", role: "bridge", gateway: true, ingressSource: "webui" },
    { id: "planner", role: "planner" },
    { id: "worker", role: "executor" },
    { id: "worker2", role: "executor" },
  ]);

  const topology = resolveLoopPlatformTopology();

  assert.equal(topology.entryAgentId, "planner");
  assert.deepEqual(topology.loopAgents, ["planner", "worker", "worker2"]);
});

test("loop-platform topology reports blocked when runtime lacks enough work agents", () => {
  setRuntimeAgents([
    { id: "controller", role: "bridge", gateway: true, ingressSource: "webui" },
    { id: "worker", role: "executor" },
  ]);

  const topology = resolveLoopPlatformTopology();

  assert.equal(topology.entryAgentId, "worker");
  assert.equal(topology.blockedReason, "loop-platform preset requires at least 2 non-bridge work agents");
});

test("direct-service probe prompt stays minimal and keeps the formal action marker in the result file flow", async () => {
  const source = await readFile("/Users/hakens/.openclaw/extensions/watchdog/lib/formal-runtime/suite-direct-service-prompts.js", "utf8");

  assert.match(source, /先读取当前任务/);
  assert.match(source, /将结果文件写成下面这一行 \[ACTION\] marker/);
  assert.doesNotMatch(source, /不要改写 inbox\/contract\.json/);
});
