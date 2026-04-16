import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteScheduleSpec,
  summarizeScheduleRegistry,
  upsertScheduleSpec,
} from "../lib/schedule/schedule-registry.js";
import {
  deleteAgentJoinSpec,
  summarizeAgentJoinRegistry,
  upsertAgentJoinSpec,
} from "../lib/agent/agent-join-registry.js";

function buildScheduleSpec(id, expr, label) {
  return {
    id,
    trigger: {
      type: "cron",
      expr,
    },
    entry: {
      targetAgent: "controller",
      message: `run ${label}`,
    },
  };
}

function buildAgentJoinSpec(id, localAgentId) {
  return {
    id,
    binding: {
      localAgentId,
      platformRole: "gateway",
    },
    identity: {
      name: localAgentId,
    },
    protocol: {
      type: "a2a",
      baseUrl: "http://example.test",
    },
  };
}

test("concurrent schedule upserts do not lose sibling writes", async () => {
  const base = `schedule-store-lock-${Date.now()}`;
  const idA = `${base}-a`;
  const idB = `${base}-b`;

  try {
    await Promise.allSettled([
      deleteScheduleSpec(idA),
      deleteScheduleSpec(idB),
    ]);

    await Promise.all([
      upsertScheduleSpec(buildScheduleSpec(idA, "*/5 * * * *", "A")),
      upsertScheduleSpec(buildScheduleSpec(idB, "*/10 * * * *", "B")),
    ]);

    const { schedules } = await summarizeScheduleRegistry();
    assert.equal(schedules.some((entry) => entry.id === idA), true);
    assert.equal(schedules.some((entry) => entry.id === idB), true);
  } finally {
    await Promise.allSettled([
      deleteScheduleSpec(idA),
      deleteScheduleSpec(idB),
    ]);
  }
});

test("concurrent agent join upserts do not lose sibling writes", async () => {
  const base = `agent-join-store-lock-${Date.now()}`;
  const idA = `${base}-a`;
  const idB = `${base}-b`;

  try {
    await Promise.allSettled([
      deleteAgentJoinSpec(idA),
      deleteAgentJoinSpec(idB),
    ]);

    await Promise.all([
      upsertAgentJoinSpec(buildAgentJoinSpec(idA, "join-a")),
      upsertAgentJoinSpec(buildAgentJoinSpec(idB, "join-b")),
    ]);

    const { agentJoins } = await summarizeAgentJoinRegistry();
    assert.equal(agentJoins.some((entry) => entry.id === idA), true);
    assert.equal(agentJoins.some((entry) => entry.id === idB), true);
  } finally {
    await Promise.allSettled([
      deleteAgentJoinSpec(idA),
      deleteAgentJoinSpec(idB),
    ]);
  }
});
