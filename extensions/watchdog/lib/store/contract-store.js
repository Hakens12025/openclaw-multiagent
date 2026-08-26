import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { withLock } from "../state.js";
import {
  RUN_CONTRACTS_DIRNAME,
  resolveContractHome,
  resolveThreadsRoot,
  runDirFor,
} from "../archive/thread-tree-store.js";
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

// 正本判定:共享正本 = 树内 threads/{t}/runs/{r}/contracts/*.json,别无他店。
function isTreeContractPath(normalizedPath) {
  const threadsRoot = resolve(resolveThreadsRoot());
  if (!normalizedPath.startsWith(`${threadsRoot}${sep}`)) return false;
  const segments = relative(threadsRoot, normalizedPath).split(sep);
  // {threadId}/runs/{runId}/contracts/{id}.json
  return segments.length === 5
    && segments[1] === "runs"
    && segments[3] === RUN_CONTRACTS_DIRNAME
    && segments[4].endsWith(".json");
}

function isSharedContractPath(contractPath) {
  const normalizedPath = normalizeContractPath(contractPath);
  if (!normalizedPath || !normalizedPath.endsWith(".json")) return false;
  return isTreeContractPath(normalizedPath);
}

// 全系统 id→正本路径唯一解析底座(同步:索引常驻内存)。索引命中 → 树内正本;
// 未命中 → null(调用方必须自带 null 处理,不存在平铺回退)。
// id 保留原串大小写(树索引/文件名都用原串;normalizeContractIdentity 会 lowercase,
// 只用于内存索引键,不得进路径)。
export function resolveSharedContractPathById(contractId) {
  const rawId = typeof contractId === "string" && contractId.trim() ? contractId.trim() : null;
  if (!rawId) return null;
  const home = resolveContractHome(rawId);
  if (!home) return null;
  // 文件名必须用登记原串 home.id —— 查询串可能是会话键派生的小写形态,
  // APFS 大小写不敏感会掩盖、大小写敏感 FS 会 ENOENT。
  return join(runDirFor(home), RUN_CONTRACTS_DIRNAME, `${home.id || rawId}.json`);
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
  // id→path 索引只认共享合约正本(树内 threads/{t}/runs/{r}/contracts/*.json)。inbox / 直接信封队列侧落盘的是
  // 窄投影(见 TASK_FACING_INBOX_ALLOW_KEYS,剥掉 output / dispatchDepth / originChain 等路由字段),
  // 一旦占住索引,后续按 id 读真值就会拿到这份缺字段的副本 —— 即 v133 "contract.output 镜像" 的复发通道,
  // 同一通道也会让 dispatch 深度守卫读到 depth=0。
  // 路径缓存保持全量(按 path 读的调用方不受影响);索引未命中时由下方共享路径兜底解析。
  if (nextId && isSharedContractPath(normalizedPath)) {
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

async function listDirectoryNames(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

// 树店全量扫描:threads/{t}/runs/{r}/contracts/*.json 的绝对路径清单。
// hydrate 与 boot 孤儿恢复(crash-recovery)共用。
export async function listTreeContractPaths() {
  const root = resolveThreadsRoot();
  const contractPaths = [];
  for (const threadId of await listDirectoryNames(root)) {
    for (const runId of await listDirectoryNames(join(root, threadId, "runs"))) {
      const contractsDir = join(root, threadId, "runs", runId, RUN_CONTRACTS_DIRNAME);
      let files = [];
      try {
        files = await readdir(contractsDir);
      } catch {
        continue; // 无 contracts/ 的纯事件 run 是合法态
      }
      for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
        contractPaths.push(join(contractsDir, file));
      }
    }
  }
  return contractPaths;
}

async function hydrateSharedContractStore() {
  if (sharedContractsLoaded) return;

  await withLock("contract_store:hydrate_shared", async () => {
    if (sharedContractsLoaded) return;

    // 树店正本(唯一常驻扫描面)
    try {
      for (const contractPath of await listTreeContractPaths()) {
        await loadContractSnapshotFromDisk(contractPath);
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

  // 路径缓存未命中 → 正本解析底座(树内 home;用原串 id 查树索引)。miss → 缺席。
  const sharedPath = resolveSharedContractPathById(contractId);
  if (!sharedPath) return null;
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
