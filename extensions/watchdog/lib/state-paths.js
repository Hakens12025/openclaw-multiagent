// state-paths.js — Path constants derived from HOME
import { join } from "node:path";
import { homedir } from "node:os";

export const HOME = homedir();
export const OC = join(HOME, ".openclaw");
export const CONTROL_PLANE_DIR = join(OC, "control-plane");
export const ADMIN_CHANGE_SET_DIR = join(CONTROL_PLANE_DIR, "admin-change-sets");
export const AGENT_DEFAULT_SKILLS_STORE = join(CONTROL_PLANE_DIR, "agent-default-skills.json");
export const AGENT_GRAPH_FILE = join(CONTROL_PLANE_DIR, "agent-graph.json");
export const AGENT_JOIN_STORE = join(CONTROL_PLANE_DIR, "agent-joins.json");
export const AUTOMATION_RUNTIME_STORE = join(CONTROL_PLANE_DIR, "automation-runtime.json");
export const AUTOMATION_STORE = join(CONTROL_PLANE_DIR, "automations.json");
export const CONVERSATIONS_DIR = join(CONTROL_PLANE_DIR, "conversations");
export const CONTRACTS_DIR = join(CONTROL_PLANE_DIR, "contracts");
export const GRAPH_LOOP_FILE = join(CONTROL_PLANE_DIR, "graph-loops.json");
export const STATE_FILE = join(CONTROL_PLANE_DIR, "watchdog-state.json");
export const QUEUE_STATE_FILE = join(CONTROL_PLANE_DIR, "queue-state.json");
export const SCHEDULE_MATERIALIZER_STORE = join(CONTROL_PLANE_DIR, "schedule-materializer.json");
export const SCHEDULE_STORE = join(CONTROL_PLANE_DIR, "schedules.json");
export const SYSTEM_ACTION_DELIVERY_TICKET_STORE = join(CONTROL_PLANE_DIR, "system-action-delivery-tickets.json");
