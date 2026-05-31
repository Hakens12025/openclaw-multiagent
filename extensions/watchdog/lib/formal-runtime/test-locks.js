import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_LOCK_ROOT = join(tmpdir(), "openclaw-test-locks");
const GLOBAL_TEST_ENVIRONMENT_LOCK_TIMEOUT_MS = 60 * 60 * 1000;
const LOCK_OWNER_FILENAME = "owner.json";
const LEGACY_STALE_LOCK_AGE_MS = 30 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireDirectoryLock(lockName, {
  timeoutMs = 30000,
  pollMs = 25,
  legacyStaleMs = LEGACY_STALE_LOCK_AGE_MS,
} = {}) {
  const normalizedLockName = String(lockName || "").trim();
  if (!normalizedLockName) {
    throw new Error("lock name is required");
  }

  await mkdir(TEST_LOCK_ROOT, { recursive: true });
  const lockDir = join(TEST_LOCK_ROOT, normalizedLockName);
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, LOCK_OWNER_FILENAME), JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }, null, 2));
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await reapStaleDirectoryLock(lockDir, { legacyStaleMs })) {
        continue;
      }
      if ((Date.now() - startedAt) >= timeoutMs) {
        throw new Error(`test lock "${normalizedLockName}" timed out after ${timeoutMs}ms`);
      }
      await sleep(pollMs);
    }
  }
}

async function readLockOwner(lockDir) {
  try {
    const raw = await readFile(join(lockDir, LOCK_OWNER_FILENAME), "utf8");
    const owner = JSON.parse(raw);
    const pid = Number(owner?.pid);
    return Number.isInteger(pid) && pid > 0
      ? owner
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function reapStaleDirectoryLock(lockDir, {
  legacyStaleMs = LEGACY_STALE_LOCK_AGE_MS,
} = {}) {
  const owner = await readLockOwner(lockDir);
  if (owner?.pid && !isProcessAlive(owner.pid)) {
    await rm(lockDir, { recursive: true, force: true });
    return true;
  }

  if (owner) {
    return false;
  }

  try {
    const info = await stat(lockDir);
    const ageMs = Math.max(
      Date.now() - (Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0),
      Date.now() - (Number.isFinite(info.birthtimeMs) ? info.birthtimeMs : 0),
    );
    if (ageMs >= legacyStaleMs) {
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {}

  return false;
}

export async function withTestLock(lockName, callback, options = {}) {
  const release = await acquireDirectoryLock(lockName, options);
  try {
    return await callback();
  } finally {
    await release();
  }
}

export async function runContractorInboxTestSerial(callback, options = {}) {
  return withTestLock("contractor-inbox", callback, options);
}

export async function runGlobalTestEnvironmentSerial(callback, options = {}) {
  return withTestLock("global-test-environment", callback, {
    timeoutMs: GLOBAL_TEST_ENVIRONMENT_LOCK_TIMEOUT_MS,
    pollMs: 100,
    ...options,
  });
}
