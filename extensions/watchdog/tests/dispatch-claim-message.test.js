import test from "node:test";
import assert from "node:assert/strict";

import { buildDispatchTargetClaimMessage } from "../lib/session/session-bootstrap.js";

test("dispatch target claim message names the agent, contract id, and title", () => {
  const message = buildDispatchTargetClaimMessage("worker", {
    id: "TC-123",
    task: "今天星期几",
  });

  assert.match(message, /worker/);
  assert.match(message, /TC-123/);
  assert.match(message, /今天星期几/);
  assert.doesNotMatch(message, /你的任务/u);
});

test("dispatch target claim message trims noisy multiline titles", () => {
  const message = buildDispatchTargetClaimMessage("worker\nignored", {
    id: "TC-456\nignored",
    task: "第一行\n第二行",
  });

  assert.match(message, /worker ignored/);
  assert.match(message, /TC-456 ignored/);
  assert.match(message, /第一行 第二行/);
});
