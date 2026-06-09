// chart-registry.test.js — the NON-truth chart store (sibling of knowledge-bases.json).
// Exercises upsert/list/move + load-on-missing against the real
// CONTROL_PLANE_PATHS.chartsRegistryFile, restoring any pre-existing file in finally.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";

import {
  loadCharts,
  listCharts,
  upsertChart,
  moveChartPosition,
} from "../lib/control-plane/chart-registry.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const FILE = CONTROL_PLANE_PATHS.chartsRegistryFile;

function buildSpec(id) {
  return {
    id,
    label: `Chart ${id}`,
    type: "line",
    title: "demo",
    series: [{ name: "s1", points: [{ x: 1, y: 2 }, { x: 2, y: 4 }] }],
  };
}

// Snapshot/restore the real store so the suite never clobbers existing data.
async function withCleanStore(body) {
  let priorContent = null;
  try {
    priorContent = await readFile(FILE, "utf8");
  } catch {
    priorContent = null;
  }
  await rm(FILE, { force: true });
  try {
    await body();
  } finally {
    if (priorContent === null) {
      await rm(FILE, { force: true });
    } else {
      await writeFile(FILE, priorContent, "utf8");
    }
  }
}

test("loadCharts on missing file returns {charts:[]}", async () => {
  await withCleanStore(async () => {
    const loaded = await loadCharts();
    assert.deepEqual(loaded, { charts: [] });
  });
});

test("upsert then list returns the stored entry", async () => {
  await withCleanStore(async () => {
    const stored = await upsertChart(buildSpec("alpha-chart"));
    assert.equal(stored.id, "alpha-chart");
    assert.equal(stored.label, "Chart alpha-chart");
    assert.equal(stored.renderMode, "declarative");
    assert.deepEqual(stored.position, { x: 0, y: 0 });
    assert.ok(Number.isFinite(stored.createdAt));
    assert.ok(Number.isFinite(stored.updatedAt));
    assert.equal(stored.spec.type, "line");

    const list = await listCharts();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "alpha-chart");
  });
});

test("upsert validates: bad spec throws", async () => {
  await withCleanStore(async () => {
    await assert.rejects(() => upsertChart({ id: "Bad ID!", type: "line", series: [] }));
    await assert.rejects(() => upsertChart({ id: "no-series", type: "line", series: [] }));
    await assert.rejects(() => upsertChart({ id: "bad-type", type: "scatter", series: [{ name: "s", points: [{ x: 1, y: 1 }] }] }));
    const list = await listCharts();
    assert.equal(list.length, 0);
  });
});

test("moveChartPosition only changes position (spec/label unchanged, updatedAt bumped)", async () => {
  await withCleanStore(async () => {
    const stored = await upsertChart(buildSpec("beta-chart"));
    await new Promise((resolve) => setTimeout(resolve, 2));

    const moved = await moveChartPosition("beta-chart", 120, -40);
    assert.deepEqual(moved.position, { x: 120, y: -40 });
    assert.equal(moved.label, stored.label);
    assert.deepEqual(moved.spec, stored.spec);
    assert.equal(moved.createdAt, stored.createdAt);
    assert.ok(moved.updatedAt >= stored.updatedAt);
    assert.notDeepEqual(moved.position, stored.position);

    await assert.rejects(() => moveChartPosition("does-not-exist", 1, 1));
  });
});
