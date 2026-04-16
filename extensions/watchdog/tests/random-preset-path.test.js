import test from "node:test";
import assert from "node:assert/strict";

import { buildRandomPathVerdict } from "./suite-single.js";

test("user-random path verdict is BLOCKED when runtime falls into direct session", () => {
  const result = buildRandomPathVerdict({
    family: "user-random",
    chosenAgent: "worker-x",
    actualPath: "direct_request",
  });

  assert.equal(result.blocked, true);
  assert.equal(result.pass, false);
  assert.equal(result.errorCode, "E_RANDOM_PATH_BLOCKED");
});
