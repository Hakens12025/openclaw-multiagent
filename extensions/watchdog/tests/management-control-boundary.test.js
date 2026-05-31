import test from "node:test";
import assert from "node:assert/strict";

import { buildManagementRegistry } from "../lib/management-registry-view.js";

test("management registry hides control-plane actors from agent targets", () => {
  const registry = buildManagementRegistry({
    agents: [
      {
        id: "operator",
        role: "agent",
        plane: "control_plane",
        mainViewVisible: false,
      },
      {
        id: "harness",
        role: "agent",
        plane: "control_plane",
        mainViewVisible: false,
      },
      {
        id: "worker-a",
        role: "executor",
        plane: "runtime",
        mainViewVisible: true,
      },
    ],
    models: [],
    agentDefaults: { ok: true },
  });

  const subject = registry.management.subjects.find((entry) => entry.kind === "agent");
  assert.deepEqual(
    (subject?.targets || []).map((entry) => entry.id).sort(),
    ["worker-a"],
  );
  assert.deepEqual(
    registry.agents.map((entry) => entry.id).sort(),
    ["worker-a"],
  );
});
