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
  deleteChart,
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

test("deleteChart on unknown id is an idempotent no-op ({removed:false})", async () => {
  await withCleanStore(async () => {
    const result = await deleteChart("never-existed-chart");
    assert.deepEqual(result, { ok: true, removed: false });
    assert.equal((await listCharts()).length, 0);
  });
});

test("provenance: valid {controlsPassed,controlsTotal,verifiedAt} is stored and round-trips loadCharts", async () => {
  await withCleanStore(async () => {
    const provenance = { controlsPassed: 2, controlsTotal: 3, verifiedAt: Date.now() };
    const stored = await upsertChart({ spec: buildSpec("prov-chart"), provenance });
    assert.deepEqual(stored.provenance, provenance);

    // Round-trip: a fresh load re-normalizes from disk and keeps exactly the three fields.
    const reloaded = await loadCharts();
    assert.deepEqual(reloaded.charts.find((entry) => entry.id === "prov-chart").provenance, provenance);
  });
});

test("provenance: invalid (missing field / negative / zero total) is omitted entirely", async () => {
  await withCleanStore(async () => {
    const missingField = await upsertChart({
      spec: buildSpec("prov-missing"),
      provenance: { controlsPassed: 3, controlsTotal: 3 },
    });
    assert.equal("provenance" in missingField, false);

    const negative = await upsertChart({
      spec: buildSpec("prov-negative"),
      provenance: { controlsPassed: -1, controlsTotal: 3, verifiedAt: Date.now() },
    });
    assert.equal("provenance" in negative, false);

    const zeroTotal = await upsertChart({
      spec: buildSpec("prov-zero-total"),
      provenance: { controlsPassed: 0, controlsTotal: 0, verifiedAt: Date.now() },
    });
    assert.equal("provenance" in zeroTotal, false);
  });
});

test("provenance anti-forgery: passed>total and far-future verifiedAt are rejected (client-asserted, no server attestation)", async () => {
  await withCleanStore(async () => {
    // Internally inconsistent verdict: more controls passed than were run.
    const inflated = await upsertChart({
      spec: buildSpec("prov-inflated"),
      provenance: { controlsPassed: 4, controlsTotal: 3, verifiedAt: Date.now() },
    });
    assert.equal("provenance" in inflated, false);

    // verifiedAt beyond now + 5min clock-skew allowance: a forged future timestamp.
    const future = await upsertChart({
      spec: buildSpec("prov-future"),
      provenance: { controlsPassed: 3, controlsTotal: 3, verifiedAt: Date.now() + 6 * 60 * 1000 },
    });
    assert.equal("provenance" in future, false);

    // Boundary sanity: a verifiedAt within the skew allowance still passes.
    const withinSkew = { controlsPassed: 3, controlsTotal: 3, verifiedAt: Date.now() + 60 * 1000 };
    const accepted = await upsertChart({ spec: buildSpec("prov-skew-ok"), provenance: withinSkew });
    assert.deepEqual(accepted.provenance, withinSkew);
  });
});

test("provenance: unverified re-upsert of the same id clears stale provenance", async () => {
  await withCleanStore(async () => {
    const provenance = { controlsPassed: 3, controlsTotal: 3, verifiedAt: Date.now() };
    const verified = await upsertChart({ spec: buildSpec("prov-stale"), provenance });
    assert.deepEqual(verified.provenance, provenance);

    // Provenance reflects the LAST verified write — a write without it must not inherit the old one.
    const unverified = await upsertChart({ spec: buildSpec("prov-stale") });
    assert.equal("provenance" in unverified, false);

    const reloaded = await loadCharts();
    assert.equal("provenance" in reloaded.charts.find((entry) => entry.id === "prov-stale"), false);
  });
});

test("deleteChart removes an existing chart and persists the shrunken store", async () => {
  await withCleanStore(async () => {
    await upsertChart(buildSpec("gamma-chart"));
    await upsertChart(buildSpec("delta-chart"));
    assert.equal((await listCharts()).length, 2);

    const result = await deleteChart("gamma-chart");
    assert.deepEqual(result, { ok: true, removed: true, id: "gamma-chart" });

    const remaining = await listCharts();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "delta-chart");

    // Persisted to disk: a fresh load sees only the survivor.
    const reloaded = await loadCharts();
    assert.equal(reloaded.charts.length, 1);
    assert.equal(reloaded.charts[0].id, "delta-chart");
  });
});
