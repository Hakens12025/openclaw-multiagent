import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  CONTRACTS_DIR,
  withLock,
} from "../state.js";
import { normalizeContractIdentity } from "../core/normalize.js";

const contractSnapshotsByPath = new Map();
const contractPathsById = new Map();
let sharedContractsLoaded = false;

function normalizeContractPath(contractPath) {
  return typeof contractPath === "string" && contractPath.trim()
    ? resolve(contractPath.trim())
    : null;
}

function normalizeContractId(contractId) {
  return normalizeContractIdentity(contractId);
}

function cloneSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return JSON.parse(JSON.stringify(snapshot));
}

function isSharedContractPath(contractPath) {
  const normalizedPath = normalizeContractPath(contractPath);
  const normalizedContractsDir = resolve(CONTRACTS_DIR);
  return Boolean(
    normalizedPath
    && (normalizedPath === normalizedContractsDir || normalizedPath.startsWith(`${normalizedContractsDir}/`))
    && normalizedPath.endsWith(".json")
  );
}

function rememberContractSnapshot(contractPath, contract) {
  const normalizedPath = normalizeContractPath(contractPath);
  if (!normalizedPath || !contract || typeof contract !== "object") {
    return null;
  }

  const previous = contractSnapshotsByPath.get(normalizedPath) || null;
  const next = cloneSnapshot(contract);
  const nextId = normalizeContractId(next.id);
  const previousId = normalizeContractId(previous?.id);

  if (previousId && previousId !== nextId && contractPathsById.get(previousId) === normalizedPath) {
    contractPathsById.delete(previousId);
  }

  contractSnapshotsByPath.set(normalizedPath, next);
  if (nextId) {
    contractPathsById.set(nextId, normalizedPath);
  }

  return cloneSnapshot(next);
}

function forgetContractSnapshot(contractPath) {
  const normalizedPath = normalizeContractPath(contractPath);
  if (!normalizedPath) return false;

  const previous = contractSnapshotsByPath.get(normalizedPath) || null;
  contractSnapshotsByPath.delete(normalizedPath);

  const previousId = normalizeContractId(previous?.id);
  if (previousId && contractPathsById.get(previousId) === normalizedPath) {
    contractPathsById.delete(previousId);
  }

  return Boolean(previous);
}

async function loadContractSnapshotFromDisk(contractPath) {
  const normalizedPath = normalizeContractPath(contractPath);
  if (!normalizedPath) return null;

  try {
    const raw = await readFile(normalizedPath, "utf8");
    return rememberContractSnapshot(normalizedPath, JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      forgetContractSnapshot(normalizedPath);
      return null;
    }
    throw error;
  }
}

async function hydrateSharedContractStore() {
  if (sharedContractsLoaded) return;

  await withLock("contract_store:hydrate_shared", async () => {
    if (sharedContractsLoaded) return;

    try {
      const files = await readdir(CONTRACTS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        await loadContractSnapshotFromDisk(join(CONTRACTS_DIR, file));
      }
    } catch {}

    sharedContractsLoaded = true;
  });
}

export async function readContractSnapshotByPath(contractPath, {
  preferCache = true,
} = {}) {
  const normalizedPath = normalizeContractPath(contractPath);
  if (!normalizedPath) return null;

  if (preferCache) {
    const cached = contractSnapshotsByPath.get(normalizedPath) || null;
    if (cached) return cloneSnapshot(cached);
  }

  return loadContractSnapshotFromDisk(normalizedPath);
}

export async function readCachedContractSnapshotById(contractId, {
  contractPathHint = null,
  preferCache = true,
} = {}) {
  const normalizedId = normalizeContractId(contractId);
  if (!normalizedId) return null;

  const hintedPath = normalizeContractPath(contractPathHint);
  if (hintedPath) {
    const hintedSnapshot = await readContractSnapshotByPath(hintedPath, { preferCache });
    if (normalizeContractId(hintedSnapshot?.id) === normalizedId) {
      return hintedSnapshot;
    }
  }

  const knownPath = contractPathsById.get(normalizedId) || null;
  if (knownPath) {
    return readContractSnapshotByPath(knownPath, { preferCache });
  }

  const sharedPath = join(CONTRACTS_DIR, `${normalizedId}.json`);
  return readContractSnapshotByPath(sharedPath, { preferCache: false });
}

export async function listSharedContractEntries() {
  await hydrateSharedContractStore();

  const entries = [];
  for (const [contractPath, contract] of contractSnapshotsByPath.entries()) {
    if (!isSharedContractPath(contractPath)) continue;
    const refreshed = await readContractSnapshotByPath(contractPath, { preferCache: false });
    if (!refreshed) continue;
    entries.push({
      contract: refreshed,
      path: contractPath,
    });
  }

  entries.sort((left, right) =>
    (Number(right.contract?.createdAt) || 0) - (Number(left.contract?.createdAt) || 0));

  return entries;
}

export function cacheContractSnapshot(contractPath, contract) {
  return rememberContractSnapshot(contractPath, contract);
}

export function evictContractSnapshotByPath(contractPath) {
  return forgetContractSnapshot(contractPath);
}

export function moveContractSnapshotPath(fromPath, toPath) {
  const normalizedFrom = normalizeContractPath(fromPath);
  const normalizedTo = normalizeContractPath(toPath);
  if (!normalizedFrom || !normalizedTo) return false;
  if (normalizedFrom === normalizedTo) {
    return contractSnapshotsByPath.has(normalizedFrom);
  }

  const snapshot = contractSnapshotsByPath.get(normalizedFrom) || null;
  forgetContractSnapshot(normalizedFrom);
  if (!snapshot) return false;
  rememberContractSnapshot(normalizedTo, snapshot);
  return true;
}

export function clearContractStore() {
  const cleared = contractSnapshotsByPath.size;
  contractSnapshotsByPath.clear();
  contractPathsById.clear();
  sharedContractsLoaded = false;
  return cleared;
}

export function getContractCacheSize() {
  return contractSnapshotsByPath.size;
}
