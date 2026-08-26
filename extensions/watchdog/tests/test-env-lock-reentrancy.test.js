// Tests: global-test-environment 锁的跨进程可重入(2026-08-16 死锁修缮锁)。
//   formal run 持锁期间 spawn 的 npm test 子进程凭 OPENCLAW_TEST_ENV_LOCK_OWNER_PID
//   凭据透传执行;凭据不符则照常抢锁。回归即 unit.npm-test 必 600s 超时复发。
//
// Run: node --test tests/test-env-lock-reentrancy.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const LOCK_DIR = join(tmpdir(), "openclaw-test-locks", "global-test-environment");

test("持锁父进程的凭据在场 → 子进程语义透传执行,不抢锁不等待", async (t) => {
  if (existsSync(LOCK_DIR)) {
    t.skip("global-test-environment 锁正被真实 run 持有,跳过以免干扰");
    return;
  }
  const savedEnv = process.env.OPENCLAW_TEST_ENV_LOCK_OWNER_PID;
  try {
    // 模拟父 formal run 持锁:锁目录 + owner.json(pid=本进程,恒存活)
    await mkdir(LOCK_DIR, { recursive: true });
    await writeFile(join(LOCK_DIR, "owner.json"), JSON.stringify({
      pid: process.pid, createdAt: Date.now(), updatedAt: Date.now(),
    }), "utf8");
    process.env.OPENCLAW_TEST_ENV_LOCK_OWNER_PID = String(process.pid);

    const startedAt = Date.now();
    let ran = false;
    await runGlobalTestEnvironmentSerial(async () => { ran = true; }, { timeoutMs: 2000 });
    assert.equal(ran, true, "凭据匹配必须透传执行 callback");
    assert.ok(Date.now() - startedAt < 1500, "透传路径不得进入锁等待轮询");
    assert.equal(existsSync(LOCK_DIR), true, "透传不得释放父进程的锁");

    // 凭据不符(owner 是别的 pid) → 照常抢锁 → 锁被占且 owner 存活 → 短超时必抛
    await writeFile(join(LOCK_DIR, "owner.json"), JSON.stringify({
      pid: process.pid, createdAt: Date.now(), updatedAt: Date.now(),
    }), "utf8");
    process.env.OPENCLAW_TEST_ENV_LOCK_OWNER_PID = String(process.pid + 999999);
    await assert.rejects(
      () => runGlobalTestEnvironmentSerial(async () => {}, { timeoutMs: 400, pollMs: 50 }),
      /timed out/,
      "凭据不符必须走正常抢锁路径(此处锁被占应超时)",
    );
  } finally {
    if (savedEnv === undefined) delete process.env.OPENCLAW_TEST_ENV_LOCK_OWNER_PID;
    else process.env.OPENCLAW_TEST_ENV_LOCK_OWNER_PID = savedEnv;
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
});
