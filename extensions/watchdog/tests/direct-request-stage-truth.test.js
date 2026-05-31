import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDirectRequestEnvelope } from "../lib/protocol-primitives.js";
import { buildInitialTaskStagePlan } from "../lib/task-stage-plan.js";

test("createDirectRequestEnvelope does not invent implicit stage truth when none is provided", () => {
  const contract = createDirectRequestEnvelope({
    agentId: "worker-d",
    sessionKey: "agent:worker-d:direct-stage-truth",
    message: "帮我做一下某个卡夫曼算法的优化",
    outputDir: join(tmpdir(), "openclaw-direct-stage-truth"),
  });

  assert.equal(contract.stagePlan, undefined);
  assert.equal(contract.stageRuntime, undefined);
  assert.equal(contract.phases, undefined);
  assert.equal(contract.total, undefined);
});

test("createDirectRequestEnvelope preserves explicit canonical task stage truth when provided", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-DIRECT-EXPLICIT-STAGE",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });

  const contract = createDirectRequestEnvelope({
    agentId: "researcher",
    sessionKey: "agent:researcher:direct-stage-explicit",
    message: "对比三个框架优缺点",
    outputDir: join(tmpdir(), "openclaw-direct-stage-explicit"),
    stagePlan,
  });

  assert.equal(contract.stagePlan?.contractId, "TC-DIRECT-EXPLICIT-STAGE");
  assert.deepEqual(contract.phases, ["建立比较维度", "补充关键证据", "形成结论"]);
  assert.equal(contract.total, 3);
});

test("createDirectRequestEnvelope includes runtime current time truth", () => {
  const previousTimeZone = process.env.OPENCLAW_RUNTIME_TIME_ZONE;
  process.env.OPENCLAW_RUNTIME_TIME_ZONE = "Asia/Shanghai";

  try {
    const now = Date.parse("2026-05-12T12:00:00.000Z");
    const contract = createDirectRequestEnvelope({
      agentId: "worker-time",
      sessionKey: "agent:worker-time:direct-time",
      message: "今天星期几？",
      outputDir: join(tmpdir(), "openclaw-direct-time"),
      now,
    });

    assert.equal(contract.runtimeContext?.version, 1);
    assert.equal(contract.runtimeContext?.currentTime?.unixMs, now);
    assert.equal(contract.runtimeContext?.currentTime?.iso, "2026-05-12T12:00:00.000Z");
    assert.equal(contract.runtimeContext?.currentTime?.timeZone, "Asia/Shanghai");
    assert.equal(contract.runtimeContext?.currentTime?.date, "2026-05-12");
    assert.equal(contract.runtimeContext?.currentTime?.time, "20:00:00");
    assert.equal(contract.runtimeContext?.currentTime?.weekday, "Tuesday");
    assert.equal(contract.runtimeContext?.currentTime?.weekdayZh, "星期二");
  } finally {
    if (previousTimeZone === undefined) {
      delete process.env.OPENCLAW_RUNTIME_TIME_ZONE;
    } else {
      process.env.OPENCLAW_RUNTIME_TIME_ZONE = previousTimeZone;
    }
  }
});
