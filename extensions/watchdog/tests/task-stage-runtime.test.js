import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { dispatchCreateExecutionContractEntry } from "../lib/ingress/dispatch-execution-contract-entry.js";
import { getContractPath, listLifecycleWorkItems, persistContractSnapshot } from "../lib/contracts.js";
import { createTrackingState, bindInboxContractEnvelope } from "../lib/session-bootstrap.js";
import { buildProgressPayload } from "../lib/transport/sse.js";
import { agentWorkspace, CONTRACTS_DIR, runtimeAgentConfigs, taskHistory } from "../lib/state.js";
import { normalizeStageRunResult } from "../lib/stage-results.js";
import { applyTrackingStageProjection } from "../lib/stage-projection.js";
import { listAgentEndMainStages } from "../lib/lifecycle/agent-end-pipeline.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { dispatchAcceptIngressMessage } from "../lib/ingress/dispatch-entry.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function cleanupContracts(prefix) {
  try {
    const files = await readdir(CONTRACTS_DIR);
    await Promise.all(
      files
        .filter((name) => name.startsWith(prefix))
        .map((name) => rm(join(CONTRACTS_DIR, name), { force: true })),
    );
  } catch {}
}

function restoreRuntimeAgentConfigs(snapshot) {
  runtimeAgentConfigs.clear();
  for (const [agentId, config] of snapshot.entries()) {
    runtimeAgentConfigs.set(agentId, config);
  }
}

test("dispatchCreateExecutionContractEntry writes definition-only stagePlan and separate stageRuntime", async () => runGlobalTestEnvironmentSerial(async () => {
  const prefix = "TC-";
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const before = new Set(await readdir(CONTRACTS_DIR));
  const originalGraph = await loadGraph();

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const result = await dispatchCreateExecutionContractEntry({
      message: "runtime stage truth ingress",
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:stage-runtime-${Date.now()}` },
      operatorContext: null,
      enqueue() {},
      wakeContractor: async () => null,
      logger,
      simple: true,
      phases: [
        "  建立比较维度  ",
        { name: " 补充关键证据 " },
        "形成结论",
      ],
    });

    const after = new Set(await readdir(CONTRACTS_DIR));
    const created = [...after].find((name) => !before.has(name) && name.startsWith(prefix));
    assert.ok(created, "expected ingress to create a contract snapshot");

    const contractPath = join(CONTRACTS_DIR, created);
    const persisted = JSON.parse(await readFile(contractPath, "utf8"));

    assert.equal(result.contractId, persisted.id);
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

    await rm(contractPath, { force: true });
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry does not persist a fake worker assignee when ingress has no graph first hop", async () => runGlobalTestEnvironmentSerial(async () => {
  const prefix = "TC-";
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const before = new Set(await readdir(CONTRACTS_DIR));
  const originalGraph = await loadGraph();

  try {
    await saveGraph({ edges: [] });

    const result = await dispatchCreateExecutionContractEntry({
      message: "ingress assignee truth",
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: `agent:controller:assignee-${Date.now()}` },
      operatorContext: null,
      enqueue() {},
      wakeContractor: async () => null,
      logger,
      simple: true,
      phases: ["分析", "执行"],
    });

    assert.equal(result.ok, false);

    const after = new Set(await readdir(CONTRACTS_DIR));
    const created = [...after].find((name) => !before.has(name) && name.startsWith(prefix));
    assert.ok(created, "expected ingress to create a contract snapshot");

    const persisted = JSON.parse(await readFile(join(CONTRACTS_DIR, created), "utf8"));
    assert.equal(persisted.assignee ?? null, null);

    await rm(join(CONTRACTS_DIR, created), { force: true });
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchCreateExecutionContractEntry persists explicit dispatch owner and resolves first hop from it", async () => runGlobalTestEnvironmentSerial(async () => {
  const prefix = "TC-";
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const before = new Set(await readdir(CONTRACTS_DIR));
  const originalGraph = await loadGraph();

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
        { from: "worker2", to: "reviewer", label: "handoff" },
      ],
    });

    const result = await dispatchCreateExecutionContractEntry({
      message: "system random should start from explicit owner",
      source: "system",
      effectiveReplyTo: { agentId: "test-run", sessionKey: `test-run:${Date.now()}` },
      dispatchOwnerAgentId: "worker2",
      operatorContext: null,
      api: null,
      logger,
      simple: true,
      phases: ["执行"],
    });

    const after = new Set(await readdir(CONTRACTS_DIR));
    const created = [...after].find((name) => !before.has(name) && name.startsWith(prefix));
    assert.ok(created, "expected ingress to create a contract snapshot");

    const persisted = JSON.parse(await readFile(join(CONTRACTS_DIR, created), "utf8"));

    assert.equal(result.contractId, persisted.id);
    assert.equal(result.targetAgent, "reviewer");
    assert.equal(persisted.dispatchOwnerAgentId, "worker2");
    assert.equal(persisted.assignee, "reviewer");

    await rm(join(CONTRACTS_DIR, created), { force: true });
  } finally {
    await saveGraph(originalGraph);
  }
}));

test("dispatchAcceptIngressMessage falls back to the default canonical stage plan when phases are omitted", async () => runGlobalTestEnvironmentSerial(async () => {
  const prefix = "TC-";
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const before = new Set(await readdir(CONTRACTS_DIR));
  const originalGraph = await loadGraph();

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner", label: "ingress" },
      ],
    });

    const result = await dispatchAcceptIngressMessage("对比三个框架优缺点", {
      source: "webui",
      replyTo: { agentId: "controller", sessionKey: `agent:controller:stage-planner-${Date.now()}` },
      simple: true,
      api: null,
      enqueue() {},
      wakeContractor: async () => null,
      logger,
    });

    const after = new Set(await readdir(CONTRACTS_DIR));
    const created = [...after].find((name) => !before.has(name) && name.startsWith(prefix));
    assert.ok(created, "expected incoming message to create a contract snapshot");

    const contractPath = join(CONTRACTS_DIR, created);
    const persisted = JSON.parse(await readFile(contractPath, "utf8"));

    assert.equal(result.contractId, persisted.id);
    assert.deepEqual(
      persisted.stagePlan.stages.map((entry) => entry.label),
      ["执行"],
    );
    assert.deepEqual(persisted.phases, ["执行"]);

    await rm(contractPath, { force: true });
  } finally {
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
      simple: true,
      phases: ["执行"],
    });

    const second = await dispatchCreateExecutionContractEntry({
      message: "second collision probe",
      source: "webui",
      effectiveReplyTo: { agentId: "controller", sessionKey: "agent:controller:collision-2" },
      operatorContext: null,
      api: null,
      logger,
      simple: true,
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
  const prefix = "TC-";
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const before = new Set(await readdir(CONTRACTS_DIR));
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

    const result = await dispatchAcceptIngressMessage("create_task child should still enter from controller", {
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
      simple: true,
      api: null,
      logger,
    });

    const after = new Set(await readdir(CONTRACTS_DIR));
    const created = [...after].find((name) => !before.has(name) && name.startsWith(prefix));
    assert.ok(created, "expected create_task ingress to create a contract snapshot");

    const persisted = JSON.parse(await readFile(join(CONTRACTS_DIR, created), "utf8"));

    assert.equal(result.contractId, persisted.id);
    assert.equal(persisted.replyTo?.agentId, "worker2");
    assert.equal(persisted.assignee, "planner");

    await rm(join(CONTRACTS_DIR, created), { force: true });
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
    await rm(workspaceDir, { recursive: true, force: true });
  } else {
    await writeFile(contractPath, original);
  }
});

test("extract_output_markers preserves rich stage definitions while ignoring planner-written witness residue", async () => {
  const contractId = `TC-STAGE-MARKER-RICH-${Date.now()}`;
  const contractPath = getContractPath(contractId);
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

  await persistContractSnapshot(contractPath, {
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
  const contractPath = getContractPath(contractId);
  const createdAt = Date.now() - 2000;
  const snapshotUpdatedAt = Date.now();

  await persistContractSnapshot(contractPath, {
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

test("listLifecycleWorkItems preserves canonical stagePlan from finalized history payloads", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:lifecycle-history-stage-runtime:${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.contract = {
    id: `TC-STAGE-RUNTIME-HISTORY-${Date.now()}`,
    task: "history stage runtime truth",
    status: CONTRACT_STATUS.COMPLETED,
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
  trackingState.stageProjection = {
    source: "ui_activity_placeholder",
    stagePlan: [],
    completedStages: [],
    currentStage: null,
    currentStageLabel: null,
    cursor: null,
    pct: null,
    done: null,
    total: null,
    round: null,
    runtimeStatus: CONTRACT_STATUS.COMPLETED,
  };

  taskHistory.push({
    ...buildProgressPayload(trackingState),
    endMs: Date.now(),
  });

  const snapshots = await listLifecycleWorkItems();
  const snapshot = snapshots.find((entry) => entry.id === trackingState.contract.id);
  assert.ok(snapshot, "expected lifecycle snapshot for finalized history contract");
  assert.equal(snapshot.stageRuntime.currentStageId, "stage-2");
  assert.deepEqual(snapshot.stageRuntime.completedStageIds, ["stage-1"]);
  assert.deepEqual(snapshot.phases, ["收集证据", "交叉比较", "形成结论"]);
  assert.equal(snapshot.total, 3);

  clearTrackingStore();
  taskHistory.length = 0;
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

test("listLifecycleWorkItems includes artifact-backed tracking work items with protocol stage truth", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const trackingState = createTrackingState({
    sessionKey: `agent:reviewer:lifecycle-artifact:${Date.now()}`,
    agentId: "reviewer",
    parentSession: null,
  });
  trackingState.artifactContext = {
    kind: "code_review",
    path: "/tmp/reviewer/inbox/code_review.json",
    protocol: {
      transport: "code_review.json",
      source: "request_review",
      intentType: "request_review",
    },
    source: {
      agentId: "worker-source",
      sessionKey: "agent:worker-source:main",
      contractId: "TC-LIFECYCLE-ARTIFACT-SOURCE",
    },
    request: {
      instruction: "请审查当前实现并给出 verdict",
      requestedAt: 1234567890,
    },
    replyTo: {
      agentId: "worker-source",
      sessionKey: "agent:worker-source:main",
    },
    upstreamReplyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    returnContext: {
      sourceAgentId: "worker-source",
      sourceSessionKey: "agent:worker-source:main",
      intentType: "request_review",
    },
    coordination: {
      ownerAgentId: "reviewer",
    },
    systemActionDeliveryTicket: {
      id: "ticket-lifecycle-artifact-1",
    },
    operatorContext: {
      conversationId: "conv-lifecycle-artifact",
    },
    domain: "generic",
    runtimeDiagnostics: null,
  };
  applyTrackingStageProjection(trackingState);
  rememberTrackingState(trackingState.sessionKey, trackingState);

  const snapshots = await listLifecycleWorkItems();
  const payload = buildProgressPayload(trackingState);
  const snapshot = snapshots.find((entry) => entry.id === payload.workItemId);
  assert.ok(snapshot, "expected lifecycle snapshot for artifact-backed tracking session");
  assert.equal(snapshot.hasContract, false);
  assert.equal(snapshot.workItemKind, "artifact_backed");
  assert.equal(snapshot.taskType, "request_review");
  assert.equal(snapshot.protocolEnvelope, "code_review");
  assert.equal(snapshot.artifactKind, "code_review");
  assert.equal(snapshot.artifactDomain, "generic");
  assert.equal(snapshot.artifactSource?.contractId, "TC-LIFECYCLE-ARTIFACT-SOURCE");
  assert.equal(snapshot.artifactRequest?.instruction, "请审查当前实现并给出 verdict");
  assert.deepEqual(snapshot.phases, ["代码审查"]);
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.stageProjection?.currentStage, "code_review");
  assert.equal(snapshot.stageProjection?.currentStageLabel, "代码审查");

  clearTrackingStore();
  taskHistory.length = 0;
});

test("listLifecycleWorkItems preserves artifact-backed history payloads after track_end", async () => {
  clearTrackingStore();
  taskHistory.length = 0;

  const trackingState = createTrackingState({
    sessionKey: `agent:reviewer:lifecycle-artifact-history:${Date.now()}`,
    agentId: "reviewer",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.artifactContext = {
    kind: "code_review",
    path: "/tmp/reviewer/inbox/code_review.json",
    protocol: {
      transport: "code_review.json",
      source: "request_review",
      intentType: "request_review",
    },
    source: {
      agentId: "worker-source",
      sessionKey: "agent:worker-source:main",
      contractId: "TC-LIFECYCLE-ARTIFACT-HISTORY-SOURCE",
    },
    request: {
      instruction: "请审查历史实现并给出 verdict",
      requestedAt: 2234567890,
    },
    replyTo: {
      agentId: "worker-source",
      sessionKey: "agent:worker-source:main",
    },
    upstreamReplyTo: null,
    returnContext: {
      sourceAgentId: "worker-source",
      sourceSessionKey: "agent:worker-source:main",
      intentType: "request_review",
    },
    coordination: {
      ownerAgentId: "reviewer",
    },
    systemActionDeliveryTicket: {
      id: "ticket-lifecycle-artifact-history-1",
    },
    operatorContext: null,
    domain: "generic",
    runtimeDiagnostics: null,
  };
  applyTrackingStageProjection(trackingState);
  taskHistory.push({
    ...buildProgressPayload(trackingState),
    endMs: Date.now(),
  });

  const snapshots = await listLifecycleWorkItems();
  const payload = buildProgressPayload(trackingState);
  const snapshot = snapshots.find((entry) => entry.id === payload.workItemId);
  assert.ok(snapshot, "expected lifecycle snapshot for artifact-backed history item");
  assert.equal(snapshot.source, "history");
  assert.equal(snapshot.hasContract, false);
  assert.equal(snapshot.workItemKind, "artifact_backed");
  assert.equal(snapshot.status, CONTRACT_STATUS.COMPLETED);
  assert.equal(snapshot.artifactKind, "code_review");
  assert.deepEqual(snapshot.phases, ["代码审查"]);
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.pct, 100);
  assert.equal(snapshot.stageProjection?.currentStageLabel, "已完成");

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
  assert.deepEqual(projection.stagePlan, ["收集证据", "交叉比较", "形成结论"]);
  assert.deepEqual(projection.completedStages, ["收集证据"]);
  assert.equal(projection.currentStage, "stage-2");
  assert.equal(projection.currentStageLabel, "交叉比较");
  assert.equal(projection.cursor, "1/3");
  assert.equal(projection.pct, 33);
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

test("applyTrackingStageProjection keeps canonical task-stage truth authoritative over live runtime topology", () => {
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
    pipelineStage: {
      pipelineId: "pipe-stage-runtime-precedence",
      loopSessionId: "LS-stage-runtime-precedence",
      stage: "交叉比较",
      round: 1,
    },
  };

  const projection = applyTrackingStageProjection(trackingState, {
    pipeline: {
      pipelineId: "pipe-stage-runtime-precedence",
      currentStage: "交叉比较",
      phaseOrder: ["收集证据", "交叉比较"],
      round: 1,
    },
    loopSession: {
      id: "LS-stage-runtime-precedence",
      currentStage: "交叉比较",
      phaseOrder: ["收集证据", "交叉比较"],
      round: 1,
    },
  });

  assert.equal(projection.source, "task_stage_truth");
  assert.equal(projection.currentStage, "stage-1");
  assert.equal(projection.currentStageLabel, "收集证据");
  assert.deepEqual(projection.completedStages, []);
  assert.equal(projection.cursor, "0/2");
  assert.equal(projection.pct, 0);
});

test("applyTrackingStageProjection lets runtime observation truth override live runtime topology", () => {
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
    },
    pipelineStage: {
      pipelineId: "pipe-stage-runtime-semantic-override",
      loopSessionId: "LS-stage-runtime-semantic-override",
      stage: "收集证据",
      round: 1,
    },
  };

  const projection = applyTrackingStageProjection(trackingState, {
    pipeline: {
      pipelineId: "pipe-stage-runtime-semantic-override",
      currentStage: "收集证据",
      phaseOrder: ["researcher", "worker-d"],
      round: 1,
    },
    loopSession: {
      id: "LS-stage-runtime-semantic-override",
      currentStage: "收集证据",
      phaseOrder: ["researcher", "worker-d"],
      round: 1,
    },
  });

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
