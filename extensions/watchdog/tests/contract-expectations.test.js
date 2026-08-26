import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:contract-expectations.test.js" });
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES, createDirectRequestEnvelope } from "../lib/protocol/protocol-primitives.js";
import { normalizeContractExpectations } from "../lib/contract/contract-expectations.js";
import { toTrackingContract } from "../lib/session/session-tracking-state.js";
import { systemActionDispatch } from "../lib/system-action/system-action-runtime.js";
import { clearSystemActionDeliveryTicketStore } from "../lib/routing/delivery/delivery-system-action-ticket.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = { info() {}, warn() {}, error() {} };

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

test("normalizeContractExpectations: canonical shape, defaults, and husk elimination", () => {
  const ok = normalizeContractExpectations({
    requiredArtifacts: ["outbox/report.md", { path: "output/final.md" }],
    expectedActions: [
      { intent: "assign_task" },
      { intent: "wake_agent", target: "worker2", required: false },
    ],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.expectations.requiredArtifacts, [
    { path: "outbox/report.md", required: true },
    { path: "output/final.md", required: true },
  ]);
  // optional 产物:required 透传给考官的 waived 分支
  const optional = normalizeContractExpectations({ requiredArtifacts: [{ path: "notes.md", required: false }] });
  assert.deepEqual(optional.expectations.requiredArtifacts, [{ path: "notes.md", required: false }]);
  assert.deepEqual(ok.expectations.expectedActions[0], { intent: "assign_task", target: null, required: true });
  assert.deepEqual(ok.expectations.expectedActions[1], { intent: "wake_agent", target: "worker2", required: false });

  // 缺席与空壳都归 null(没有期望就没有可核验对象)
  assert.deepEqual(normalizeContractExpectations(null), { ok: true, expectations: null });
  assert.deepEqual(normalizeContractExpectations({}), { ok: true, expectations: null });
  assert.deepEqual(
    normalizeContractExpectations({ requiredArtifacts: [], expectedActions: [] }),
    { ok: true, expectations: null },
  );
});

test("normalizeContractExpectations: structural garbage is rejected, not repaired", () => {
  assert.equal(normalizeContractExpectations("要有产物").ok, false);
  assert.equal(normalizeContractExpectations({ requiredArtifacts: "outbox/x.md" }).ok, false);
  assert.equal(normalizeContractExpectations({ requiredArtifacts: [{ label: "no-path" }] }).ok, false);
  assert.equal(normalizeContractExpectations({ expectedActions: [{ target: "worker2" }] }).ok, false);
  // intent 必须在意图词汇表内(垃圾期望结构化拒绝)
  assert.equal(normalizeContractExpectations({ expectedActions: [{ intent: "summon_dragon" }] }).ok, false);
});

test("expectedActions.intent converges to the exposed collaboration surface (一表四消费之③)", async () => {
  const { listExposedToolIntents } = await import("../lib/system-action/collaboration-intent-policy.js");
  // 暴露面内的 intent 全部可声明
  for (const intent of listExposedToolIntents()) {
    assert.equal(normalizeContractExpectations({ expectedActions: [{ intent }] }).ok, true, `${intent} must be declarable`);
  }
  // 编排 intent(词汇表内但 assignee 无法经工具面自行发起)→ 受理时刻拒绝,
  // 否则考官对照会话真值必判 violated
  for (const intent of ["create_task"]) {
    const verdict = normalizeContractExpectations({ expectedActions: [{ intent }] });
    assert.equal(verdict.ok, false, `${intent} must be rejected`);
    assert.match(verdict.error, /declarable collaboration surface/);
  }
});

test("createDirectRequestEnvelope carries platform-written expectations verbatim", () => {
  const expectations = {
    requiredArtifacts: [{ path: "output/x.md", required: true }],
    expectedActions: [{ intent: "assign_task", target: null, required: true }],
  };
  const contract = createDirectRequestEnvelope({
    agentId: "worker-exp",
    sessionKey: "agent:worker-exp:main",
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    message: "做一份报告",
    outputDir: "/tmp/worker-exp/output",
    source: INTENT_TYPES.ASSIGN_TASK,
    expectations,
  });
  assert.deepEqual(contract.expectations, expectations);
  // 会话真值投影同样可达(考官与开工简报的读取面)
  assert.deepEqual(toTrackingContract(contract, "/tmp/x.json").expectations, expectations);

  const bare = createDirectRequestEnvelope({
    agentId: "worker-exp",
    sessionKey: "agent:worker-exp:main",
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    message: "做一份报告",
    outputDir: "/tmp/worker-exp/output",
  });
  assert.equal("expectations" in bare, false);
});

test("assign_task materializes caller expectations onto the child contract; garbage is rejected at acceptance", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const suffix = `${Date.now()}`;
  const sourceAgent = `exp-source-${suffix}`;
  const targetAgent = `exp-target-${suffix}`;

  try {
    for (const id of [sourceAgent, targetAgent]) {
      runtimeAgentConfigs.set(id, { id, role: "agent", workspace: agentWorkspace(id) });
    }
    await saveGraph({ edges: [{ from: sourceAgent, to: targetAgent, label: "assign" }] });
    await clearSystemActionDeliveryTicketStore();

    // 垃圾期望 → 受理时刻结构化拒绝,不建约
    const rejected = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: {
        targetAgent,
        message: "整理一份清单",
        expectations: { expectedActions: [{ intent: "summon_dragon" }] },
      },
    }, {
      agentId: sourceAgent,
      sessionKey: `agent:${sourceAgent}:main`,
      contractData: { id: `TC-EXP-BAD-${suffix}` },
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      logger,
      actionReplyTo: { agentId: sourceAgent, sessionKey: `agent:${sourceAgent}:main` },
    });
    assert.equal(rejected.status, SYSTEM_ACTION_STATUS.INVALID_PARAMS);
    assert.match(rejected.error || "", /expectations/);

    // 合法期望 → 原样落到子约,且经 inbox 投影可达 assignee
    // phases → 归一(去空白项)后物化为子约 stagePlan(OMIT-02 透传)
    const accepted = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: {
        targetAgent,
        message: "整理一份清单",
        phases: ["调研", " 写作 ", ""],
        expectations: {
          requiredArtifacts: [{ path: "output/list.md" }],
          expectedActions: [{ intent: "assign_task", required: false }],
        },
      },
    }, {
      agentId: sourceAgent,
      sessionKey: `agent:${sourceAgent}:main`,
      contractData: { id: `TC-EXP-OK-${suffix}` },
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      logger,
      actionReplyTo: { agentId: sourceAgent, sessionKey: `agent:${sourceAgent}:main` },
    });
    assert.equal(accepted.status, SYSTEM_ACTION_STATUS.DISPATCHED);

    const inboxContract = JSON.parse(
      await readFile(join(agentWorkspace(targetAgent), "inbox", "contract.json"), "utf8"),
    );
    // 2026-08-12 断供修复:相对路径在建约抄写时物化为受托方 workspace 绝对路径
    // (判决侧纯机械 stat,零"相对于谁"猜测)。
    assert.deepEqual(inboxContract.expectations, {
      requiredArtifacts: [{ path: join(agentWorkspace(targetAgent), "output/list.md"), required: true }],
      expectedActions: [{ intent: "assign_task", target: null, required: false }],
    });
    // phases 透传:display phases = 归一后的阶段标签,stagePlan/stageRuntime 同步物化
    assert.deepEqual(inboxContract.phases, ["调研", "写作"]);
    assert.equal(inboxContract.stagePlan?.stages?.length, 2);
    assert.equal(inboxContract.stageRuntime?.currentStageId, "stage-1");
  } finally {
    await saveGraph(previousGraph);
    await clearSystemActionDeliveryTicketStore();
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));

test("materializeExpectationPaths:相对路径钉成受托方 workspace 绝对路径,绝对/~ 不动(断供修复)", async () => {
  const { materializeExpectationPaths } = await import("../lib/contract/contract-expectations.js");
  const src = {
    requiredArtifacts: [
      { path: "output/probe.md", required: true },
      { path: "/abs/keep.md", required: true },
      { path: "~/home-keep.md", required: true },
    ],
    expectedActions: [],
  };
  const out = materializeExpectationPaths(src, "/ws/worker");
  assert.equal(out.requiredArtifacts[0].path, "/ws/worker/output/probe.md");
  assert.equal(out.requiredArtifacts[1].path, "/abs/keep.md");
  assert.equal(out.requiredArtifacts[2].path, "~/home-keep.md");
  assert.equal(materializeExpectationPaths(null, "/ws/worker"), null);
  assert.equal(materializeExpectationPaths(src, null), src);
});
