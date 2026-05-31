import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveSingleTestSendPlan } from "../lib/formal-runtime/suite-single.js";

test("formal single tests default to watchdog trusted ingress instead of core hook bridge", () => {
  const replyTo = {
    kind: "test_run",
    runId: "TR-1",
    agentId: "test-run",
    sessionKey: "test-run:TR-1",
  };

  const plan = resolveSingleTestSendPlan({
    message: "今天星期几",
    options: {
      source: "webui",
      replyTo,
    },
  });

  assert.equal(plan.kind, "trusted_ingress");
  assert.equal(plan.label, "watchdog trusted ingress");
  assert.equal(plan.source, "webui");
  assert.deepEqual(plan.replyTo, replyTo);
});

test("watchdog ingress code does not treat core external wrapper as WebUI truth", async () => {
  const content = await readFile(
    new URL("../lib/ingress/before-start-ingress.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(content, /WebUI webhook format/u);
  assert.doesNotMatch(content, /EXTERNAL_UNTRUSTED_CONTENT/u);
});
