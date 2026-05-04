import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateControllerRuntimeStateToControlPlane } from "../lib/control-plane-migration.js";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildPaths(root) {
  return {
    legacyContractsDir: join(root, "workspaces", "controller", "contracts"),
    legacyStateFile: join(root, "workspaces", "controller", ".watchdog-state.json"),
    legacyQueueStateFile: join(root, "workspaces", "controller", ".queue-state.json"),
    controlPlaneDir: join(root, "control-plane"),
    contractsDir: join(root, "control-plane", "contracts"),
    stateFile: join(root, "control-plane", "watchdog-state.json"),
    queueStateFile: join(root, "control-plane", "queue-state.json"),
  };
}

test("migrateControllerRuntimeStateToControlPlane moves legacy runtime state into control-plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-control-plane-migration-"));
  const paths = buildPaths(root);

  try {
    await mkdir(paths.legacyContractsDir, { recursive: true });
    await writeFile(paths.legacyStateFile, JSON.stringify({ dispatchChain: ["legacy"] }), "utf8");
    await writeFile(paths.legacyQueueStateFile, JSON.stringify({ targets: { worker: {} } }), "utf8");
    await writeFile(join(paths.legacyContractsDir, "TC-MIGRATE.json"), JSON.stringify({ id: "TC-MIGRATE" }), "utf8");

    const result = await migrateControllerRuntimeStateToControlPlane({ paths });

    assert.equal(result.migratedFiles, 3);
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(JSON.parse(await readFile(paths.stateFile, "utf8")), { dispatchChain: ["legacy"] });
    assert.deepEqual(JSON.parse(await readFile(paths.queueStateFile, "utf8")), { targets: { worker: {} } });
    assert.deepEqual(
      JSON.parse(await readFile(join(paths.contractsDir, "TC-MIGRATE.json"), "utf8")),
      { id: "TC-MIGRATE" },
    );
    assert.equal(await exists(paths.legacyStateFile), false);
    assert.equal(await exists(paths.legacyQueueStateFile), false);
    assert.equal(await exists(join(paths.legacyContractsDir, "TC-MIGRATE.json")), false);

    const second = await migrateControllerRuntimeStateToControlPlane({ paths });
    assert.equal(second.migratedFiles, 0);
    assert.equal(second.conflicts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateControllerRuntimeStateToControlPlane preserves conflicting legacy data", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-control-plane-migration-"));
  const paths = buildPaths(root);

  try {
    await mkdir(paths.legacyContractsDir, { recursive: true });
    await mkdir(paths.contractsDir, { recursive: true });
    await writeFile(paths.legacyStateFile, "legacy-state", "utf8");
    await writeFile(paths.stateFile, "current-state", "utf8");
    await writeFile(join(paths.legacyContractsDir, "TC-CONFLICT.json"), "legacy-contract", "utf8");
    await writeFile(join(paths.contractsDir, "TC-CONFLICT.json"), "current-contract", "utf8");

    const result = await migrateControllerRuntimeStateToControlPlane({ paths });

    assert.deepEqual(
      result.conflicts.map((entry) => entry.kind).sort(),
      ["contract", "state"].sort(),
    );
    assert.equal(await readFile(paths.stateFile, "utf8"), "current-state");
    assert.equal(await readFile(paths.legacyStateFile, "utf8"), "legacy-state");
    assert.equal(await readFile(join(paths.contractsDir, "TC-CONFLICT.json"), "utf8"), "current-contract");
    assert.equal(await readFile(join(paths.legacyContractsDir, "TC-CONFLICT.json"), "utf8"), "legacy-contract");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
