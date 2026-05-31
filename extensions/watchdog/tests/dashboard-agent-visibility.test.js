import test from "node:test";
import assert from "node:assert/strict";

import {
  filterDashboardAgentCandidates,
  shouldDisplayDashboardAgentRecord,
} from "../dashboard-agent-visibility.js";

test("main-view agent visibility hides runtime control actors by identity without explicit flags", () => {
  const agents = [
    { id: "controller", role: "bridge", gateway: true },
    { id: "operator", role: "agent" },
    { id: "harness", role: "agent" },
    { id: "cli-system", role: "agent" },
    { id: "automation", role: "agent" },
    { id: "planner", role: "planner" },
    { id: "worker", role: "executor" },
  ];

  assert.deepEqual(
    agents.filter(shouldDisplayDashboardAgentRecord).map((agent) => agent.id),
    ["controller", "planner", "worker"],
  );
});

test("main-view agent visibility respects explicit hidden flags and folds secondary gateway bridges", () => {
  const agents = [
    { id: "controller", role: "bridge", gateway: true },
    { id: "agent-for-kksl", role: "bridge", gateway: true },
    { id: "control-helper", role: "agent", mainViewVisible: false },
    { id: "worker", role: "executor" },
  ];

  assert.deepEqual(
    agents.filter(shouldDisplayDashboardAgentRecord).map((agent) => agent.id),
    ["controller", "worker"],
  );
});

test("candidate visibility hides control-layer join candidates", () => {
  assert.deepEqual(
    filterDashboardAgentCandidates([
      { id: "automation", role: "agent", joinable: true },
      { id: "cli-system", role: "agent", joinable: true },
      { id: "worker", role: "executor", joinable: true },
    ]).map((agent) => agent.id),
    ["worker"],
  );
});
