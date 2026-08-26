// lib/state/state-paths.js — Path constants derived from HOME.
// CONTRACTS_DIR / STATE_FILE / QUEUE_STATE_FILE are back-compat re-exports;
// the authoritative source is control-plane-paths.js.
import { join } from "node:path";
import { homedir } from "node:os";

import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

export const HOME = homedir();
export const OC = join(HOME, ".openclaw");
export const CONTRACTS_DIR = CONTROL_PLANE_PATHS.contractsDir;
export const STATE_FILE = CONTROL_PLANE_PATHS.stateFile;
export const QUEUE_STATE_FILE = CONTROL_PLANE_PATHS.queueStateFile;
