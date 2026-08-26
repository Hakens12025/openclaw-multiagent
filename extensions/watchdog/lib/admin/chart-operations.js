// chart-operations.js — admin-surface operation handlers for the "chart" family.
// viz-master is a meta-agent because it is the SOLE WRITER of this surface family,
// NOT because it owns a platform truth: charts.json is a non-truth control-plane
// store (sibling of knowledge-bases.json). These handlers wrap chart-registry
// upsert/move into the { ok, ... } operation contract shared by every entry in
// admin-surface-operations.js (validation failure → { ok:false, error } so the
// executor never sees a throw past the handler boundary; chart ops are snapshot-free).

import { normalizeString } from "../core/normalize.js";
import { upsertChart, moveChartPosition as moveChartInRegistry, deleteChart } from "../control-plane/chart-registry.js";

// apply.chart_create — content-level upsert of a declarative chart spec. validateChartSpec
// (inside upsertChart) throws on a malformed spec; catch it into { ok:false } so a bad spec
// is a clean failure, not an uncaught throw (charts are non-truth → no rollback side effect).
// payload.provenance (accept-stage 防伪对照 verdict) flows through to the registry, which
// sanitizes it — absent/invalid provenance is simply omitted from the stored entry.
export async function createChartDefinition({ payload }) {
  try {
    const chart = await upsertChart({ spec: payload?.spec, provenance: payload?.provenance });
    return { ok: true, chart };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// apply.chart_move — reposition an existing chart on the board. moveChartPosition throws on a
// missing/unknown chart id; surface that as { ok:false } to keep the handler contract.
export async function moveChartPosition({ payload }) {
  try {
    const chart = await moveChartInRegistry(normalizeString(payload?.chartId), payload?.x, payload?.y);
    return { ok: true, chart };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// apply.chart_delete — remove a chart from the board. deleteChart is idempotent (unknown id →
// { removed:false }) and non-throwing in practice; keep the catch for the handler contract.
export async function deleteChartDefinition({ payload }) {
  try {
    return { ok: true, ...await deleteChart(payload?.chartId) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
