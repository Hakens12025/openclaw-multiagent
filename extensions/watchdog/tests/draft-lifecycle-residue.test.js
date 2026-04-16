import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { EVENT_TYPE } from "../lib/core/event-types.js";

test("runtime surface no longer exposes draft promotion compatibility events", () => {
  assert.equal("DRAFT_PROMOTED" in EVENT_TYPE, false);
  assert.equal("DRAFT_TIMEOUT" in EVENT_TYPE, false);
});

test("dispatch graph policy no longer carries promoteFromDraft compatibility logic", async () => {
  const source = await readFile("/Users/hakens/.openclaw/extensions/watchdog/lib/routing/dispatch-graph-policy.js", "utf8");

  assert.doesNotMatch(source, /\bpromoteFromDraft\b/);
  assert.doesNotMatch(source, /\bdraft_promoted\b/);
  assert.doesNotMatch(source, /ingress creates PENDING directly/);
});

test("direct service suite no longer expects draft_promoted runtime events", async () => {
  const source = await readFile("/Users/hakens/.openclaw/extensions/watchdog/tests/suite-direct-service.js", "utf8");

  assert.doesNotMatch(source, /\bdraft_promoted\b/);
});

test("dashboard no longer consumes dead draft lifecycle compatibility events", async () => {
  const source = await readFile("/Users/hakens/.openclaw/extensions/watchdog/dashboard.js", "utf8");

  assert.doesNotMatch(source, /\bdraft_promoted\b/);
  assert.doesNotMatch(source, /\bdraft_timeout\b/);
});
