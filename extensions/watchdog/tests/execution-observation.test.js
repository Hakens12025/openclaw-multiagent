import test from "node:test";
import assert from "node:assert/strict";

import { normalizeExecutionObservation } from "../lib/stage/execution-observation.js";

test("legacy contractResult is ignored by execution observation", () => {
  const observation = normalizeExecutionObservation({
    contractResult: {
      status: "completed",
      summary: "legacy result",
    },
  }, {
    contractId: "TC-legacy-result",
    observedAt: 123,
  });

  assert.equal("contractResult" in observation, false);
  assert.equal(observation.collected, false);
});
