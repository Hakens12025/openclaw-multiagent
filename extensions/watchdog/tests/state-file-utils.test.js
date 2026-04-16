import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import {
  atomicWriteFile,
  readJsonFile,
  withLock,
  operationLocks,
  rememberRecentOperation,
  clearRecentOperationGuards,
  esc,
  isPathWithin,
} from "../lib/state-file-utils.js";

let tempDir;

test("setup: create temp directory", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oc-state-test-"));
});

// ── atomicWriteFile ─────────────────────────────────────────────────────────

test("atomicWriteFile: writes file that can be read back", async () => {
  const p = join(tempDir, "atomic-test.txt");
  await atomicWriteFile(p, "hello world");
  const content = await readFile(p, "utf8");
  assert.equal(content, "hello world");
});

test("atomicWriteFile: overwrites existing file", async () => {
  const p = join(tempDir, "atomic-overwrite.txt");
  await atomicWriteFile(p, "first");
  await atomicWriteFile(p, "second");
  const content = await readFile(p, "utf8");
  assert.equal(content, "second");
});

test("atomicWriteFile: no leftover tmp files", async () => {
  const p = join(tempDir, "atomic-clean.txt");
  await atomicWriteFile(p, "data");
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(tempDir);
  const tmpFiles = files.filter((f) => f.startsWith("atomic-clean.txt.tmp-"));
  assert.equal(tmpFiles.length, 0);
});

// ── readJsonFile ────────────────────────────────────────────────────────────

test("readJsonFile: reads valid JSON", async () => {
  const p = join(tempDir, "valid.json");
  await writeFile(p, JSON.stringify({ key: "value" }));
  const result = await readJsonFile(p);
  assert.deepEqual(result, { key: "value" });
});

test("readJsonFile: returns null for missing file", async () => {
  const result = await readJsonFile(join(tempDir, "nonexistent.json"));
  assert.equal(result, null);
});

test("readJsonFile: returns null for corrupt JSON", async () => {
  const p = join(tempDir, "corrupt.json");
  await writeFile(p, "{bad json!!!");
  const result = await readJsonFile(p);
  assert.equal(result, null);
});

test("readJsonFile: reads arrays", async () => {
  const p = join(tempDir, "array.json");
  await writeFile(p, "[1,2,3]");
  const result = await readJsonFile(p);
  assert.deepEqual(result, [1, 2, 3]);
});

// ── withLock ────────────────────────────────────────────────────────────────

test("withLock: executes fn and returns result", async () => {
  const result = await withLock("test-basic", () => 42);
  assert.equal(result, 42);
});

test("withLock: serializes concurrent calls on same key", async () => {
  const order = [];
  const a = withLock("test-serial", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("a-end");
  });
  const b = withLock("test-serial", async () => {
    order.push("b-start");
    order.push("b-end");
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("withLock: different keys run concurrently", async () => {
  const order = [];
  const a = withLock("key-a", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("a-end");
  });
  const b = withLock("key-b", async () => {
    order.push("b-start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("b-end");
  });
  await Promise.all([a, b]);
  // Both should start before either ends
  assert.ok(order.indexOf("b-start") < order.indexOf("a-end"));
});

test("withLock: cleans up lock map after execution", async () => {
  await withLock("test-cleanup", () => "done");
  assert.equal(operationLocks.has("test-cleanup"), false);
});

test("withLock: propagates errors from fn", async () => {
  await assert.rejects(
    () => withLock("test-error", () => { throw new Error("boom"); }),
    { message: "boom" },
  );
});

test("withLock: invalid key or non-function calls fn directly", async () => {
  // Empty key — falls through to fn?.()
  const result = await withLock("", () => "fallback");
  assert.equal(result, "fallback");
});

test("withLock: serializes same-key critical sections across child processes", async () => {
  const controlDir = await mkdtemp(join(tempDir, "with-lock-cross-process-"));
  const stateFile = join(controlDir, "count.txt");
  const childScript = fileURLToPath(new URL("./helpers/with-lock-child.js", import.meta.url));
  const lockKey = `cross-process-lock-${Date.now()}`;

  const waitForFile = async (filePath, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await readFile(filePath, "utf8");
        return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timeout waiting for file: ${filePath}`);
  };

  const waitForProcess = (child) => new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      if (child.exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`child exited with code ${child.exitCode}`));
      return;
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`child exited with code ${code}`));
    });
  });

  const waitForEnteredFiles = async (count, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entered = (await readdir(controlDir))
        .filter((entry) => entry.endsWith(".entered"))
        .sort();
      if (entered.length >= count) {
        return entered;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timeout waiting for ${count} entered file(s)`);
  };

  try {
    await writeFile(stateFile, "0", "utf8");

    const childA = spawn(process.execPath, [childScript, controlDir, lockKey, "a"], {
      stdio: "inherit",
    });
    const childB = spawn(process.execPath, [childScript, controlDir, lockKey, "b"], {
      stdio: "inherit",
    });

    const firstEntered = await waitForEnteredFiles(1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const enteredBeforeRelease = await waitForEnteredFiles(1);
    assert.deepEqual(
      enteredBeforeRelease,
      firstEntered,
      "second process should stay blocked on the same lock key until the first releases",
    );

    const firstWorker = firstEntered[0].replace(".entered", "");
    const secondWorker = firstWorker === "a" ? "b" : "a";

    await writeFile(join(controlDir, `${firstWorker}.release`), "go", "utf8");
    await waitForFile(join(controlDir, `${firstWorker}.done`));
    await waitForFile(join(controlDir, `${secondWorker}.entered`));
    await writeFile(join(controlDir, `${secondWorker}.release`), "go", "utf8");

    await Promise.all([waitForProcess(childA), waitForProcess(childB)]);

    const finalCount = await readFile(stateFile, "utf8");
    assert.equal(finalCount, "2");
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
});

// ── rememberRecentOperation ─────────────────────────────────────────────────

test("rememberRecentOperation: returns true on first call", () => {
  clearRecentOperationGuards();
  assert.equal(rememberRecentOperation("op-a"), true);
});

test("rememberRecentOperation: returns false on duplicate key", () => {
  clearRecentOperationGuards();
  rememberRecentOperation("op-dup");
  assert.equal(rememberRecentOperation("op-dup"), false);
});

test("rememberRecentOperation: returns false for empty key", () => {
  assert.equal(rememberRecentOperation(""), false);
  assert.equal(rememberRecentOperation(null), false);
  assert.equal(rememberRecentOperation(undefined), false);
});

test("clearRecentOperationGuards: clears all guards", () => {
  clearRecentOperationGuards();
  rememberRecentOperation("guard-1");
  rememberRecentOperation("guard-2");
  clearRecentOperationGuards();
  // After clear, same keys should be accepted again
  assert.equal(rememberRecentOperation("guard-1"), true);
  assert.equal(rememberRecentOperation("guard-2"), true);
  clearRecentOperationGuards();
});

// ── esc ─────────────────────────────────────────────────────────────────────

test("esc: escapes HTML special characters", () => {
  assert.equal(esc('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test("esc: escapes ampersand and single quote", () => {
  assert.equal(esc("a & b's"), "a &amp; b&#39;s");
});

test("esc: passes through safe strings", () => {
  assert.equal(esc("hello world"), "hello world");
});

test("esc: converts non-string to string first", () => {
  assert.equal(esc(42), "42");
  assert.equal(esc(null), "null");
});

// ── isPathWithin ────────────────────────────────────────────────────────────

test("isPathWithin: path inside allowed dir", () => {
  assert.equal(isPathWithin("/home/user/data/file.txt", "/home/user/data"), true);
});

test("isPathWithin: exact match of allowed dir", () => {
  assert.equal(isPathWithin("/home/user/data", "/home/user/data"), true);
});

test("isPathWithin: path outside allowed dir", () => {
  assert.equal(isPathWithin("/etc/passwd", "/home/user/data"), false);
});

test("isPathWithin: path traversal blocked", () => {
  assert.equal(isPathWithin("/home/user/data/../../../etc/passwd", "/home/user/data"), false);
});

test("isPathWithin: prefix overlap but different dir", () => {
  // /home/user/data-extra should NOT match /home/user/data
  assert.equal(isPathWithin("/home/user/data-extra/file.txt", "/home/user/data"), false);
});

// ── teardown ────────────────────────────────────────────────────────────────

test("teardown: remove temp directory", async () => {
  clearRecentOperationGuards();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});
