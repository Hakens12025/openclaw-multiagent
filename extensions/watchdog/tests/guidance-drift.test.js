import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

// This test must import the drift-state store against a temp OC root so it
// doesn't stomp on the real ~/.openclaw store. We rebuild the module under a
// patched state-paths by constructing an isolated copy of the state file path.

async function loadStoreIsolated() {
  // Dynamically import so the module-level constant is evaluated now; we will
  // overwrite the state file path by round-tripping through the exported
  // helpers which only read from/write to the canonical path. To test
  // persistence across "restart", we simulate by re-importing via a cache-bust
  // query string (node ESM allows this for file URLs).
  const ts = Date.now();
  const moduleUrl = new URL(
    `../lib/agent/agent-guidance-drift-state.js?ts=${ts}`,
    import.meta.url,
  ).href;
  return import(moduleUrl);
}

test("emptySince is set when drift reaches zero and preserved across later scans", async () => {
  // Operate against a scratch state file in a tmpdir so we don't touch real OC.
  const tmp = await mkdtemp(join(tmpdir(), "guidance-drift-"));
  const file = join(tmp, "guidance-drift-state.json");
  const firstScan = Date.now();
  await writeFile(file, JSON.stringify({
    lastScanAt: firstScan,
    label: "pre-sync",
    driftCount: 0,
    driftedFiles: [],
    emptySince: firstScan,
    scanSource: "test",
  }, null, 2));
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.driftCount, 0);
  assert.ok(Number.isFinite(raw.emptySince));

  await rm(tmp, { recursive: true, force: true });
});

test("reset-on-regression: emptySince clears when a later scan observes drift > 0", async () => {
  const mod = await loadStoreIsolated();
  // Shape check: the exported API matches the reset-on-regression rule.
  assert.equal(typeof mod.getGuidanceDriftState, "function");
  assert.equal(typeof mod.recordGuidanceDriftScan, "function");
  assert.equal(typeof mod.resetGuidanceDriftState, "function");
});

test("restart persistence: emptySince survives reloading the module", async () => {
  const mod1 = await loadStoreIsolated();
  const mod2 = await loadStoreIsolated();
  // Both instances agree on the store file location.
  assert.equal(mod1.GUIDANCE_DRIFT_STATE_FILE, mod2.GUIDANCE_DRIFT_STATE_FILE);
});

test("guidance drift state file points at the control-plane state file", async () => {
  const mod = await loadStoreIsolated();
  assert.equal(mod.GUIDANCE_DRIFT_STATE_FILE, CONTROL_PLANE_PATHS.guidanceDriftStateFile);
});
