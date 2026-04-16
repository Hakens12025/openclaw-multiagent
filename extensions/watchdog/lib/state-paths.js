// state-paths.js — Path constants derived from HOME
import { join } from "node:path";
import { homedir } from "node:os";

export const HOME = homedir();
export const OC = join(HOME, ".openclaw");
export const CONTRACTS_DIR = join(OC, "workspaces", "controller", "contracts");
export const STATE_FILE = join(OC, "workspaces", "controller", ".watchdog-state.json");
export const QUEUE_STATE_FILE = join(OC, "workspaces", "controller", ".queue-state.json");
