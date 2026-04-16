// lib/harness-run-store.js — Persist and retrieve HarnessRun records
//
// Storage: ~/.openclaw/research-lab/harness-runs/{runId}.json
// Atomic writes (tmp + rename) to prevent corruption.
// All records use the rich normalizeHarnessRun format.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizeHarnessRun } from "./harness-run.js";

const HARNESS_RUNS_DIR = join(homedir(), ".openclaw", "research-lab", "harness-runs");

function runPath(runId) {
  return join(HARNESS_RUNS_DIR, `${runId}.json`);
}

async function ensureDir() {
  await mkdir(HARNESS_RUNS_DIR, { recursive: true });
}

async function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, filePath);
}

async function readPersistedHarnessRun(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return normalizeHarnessRun(raw);
  } catch {
    return null;
  }
}

export async function recordHarnessRun(params) {
  await ensureDir();
  const run = normalizeHarnessRun(params);
  if (!run?.id) {
    throw new Error("invalid harness run");
  }
  await atomicWrite(runPath(run.id), JSON.stringify(run, null, 2));
  return run;
}

export async function getHarnessRun(runId) {
  if (!runId || typeof runId !== "string") return null;
  try {
    return await readPersistedHarnessRun(runPath(runId));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function listHarnessRunsByContract(contractId) {
  if (!contractId || typeof contractId !== "string") return [];
  await ensureDir();
  const files = await readdir(HARNESS_RUNS_DIR);
  const results = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const run = await readPersistedHarnessRun(join(HARNESS_RUNS_DIR, file));
    if (run?.contractId === contractId) results.push(run);
  }
  results.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return results;
}

export async function listRecentHarnessRuns(limit = 10) {
  await ensureDir();
  const files = await readdir(HARNESS_RUNS_DIR);
  const runs = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const run = await readPersistedHarnessRun(join(HARNESS_RUNS_DIR, file));
    if (run) runs.push(run);
  }
  runs.sort((a, b) => (
    (b.finalizedAt || b.startedAt || 0) - (a.finalizedAt || a.startedAt || 0)
  ));
  return runs.slice(0, Math.max(1, limit));
}
