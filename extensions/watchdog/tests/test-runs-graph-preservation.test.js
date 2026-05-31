import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { loadGraphLoopRegistry, saveGraphLoopRegistry } from "../lib/loop/graph-loop-registry.js";
import { LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";
import { withPreservedRuntimeGraph } from "../lib/test-runs.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

test("withPreservedRuntimeGraph restores the live graph after a temporary test-run mutation", async () => (
  runGlobalTestEnvironmentSerial(async () => {
    const originalGraph = await loadGraph();

    await withPreservedRuntimeGraph(async () => {
      await saveGraph({
        edges: [
          {
            from: "worker-3",
            to: "worker-4",
            label: "temporary-test-run-graph",
          },
        ],
      });

      const mutatedGraph = await loadGraph();
      assert.equal(mutatedGraph.edges.length, 1);
      assert.equal(mutatedGraph.edges[0]?.label, "temporary-test-run-graph");
    });

    const restoredGraph = await loadGraph();
    assert.deepEqual(restoredGraph, originalGraph);
  })
));

test("withPreservedRuntimeGraph restores loop registry and loop session state after temporary mutations", async () => (
  runGlobalTestEnvironmentSerial(async () => {
    const originalLoopRegistry = await loadGraphLoopRegistry();
    const originalLoopSessionRaw = await readFile(LOOP_SESSION_STATE_FILE, "utf8").catch(() => null);

    await withPreservedRuntimeGraph(async () => {
      await saveGraphLoopRegistry({
        loops: [{
          id: "temporary-test-loop",
          nodes: ["planner", "worker"],
          entryAgentId: "planner",
        }],
      });
      await writeFile(LOOP_SESSION_STATE_FILE, JSON.stringify({
        activeSession: {
          id: "temporary-session",
          loopId: "temporary-test-loop",
          currentStage: "planner",
          nodes: ["planner", "worker"],
        },
      }), "utf8");

      const mutatedRegistry = await loadGraphLoopRegistry();
      const mutatedSession = JSON.parse(await readFile(LOOP_SESSION_STATE_FILE, "utf8"));
      assert.equal(mutatedRegistry.loops[0]?.id, "temporary-test-loop");
      assert.equal(mutatedSession.activeSession?.id, "temporary-session");
    });

    const restoredLoopRegistry = await loadGraphLoopRegistry();
    const restoredLoopSessionRaw = await readFile(LOOP_SESSION_STATE_FILE, "utf8").catch(() => null);
    assert.deepEqual(restoredLoopRegistry, originalLoopRegistry);
    assert.equal(restoredLoopSessionRaw, originalLoopSessionRaw);

    if (originalLoopSessionRaw == null) {
      await rm(LOOP_SESSION_STATE_FILE, { force: true });
    }
  })
));
