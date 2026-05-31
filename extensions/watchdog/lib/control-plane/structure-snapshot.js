// structure-snapshot.js — ⑤ Operator control plane: the rollback foundation.
// Captures + restores + verifies the 4 structural truths (graph / loop registry /
// agent bindings = full config / automation specs) as a content-addressed snapshot.
// Reuses the existing atomic writers verbatim — builds no new config/graph/automation writer.
//
// "Structure snapshot code" = SNAP-<capturedAt>-<shortHash>, self-describing + the rollback handle.
// Also provides projectStructureAfter() — the reverse use: project the post-apply structure
// WITHOUT touching live state, so the UI can preview "what the system becomes" before approving.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadGraph } from "../agent/agent-graph.js";
import { saveGraph } from "../agent/agent-graph-mutations.js";
import { loadGraphLoopRegistry, saveGraphLoopRegistry, composeLoopSpecFromAgents } from "../loop/graph-loop-registry.js";
import { loadConfig, saveConfig } from "../agent/agent-admin-store.js";
import { listAutomationSpecs, writeAutomationStore } from "../automation/automation-registry.js";
import { atomicWriteFile, withLock } from "../state.js";
import { CONTROL_PLANE_PATHS } from "./control-plane-paths.js";

const FILE = CONTROL_PLANE_PATHS.structureSnapshotsFile;
const LOCK = "control-plane:structure-snapshot";
const MAX_SNAPSHOTS = 20;

function norm(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Deterministic serialization for hashing: recursively sort object keys (arrays keep order).
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function hashTruths(truths) {
  return createHash("sha256").update(JSON.stringify(canonicalize(truths))).digest("hex");
}

async function readTruths() {
  const [graph, loopRegistry, config, automations] = await Promise.all([
    loadGraph(),
    loadGraphLoopRegistry(),
    loadConfig(),
    listAutomationSpecs(),
  ]);
  return { graph, loopRegistry, config, automations };
}

async function readRegistry() {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8"));
    return { snapshots: Array.isArray(parsed?.snapshots) ? parsed.snapshots : [] };
  } catch {
    return { snapshots: [] };
  }
}

// Public summary (no full truths → never leaks config/secrets into listings).
function summarize(record) {
  return {
    id: record.id,
    label: record.label || null,
    contentHash: record.contentHash,
    capturedAt: record.capturedAt,
    reason: record.reason || null,
    sourceDraftId: record.sourceDraftId || null,
  };
}

export async function captureStructureSnapshot({ label = null, reason = null, sourceDraftId = null } = {}) {
  return withLock(LOCK, async () => {
    const truths = await readTruths();
    const contentHash = hashTruths(truths);
    const capturedAt = Date.now();
    const id = `SNAP-${capturedAt}-${contentHash.slice(0, 8)}`;
    const record = {
      id,
      label: norm(label),
      contentHash,
      capturedAt,
      reason: norm(reason),
      sourceDraftId: norm(sourceDraftId),
      truths,
    };
    const { snapshots } = await readRegistry();
    const next = [record, ...snapshots].slice(0, MAX_SNAPSHOTS);
    await atomicWriteFile(FILE, JSON.stringify({ updatedAt: capturedAt, snapshots: next }, null, 2));
    return summarize(record);
  });
}

export async function listStructureSnapshots() {
  const { snapshots } = await readRegistry();
  return snapshots.map(summarize);
}

export async function getStructureSnapshot(snapshotId) {
  const id = norm(snapshotId);
  const { snapshots } = await readRegistry();
  return snapshots.find((s) => s.id === id) || null;
}

// Read-only integrity / pre-flight drift check: does live structure still match the snapshot?
export async function verifyAgainstSnapshot(snapshotId) {
  const snap = await getStructureSnapshot(snapshotId);
  if (!snap) return { ok: false, error: "snapshot not found", id: norm(snapshotId) };
  const liveHash = hashTruths(await readTruths());
  return {
    ok: true,
    id: snap.id,
    liveHash,
    snapshotHash: snap.contentHash,
    drifted: liveHash !== snap.contentHash,
  };
}

// Rollback = restore-from-saved-state (NOT inverse-op undo — structural changes have no
// general inverse). Re-writes the 4 truths via existing writers in a fixed, documented order.
export async function restoreStructureSnapshot(snapshotId, { expectHash = null } = {}) {
  return withLock(LOCK, async () => {
    const snap = await getStructureSnapshot(snapshotId);
    if (!snap) return { ok: false, error: "snapshot not found", id: norm(snapshotId) };

    // TOCTOU guard: if the caller showed the human a specific live hash and it changed since, abort.
    if (expectHash) {
      const liveHash = hashTruths(await readTruths());
      if (liveHash !== expectHash) {
        return { ok: false, error: "drift: live state changed since preview", id: snap.id, liveHash, expectHash };
      }
    }

    // Fixed order: bindings(saveConfig) → graph → loops → automations. Each inner writer is
    // itself atomic+locked, so no file is ever half-written.
    await saveConfig(snap.truths.config);
    await saveGraph(snap.truths.graph);
    await saveGraphLoopRegistry(snap.truths.loopRegistry);
    await writeAutomationStore(snap.truths.automations);

    // No silent partial success: verify the live hash matches the snapshot after writing all 4.
    const liveHash = hashTruths(await readTruths());
    const drifted = liveHash !== snap.contentHash;
    return {
      ok: !drifted,
      id: snap.id,
      restored: { graph: true, loops: true, bindings: true, automations: true },
      drift: drifted ? { liveHash, snapshotHash: snap.contentHash } : null,
    };
  });
}

// ── Reverse use of the snapshot mechanism: project the post-apply structure WITHOUT
// mutating live state, so the UI can preview "what the system becomes". Pure computation.
// v1 covers structural surfaces (graph loop/edges); others fall back to no structural diff.
function diffEdges(before, after) {
  const key = (e) => `${e.from}→${e.to}`;
  const beforeSet = new Set((before || []).map(key));
  const afterSet = new Set((after || []).map(key));
  return {
    added: (after || []).filter((e) => !beforeSet.has(key(e))).map(key),
    removed: (before || []).filter((e) => !afterSet.has(key(e))).map(key),
  };
}

export async function projectStructureAfter({ surfaceId, payload } = {}) {
  const current = await readTruths();
  const projected = JSON.parse(JSON.stringify(current)); // deep clone, never touch live
  let structural = false;
  const sid = norm(surfaceId);
  const p = payload && typeof payload === "object" ? payload : {};

  if (sid === "graph.loop.compose") {
    structural = true;
    const agents = Array.isArray(p.agents) ? p.agents.filter(Boolean)
      : (typeof p.agentsText === "string" ? p.agentsText.split("\n").map((s) => s.trim()).filter(Boolean) : []);
    if (agents.length >= 2) {
      // project the closed-cycle edges + the LoopSpec (reuse the same pure spec builder as real apply)
      const edges = projected.graph.edges || (projected.graph.edges = []);
      for (let i = 0; i < agents.length; i += 1) {
        const from = agents[i], to = agents[(i + 1) % agents.length];
        if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to });
      }
      const spec = composeLoopSpecFromAgents(agents, {
        loopId: p.loopId, label: p.label, entryAgentId: p.entryAgentId,
        continueSignal: p.continueSignal, concludeSignal: p.concludeSignal,
        maxRounds: p.maxRounds, maxExperiments: p.maxExperiments,
      });
      const loops = projected.loopRegistry.loops || (projected.loopRegistry.loops = []);
      const idx = loops.findIndex((l) => l.id === spec.id);
      if (idx >= 0) loops[idx] = spec; else loops.push(spec);
    }
  } else if (sid === "graph.edge.add" && norm(p.from) && norm(p.to)) {
    structural = true;
    const edges = projected.graph.edges || (projected.graph.edges = []);
    if (!edges.some((e) => e.from === p.from && e.to === p.to)) edges.push({ from: p.from, to: p.to });
  } else if (sid === "graph.edge.delete" && norm(p.from) && norm(p.to)) {
    structural = true;
    projected.graph.edges = (projected.graph.edges || []).filter((e) => !(e.from === p.from && e.to === p.to));
  }

  return {
    surfaceId: sid,
    structural,
    edgeDiff: structural ? diffEdges(current.graph.edges, projected.graph.edges) : null,
    current: { edges: current.graph.edges, loops: current.loopRegistry.loops },
    projected: { edges: projected.graph.edges, loops: projected.loopRegistry.loops },
    note: structural ? null : "此 surface 暂无结构投影,仅 payload diff(v1 覆盖 graph 边/loop)。",
  };
}
