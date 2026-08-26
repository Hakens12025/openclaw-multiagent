// agent-guidance-drift-state.js — durable drift evidence store.
//
// Tracks when the configured-agent fleet was last scanned for managed-guidance
// drift, and how long the fleet has been drift-free. `emptySince` is the
// load-bearing timestamp the legacy-retirement gate reads.
//
// Semantics:
//   - driftCount === 0 and emptySince == null  → set emptySince to scan ts.
//   - driftCount > 0                           → reset emptySince to null.
//   - emptySince must survive process restarts (file-backed).

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { atomicWriteFile, readJsonFile, withLock } from "../state/state-file-utils.js";

const STORE_FILE = CONTROL_PLANE_PATHS.guidanceDriftStateFile;
const LOCK_KEY = "guidance-drift-state";

const DEFAULT_STATE = Object.freeze({
  lastScanAt: null,
  label: null,
  driftCount: 0,
  driftedFiles: [],
  emptySince: null,
  scanSource: null,
});

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return { ...DEFAULT_STATE };
  return {
    lastScanAt: Number.isFinite(entry.lastScanAt) ? Number(entry.lastScanAt) : null,
    label: typeof entry.label === "string" ? entry.label : null,
    driftCount: Number.isFinite(entry.driftCount) ? Number(entry.driftCount) : 0,
    driftedFiles: Array.isArray(entry.driftedFiles)
      ? entry.driftedFiles.map((item) => String(item || "")).filter(Boolean)
      : [],
    emptySince: Number.isFinite(entry.emptySince) ? Number(entry.emptySince) : null,
    scanSource: typeof entry.scanSource === "string" ? entry.scanSource : null,
  };
}

async function readState() {
  const raw = await readJsonFile(STORE_FILE);
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STATE };
  }
  return normalizeEntry(raw);
}

async function writeState(next) {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  await atomicWriteFile(STORE_FILE, JSON.stringify(normalizeEntry(next), null, 2));
}

export async function getGuidanceDriftState() {
  return readState();
}

export async function recordGuidanceDriftScan({
  label = null,
  driftCount = 0,
  driftedFiles = [],
  scanSource = null,
  now = Date.now(),
} = {}) {
  return withLock(LOCK_KEY, async () => {
    const prev = await readState();
    const normalizedCount = Number.isFinite(driftCount) ? Number(driftCount) : 0;
    const nextEmptySince = normalizedCount === 0
      ? (prev.emptySince || now)
      : null;
    const next = {
      lastScanAt: now,
      label: typeof label === "string" ? label : null,
      driftCount: normalizedCount,
      driftedFiles: Array.isArray(driftedFiles)
        ? driftedFiles.map((item) => String(item || "")).filter(Boolean)
        : [],
      emptySince: nextEmptySince,
      scanSource: typeof scanSource === "string" ? scanSource : null,
    };
    await writeState(next);
    return next;
  });
}

export async function resetGuidanceDriftState() {
  return withLock(LOCK_KEY, async () => {
    await writeState({ ...DEFAULT_STATE });
    return { ...DEFAULT_STATE };
  });
}

export const GUIDANCE_DRIFT_STATE_FILE = STORE_FILE;
