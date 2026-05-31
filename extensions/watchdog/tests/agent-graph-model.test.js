import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGraphEdges } from "../lib/agent/agent-graph.js";

test("agent graph model strips edge semantic fields to topology plus display metadata", () => {
  const [edge] = normalizeGraphEdges([
    {
      from: "planner",
      to: "worker",
      label: "handoff",
      gate: "on-complete",
      capability: "coding",
      gates: ["review"],
      metadata: { source: "test" },
    },
  ]);

  assert.deepEqual(edge, {
    from: "planner",
    to: "worker",
    label: "handoff",
    metadata: { source: "test" },
  });
});
