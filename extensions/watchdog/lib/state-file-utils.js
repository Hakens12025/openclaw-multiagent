// state-file-utils.js — File utilities, locking, and path safety
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { HOME } from "./state-paths.js";

// Lock maps — owned here, withLock operates on them directly
export const operationLocks = new Map();
const recentOperationGuards = new Map(); // key → timeout handle
const CROSS_PROCESS_LOCK_ROOT = join(tmpdir(), "openclaw-state-locks");

export async function atomicWriteFile(filePath, data) {
  const tmp = filePath + `.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}

function buildCrossProcessLockPath(key) {
  return join(
    CROSS_PROCESS_LOCK_ROOT,
    createHash("sha256").update(key).digest("hex"),
  );
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCrossProcessLockOwner(lockPath) {
  try {
    const raw = await readFile(join(lockPath, "owner.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function maybeClearStaleCrossProcessLock(lockPath, key, timeoutMs) {
  const owner = await readCrossProcessLockOwner(lockPath);
  if (!owner || owner.key !== key) {
    return false;
  }

  const ownerPid = Number(owner.pid) || 0;
  const ownerTs = Number(owner.ts) || 0;
  const stale = !isProcessAlive(ownerPid)
    || (ownerTs > 0 && (Date.now() - ownerTs) > timeoutMs);
  if (!stale) {
    return false;
  }

  await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function acquireCrossProcessLock(key, { timeoutMs = 30000, pollMs = 25 } = {}) {
  const lockPath = buildCrossProcessLockPath(key);
  const deadline = Date.now() + timeoutMs;
  await mkdir(CROSS_PROCESS_LOCK_ROOT, { recursive: true });

  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({
        key,
        pid: process.pid,
        ts: Date.now(),
      }, null, 2), "utf8");
      return async () => {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const cleared = await maybeClearStaleCrossProcessLock(lockPath, key, timeoutMs);
      if (!cleared) {
        await sleep(pollMs);
      }
    }
  }

  throw new Error(`withLock("${key}") timed out after ${timeoutMs}ms`);
}

export async function withLock(key, fn, { timeoutMs = 30000 } = {}) {
  const normalizedKey = typeof key === "string" && key.trim()
    ? key.trim()
    : String(key || "");
  if (!normalizedKey || typeof fn !== "function") {
    return fn?.();
  }

  const previous = operationLocks.get(normalizedKey) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  operationLocks.set(normalizedKey, current);

  // Timeout guard: if previous lock holder hangs, don't block forever
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    const h = setTimeout(() => {
      timedOut = true;
      reject(new Error(`withLock("${normalizedKey}") timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    h?.unref?.();
  });

  try {
    await Promise.race([previous, timeoutPromise]);
  } catch (e) {
    if (timedOut) {
      console.error(`[withLock] ${e.message}`);
      // Force-release stale lock so subsequent callers aren't blocked
      if (operationLocks.get(normalizedKey) === current) {
        operationLocks.delete(normalizedKey);
      }
      releaseCurrent?.();
      throw e;
    }
  }

  const releaseCrossProcessLock = await acquireCrossProcessLock(normalizedKey, { timeoutMs });
  try {
    return await fn();
  } finally {
    await releaseCrossProcessLock?.();
    if (operationLocks.get(normalizedKey) === current) {
      operationLocks.delete(normalizedKey);
    }
    releaseCurrent?.();
  }
}

export function rememberRecentOperation(key, ttlMs = 60000) {
  if (!key || recentOperationGuards.has(key)) {
    return false;
  }

  const handle = setTimeout(() => {
    recentOperationGuards.delete(key);
  }, ttlMs);
  handle?.unref?.();
  recentOperationGuards.set(key, handle);
  return true;
}

export function clearRecentOperationGuards() {
  for (const [, handle] of recentOperationGuards.entries()) {
    clearTimeout(handle);
  }
  recentOperationGuards.clear();
}

export function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isPathWithin(filePath, allowedDir) {
  const resolved = resolve(String(filePath).replace(/^~/, HOME));
  const allowed = resolve(allowedDir);
  return resolved.startsWith(allowed + "/") || resolved === allowed;
}
