import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const WATCHDOG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);

const PRODUCTION_SOURCE_ROOTS = Object.freeze([
  "lib",
  "hooks",
  "routes",
]);

const PRODUCTION_SOURCE_FILES = Object.freeze([
  "runtime-mailbox.js",
  "protocol-registry.js",
  "test-runner.js",
  "dashboard.js",
  "dashboard-runtime-graph.js",
  "dashboard-contract-card.js",
  "dashboard-contract-lane.js",
  "dashboard-contract-flow-animator.js",
  "dashboard-agent-card.js",
  "dashboard-agents.js",
  "dashboard-operator.js",
  "dashboard-harness.js",
  "dashboard-work-items.js",
  "dashboard-work-items-state.js",
]);

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

test("production code no longer imports retired agent-bootstrap compatibility shell", async () => {
  const files = [
    new URL("../routes/api.js", import.meta.url),
    new URL("../lib/agent/agent-enrollment.js", import.meta.url),
    new URL("../lib/agent/agent-admin-agent-operations.js", import.meta.url),
    new URL("../lib/agent/agent-admin-profile.js", import.meta.url),
    new URL("../lib/agent/agent-enrollment-guidance.js", import.meta.url),
    new URL("../lib/agent/agent-enrollment-discovery.js", import.meta.url),
    new URL("../lib/admin/admin-surface-graph-operations.js", import.meta.url),
    new URL("../lib/effective-profile-composer.js", import.meta.url),
  ];

  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /agent-bootstrap\.js/);
  }
});

test("agent-bootstrap compatibility shell has been retired from the codebase", async () => {
  const fileUrl = new URL("../lib/agent/agent-bootstrap.js", import.meta.url);
  await assert.rejects(
    access(fileUrl, fsConstants.F_OK),
    /ENOENT/,
  );
});

test("legacy retry and delivery compatibility shells have been retired from the codebase", async () => {
  const retiredFiles = [
    "../lib/retry-manager.js",
    "../lib/routing/delivery.js",
  ];

  for (const retiredFile of retiredFiles) {
    await assert.rejects(
      access(new URL(retiredFile, import.meta.url), fsConstants.F_OK),
      /ENOENT/,
    );
  }
});

test("production source does not reintroduce retired compatibility shell imports", async () => {
  const retiredPatterns = [
    /agent-bootstrap\.js/u,
    /retry-manager\.js/u,
    /routing\/delivery\.js/u,
  ];
  const violations = [];

  for (const filePath of await listProductionSourceFiles()) {
    const source = await readFile(filePath, "utf8");
    for (const pattern of retiredPatterns) {
      if (pattern.test(source)) {
        violations.push(`${relativeSourcePath(filePath)} matches ${pattern}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("runtime workspace projections are not checked into repository truth", async () => {
  const { stdout } = await execFileAsync("git", ["ls-files", "workspaces"], {
    cwd: REPO_ROOT,
  });
  const trackedRuntimeWorkspaceFiles = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !entry.startsWith("workspaces/_configs/"));

  assert.deepEqual(trackedRuntimeWorkspaceFiles, []);
});

test("setup and cleanup surfaces use control-plane stores instead of controller workspace stores", async () => {
  const files = {
    setupScript: await readFile(join(REPO_ROOT, "setup.sh"), "utf8"),
    cleanScript: await readFile(join(REPO_ROOT, "clean.sh"), "utf8"),
    cleanRestartScript: await readFile(join(REPO_ROOT, "scripts", "clean-restart-gateway.sh"), "utf8"),
    setupDoc: await readFile(join(REPO_ROOT, "SETUP.md"), "utf8"),
  };

  for (const [label, content] of Object.entries(files)) {
    assert.doesNotMatch(content, /workspaces\/controller\/(?:contracts|output|deliveries)/u, `${label} still references controller-rooted runtime stores`);
  }

  assert.match(files.setupScript, /control-plane\/contracts/u);
  assert.match(files.cleanScript, /control-plane\/contracts/u);
  assert.match(files.cleanScript, /control-plane\/output/u);
  assert.match(files.setupDoc, /control-plane\/contracts/u);
  assert.match(files.setupDoc, /control-plane\/output/u);
});
