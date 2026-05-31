import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const TEST_LOCK_ROOT = join(tmpdir(), "openclaw-test-locks");
const GLOBAL_LOCK_DIR = join(TEST_LOCK_ROOT, "global-test-environment");
const OWNER_FILE = join(GLOBAL_LOCK_DIR, "owner.json");

async function resetLockRoot() {
  await rm(TEST_LOCK_ROOT, { recursive: true, force: true });
}

test("runGlobalTestEnvironmentSerial reaps stale lock owned by dead process", async () => {
  await resetLockRoot();
  await mkdir(GLOBAL_LOCK_DIR, { recursive: true });
  await writeFile(OWNER_FILE, JSON.stringify({
    pid: 999999,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
  }, null, 2));

  let entered = false;
  await runGlobalTestEnvironmentSerial(async () => {
    entered = true;
  }, {
    timeoutMs: 200,
    pollMs: 10,
  });

  assert.equal(entered, true);
  await resetLockRoot();
});

test("runGlobalTestEnvironmentSerial reaps stale legacy lock without owner metadata", async () => {
  await resetLockRoot();
  await mkdir(GLOBAL_LOCK_DIR, { recursive: true });
  const staleAt = new Date(Date.now() - 60_000);
  await utimes(GLOBAL_LOCK_DIR, staleAt, staleAt);

  let entered = false;
  await runGlobalTestEnvironmentSerial(async () => {
    entered = true;
  }, {
    timeoutMs: 200,
    pollMs: 10,
  });

  assert.equal(entered, true);
  await resetLockRoot();
});
