import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SURFACE_INPUT_FIELDS } from "../lib/admin/admin-surface-input-fields.js";

test("admin surface placeholders avoid stale legacy agent examples", () => {
  const loopComposeFields = SURFACE_INPUT_FIELDS["graph.loop.compose"] || [];
  const runtimeLoopStartFields = SURFACE_INPUT_FIELDS["runtime.loop.start"] || [];
  const agentJoinFields = SURFACE_INPUT_FIELDS["agent_joins.create"] || [];

  assert.equal("runtime.workspace_migration.apply" in SURFACE_INPUT_FIELDS, false);
  assert.doesNotMatch(
    loopComposeFields[0]?.placeholder || "",
    /researcher|worker-d|reviewer/i,
  );
  assert.doesNotMatch(
    runtimeLoopStartFields[2]?.placeholder || "",
    /researcher/i,
  );
  assert.doesNotMatch(
    agentJoinFields[1]?.placeholder || "",
    /deerflow-researcher/i,
  );
});

test("dashboard operator compose placeholder avoids stale legacy topology examples", () => {
  const source = readFileSync(
    new URL("../dashboard-operator.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /worker-a|worker-d|reviewer/);
});

test("runtime admin reset fallback avoids stale legacy worker defaults", () => {
  const source = readFileSync(
    new URL("../lib/admin/runtime-admin.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /"worker-a"|"worker-b"|"worker-c"|"worker-d"/);
});

test("agents dashboard no longer renders workspace migration compatibility panel", () => {
  const source = readFileSync(
    new URL("../dashboard-agents.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /LEGACY WORKSPACE ALIASES/);
  assert.doesNotMatch(source, /workspace-migration/i);
});
