import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_LOCK_ROOT = join(tmpdir(), "openclaw-test-locks");
const GLOBAL_TEST_ENVIRONMENT_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireDirectoryLock(lockName, {
  timeoutMs = 30000,
  pollMs = 25,
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
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if ((Date.now() - startedAt) >= timeoutMs) {
        throw new Error(`test lock "${normalizedLockName}" timed out after ${timeoutMs}ms`);
      }
      await sleep(pollMs);
    }
  }
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
