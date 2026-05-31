import test from "node:test";
import assert from "node:assert/strict";

import {
  loadGraphLoopRegistry,
  saveGraphLoopRegistry,
  upsertGraphLoopSpec,
  removeGraphLoopSpec,
} from "../lib/loop/graph-loop-registry.js";
import { deleteGraphLoop } from "../lib/admin/admin-surface-graph-operations.js";

const logger = { info() {}, warn() {}, error() {} };

test("removeGraphLoopSpec removes a registered loop and reports count", async () => {
  const orig = await loadGraphLoopRegistry();
  try {
    await upsertGraphLoopSpec({ id: "test-rm-loop", nodes: ["a", "b"], entryAgentId: "a" });
    assert.ok((await loadGraphLoopRegistry()).loops.some((l) => l.id === "test-rm-loop"));

    const r = await removeGraphLoopSpec("test-rm-loop");
    assert.equal(r.removed, 1);
    assert.equal((await loadGraphLoopRegistry()).loops.some((l) => l.id === "test-rm-loop"), false);

    const miss = await removeGraphLoopSpec("does-not-exist");
    assert.equal(miss.removed, 0);
  } finally {
    await saveGraphLoopRegistry(orig);
  }
});

test("graph.loop.delete surface de-registers a loop (operator-reachable inverse of compose)", async () => {
  const orig = await loadGraphLoopRegistry();
  try {
    await upsertGraphLoopSpec({ id: "test-del-surface", nodes: ["a", "b"], entryAgentId: "a" });

    const res = await deleteGraphLoop({ payload: { loopId: "test-del-surface" }, logger });
    assert.equal(res.ok, true);
    assert.equal(res.removed, 1);
    assert.equal((await loadGraphLoopRegistry()).loops.some((l) => l.id === "test-del-surface"), false);

    const miss = await deleteGraphLoop({ payload: { loopId: "still-missing" }, logger });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /not found/);
  } finally {
    await saveGraphLoopRegistry(orig);
  }
});

test("graph.loop.delete requires loopId", async () => {
  await assert.rejects(() => deleteGraphLoop({ payload: {}, logger }), /requires loopId/);
});
