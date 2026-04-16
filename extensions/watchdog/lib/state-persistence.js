// state-persistence.js — State snapshot, restore, persist, load
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "./state-file-utils.js";
import { STATE_FILE } from "./state-paths.js";
import {
  restoreDispatchChainSnapshot,
  snapshotDispatchChain,
} from "./store/contract-flow-store.js";
import {
  restoreResumableTrackingSessions,
  snapshotResumableTrackingSessions,
} from "./store/tracker-store.js";

export async function persistState(logger) {
  try {
    const state = {
      dispatchChain: snapshotDispatchChain(),
      resumableTrackingSessions: snapshotResumableTrackingSessions(),
      savedAt: Date.now(),
    };
    await atomicWriteFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger?.warn(`[watchdog] persistState error: ${e.message}`);
  }
}

export async function loadState(logger) {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    restoreDispatchChainSnapshot(state.dispatchChain, logger);
    restoreResumableTrackingSessions(state.resumableTrackingSessions, logger);
  } catch {
    // File doesn't exist on first run
  }
}
