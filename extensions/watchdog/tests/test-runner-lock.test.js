import test from "node:test";
import assert from "node:assert/strict";

import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("runGlobalTestEnvironmentSerial serializes concurrent test-environment callbacks", async () => {
  const events = [];
  const start = Date.now();

  await Promise.all([
    runGlobalTestEnvironmentSerial(async () => {
      events.push({ type: "first-start", at: Date.now() - start });
      await sleep(120);
      events.push({ type: "first-end", at: Date.now() - start });
    }),
    runGlobalTestEnvironmentSerial(async () => {
      events.push({ type: "second-start", at: Date.now() - start });
      await sleep(10);
      events.push({ type: "second-end", at: Date.now() - start });
    }),
  ]);

  const starts = events.filter((entry) => entry.type.endsWith("-start"));
  const ends = events.filter((entry) => entry.type.endsWith("-end"));

  assert.equal(starts.length, 2, "both callbacks should start");
  assert.equal(ends.length, 2, "both callbacks should end");

  const firstCompletedAt = ends[0]?.at ?? -1;
  const secondStartedAt = starts[1]?.at ?? Number.POSITIVE_INFINITY;
  assert.ok(
    secondStartedAt >= firstCompletedAt,
    `callbacks should not overlap: secondStartedAt=${secondStartedAt} firstCompletedAt=${firstCompletedAt}`,
  );
});
