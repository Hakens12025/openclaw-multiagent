import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:task-stage-runtime.test.js" });
import { dispatchCreateExecutionContractEntry } from "../lib/ingress/dispatch-execution-contract-entry.js";
import { getContractPath, listLifecycleWorkItems, persistContractById } from "../lib/contract/contracts.js";
import { listTreeContractPaths } from "../lib/store/contract-store.js";
import { createTrackingState, bindInboxContractEnvelope } from "../lib/session/session-bootstrap.js";
import { buildProgressPayload } from "../lib/transport/sse.js";
import {
  agentWorkspace,
  dispatchTargetStateMap,
  runtimeAgentConfigs,
  taskHistory,
  apiRef,
  setApiRef,
} from "../lib/state.js";
import { normalizeStageRunResult } from "../lib/stage/stage-results.js";
import { applyTrackingStageProjection } from "../lib/stage/stage-projection.js";
import { listAgentEndMainStages } from "../lib/lifecycle/agent-end/lifecycle.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { dispatchAcceptIngressMessage } from "../lib/ingress/dispatch-entry.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function cleanupContracts(prefix) {
  // 正本落树内(threads/{t}/runs/{r}/contracts/),同前缀一并清理
  try {
    const treePaths = await listTreeContractPaths();
    await Promise.all(
      treePaths
        .filter((contractPath) => basename(contractPath).startsWith(prefix))
        .map((contractPath) => rm(contractPath, { force: true })),
    );
  } catch {}
}

function uniqueTask(label) {
  return `${label} [test:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}]`;
}

async function readPersistedContractForResult(result, message) {
  assert.ok(result?.contractId, message);
  const contractPath = getContractPath(result.contractId);
  const persisted = JSON.parse(await readFile(contractPath, "utf8"));
  return { contractPath, persisted };
}

async function listPersistedContractsByTask(task) {
  // 正本落树内(task 经 uniqueTask() 全局唯一,跨文件残留不会误配)。
  const candidates = [];
  for (const contractPath of await listTreeContractPaths()) {
    candidates.push({ fileName: basename(contractPath), contractPath });
  }
  const matches = [];
  for (const { fileName, contractPath } of candidates) {
    if (!fileName.startsWith("TC-") || !fileName.endsWith(".json")) continue;
    try {
      const persisted = JSON.parse(await readFile(contractPath, "utf8"));
      if (persisted?.task === task) {
        matches.push({ fileName, contractPath, persisted });
      }
    } catch {}
  }
  return matches;
}

async function readOnlyPersistedContractByTask(task) {
  const matches = await listPersistedContractsByTask(task);
  assert.equal(matches.length, 1);
  return matches[0];
}

async function assertNoPersistedContractWithTask(task) {
  const matches = await listPersistedContractsByTask(task);
  assert.deepEqual(matches.map((entry) => entry.fileName), []);
}

function restoreRuntimeAgentConfigs(snapshot) {
  runtimeAgentConfigs.clear();
  for (const [agentId, config] of snapshot.entries()) {
    runtimeAgentConfigs.set(agentId, config);
  }
}

test("dispatchCreateExecutionContractEntry writes definition-only stagePlan and separate stageRuntime", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("runtime stage truth ingress");
    const result = await dispatchCreateExecutionContractEntry({
      message: task,
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:stage-runtime-${Date.now()}` },
      operatorContext: null,
      wakeContractor: async () => null,
      logger,
      phases: [
        "  建立比较维度  ",
        { name: " 补充关键证据 " },
        "形成结论",
      ],
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.ok(persisted.stagePlan && typeof persisted.stagePlan === "object");
    assert.ok(!("currentStageId" in persisted.stagePlan));
    assert.ok(!("completedStageIds" in persisted.stagePlan));
    assert.deepEqual(
      persisted.stagePlan.stages.map((entry) => entry.label),
      ["建立比较维度", "补充关键证据", "形成结论"],
    );
    assert.deepEqual(persisted.stageRuntime, {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    });
    assert.deepEqual(persisted.phases, ["建立比较维度", "补充关键证据", "形成结论"]);
    assert.equal(persisted.total, 3);
    assert.equal("fastTrack" in persisted, false);
    assert.equal("route" in (persisted.protocol || {}), false);
    assert.equal(persisted.runtimeContext?.version, 1);
    assert.equal(persisted.runtimeContext?.currentTime?.unixMs, persisted.createdAt);
    assert.equal(
      persisted.runtimeContext?.currentTime?.iso,
      new Date(persisted.createdAt).toISOString(),
    );
    assert.equal(typeof persisted.runtimeContext?.currentTime?.text, "string");

    await rm(contractPath, { force: true });
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry does not persist a fake worker assignee when ingress has no graph first hop", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();

  try {
    await saveGraph({ edges: [] });

    const task = uniqueTask("ingress assignee truth");
    const result = await dispatchCreateExecutionContractEntry({
      message: task,
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:assignee-${Date.now()}` },
      operatorContext: null,
      wakeContractor: async () => null,
      logger,
      phases: ["分析", "执行"],
    });

    assert.equal(result.ok, false);

    const { contractPath, persisted } = await readOnlyPersistedContractByTask(task);
    assert.equal(persisted.assignee ?? null, null);

    await rm(contractPath, { force: true });
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry rejects unauthorized explicit targets before persisting a contract", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("unauthorized target should not leave shared state");
    const result = await dispatchCreateExecutionContractEntry({
      message: task,
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:unauthorized-${Date.now()}` },
      targetAgent: "worker",
      operatorContext: null,
      api: null,
      logger,
      phases: ["执行"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "unauthorized_explicit_target");
    assert.equal(result.targetAgent, "worker");

    await assertNoPersistedContractWithTask(task);
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry rejects hidden control-plane targets before persisting a contract", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
    runtimeAgentConfigs.set("operator", {
      id: "operator",
      role: "agent",
      plane: "control_plane",
      mainViewVisible: false,
      formalTimelineVisible: false,
      autoWakeEligible: false,
    });
    await saveGraph({
      edges: [
        { from: "controller", to: "operator", label: "invalid-control-target" },
      ],
    });

    const task = uniqueTask("hidden operator should not receive an execution contract");
    const result = await dispatchCreateExecutionContractEntry({
      message: task,
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:hidden-target-${Date.now()}` },
      targetAgent: "operator",
      operatorContext: null,
      api: null,
      logger,
      phases: ["执行"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "target_not_task_runtime");
    assert.equal(result.targetAgent, "operator");

    await assertNoPersistedContractWithTask(task);
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry rejects graph first hop into hidden control-plane target before persisting", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
    runtimeAgentConfigs.set("operator", {
      id: "operator",
      role: "agent",
      plane: "control_plane",
      mainViewVisible: false,
      formalTimelineVisible: false,
      autoWakeEligible: false,
    });
    await saveGraph({
      edges: [
        { from: "controller", to: "operator", label: "invalid-control-target" },
      ],
    });

    const task = uniqueTask("graph first hop should not be control plane");
    const result = await dispatchCreateExecutionContractEntry({
      message: task,
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:hidden-first-hop-${Date.now()}` },
      operatorContext: null,
      api: null,
      logger,
      phases: ["执行"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "target_not_task_runtime");
    assert.equal(result.targetAgent, "operator");

    await assertNoPersistedContractWithTask(task);
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry preserves direct user wording for greetings without injecting protocol hardening", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const result = await dispatchCreateExecutionContractEntry({
      message: "你好",
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:greeting-${Date.now()}` },
      operatorContext: null,
      wakeContractor: async () => null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, "你好");
    assert.doesNotMatch(persisted.task, /用户原话/u);
    assert.doesNotMatch(persisted.task, /不要只重复原句/u);
    assert.doesNotMatch(persisted.task, /不要只在聊天里回答/u);
    assert.doesNotMatch(persisted.task, /contract\.output/u);

    await rm(contractPath, { force: true });
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry persists explicit dispatch owner and resolves first hop from it", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("worker2", {
      id: "worker2",
      role: "executor",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
    runtimeAgentConfigs.set("reviewer", {
      id: "reviewer",
      role: "reviewer",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
        { from: "worker2", to: "reviewer", label: "handoff" },
      ],
    });

    const task = uniqueTask("system random should start from explicit owner");
    const result = await dispatchCreateExecutionContractEntry({
      message: task,
      source: "system",
      effectiveReplyTo: { agentId: "test-run", sessionKey: `test-run:${Date.now()}` },
      dispatchOwnerAgentId: "worker2",
      operatorContext: null,
      api: null,
      logger,
      phases: ["执行"],
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(result.targetAgent, "reviewer");
    // 账物分离 batch2:owner 不再写正本;assignee 落到对的首跳即证明 owner 解析正确。
    assert.equal(persisted.dispatchOwnerAgentId, undefined);
    assert.equal(persisted.assignee, "reviewer");

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage does not inject a default stage plan when phases are omitted", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("对比三个框架优缺点");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "webui",
      replyTo: { agentId: "controller", sessionKey: `agent:controller:stage-planner-${Date.now()}` },
      api: null,
      wakeContractor: async () => null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected incoming message to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal("stagePlan" in persisted, false);
    assert.equal("stageRuntime" in persisted, false);
    assert.equal("phases" in persisted, false);
    assert.equal("total" in persisted, false);

    await rm(contractPath, { force: true });
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage rejects QQ ingress without live reply target", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    await assert.rejects(
      dispatchAcceptIngressMessage("给worker发个任务，研究一下react是啥", {
        source: "qq",
        replyTo: {
          agentId: "controller",
          sessionKey: "agent:controller:main",
        },
        api: null,
        logger,
      }),
      /live QQ reply target/u,
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage preserves QQ passive reply metadata on bridge ingress", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("给worker发个任务，研究一下react是啥");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "qq",
      replyTo: {
        agentId: "controller",
        sessionKey: "agent:controller:main",
        channel: "qqbot",
        target: "c2c:openid-1",
        messageId: "qq-message-1",
        replyToId: "qq-message-1",
        accountId: "default",
      },
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected qq ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(persisted.replyTo?.channel, "qqbot");
    assert.equal(persisted.replyTo?.target, "c2c:openid-1");
    assert.equal(persisted.replyTo?.messageId, "qq-message-1");
    assert.equal(persisted.replyTo?.replyToId, "qq-message-1");
    assert.equal(persisted.replyTo?.accountId, "default");

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage rejects qqbot source without live reply target", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    await assert.rejects(
      dispatchAcceptIngressMessage("qq ingress without explicit target", {
        source: "qq",
        replyTo: {
          agentId: "controller",
          sessionKey: "agent:controller:main",
        },
        api: null,
        logger,
      }),
      /live QQ reply target/u,
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage rejects qqbot alias without live reply target", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    await assert.rejects(
      dispatchAcceptIngressMessage("qqbot alias ingress", {
        source: "qqbot",
        replyTo: null,
        api: null,
        logger,
      }),
      /live QQ reply target/u,
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage rejects synthetic QQ reply targets before terminal delivery", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    await assert.rejects(
      dispatchAcceptIngressMessage("qq visible synthetic target probe", {
        source: "qq",
        replyTo: {
          agentId: "controller",
          sessionKey: "agent:controller:main",
          channel: "qqbot",
          target: "c2c:synthetic-test",
          messageId: "synthetic-msg",
          replyToId: "synthetic-msg",
          accountId: "default",
        },
        api: null,
        logger,
      }),
      /synthetic QQ reply target/u,
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage preserves QQ group reply target prefix on bridge ingress", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("群聊里来的任务");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "qq",
      replyTo: {
        agentId: "controller",
        sessionKey: "agent:controller:main",
        channel: "qqbot",
        target: "group:group-openid-1",
        messageId: "group-message-1",
        replyToId: "group-message-1",
        accountId: "default",
      },
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected qq ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(persisted.replyTo?.channel, "qqbot");
    assert.equal(persisted.replyTo?.target, "group:group-openid-1");
    assert.equal(persisted.replyTo?.messageId, "group-message-1");
    assert.equal(persisted.replyTo?.replyToId, "group-message-1");
    assert.equal(persisted.replyTo?.accountId, "default");

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry falls back to runtime apiRef to wake planner on first-hop ingress", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const originalApiRef = apiRef;
  const heartbeatCalls = [];

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    setApiRef({
      runtime: {
        system: {
          requestHeartbeatNow(payload) {
            heartbeatCalls.push(payload);
          },
        },
      },
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("hello planner wake fallback");
    const result = await dispatchCreateExecutionContractEntry({
      message: task,
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:wake-fallback-${Date.now()}` },
      operatorContext: null,
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected ingress to create a contract snapshot",
    );

    assert.equal(result.targetAgent, "planner");
    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls[0]?.agentId, "planner");
    assert.equal(heartbeatCalls[0]?.sessionKey, `agent:planner:contract:${result.contractId}`);
    assert.match(heartbeatCalls[0]?.reason || "", new RegExp(`current contract: ${result.contractId}`));
    assert.doesNotMatch(heartbeatCalls[0]?.reason || "", /任务：|输出路径：|runtime_result/u);

    await rm(contractPath, { force: true });
  } finally {
    setApiRef(originalApiRef);
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage routes a2a ingress through front-desk graph owner while preserving external reply target", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("研究 React 是什么，输出一份简要说明");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "a2a",
      replyTo: {
        agentId: "worker",
        sessionKey: "agent:worker:main",
      },
      ingressDirective: {},
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected a2a ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(result.targetAgent, "planner");
    assert.equal(persisted.replyTo?.agentId, "worker");
    // 账物分离 batch2:owner 不再写正本;assignee 落到对的首跳即证明 owner 解析正确。
    assert.equal(persisted.dispatchOwnerAgentId, undefined);
    assert.equal(persisted.assignee, "planner");

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage ignores external targetAgent on a2a ingress and follows graph first hop", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });
    runtimeAgentConfigs.set("worker", {
      id: "worker",
      role: "executor",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("研究 React 是什么，输出一份简要说明");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "a2a",
      replyTo: {
        agentId: "worker",
        sessionKey: "agent:worker:main",
      },
      ingressDirective: {
        targetAgent: "worker",
      },
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected a2a ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(result.targetAgent, "planner");
    assert.equal(persisted.replyTo?.agentId, "worker");
    // 账物分离 batch2:owner 不再写正本;assignee 落到对的首跳即证明 owner 解析正确。
    assert.equal(persisted.dispatchOwnerAgentId, undefined);
    assert.equal(persisted.assignee, "planner");

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage ignores external replyTo agent for a2a dispatch owner selection", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("worker", {
      id: "worker",
      role: "executor",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });
    runtimeAgentConfigs.set("reviewer", {
      id: "reviewer",
      role: "reviewer",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
        { from: "worker", to: "reviewer", label: "worker-next" },
      ],
    });

    const task = uniqueTask("external reply target must not choose graph origin");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "a2a",
      replyTo: {
        agentId: "worker",
        sessionKey: "agent:worker:main",
      },
      ingressDirective: {
        targetAgent: "reviewer",
      },
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected a2a ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(result.targetAgent, "planner");
    assert.equal(persisted.replyTo?.agentId, "worker");
    // 账物分离 batch2:owner 不再写正本;assignee 落到对的首跳即证明 owner 解析正确。
    assert.equal(persisted.dispatchOwnerAgentId, undefined);
    assert.equal(persisted.assignee, "planner");

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage does not convert non-QQ reply target into QQ transport", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      protected: true,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("a2a bridge reply remains internal");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "a2a",
      replyTo: {
        agentId: "controller",
        sessionKey: "agent:controller:main",
      },
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected a2a ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(persisted.replyTo?.agentId, "controller");
    assert.equal(persisted.replyTo?.channel, undefined);
    assert.equal(persisted.replyTo?.target, undefined);

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry generates distinct contract ids even within the same millisecond", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalNow = Date.now;

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    Date.now = () => 1_777_000_000_000;

    const first = await dispatchCreateExecutionContractEntry({
      message: "first collision probe",
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: "agent:controller:collision-1" },
      operatorContext: null,
      api: null,
      logger,
      phases: ["执行"],
    });

    const second = await dispatchCreateExecutionContractEntry({
      message: "second collision probe",
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: "agent:controller:collision-2" },
      operatorContext: null,
      api: null,
      logger,
      phases: ["执行"],
    });

    assert.notEqual(first.contractId, second.contractId);
  } finally {
    Date.now = originalNow;
    await saveGraph(originalGraph);
    await cleanupContracts("TC-1777000000000");
  }
}));

test("dispatchAcceptIngressMessage routes webui create_task by ingress owner instead of system_action reply target", async () => runGlobalTestEnvironmentSerial(async () => {
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("planner", {
      id: "planner",
      role: "planner",
      gateway: false,
      ingressSource: null,
      specialized: false,
      skills: [],
    });
    runtimeAgentConfigs.set("worker2", {
      id: "worker2",
      role: "executor",
      gateway: false,
      ingressSource: null,
      specialized: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const task = uniqueTask("create_task child should still enter from controller");
    const result = await dispatchAcceptIngressMessage(task, {
      source: "webui",
      replyTo: {
        agentId: "worker2",
        sessionKey: `agent:worker2:contract:create-task-${Date.now()}`,
      },
      upstreamReplyTo: {
        agentId: "controller",
        sessionKey: "agent:controller:main",
      },
      returnContext: {
        sourceAgentId: "worker2",
        sourceContractId: `TC-PARENT-${Date.now()}`,
        sourceSessionKey: `agent:worker2:contract:parent-${Date.now()}`,
        intentType: "create_task",
      },
      api: null,
      logger,
    });

    const { contractPath, persisted } = await readPersistedContractForResult(
      result,
      "expected create_task ingress to create a contract snapshot",
    );

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.task, task);
    assert.equal(persisted.replyTo?.agentId, "worker2");
    assert.equal(persisted.assignee, "planner");

    await rm(contractPath, { force: true });
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));


test("bindInboxContractEnvelope maps stageRuntime separately from definition-only stagePlan", async () => {
  const agentId = `stage-runtime-bind-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const contractPath = join(inboxDir, "contract.json");
  const original = await readFile(contractPath, "utf8").catch(() => null);
  await mkdir(inboxDir, { recursive: true });

  const contract = {
    id: `TC-STAGE-RUNTIME-BIND-${Date.now()}`,
    task: "bind stage runtime truth",
    assignee: agentId,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "分析", semanticLabel: "分析", status: "active" },
        { id: "stage-2", label: "写报告", semanticLabel: "写报告", status: "pending" },
      ],
      revisionCount: 0,
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
      lastRevisionReason: null,
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    phases: ["stale-phase"],
    total: 999,
    output: join(agentWorkspace("controller"), "output", `TC-STAGE-RUNTIME-BIND-${Date.now()}.md`),
  };
  await writeFile(contractPath, JSON.stringify(contract, null, 2), "utf8");
  dispatchTargetStateMap.set(agentId, {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: Date.now(),
    currentContract: contract.id,
    queue: [],
  });

  const trackingState = createTrackingState({
    sessionKey: `agent:${agentId}:stage-runtime:${Date.now()}`,
    agentId,
    parentSession: null,
  });

  const bound = await bindInboxContractEnvelope({
    agentId,
    trackingState,
    logger,
    allowNonDirectRequest: true,
  });

  assert.equal(bound?.contract?.id, contract.id);
  assert.ok(!("currentStageId" in trackingState.contract?.stagePlan));
  assert.ok(!("completedStageIds" in trackingState.contract?.stagePlan));
  assert.equal(trackingState.contract?.stageRuntime?.currentStageId, "stage-1");
  assert.deepEqual(trackingState.contract?.stageRuntime?.completedStageIds, []);
  assert.deepEqual(trackingState.contract?.phases, ["分析", "写报告"]);
  assert.equal(trackingState.contract?.total, 2);

  if (original === null) {
    dispatchTargetStateMap.delete(agentId);
    await rm(workspaceDir, { recursive: true, force: true });
  } else {
    dispatchTargetStateMap.delete(agentId);
    await writeFile(contractPath, original);
  }
});

test("extract_output_markers preserves rich stage definitions while ignoring planner-written witness residue", async () => {
  const contractId = `TC-STAGE-MARKER-RICH-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const outputDir = join(agentWorkspace("controller"), "output");
  const outputPath = join(outputDir, `${contractId}.md`);
  const extractStage = listAgentEndMainStages().find((stage) => stage.id === "extract_output_markers");
  assert.ok(extractStage, "expected extract_output_markers stage");

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, [
    "[STAGE 1] 建立比较维度",
    "- 目标: 明确三类技术对比维度",
    "- 交付: 对比维度清单",
    "- 完成标准: 至少列出三个维度",
    "- 见证: 主产物已生成且非空",
    "",
    "[STAGE 2] 补充关键证据",
    "- Goal: 收集每个方案的关键证据",
    "- Deliverable: 证据摘要",
    "- Completion: 每个方案至少两条证据",
    "- Witness: 主产物已生成且非空",
    "- Witness: 评审通过",
  ].join("\n"), "utf8");

  contractPath = await persistContractById({
    id: contractId,
    task: "preserve rich marker definitions",
    assignee: "worker",
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phases: [],
    total: 0,
    output: outputPath,
  }, logger);

  const trackingState = createTrackingState({
    sessionKey: `agent:worker:stage-marker-rich:${Date.now()}`,
    agentId: "worker",
    parentSession: null,
  });
  trackingState.contract = {
    id: contractId,
    path: contractPath,
    task: "preserve rich marker definitions",
    status: CONTRACT_STATUS.PENDING,
    output: outputPath,
  };

  try {
    await extractStage.run({
      event: { success: true },
      executionObservation: {
        primaryOutputPath: outputPath,
        contractId,
      },
      trackingState,
      logger,
    });

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.deepEqual(
      persisted.stagePlan?.stages?.map((entry) => ({
        label: entry.label,
        objective: entry.objective,
        deliverable: entry.deliverable,
        completionCriteria: entry.completionCriteria,
        witness: entry.witness,
      })),
      [
        {
          label: "建立比较维度",
          objective: "明确三类技术对比维度",
          deliverable: "对比维度清单",
          completionCriteria: "至少列出三个维度",
          witness: [],
        },
        {
          label: "补充关键证据",
          objective: "收集每个方案的关键证据",
          deliverable: "证据摘要",
          completionCriteria: "每个方案至少两条证据",
          witness: [],
        },
      ],
    );
    assert.deepEqual(
      trackingState.contract?.stagePlan?.stages?.map((entry) => ({
        label: entry.label,
        objective: entry.objective,
        deliverable: entry.deliverable,
        completionCriteria: entry.completionCriteria,
        witness: entry.witness,
      })),
      [
        {
          label: "建立比较维度",
          objective: "明确三类技术对比维度",
          deliverable: "对比维度清单",
          completionCriteria: "至少列出三个维度",
          witness: [],
        },
        {
          label: "补充关键证据",
          objective: "收集每个方案的关键证据",
          deliverable: "证据摘要",
          completionCriteria: "每个方案至少两条证据",
          witness: [],
        },
      ],
    );
  } finally {
    await rm(contractPath, { force: true });
    await rm(outputPath, { force: true });
  }
});

test("listLifecycleWorkItems carries canonical stagePlan and compatibility phases/total derived from it", async () => {
  clearTrackingStore();
  taskHistory.length = 0;
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:lifecycle-stage-runtime:${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-LIFECYCLE-${Date.now()}`,
    task: "lifecycle stage runtime truth",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "completed" },
        { id: "stage-2", label: "交叉比较", semanticLabel: "交叉比较", status: "active" },
        { id: "stage-3", label: "形成结论", semanticLabel: "形成结论", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    phases: ["legacy-stale-phase"],
    total: 111,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rememberTrackingState(trackingState.sessionKey, trackingState);

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === trackingState.contract.id);
  assert.ok(snapshot, "expected lifecycle snapshot for tracking contract");
  assert.equal(snapshot.stageRuntime.currentStageId, "stage-2");
  assert.deepEqual(snapshot.stageRuntime.completedStageIds, ["stage-1"]);
  assert.deepEqual(snapshot.phases, ["收集证据", "交叉比较", "形成结论"]);
  assert.equal(snapshot.total, 3);

  clearTrackingStore();
  taskHistory.length = 0;
  await cleanupContracts("TC-STAGE-RUNTIME-LIFECYCLE-");
});

test("listLifecycleWorkItems prefers live tracker stageRuntime over stale running history", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const contractId = `TC-STAGE-RUNTIME-LIVE-OVER-HISTORY-${Date.now()}`;
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:lifecycle-live-runtime:${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: contractId,
    task: "live tracker runtime should stay authoritative",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据" },
        { id: "stage-2", label: "交叉比较", semanticLabel: "交叉比较" },
        { id: "stage-3", label: "形成结论", semanticLabel: "形成结论" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 2,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    phases: ["legacy-stale-phase"],
    total: 111,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  };
  trackingState.stageProjection = {
    source: "task_stage_truth",
    confidence: "planner",
    stagePlan: ["收集证据", "交叉比较", "形成结论"],
    completedStages: ["收集证据"],
    currentStage: "stage-2",
    currentStageLabel: "交叉比较",
    cursor: "1/3",
    pct: 33,
    done: 1,
    total: 3,
    round: null,
    runtimeStatus: CONTRACT_STATUS.RUNNING,
  };
  rememberTrackingState(trackingState.sessionKey, trackingState);

  taskHistory.push({
    sessionKey: "agent:planner:contract:history-stage-1",
    contractId,
    task: trackingState.contract.task,
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: trackingState.contract.stagePlan,
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    phases: ["收集证据", "交叉比较", "形成结论"],
    total: 3,
    createdAt: trackingState.contract.createdAt,
    updatedAt: trackingState.contract.updatedAt - 500,
    endMs: Date.now() - 500,
  });

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === contractId);
  assert.ok(snapshot, "expected lifecycle snapshot for live tracking contract");
  assert.equal(snapshot.stageRuntime?.currentStageId, "stage-2");
  assert.deepEqual(snapshot.stageRuntime?.completedStageIds, ["stage-1"]);
  assert.equal(snapshot.source, "tracker");

  clearTrackingStore();
  taskHistory.length = 0;
});

test("listLifecycleWorkItems keeps fresher terminal snapshot status over stale running history", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const contractId = `TC-STAGE-RUNTIME-SNAPSHOT-WINS-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const createdAt = Date.now() - 2000;
  const snapshotUpdatedAt = Date.now();

  contractPath = await persistContractById({
    id: contractId,
    task: "terminal snapshot should stay authoritative over stale history",
    status: CONTRACT_STATUS.CANCELLED,
    terminalOutcome: {
      version: 1,
      status: CONTRACT_STATUS.CANCELLED,
      source: "test_snapshot",
      reason: "historic_orphan_cleanup",
      summary: "snapshot terminal truth",
      ts: snapshotUpdatedAt,
    },
    createdAt,
    updatedAt: snapshotUpdatedAt,
  }, logger);

  taskHistory.push({
    sessionKey: `agent:worker-d:history-running:${Date.now()}`,
    contractId,
    task: "terminal snapshot should stay authoritative over stale history",
    status: CONTRACT_STATUS.RUNNING,
    createdAt,
    updatedAt: snapshotUpdatedAt - 1000,
    endMs: snapshotUpdatedAt - 1000,
  });

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === contractId);
  assert.ok(snapshot, "expected lifecycle snapshot for shared contract");
  assert.equal(snapshot.status, CONTRACT_STATUS.CANCELLED);
  assert.equal(snapshot.terminalOutcome?.reason, "historic_orphan_cleanup");

  taskHistory.length = 0;
  await cleanupContracts(contractId);
});

test("listLifecycleWorkItems does not promote stageProjection fallback into canonical stage truth", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:lifecycle-projection-fallback:${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-PROJECTION-${Date.now()}`,
    task: "projection fallback should stay non-canonical",
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  trackingState.stageProjection = {
    source: "runtime_stage",
    stagePlan: ["executor-a", "executor-b"],
    completedStages: ["executor-a"],
    currentStage: "executor-b",
    currentStageLabel: "executor-b",
    cursor: "1/2",
    pct: 50,
    done: 1,
    total: 2,
    round: null,
    runtimeStatus: CONTRACT_STATUS.RUNNING,
  };
  rememberTrackingState(trackingState.sessionKey, trackingState);

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === trackingState.contract.id);
  assert.ok(snapshot, "expected lifecycle snapshot for projection fallback contract");
  assert.equal(snapshot.stagePlan, null);
  assert.equal(snapshot.phases, undefined);
  assert.equal(snapshot.total, undefined);
  assert.equal(snapshot.stageProjection?.currentStage, "executor-b");

  clearTrackingStore();
  taskHistory.length = 0;
});

test("listLifecycleWorkItems ignores taskHistory entries (history merge retired, tree contracts are the source)", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const contractId = `TC-STAGE-RUNTIME-HISTORY-RETIRED-${Date.now()}`;
  taskHistory.push({
    sessionKey: `agent:worker-d:lifecycle-history-retired:${Date.now()}`,
    contractId,
    task: "history-only entry must stay invisible",
    status: CONTRACT_STATUS.COMPLETED,
    hasContract: true,
    endMs: Date.now(),
  });

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === contractId);
  assert.equal(snapshot, undefined, "内存 taskHistory 不再是 work_items 数据源");

  clearTrackingStore();
  taskHistory.length = 0;
});

test("listLifecycleWorkItems excludes session-only tracking entries without contract or artifact semantics", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const sessionKey = `agent:controller:main:${Date.now()}`;
  const trackingState = createTrackingState({
    sessionKey,
    agentId: "controller",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  rememberTrackingState(sessionKey, trackingState);

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === sessionKey);

  assert.equal(snapshot, undefined);

  clearTrackingStore();
  taskHistory.length = 0;
});

test("buildProgressPayload marks contract-backed sessions with contract_backed work item kind", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-a:contract-kind:${Date.now()}`,
    agentId: "worker-a",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-WORK-ITEM-KIND-${Date.now()}`,
    task: "contract-backed work item kind",
    taskType: "research_analysis",
    assignee: "worker-a",
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const payload = buildProgressPayload(trackingState);

  assert.equal(payload.hasContract, true);
  assert.equal(payload.workItemKind, "contract_backed");
  assert.equal(payload.workItemId, trackingState.contract.id);
});

test("buildProgressPayload and lifecycle snapshots carry system-owned activity cursor", async () => {
  const sessionKey = `agent:worker-activity:cursor:${Date.now()}`;
  const trackingState = createTrackingState({
    sessionKey,
    agentId: "worker-activity",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-ACTIVITY-CURSOR-${Date.now()}`,
    task: "activity cursor should stay system-owned and visible",
    taskType: "research_analysis",
    assignee: "worker-activity",
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  trackingState.lastLabel = "读取网页: react.dev";
  trackingState.activityCursor = {
    source: "framework_tool_event",
    kind: "read_remote",
    label: "读取网页: react.dev",
    toolName: "web_fetch",
    observedAt: Date.now(),
  };

  rememberTrackingState(sessionKey, trackingState);

  const payload = buildProgressPayload(trackingState);
  assert.deepEqual(payload.activityCursor, trackingState.activityCursor);

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === trackingState.contract.id);
  assert.ok(snapshot, "expected tracker-backed lifecycle snapshot");
  assert.equal(snapshot?.lastLabel, "读取网页: react.dev");
  assert.deepEqual(snapshot?.activityCursor, trackingState.activityCursor);
});

test("normalizeStageRunResult keeps semantic stage id and revision data but drops semantic completion action residue", () => {
  const normalized = normalizeStageRunResult({
    stage: "contractor",
    status: "completed",
    semanticStageId: "stage-2",
    semanticStageAction: "complete",
    stagePlanRevision: {
      reason: "refine next steps",
      stages: ["收集证据", { label: "  交叉比较  " }, "形成结论"],
    },
  });

  assert.equal(normalized.semanticStageId, "stage-2");
  assert.equal("semanticStageAction" in normalized, false);
  assert.deepEqual(normalized.stagePlanRevision, {
    reason: "refine next steps",
    stages: ["收集证据", { label: "  交叉比较  " }, "形成结论"],
  });
});

test("applyTrackingStageProjection prefers canonical task-stage truth with runtime observation even when terminal", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-semantic-terminal-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-SEMANTIC-TERMINAL-${Date.now()}`,
    task: "semantic completion under canonical truth",
    status: CONTRACT_STATUS.COMPLETED,
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "active" },
        { id: "stage-2", label: "形成结论", semanticLabel: "形成结论", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    executionObservation: {
      collected: true,
      primaryOutputPath: "/runtime/contracts/terminal-observed-output.md",
      artifactPaths: ["/runtime/contracts/terminal-observed-output.md"],
      // 判决面重做:阶段推进按自报,产物观测本身不再推进阶段。
      stageRunResult: { version: 1, status: "completed", summary: "收集完成" },
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(projection.stagePlan, ["收集证据", "形成结论"]);
  assert.deepEqual(projection.completedStages, ["收集证据"]);
  assert.equal(projection.currentStage, "stage-2");
  assert.equal(projection.currentStageLabel, "形成结论");
  assert.equal(projection.cursor, "1/2");
  assert.equal(projection.pct, 50);
});

test("applyTrackingStageProjection does not auto-complete canonical stages from terminal status alone", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-terminal-no-evidence-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-TERMINAL-NO-EVIDENCE-${Date.now()}`,
    task: "terminal status without runtime stage evidence",
    status: CONTRACT_STATUS.COMPLETED,
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据" },
        { id: "stage-2", label: "形成结论", semanticLabel: "形成结论" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(projection.stagePlan, ["收集证据", "形成结论"]);
  assert.deepEqual(projection.completedStages, []);
  assert.equal(projection.currentStage, "stage-1");
  assert.equal(projection.currentStageLabel, "收集证据");
  assert.equal(projection.cursor, "0/2");
  assert.equal(projection.pct, 0);
});

test("applyTrackingStageProjection reaches 100% when runtime review witness closes final canonical stage", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-semantic-final-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-SEMANTIC-FINAL-${Date.now()}`,
    task: "semantic completion final stage",
    status: CONTRACT_STATUS.COMPLETED,
    stagePlan: {
      version: 2,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "completed" },
        {
          id: "stage-2",
          label: "形成结论",
          semanticLabel: "形成结论",
          status: "active",
          witness: [{ kind: "review_verdict", expected: "pass" }],
        },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    executionObservation: {
      collected: true,
      reviewerResult: {
        verdict: "pass",
      },
      // 判决面重做:评审结论是执行面产物(转述),不再当阶段证人;收尾阶段按自报关闭。
      stageRunResult: { version: 1, status: "completed", summary: "结论成稿" },
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(projection.completedStages, ["收集证据", "形成结论"]);
  assert.equal(projection.cursor, "2/2");
  assert.equal(projection.pct, 100);
});

test("applyTrackingStageProjection ignores invalid stagePlanRevision and keeps canonical truth", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-semantic-invalid-revision-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-SEMANTIC-INVALID-REVISION-${Date.now()}`,
    task: "invalid revision should not mutate canonical truth",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: {
      version: 3,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "completed" },
        { id: "stage-2", label: "交叉比较", semanticLabel: "交叉比较", status: "active" },
        { id: "stage-3", label: "形成结论", semanticLabel: "形成结论", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    stageRunResult: {
      status: "completed",
      stagePlanRevision: {
        reason: "rewrite completed stage",
        stages: ["重写历史", "交叉比较", "形成结论"],
      },
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  // 坏修订被拒(计划保持原名);自报 completed 照常推进当前阶段——两件事独立。
  assert.deepEqual(projection.stagePlan, ["收集证据", "交叉比较", "形成结论"]);
  assert.deepEqual(projection.completedStages, ["收集证据", "交叉比较"]);
  assert.equal(projection.currentStage, "stage-3");
  assert.equal(projection.currentStageLabel, "形成结论");
  assert.equal(projection.cursor, "2/3");
  assert.equal(projection.pct, 67);
});

test("applyTrackingStageProjection does not let runtime-backed completion-time revision rewrite newly completed history", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-semantic-rewrite-history-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-SEMANTIC-REWRITE-HISTORY-${Date.now()}`,
    task: "completion-time revision must not rewrite completed stage",
    status: CONTRACT_STATUS.COMPLETED,
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "active" },
        { id: "stage-2", label: "形成结论", semanticLabel: "形成结论", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    executionObservation: {
      collected: true,
      primaryOutputPath: "/runtime/contracts/rewrite-history.md",
      artifactPaths: ["/runtime/contracts/rewrite-history.md"],
    },
    stageRunResult: {
      status: "completed",
      stagePlanRevision: {
        reason: "rewrite just completed stage",
        stages: ["改写历史", "形成结论"],
      },
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(projection.stagePlan, ["收集证据", "形成结论"]);
  assert.deepEqual(projection.completedStages, ["收集证据"]);
  assert.equal(projection.currentStage, "stage-2");
  assert.equal(projection.currentStageLabel, "形成结论");
  assert.equal(projection.cursor, "1/2");
  assert.equal(projection.pct, 50);
});

test("applyTrackingStageProjection keeps canonical task-stage truth authoritative and never emits a round", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-stage-precedence-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-STAGE-PRECEDENCE-${Date.now()}`,
    task: "live runtime stage should beat stale canonical seed",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "active" },
        { id: "stage-2", label: "交叉比较", semanticLabel: "交叉比较", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.equal(projection.currentStage, "stage-1");
  assert.equal(projection.currentStageLabel, "收集证据");
  assert.deepEqual(projection.completedStages, []);
  assert.equal(projection.cursor, "0/2");
  assert.equal(projection.pct, 0);
  // 回路退役搬迁(B6):原住 loop-semantic-stage-projection.test.js 的唯一独有断言——
  // 投影绝不把轮次当成阶段真值往外抛。B6b 起 contract.pipelineStage 路由段已整体移出
  // schema,round 连来源都不复存在;硬写的 round:null 占位也已删,所以这里断言的是
  // 「字段根本不出现」,而不是「字段存在但为 null」——后者会让占位悄悄复活而测试仍绿。
  assert.equal('round' in projection, false);
});

test("applyTrackingStageProjection lets runtime observation truth advance the seeded canonical stage", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-stage-semantic-override-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-STAGE-SEMANTIC-OVERRIDE-${Date.now()}`,
    task: "explicit semantic truth should override actor topology",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: {
      version: 1,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "active" },
        { id: "stage-2", label: "交叉比较", semanticLabel: "交叉比较", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    executionObservation: {
      collected: true,
      primaryOutputPath: "/runtime/contracts/topology-override.md",
      artifactPaths: ["/runtime/contracts/topology-override.md"],
      stageRunResult: { version: 1, status: "completed", summary: "收集完成" },
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(projection.stagePlan, ["收集证据", "交叉比较"]);
  assert.deepEqual(projection.completedStages, ["收集证据"]);
  assert.equal(projection.currentStage, "stage-2");
  assert.equal(projection.currentStageLabel, "交叉比较");
  assert.equal(projection.cursor, "1/2");
  assert.equal(projection.pct, 50);
});

test("applyTrackingStageProjection does not advance canonical stage on non-completed semantic payloads", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:runtime-semantic-non-complete-${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-SEMANTIC-NON-COMPLETE-${Date.now()}`,
    task: "failed semantic payload must not advance canonical stage",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: {
      version: 2,
      stages: [
        { id: "stage-1", label: "收集证据", semanticLabel: "收集证据", status: "completed" },
        { id: "stage-2", label: "形成结论", semanticLabel: "形成结论", status: "active" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    stageRunResult: {
      status: "failed",
      semanticStageId: "stage-2",
      semanticStageAction: "complete",
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(projection.completedStages, ["收集证据"]);
  assert.equal(projection.currentStage, "stage-2");
  assert.equal(projection.currentStageLabel, "形成结论");
  assert.equal(projection.cursor, "1/2");
  assert.equal(projection.pct, 50);
});
