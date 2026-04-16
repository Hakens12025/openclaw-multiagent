import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDirectRequestEnvelope } from "../lib/protocol-primitives.js";
import { buildInitialTaskStagePlan } from "../lib/task-stage-plan.js";

test("createDirectRequestEnvelope uses minimal default stage truth until planner/runtime refines it", () => {
  const contract = createDirectRequestEnvelope({
    agentId: "worker-d",
    sessionKey: "agent:worker-d:direct-stage-truth",
    message: "帮我做一下某个卡夫曼算法的优化",
    outputDir: join(tmpdir(), "openclaw-direct-stage-truth"),
  });

  assert.deepEqual(
    contract.stagePlan?.stages?.map((entry) => entry.label),
    ["执行"],
  );
  assert.deepEqual(contract.phases, ["执行"]);
  assert.equal(contract.total, 1);
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
