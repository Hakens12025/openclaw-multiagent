import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WATCHDOG_ROOT = fileURLToPath(new URL("..", import.meta.url));

const CANONICAL_RUNTIME_WAKE_CONSUMERS = [
  "../index.js",
  "../lib/lifecycle/agent-end-transport.js",
  "../lib/lifecycle/crash-recovery.js",
  "../lib/routing/delivery-system-action-transport.js",
  "../lib/routing/delivery-terminal.js",
  "../lib/routing/dispatch-transport.js",
  "../lib/system-action/system-action-request-review.js",
  "../lib/system-action/system-action-runtime.js",
  "../lib/transport/runtime-wake-envelope.js",
];

const PRODUCTION_SOURCE_ROOTS = [
  "lib",
  "hooks",
  "routes",
];

const PRODUCTION_SOURCE_FILES = [
  "index.js",
  "runtime-mailbox.js",
  "protocol-registry.js",
  "test-runner.js",
];

async function listSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(path));
      continue;
    }
    if (entry.isFile() && path.endsWith(".js")) {
      files.push(path);
    }
  }
  return files;
}

async function listProductionSourceFiles() {
  const files = [];
  for (const root of PRODUCTION_SOURCE_ROOTS) {
    files.push(...await listSourceFiles(join(WATCHDOG_ROOT, root)));
  }
  for (const fileName of PRODUCTION_SOURCE_FILES) {
    files.push(join(WATCHDOG_ROOT, fileName));
  }
  return [...new Set(files)];
}

function relativeSourcePath(filePath) {
  return filePath.replace(`${WATCHDOG_ROOT}/`, "");
}

test("canonical runtime wake consumers use runtime-wake transport", async () => {
  for (const modulePath of CANONICAL_RUNTIME_WAKE_CONSUMERS) {
    const source = await readFile(new URL(modulePath, import.meta.url), "utf8");

    assert.match(source, /runtime-wake-transport\.js/u);
  }
});

test("production source is free of legacy transport/comm imports", async () => {
  const violations = [];

  for (const filePath of await listProductionSourceFiles()) {
    const source = await readFile(filePath, "utf8");
    if (/transport\/comm\.js/u.test(source)) {
      violations.push(relativeSourcePath(filePath));
    }
  }

  assert.deepEqual(violations, []);
});

test("legacy transport/comm module is retired", async () => {
  await assert.rejects(
    () => readFile(new URL("../lib/transport/comm.js", import.meta.url), "utf8"),
    /ENOENT/u,
  );
});
