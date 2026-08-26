import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:collaboration-toolface.test.js" });
import { runtimeAgentConfigs, agentWorkspace } from "../lib/state.js";
import {
  buildCollaborationReceipt,
  buildCollaborationTools,
} from "../lib/system-action/collaboration-toolface.js";
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES } from "../lib/protocol/protocol-primitives.js";
import { systemActionDispatch } from "../lib/system-action/system-action-runtime.js";
import { clearSystemActionDeliveryTicketStore } from "../lib/routing/delivery/delivery-system-action-ticket.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

function registerAgentWithRole(agentId, role) {
  runtimeAgentConfigs.set(agentId, {
    id: agentId,
    role,
    workspace: agentWorkspace(agentId),
  });
}

test("factory exposes exactly the role-allowed subset of the v1 tool face", () => {
  registerAgentWithRole("tf-agent", "agent");
  registerAgentWithRole("tf-executor", "executor");
  registerAgentWithRole("tf-bridge", "bridge");

  const agentTools = buildCollaborationTools({ agentId: "tf-agent", sessionKey: "agent:tf-agent:main", logger });
  assert.deepEqual(agentTools.map((tool) => tool.name).sort(), ["assign_task", "wake_agent"]);

  // executor: 授权表内没有任何协作动作 → 空工具面
  const executorTools = buildCollaborationTools({ agentId: "tf-executor", sessionKey: "agent:tf-executor:main", logger });
  assert.deepEqual(executorTools, []);

  // 未注册 agent → 空工具面(工具面永不因身份未知而放大权限)
  const unknownTools = buildCollaborationTools({ agentId: "tf-nobody", sessionKey: "agent:tf-nobody:main", logger });
  assert.deepEqual(unknownTools, []);
});

test("every exposed tool carries a JSON-schema parameters object and an execute function", () => {
  registerAgentWithRole("tf-shape", "agent");
  for (const tool of buildCollaborationTools({ agentId: "tf-shape", sessionKey: "agent:tf-shape:main", logger })) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.parameters?.type, "object");
    assert.equal(typeof tool.execute, "function");
  }
});

test("assign_task tool schema declares expectations and phases parameters (OMIT-02)", () => {
  registerAgentWithRole("tf-params", "agent");
  const tools = buildCollaborationTools({ agentId: "tf-params", sessionKey: "agent:tf-params:main", logger });
  const assignTool = tools.find((tool) => tool.name === "assign_task");
  assert.ok(assignTool);
  const props = assignTool.parameters.properties;
  // expectations:requiredArtifacts + expectedActions 两个子面,受理校验按此结构
  assert.equal(props.expectations?.type, "object");
  assert.equal(props.expectations.properties.requiredArtifacts?.type, "array");
  assert.deepEqual(props.expectations.properties.requiredArtifacts.items.required, ["path"]);
  assert.equal(props.expectations.properties.expectedActions?.type, "array");
  assert.deepEqual(props.expectations.properties.expectedActions.items.required, ["intent"]);
  // phases:派工先验阶段(字符串数组)
  assert.equal(props.phases?.type, "array");
  assert.equal(props.phases.items?.type, "string");
});

test("buildCollaborationReceipt: accepted on dispatched/queued, structured rejection otherwise", () => {
  const ok = buildCollaborationReceipt({
    status: SYSTEM_ACTION_STATUS.DISPATCHED,
    actionType: "assign_task",
    contractId: "DIRECT-9",
    deliveryTicketId: "SADT-9",
    targetAgent: "worker2",
  });
  assert.equal(ok.accepted, true);
  assert.equal(ok.contractId, "DIRECT-9");
  assert.equal(ok.deliveryTicketId, "SADT-9");

  const queued = buildCollaborationReceipt({ status: SYSTEM_ACTION_STATUS.QUEUED, actionType: "assign_task" });
  assert.equal(queued.accepted, true);
  assert.equal(queued.queued, true);
  // 位次取不到时凭证只带布尔 queued(OMIT-14)
  assert.equal("queuePosition" in queued, false);

  const queuedWithPosition = buildCollaborationReceipt({
    status: SYSTEM_ACTION_STATUS.QUEUED,
    actionType: "assign_task",
    contractId: "DIRECT-Q",
    queuePosition: 2,
  });
  assert.equal(queuedWithPosition.queued, true);
  assert.equal(queuedWithPosition.queuePosition, 2);
  // dispatched 分支免带排队字段
  const dispatched = buildCollaborationReceipt({
    status: SYSTEM_ACTION_STATUS.DISPATCHED,
    actionType: "assign_task",
    queuePosition: 1,
  });
  assert.equal("queuePosition" in dispatched, false);

  const rejected = buildCollaborationReceipt({
    status: SYSTEM_ACTION_STATUS.INVALID_STATE,
    actionType: "wake_agent",
    error: "graph disallows wake_agent from a to b",
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.code, SYSTEM_ACTION_STATUS.INVALID_STATE);
  assert.match(rejected.reason, /graph disallows/);
});

test("execute runs the platform consume path and returns the receipt as tool result", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const agentId = `tf-exec-${Date.now()}`;
  try {
    registerAgentWithRole(agentId, "agent");
    await saveGraph({ edges: [] });

    const tools = buildCollaborationTools({ agentId, sessionKey: `agent:${agentId}:main`, logger });
    const wakeTool = tools.find((tool) => tool.name === "wake_agent");
    assert.ok(wakeTool);

    // 无图边 → 受理时刻结构化拒绝(不是执行结果,是当场可改道的凭证)
    const result = await wakeTool.execute("tc-1", { targetAgent: "nobody-agent", reason: "test wake" });
    assert.equal(result.details?.accepted, false);
    assert.ok(result.details?.reason);
    const text = result.content?.[0]?.text || "";
    assert.match(text, /"accepted": false/);
  } finally {
    await saveGraph(previousGraph);
  }
}));

test("role whitelist union lets policy-granted collab tools through (P4 R1 lock)", async () => {
  const { getToolRestrictions } = await import("../lib/security/capability-preset-registry.js");
  const { listExposedToolIntents } = await import("../lib/system-action/collaboration-intent-policy.js");
  const {
    isExposedCollabToolForRole,
    listAllowedActionTypesForRole,
  } = await import("../lib/system-action/system-action-role-policy.js");
  // before-tool-call 的 2a 判定 = allowedTools.includes(tool) || isExposedCollabToolForRole:
  // 对每个受限角色,授权单源授予的暴露协作工具必须经并集放行。
  for (const role of ["planner", "reviewer", "executor", "researcher", "agent", "bridge"]) {
    const allowed = new Set(listAllowedActionTypesForRole(role));
    for (const intent of listExposedToolIntents()) {
      assert.equal(
        isExposedCollabToolForRole(role, intent),
        allowed.has(intent),
        `${role} × ${intent} union verdict must mirror the intent policy`,
      );
    }
    const restrictions = getToolRestrictions(role);
    if (restrictions?.allowedTools) {
      // 本地白名单不再需要点名协作工具(并集另一臂负责),但也不得点名策略未授予的
      for (const intent of listExposedToolIntents()) {
        if (!allowed.has(intent)) {
          assert.ok(!restrictions.allowedTools.includes(intent), `${role} whitelist must not smuggle ${intent}`);
        }
      }
    }
  }
  // 非协作工具永不经并集臂放行
  assert.equal(isExposedCollabToolForRole("planner", "bash"), false);
  assert.equal(isExposedCollabToolForRole("planner", "wake_agent"), false);
});

test("tool-face definitions equal the exposed intent set (parity)", async () => {
  const { listToolFaceDefinitionNames } = await import("../lib/system-action/collaboration-toolface.js");
  const { listExposedToolIntents } = await import("../lib/system-action/collaboration-intent-policy.js");
  assert.deepEqual([...listToolFaceDefinitionNames()].sort(), [...listExposedToolIntents()].sort());
});

test("queued assign_task receipt carries the FIFO queuePosition (OMIT-14)", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const suffix = `${Date.now()}`;
  const sourceAgent = `qp-source-${suffix}`;
  const targetAgent = `qp-target-${suffix}`;
  const dispatchContext = (contractId) => ({
    agentId: sourceAgent,
    sessionKey: `agent:${sourceAgent}:main`,
    contractData: { id: contractId },
    api: { runtime: { system: { requestHeartbeatNow() {} } } },
    logger,
    actionReplyTo: { agentId: sourceAgent, sessionKey: `agent:${sourceAgent}:main` },
  });

  try {
    for (const id of [sourceAgent, targetAgent]) {
      runtimeAgentConfigs.set(id, { id, role: "agent", workspace: agentWorkspace(id) });
    }
    await saveGraph({ edges: [{ from: sourceAgent, to: targetAgent, label: "assign" }] });
    await clearSystemActionDeliveryTicketStore();

    // 目标 inbox 被占 → 后续派工进落盘队列(promoted=false)
    const targetInbox = join(agentWorkspace(targetAgent), "inbox");
    await mkdir(targetInbox, { recursive: true });
    await writeFile(join(targetInbox, "contract.json"), JSON.stringify({ id: `BUSY-${suffix}`, status: "running" }));

    const first = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: { targetAgent, message: "排队任务一" },
    }, dispatchContext(`TC-QP-1-${suffix}`));
    assert.equal(first.status, SYSTEM_ACTION_STATUS.QUEUED);
    assert.equal(first.queuePosition, 1);

    const second = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: { targetAgent, message: "排队任务二" },
    }, dispatchContext(`TC-QP-2-${suffix}`));
    assert.equal(second.status, SYSTEM_ACTION_STATUS.QUEUED);
    assert.equal(second.queuePosition, 2);

    // 凭证面透传位次(spec §5: {accepted, contractId, queuePosition})
    const receipt = buildCollaborationReceipt(second);
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.queued, true);
    assert.equal(receipt.queuePosition, 2);
    assert.equal(receipt.contractId, second.contractId);
  } finally {
    await saveGraph(previousGraph);
    await clearSystemActionDeliveryTicketStore();
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));
