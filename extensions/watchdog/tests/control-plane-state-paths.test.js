import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ADMIN_CHANGE_SET_DIR,
  AGENT_DEFAULT_SKILLS_STORE,
  AGENT_GRAPH_FILE,
  AGENT_JOIN_STORE,
  AUTOMATION_RUNTIME_STORE,
  AUTOMATION_STORE,
  CONVERSATIONS_DIR,
  CONTRACTS_DIR,
  GRAPH_LOOP_FILE,
  QUEUE_STATE_FILE,
  SCHEDULE_MATERIALIZER_STORE,
  SCHEDULE_STORE,
  STATE_FILE,
  SYSTEM_ACTION_DELIVERY_TICKET_STORE,
} from "../lib/state-paths.js";

test("runtime control-plane state paths are outside controller workspace", () => {
  const paths = {
    ADMIN_CHANGE_SET_DIR,
    AGENT_DEFAULT_SKILLS_STORE,
    AGENT_GRAPH_FILE,
    AGENT_JOIN_STORE,
    AUTOMATION_RUNTIME_STORE,
    AUTOMATION_STORE,
    CONVERSATIONS_DIR,
    CONTRACTS_DIR,
    GRAPH_LOOP_FILE,
    STATE_FILE,
    QUEUE_STATE_FILE,
    SCHEDULE_MATERIALIZER_STORE,
    SCHEDULE_STORE,
    SYSTEM_ACTION_DELIVERY_TICKET_STORE,
  };

  for (const [name, value] of Object.entries(paths)) {
    assert.match(value, /\.openclaw\/control-plane/u, `${name} should live under control-plane`);
    assert.doesNotMatch(value, /workspaces\/controller/u, `${name} should not live under controller workspace`);
  }

  assert.match(CONTRACTS_DIR, /\/contracts$/u);
  assert.match(STATE_FILE, /\/watchdog-state\.json$/u);
  assert.match(QUEUE_STATE_FILE, /\/queue-state\.json$/u);
});

test("gateway startup migrates legacy controller runtime state before loading stores", async () => {
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const migrationCall = source.indexOf("await migrateControllerRuntimeStateToControlPlane");
  const loadStateCall = source.indexOf("await loadState");
  const loadDispatchCall = source.indexOf("await loadDispatchRuntimeState");

  assert.ok(migrationCall > -1, "startup should invoke control-plane migration");
  assert.ok(loadStateCall > -1, "startup should load watchdog state");
  assert.ok(loadDispatchCall > -1, "startup should load dispatch queue state");
  assert.ok(migrationCall < loadStateCall, "migration should run before watchdog state load");
  assert.ok(migrationCall < loadDispatchCall, "migration should run before dispatch queue load");
});
