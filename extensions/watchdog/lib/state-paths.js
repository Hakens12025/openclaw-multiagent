// state-paths.js — Path constants derived from HOME
import { join } from "node:path";
import { homedir } from "node:os";

export const HOME = homedir();
export const OC = join(HOME, ".openclaw");
export const CONTROL_PLANE_DIR = join(OC, "control-plane");
export const CONTRACTS_DIR = join(CONTROL_PLANE_DIR, "contracts");
export const STATE_FILE = join(CONTROL_PLANE_DIR, "watchdog-state.json");
export const QUEUE_STATE_FILE = join(CONTROL_PLANE_DIR, "queue-state.json");
