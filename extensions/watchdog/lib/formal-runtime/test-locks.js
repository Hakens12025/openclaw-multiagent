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
        // 锁等待超时必须带 owner 身份:2026-08-16 死锁案在 600s 静默超时里躲了一整天,
        // 报错里有 owner pid 十秒就能定位。
        let ownerNote = "";
        try {
          const raw = await readFile(join(lockDir, LOCK_OWNER_FILENAME), "utf8");
          const owner = JSON.parse(raw);
          ownerNote = ` (held by pid ${owner?.pid} since ${new Date(owner?.createdAt || 0).toISOString()})`;
        } catch {}
        throw new Error(`test lock "${normalizedLockName}" timed out after ${timeoutMs}ms${ownerNote}`);
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

const GLOBAL_TEST_ENVIRONMENT_LOCK_NAME = "global-test-environment";

async function currentGlobalTestEnvironmentLockOwnerPid() {
  try {
    const raw = await readFile(
      join(TEST_LOCK_ROOT, GLOBAL_TEST_ENVIRONMENT_LOCK_NAME, LOCK_OWNER_FILENAME),
      "utf8",
    );
    const pid = Number(JSON.parse(raw)?.pid);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// 跨进程可重入(2026-08-16 死锁修缮):网关 formal run 在整个 run 期间持有本锁,
// 而它 spawn 的 npm test 单测扫里有 19 个文件会再抢同一把锁——owner 存活不收割,
// 等待上限 60 分钟 > unit suite 600s 预算 ⇒ unit.npm-test 必超时。持锁进程把
// 自己的 pid 经 OPENCLAW_TEST_ENV_LOCK_OWNER_PID 传给子进程;子进程核对凭据与
// 磁盘 owner 一致时直接透传执行——run 级锁已提供这些单测要的全局串行性
// (npm 扫 --test-concurrency=1 单飞),子进程再抢只会自死锁。凭据不符/锁不在
// (非 formal-run 派生的普通手跑)→ 照常抢锁。
export async function runGlobalTestEnvironmentSerial(callback, options = {}) {
  const inheritedOwnerPid = Number(process.env.OPENCLAW_TEST_ENV_LOCK_OWNER_PID || "");
  if (Number.isFinite(inheritedOwnerPid) && inheritedOwnerPid > 0) {
    const ownerPid = await currentGlobalTestEnvironmentLockOwnerPid();
    if (ownerPid === inheritedOwnerPid) {
      return callback();
    }
  }
  return withTestLock(GLOBAL_TEST_ENVIRONMENT_LOCK_NAME, callback, {
    timeoutMs: GLOBAL_TEST_ENVIRONMENT_LOCK_TIMEOUT_MS,
    pollMs: 100,
    ...options,
  });
}
