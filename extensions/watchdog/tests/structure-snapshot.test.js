import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import {
  captureStructureSnapshot,
  restoreStructureSnapshot,
  verifyAgainstSnapshot,
  listStructureSnapshots,
  projectStructureAfter,
} from "../lib/control-plane/structure-snapshot.js";
import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { loadGraphLoopRegistry, saveGraphLoopRegistry } from "../lib/loop/graph-loop-registry.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const SNAP_FILE = CONTROL_PLANE_PATHS.structureSnapshotsFile;

test("structure snapshot: capture→mutate→restore→verify round-trip", async () => {
  const origGraph = await loadGraph();
  const origReg = await loadGraphLoopRegistry();
  try {
    const s0 = await captureStructureSnapshot({ label: "test-baseline", reason: "unit test" });
    assert.match(s0.id, /^SNAP-\d+-[0-9a-f]{8}$/, "snapshot code format SNAP-<ts>-<8hex>");

    // mutate the graph (add a test edge)
    await saveGraph({ edges: [...(origGraph.edges || []), { from: "__snap_test_a__", to: "__snap_test_b__" }] });
    const s1 = await captureStructureSnapshot({ label: "test-mutated" });
    assert.notEqual(s1.contentHash, s0.contentHash, "contentHash must change after a structural mutation");

    // restore baseline
    const r = await restoreStructureSnapshot(s0.id);
    assert.equal(r.ok, true, `restore must succeed without drift (got ${JSON.stringify(r.drift)})`);

    // live must match baseline again
    const v = await verifyAgainstSnapshot(s0.id);
    assert.equal(v.drifted, false, "live structure must match baseline after restore");

    // the test edge must be gone
    const g = await loadGraph();
    assert.equal(g.edges.some((e) => e.from === "__snap_test_a__"), false, "test edge must be removed by restore");
  } finally {
    await saveGraph(origGraph);
    await saveGraphLoopRegistry(origReg);
    await rm(SNAP_FILE, { force: true });
  }
});

test("structure snapshot: projectStructureAfter is non-destructive + shows edge diff", async () => {
  const before = await loadGraph();
  const proj = await projectStructureAfter({ surfaceId: "graph.edge.add", payload: { from: "__proj_a__", to: "__proj_b__" } });
  assert.equal(proj.structural, true);
  assert.ok(proj.edgeDiff.added.includes("__proj_a__→__proj_b__"), "projected diff lists the new edge");
  const after = await loadGraph();
  assert.equal(after.edges.length, before.edges.length, "projection must NOT mutate the live graph");
  assert.equal(after.edges.some((e) => e.from === "__proj_a__"), false, "live graph stays clean after projection");
});

test("structure snapshot: expectHash guard aborts restore on drift (TOCTOU)", async () => {
  try {
    const s0 = await captureStructureSnapshot({ label: "test-guard" });
    const r = await restoreStructureSnapshot(s0.id, { expectHash: "deadbeefwronghash" });
    assert.equal(r.ok, false, "restore must abort when expectHash mismatches live");
    assert.match(r.error, /drift/);
  } finally {
    await rm(SNAP_FILE, { force: true });
  }
});

test("structure snapshot: missing snapshot id is handled, not thrown", async () => {
  const r = await restoreStructureSnapshot("SNAP-does-not-exist");
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});
