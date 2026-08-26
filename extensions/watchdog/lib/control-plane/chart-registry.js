// chart-registry.js — the NON-truth chart store. Sibling of knowledge-bases.json,
// mirrors automation-registry.js (read/write/list/get/upsert/move/delete + normalize,
// atomicWriteFile + withLock). A chart entry is a declarative SVG spec plus a board
// position; it is NOT a structural truth and is deliberately NOT wired into
// structure-snapshot.js / readTruths. viz-master owns the "chart" surface family.

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWriteFile, withLock } from "../state.js";
import { normalizeString } from "../core/normalize.js";
import { validateChartSpec } from "../viz/chart-spec-schema.js";
import { CONTROL_PLANE_PATHS } from "./control-plane-paths.js";

const FILE = CONTROL_PLANE_PATHS.chartsRegistryFile;
const LOCK = "store:charts";

function normalizePosition(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const x = typeof source.x === "number" && Number.isFinite(source.x) ? source.x : 0;
  const y = typeof source.y === "number" && Number.isFinite(source.y) ? source.y : 0;
  return { x, y };
}

// Provenance of the accept-stage 防伪对照 verdict. All three fields must be valid —
// controlsPassed int>=0, controlsTotal int>0, verifiedAt finite epoch ms — or the field is
// omitted entirely. Rule: provenance reflects the LAST verified write — because the entry is
// rebuilt from its source on every upsert, an upsert WITHOUT provenance clears any stale
// provenance (honest: a verdict never outlives the write that earned it).
function normalizeProvenance(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const { controlsPassed, controlsTotal, verifiedAt } = source;
  if (!Number.isInteger(controlsPassed) || controlsPassed < 0) return null;
  if (!Number.isInteger(controlsTotal) || controlsTotal <= 0) return null;
  if (!Number.isFinite(verifiedAt)) return null;
  // client-asserted, no server attestation — reject internally-inconsistent verdicts
  // (passed > total) and verifiedAt timestamps from the future (small clock-skew allowance).
  if (controlsPassed > controlsTotal) return null;
  if (verifiedAt > Date.now() + 5 * 60 * 1000) return null;
  return { controlsPassed, controlsTotal, verifiedAt };
}

// Pure: throws on an invalid chart spec (via validateChartSpec); returns a normalized
// stored entry. The validated spec is the single source of id/label.
export function normalizeChartSpec(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const spec = validateChartSpec(source.spec && typeof source.spec === "object" ? source.spec : source);
  const provenance = normalizeProvenance(source.provenance);

  return {
    id: spec.id,
    label: normalizeString(source.label) ?? spec.label,
    spec,
    position: normalizePosition(source.position),
    renderMode: "declarative",
    ...(provenance ? { provenance } : {}),
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}

async function readChartStore() {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

function sortCharts(charts) {
  return [...(Array.isArray(charts) ? charts : [])]
    .sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
}

export async function loadCharts() {
  const parsed = await readChartStore();
  const entries = Array.isArray(parsed?.charts) ? parsed.charts : [];
  const charts = sortCharts(entries
    .map((entry) => {
      try {
        return normalizeChartSpec(entry);
      } catch {
        return null;
      }
    })
    .filter(Boolean));
  return { charts };
}

export async function saveCharts(charts) {
  const normalized = sortCharts(
    (Array.isArray(charts) ? charts : [])
      .map((entry) => {
        try {
          return normalizeChartSpec(entry);
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );
  const now = Date.now();
  await mkdir(dirname(FILE), { recursive: true });
  await atomicWriteFile(FILE, JSON.stringify({
    updatedAt: now,
    charts: normalized,
  }, null, 2));
  return normalized;
}

export async function listCharts() {
  const { charts } = await loadCharts();
  return charts;
}

export async function upsertChart(spec) {
  const normalized = normalizeChartSpec(spec);

  return withLock(LOCK, async () => {
    const now = Date.now();
    const charts = await listCharts();
    const existing = charts.find((entry) => entry.id === normalized.id) || null;
    const nextCharts = charts
      .filter((entry) => entry.id !== normalized.id)
      .concat({
        ...normalized,
        position: existing ? existing.position : normalized.position,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await saveCharts(nextCharts);
    return saved.find((entry) => entry.id === normalized.id) || null;
  });
}

export async function moveChartPosition(id, x, y) {
  const normalizedId = normalizeString(id);
  if (!normalizedId) {
    throw new Error("missing chart id");
  }

  return withLock(LOCK, async () => {
    const now = Date.now();
    const charts = await listCharts();
    const existing = charts.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown chart id: ${normalizedId}`);
    }

    const nextCharts = charts
      .filter((entry) => entry.id !== normalizedId)
      .concat({
        ...existing,
        position: normalizePosition({ x, y }),
        updatedAt: now,
      });
    const saved = await saveCharts(nextCharts);
    return saved.find((entry) => entry.id === normalizedId) || null;
  });
}

// Idempotent removal: unknown id is a no-op success ({ removed:false }), not a throw —
// charts are non-truth and delete has no rollback side effect (route guards confirmation).
export async function deleteChart(id) {
  const nid = normalizeString(id);
  return withLock(LOCK, async () => {
    const charts = await listCharts();
    const exists = charts.find((entry) => entry.id === nid);
    if (!exists) {
      return { ok: true, removed: false };
    }
    await saveCharts(charts.filter((entry) => entry.id !== nid));
    return { ok: true, removed: true, id: nid };
  });
}
