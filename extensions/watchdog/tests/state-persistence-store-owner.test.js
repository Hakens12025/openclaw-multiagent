import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "openclaw-state-persistence-"));
const stateFile = join(tempDir, "state.json");

const atomicWriteCalls = [];
const restoreTrackerCalls = [];
const restoreDispatchChainCalls = [];

const trackerSnapshot = {
  "agent:planner:main": {
    sessionKey: "agent:planner:main",
    followUpLease: { active: true, workflow: "system_action delivery" },
  },
};

const dispatchChainSnapshot = {
  worker: {
    originAgentId: "planner",
    originSessionKey: "agent:planner:main",
    ts: 123,
  },
};

mock.module("../lib/state-file-utils.js", {
  namedExports: {
    atomicWriteFile: async (filePath, data) => {
      atomicWriteCalls.push({ filePath, data });
      await writeFile(filePath, data, "utf8");
    },
  },
});

mock.module("../lib/state-paths.js", {
  namedExports: {
    STATE_FILE: stateFile,
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    snapshotResumableTrackingSessions: () => trackerSnapshot,
    restoreResumableTrackingSessions: (savedSessions, logger) => {
      restoreTrackerCalls.push({ savedSessions, logger });
      return Object.keys(savedSessions || {}).length;
    },
  },
});

mock.module("../lib/store/contract-flow-store.js", {
  namedExports: {
    snapshotDispatchChain: () => dispatchChainSnapshot,
    restoreDispatchChainSnapshot: (snapshot, logger) => {
      restoreDispatchChainCalls.push({ snapshot, logger });
      return Object.keys(snapshot || {}).length;
    },
  },
});

const { persistState, loadState } = await import("../lib/state-persistence.js");

test("persistState writes tracker and dispatch snapshots provided by their store owners", async () => {
  atomicWriteCalls.length = 0;

  await persistState();

  assert.equal(atomicWriteCalls.length, 1);
  assert.equal(atomicWriteCalls[0].filePath, stateFile);

  const parsed = JSON.parse(atomicWriteCalls[0].data);
  assert.deepEqual(parsed.dispatchChain, dispatchChainSnapshot);
  assert.deepEqual(parsed.resumableTrackingSessions, trackerSnapshot);
  assert.equal(Number.isFinite(parsed.savedAt), true);
});

test("loadState restores tracker and dispatch snapshots through their store owners", async () => {
  restoreTrackerCalls.length = 0;
  restoreDispatchChainCalls.length = 0;

  await writeFile(stateFile, JSON.stringify({
    dispatchChain: dispatchChainSnapshot,
    resumableTrackingSessions: trackerSnapshot,
    savedAt: Date.now(),
  }, null, 2), "utf8");

  const logger = { info() {}, warn() {}, error() {} };
  await loadState(logger);

  assert.equal(restoreDispatchChainCalls.length, 1);
  assert.deepEqual(restoreDispatchChainCalls[0].snapshot, dispatchChainSnapshot);
  assert.equal(restoreDispatchChainCalls[0].logger, logger);

  assert.equal(restoreTrackerCalls.length, 1);
  assert.deepEqual(restoreTrackerCalls[0].savedSessions, trackerSnapshot);
  assert.equal(restoreTrackerCalls[0].logger, logger);
});

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
