import test from "node:test";
import assert from "node:assert/strict";

import { drainSSEEvents } from "../lib/formal-runtime/suite-single.js";

test("formal test timeline drops hidden control-plane events", () => {
  const timeline = [];
  const sse = {
    events: [
      {
        type: "track_start",
        receivedAt: 10,
        data: {
          agentId: "operator",
          formalTimelineVisible: false,
        },
      },
    ],
  };

  const lastObserved = drainSSEEvents(sse, 0, null, timeline);

  assert.equal(lastObserved, 0);
  assert.deepEqual(timeline, []);
});
