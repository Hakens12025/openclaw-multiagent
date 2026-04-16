import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { INTENT_TYPES } from "../lib/protocol-primitives.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";
import {
  SEMANTIC_WORKFLOWS,
  inferSemanticWorkflow,
} from "../lib/runtime-workflow-semantics.js";
import { deliveryRunTerminal } from "../lib/routing/delivery-terminal.js";
import { normalizeSystemActionDeliveryDiagnostic } from "../lib/lifecycle/runtime-diagnostics.js";
import {
  buildSystemActionDeliveryResult,
  buildRuntimeDeliveryResultSource,
  resolveRuntimeResultOutputPath,
  summarizeDeliveryResultPayload,
} from "../lib/routing/delivery-result.js";
import { buildProgressPayload } from "../lib/transport/sse.js";
import {
  SYSTEM_ACTION_STATUS,
} from "../lib/core/runtime-status.js";
import {
  buildDeferredSystemActionFollowUp,
} from "../lib/system-action/system-action-runtime-ledger.js";
import { buildOutboxManifestExample } from "../lib/platform-doc-builder.js";
import { deliveryRunSystemActionContractResult } from "../lib/routing/delivery-system-action-contract-result.js";

test("workspace guidance writes DELIVERY.md and documents both terminal and system_action delivery", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-delivery-guidance-"));
  runtimeAgentConfigs.clear();

  try {
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
      specialized: false,
      skills: ["system-action"],
    });
    runtimeAgentConfigs.set("bridge-office", {
      id: "bridge-office",
      role: "bridge",
      gateway: false,
      ingressSource: null,
      specialized: false,
      skills: [],
    });
    runtimeAgentConfigs.set("worker-a", {
      id: "worker-a",
      role: "executor",
      gateway: false,
      ingressSource: null,
      specialized: false,
      skills: [],
    });

    await syncAgentWorkspaceGuidance({
      agentId: "bridge-office",
      role: "bridge",
      skills: ["platform-map", "platform-tools", "system-action"],
      workspaceDir,
      graph: {
        edges: [
          { from: "bridge-office", to: "worker-a", label: "assign", gates: [], metadata: {} },
        ],
      },
      loops: [],
    });

    const agents = await readFile(join(workspaceDir, "AGENTS.md"), "utf8");
    const delivery = await readFile(join(workspaceDir, "DELIVERY.md"), "utf8");

    await assert.rejects(
      readFile(join(workspaceDir, "RUNTIME-RETURN.md"), "utf8"),
    );
    assert.match(agents, /处理 delivery 语义时再查 `DELIVERY\.md`/);
    assert.match(delivery, /delivery:terminal/);
    assert.match(delivery, /delivery:system_action/);
    assert.match(delivery, /delivery:system_action_assign_task_result/);
    assert.match(delivery, /delivery:system_action_contract_result/);
    assert.match(delivery, /delivery:system_action_review_verdict/);
    assert.match(delivery, /replyTo/);
  } finally {
    runtimeAgentConfigs.clear();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("planner platform guidance uses execution_result manifest semantics", () => {
  const manifest = buildOutboxManifestExample(AGENT_ROLE.PLANNER);

  assert.match(manifest, /"kind": "execution_result"/);
  assert.doesNotMatch(manifest, /planner_contract/);
});

test("legacy planner soul upgrade no longer depends on draft-era wording", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-planner-legacy-soul-"));
  const legacySoul = `# Contractor

任务规划者。职责：读取 Contract，判断该任务应走标准一次性执行链路，还是应交给已登记的 graph-backed loop；然后把决定写到 outbox。

## 状态机

\`\`\`
唤醒
├─ inbox/ 有 contract.json → 判断路径 → 写协作动作或 outbox/result.json → 停止
└─ inbox/ 为空 → HEARTBEAT_OK → 停止
\`\`\`
`;

  try {
    await writeFile(join(workspaceDir, "SOUL.md"), legacySoul, "utf8");
    const updates = await syncAgentWorkspaceGuidance({
      agentId: "contractor",
      role: "planner",
      skills: ["platform-map", "platform-tools", "system-action"],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });
    const soul = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
    const soulUpdate = updates.find((entry) => entry.name === "SOUL.md");

    assert.equal(soulUpdate?.updated, true);
    assert.match(soul, /managed-by-watchdog:agent-bootstrap/);
    assert.match(soul, /规划节点。把模糊任务拆成清晰阶段/);
    assert.match(soul, /\[STAGE\]/);
    assert.doesNotMatch(soul, /见证/u);
    assert.doesNotMatch(soul, /Witness/u);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("deferred system_action follow-up uses delivery workflows", () => {
  const createTaskFollowUp = buildDeferredSystemActionFollowUp({
    actionType: INTENT_TYPES.CREATE_TASK,
    status: SYSTEM_ACTION_STATUS.DISPATCHED,
    deferredCompletion: true,
    contractId: "contract-create",
    deliveryTicketId: "ticket-create",
  });
  const assignTaskFollowUp = buildDeferredSystemActionFollowUp({
    actionType: INTENT_TYPES.ASSIGN_TASK,
    status: SYSTEM_ACTION_STATUS.DISPATCHED,
    deferredCompletion: true,
    targetAgent: "worker-a",
    contractId: "contract-assign",
  });
  const reviewFollowUp = buildDeferredSystemActionFollowUp({
    actionType: INTENT_TYPES.REQUEST_REVIEW,
    status: SYSTEM_ACTION_STATUS.DISPATCHED,
    deferredCompletion: true,
    targetAgent: "reviewer",
  });

  assert.equal(createTaskFollowUp.mode, "delivery");
  assert.equal(createTaskFollowUp.workflow, "delivery:system_action_contract_result");
  assert.equal(createTaskFollowUp.semanticWorkflow, SEMANTIC_WORKFLOWS.DELIVERY_SYSTEM_ACTION);
  assert.equal(createTaskFollowUp.deliveryTicketId, "ticket-create");
  assert.equal("returnTicketId" in createTaskFollowUp, false);

  assert.equal(assignTaskFollowUp.workflow, "delivery:system_action_assign_task_result");
  assert.equal(assignTaskFollowUp.semanticWorkflow, SEMANTIC_WORKFLOWS.DELIVERY_SYSTEM_ACTION);

  assert.equal(reviewFollowUp.workflow, "delivery:system_action_review_verdict");
  assert.equal(reviewFollowUp.semanticWorkflow, SEMANTIC_WORKFLOWS.DELIVERY_SYSTEM_ACTION);
});

test("semantic workflow only accepts unified delivery lanes", () => {
  assert.equal(
    inferSemanticWorkflow("execution_contract_return"),
    null,
  );
  assert.equal(
    inferSemanticWorkflow("assign_task_return"),
    null,
  );
  assert.equal(
    inferSemanticWorkflow("review_verdict_return"),
    null,
  );
  assert.equal(
    inferSemanticWorkflow("delivery:system_action_review_verdict"),
    SEMANTIC_WORKFLOWS.DELIVERY_SYSTEM_ACTION,
  );
  assert.equal(
    inferSemanticWorkflow("delivery:terminal"),
    SEMANTIC_WORKFLOWS.DELIVERY_TERMINAL,
  );
});

test("terminal delivery result exposes delivery:terminal semantics", async () => {
  const result = await deliveryRunTerminal({
    contract: {
      id: "contract-terminal",
      task: "demo terminal delivery",
    },
    startMs: Date.now(),
    toolCallTotal: 0,
  }, null, {
    info() {},
    warn() {},
    error() {},
  });

  assert.equal(result.deliveryType, "terminal");
  assert.equal(result.workflow, "delivery:terminal");
});

test("runtime delivery result source prefers terminalOutcome artifact over legacy output residues", () => {
  const outputPath = resolveRuntimeResultOutputPath({
    contract: {
      output: "/tmp/legacy-output.md",
      terminalOutcome: {
        artifact: "/tmp/terminal-outcome-artifact.md",
      },
      executionObservation: {
        collected: true,
        primaryOutputPath: "/tmp/execution-observation-output.md",
        stageRunResult: {
          status: "completed",
          primaryArtifactPath: "/tmp/stage-run-artifact.md",
        },
      },
    },
  });

  assert.equal(outputPath, "/tmp/terminal-outcome-artifact.md");
});

test("runtime delivery result source no longer falls back to legacy top-level stage fields", () => {
  const resultSource = buildRuntimeDeliveryResultSource({
    contractData: {
      id: "TC-LEGACY-STAGE-FALLBACK",
      terminalOutcome: {
        status: "completed",
        summary: "terminal summary",
      },
      stageRunResult: {
        status: "completed",
        summary: "legacy top-level stage summary",
        primaryArtifactPath: "/tmp/legacy-top-level-stage.md",
      },
      stageCompletion: {
        status: "completed",
        feedback: "legacy top-level stage completion",
      },
    },
  });

  assert.equal(resultSource.stageRunResult, null);
  assert.equal(resultSource.stageCompletion, null);
});

test("resolveRuntimeResultOutputPath no longer falls back to legacy top-level stage artifacts", () => {
  const outputPath = resolveRuntimeResultOutputPath({
    contractId: "TC-LEGACY-STAGE-ARTIFACT",
    stageRunResult: {
      status: "completed",
      primaryArtifactPath: "/tmp/legacy-top-level-stage-artifact.md",
    },
  });

  assert.equal(outputPath, null);
});

test("summarizeDeliveryResultPayload no longer falls back to legacy top-level stage feedback", () => {
  const summary = summarizeDeliveryResultPayload({
    source: {
      stageCompletion: {
        status: "completed",
        feedback: "legacy top-level stage feedback",
      },
      stageRunResult: {
        status: "completed",
        summary: "legacy top-level stage summary",
      },
    },
  });

  assert.equal(summary, "");
});

test("deliveryRunTerminal falls back to terminalOutcome summary when no artifact file exists", async () => {
  const gatewayAgentId = `delivery-gateway-${Date.now()}`;
  const contractId = `TC-TERMINAL-SUMMARY-${Date.now()}`;
  const workspaceDir = agentWorkspace(gatewayAgentId);
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  runtimeAgentConfigs.clear();
  runtimeAgentConfigs.set(gatewayAgentId, {
    id: gatewayAgentId,
    role: "bridge",
    gateway: true,
    ingressSource: null,
    specialized: false,
    skills: [],
  });

  try {
    const result = await deliveryRunTerminal({
      status: "completed",
      startMs: Date.now() - 1000,
      toolCallTotal: 0,
      contract: {
        id: contractId,
        task: "terminal summary fallback contract",
        output: "",
        replyTo: {
          kind: "agent",
          agentId: gatewayAgentId,
          sessionKey: `agent:${gatewayAgentId}:main`,
        },
        terminalOutcome: {
          status: "completed",
          source: "completion_criteria",
          summary: "terminal summary from outcome",
          reason: "terminal reason from outcome",
        },
      },
    }, null, {
      info() {},
      warn() {},
      error() {},
    });

    assert.equal(result.ok, true);

    const delivered = JSON.parse(
      await readFile(join(workspaceDir, "deliveries", `DL-${contractId}.json`), "utf8"),
    );
    assert.equal(delivered.resultSummary, "terminal summary from outcome");
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("progress payload exposes unified delivery fields only", () => {
  const payload = buildProgressPayload({
    sessionKey: "agent:worker-a:main",
    agentId: "worker-a",
    parentSession: null,
    status: "running",
    lastLabel: "demo",
    toolCallTotal: 0,
    startMs: Date.now(),
    contract: {
      id: "contract-delivery",
      task: "demo",
      systemActionDelivery: { workflow: "delivery:system_action_contract_result" },
      systemActionDeliveryTicket: { id: "ticket-1" },
    },
  });

  assert.deepEqual(payload.systemActionDelivery, { workflow: "delivery:system_action_contract_result" });
  assert.deepEqual(payload.systemActionDeliveryTicket, { id: "ticket-1" });
  assert.equal("runtimeReturn" in payload, false);
  assert.equal("runtimeReturnTicket" in payload, false);
});

test("runtime surface exposes only unified delivery event names", () => {
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_DELIVERY_FAILED, "system_action_delivery_failed");
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_CONTRACT_RESULT_DELIVERED, "system_action_contract_result_delivered");
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_ASSIGN_TASK_RESULT_DELIVERED, "system_action_assign_task_result_delivered");
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_REVIEW_VERDICT_DELIVERED, "system_action_review_verdict_delivered");
  assert.equal("RUNTIME_BRIDGE_FAILED" in EVENT_TYPE, false);
  assert.equal("EXECUTION_RESULT_RETURNED" in EVENT_TYPE, false);
  assert.equal("ASSIGN_TASK_RESULT_RETURNED" in EVENT_TYPE, false);
  assert.equal("REVIEW_VERDICT_RETURNED" in EVENT_TYPE, false);
});

test("system_action delivery result and diagnostics expose deliveryTicketId only", () => {
  const result = buildSystemActionDeliveryResult({
    deliveryId: "delivery:system_action_contract_result",
    deliveryTicketId: "ticket-123",
  });
  const diagnostic = normalizeSystemActionDeliveryDiagnostic(result);

  assert.equal(result.deliveryTicketId, "ticket-123");
  assert.equal("returnTicketId" in result, false);
  assert.equal(diagnostic?.deliveryTicketId, "ticket-123");
  assert.equal("returnTicketId" in (diagnostic || {}), false);
});

test("system_action contract delivery reads result content from executionObservation artifacts", async () => {
  const targetAgent = `delivery-target-${Date.now()}`;
  const workspaceDir = agentWorkspace(targetAgent);
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-delivery-artifact-"));
  const artifactPath = join(artifactDir, "result.md");
  const artifactContent = "artifact-backed result content";

  await writeFile(artifactPath, artifactContent, "utf8");

  try {
    await deliveryRunSystemActionContractResult({
      trackingState: {
        agentId: "worker-a",
        contract: {
          id: "TC-SYSTEM-ACTION-RESULT",
          task: "deliver artifact-backed result",
          executionObservation: {
            collected: true,
            contractId: "TC-SYSTEM-ACTION-RESULT",
            stageRunResult: {
              status: "completed",
              summary: "artifact summary",
              primaryArtifactPath: artifactPath,
            },
          },
        },
      },
      contractData: {
        id: "TC-SYSTEM-ACTION-RESULT",
        task: "deliver artifact-backed result",
        replyTo: {
          kind: "agent",
          agentId: targetAgent,
          sessionKey: `agent:${targetAgent}:main`,
        },
        upstreamReplyTo: {
          kind: "agent",
          agentId: "controller",
          sessionKey: "agent:controller:main",
        },
        protocol: {
          envelope: "execution_contract",
          source: INTENT_TYPES.CREATE_TASK,
        },
      },
      terminalStatus: "completed",
      outcome: {
        status: "completed",
        reason: "artifact summary",
        summary: "artifact summary",
      },
      api: null,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

    const delivered = JSON.parse(
      await readFile(join(workspaceDir, "inbox", "contract.json"), "utf8"),
    );

    assert.match(delivered.task, /artifact-backed result content/);
    assert.equal("executionResult" in delivered, false);
    assert.equal("delegatedResult" in delivered, false);
    assert.equal("stageRunResult" in delivered, false);
    assert.equal("stageCompletion" in delivered, false);
    assert.equal(delivered.executionObservation?.stageRunResult?.primaryArtifactPath, artifactPath);
    assert.equal(delivered.terminalOutcome?.status, "completed");
    assert.equal(delivered.terminalOutcome?.summary, "artifact summary");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("delivery control-plane source files no longer mention legacy runtime return residue", async () => {
  const files = [
    join(process.cwd(), "lib", "routing", "dispatch-transport.js"),
    join(process.cwd(), "lib", "runtime-workflow-semantics.js"),
    join(process.cwd(), "lib", "workspace-guidance-writer.js"),
    join(process.cwd(), "lib", "harness", "harness-module-evidence.js"),
  ];
  const legacyPatterns = [
    /\bexecution_contract_return\b/,
    /\bassign_task_return\b/,
    /\breview_verdict_return\b/,
    /\bRUNTIME-RETURN\.md\b/,
    /\bruntimeReturnTicket\b/,
    /\bruntime return\b/i,
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    for (const pattern of legacyPatterns) {
      assert.doesNotMatch(content, pattern, `${filePath} still mentions ${pattern}`);
    }
  }
});

test("tracked workspaces no longer ship runtime return guidance docs", async () => {
  const workspacesDir = join(process.cwd(), "..", "..", "workspaces");
  const workspaceEntries = await readdir(workspacesDir, { withFileTypes: true });
  const managedDocNames = ["AGENTS.md", "BUILDING-MAP.md", "PLATFORM-GUIDE.md", "DELIVERY.md"];
  const legacyPatterns = [
    /\bRUNTIME-RETURN\.md\b/,
    /\bruntimeReturnTicket\b/,
    /\bruntime return\b/i,
    /回流语义见 `RUNTIME-RETURN\.md`/,
  ];

  for (const entry of workspaceEntries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = join(workspacesDir, entry.name);

    await assert.rejects(
      access(join(workspaceDir, "RUNTIME-RETURN.md")),
      `${workspaceDir} still ships RUNTIME-RETURN.md`,
    );

    for (const fileName of managedDocNames) {
      const filePath = join(workspaceDir, fileName);
      try {
        const content = await readFile(filePath, "utf8");
        for (const pattern of legacyPatterns) {
          assert.doesNotMatch(content, pattern, `${filePath} still mentions ${pattern}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
});

test("tracked runtime state fixtures no longer mention runtimeReturnTicket", async () => {
  const workspacesDir = join(process.cwd(), "..", "..", "workspaces");
  const entries = await readdir(workspacesDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(workspacesDir, entry.name, "inbox", "context.json"));

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf8");
      assert.doesNotMatch(content, /\bruntimeReturnTicket\b/, `${filePath} still mentions runtimeReturnTicket`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
});

test("workspace guidance building map no longer advertises legacy dedicated role roster as current office truth", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-building-map-"));

  try {
    await syncAgentWorkspaceGuidance({
      agentId: "bridge-office",
      role: "bridge",
      skills: ["platform-map", "platform-tools", "system-action"],
      workspaceDir,
      graph: {
        edges: [],
      },
      loops: [],
    });

    const buildingMap = await readFile(join(workspaceDir, "BUILDING-MAP.md"), "utf8");
    assert.doesNotMatch(buildingMap, /办公室（planner \/ executor \/ researcher \/ reviewer）/);
    assert.match(buildingMap, /办公室负责内容生产、研究、审查与决策/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("legacy runtime direct inbox module is removed in favor of direct envelope queue semantics", async () => {
  const queueModule = await import("../lib/runtime-direct-envelope-queue.js");

  assert.equal(typeof queueModule.ensureRuntimeDirectEnvelopeInbox, "function");
  assert.equal(typeof queueModule.enqueueRuntimeDirectEnvelope, "function");
  await assert.rejects(
    access(join(process.cwd(), "lib", "runtime-direct-inbox.js")),
  );
});

test("legacy bridge module files are removed", async () => {
  const legacyFiles = [
    "agent-end-bridge-chain.js",
    "contract-return-bridge.js",
    "review-bridge.js",
    "runtime-bridge-core.js",
    "runtime-bridge-result.js",
    "runtime-return-helpers.js",
    "runtime-return-ticket-ledger.js",
  ];

  for (const fileName of legacyFiles) {
    await assert.rejects(
      access(join(process.cwd(), "lib", "bridge", fileName)),
    );
  }
});

test("legacy pool compatibility shell file is removed", async () => {
  await assert.rejects(
    access(join(process.cwd(), "lib", "routing", "pool.js")),
  );
});

test("dispatch module no longer exports compatibility wrappers", async () => {
  const dispatchModule = await import("../lib/routing/dispatch-transport.js");

  assert.equal(typeof dispatchModule.dispatchSendDirectRequest, "function");
  assert.equal(typeof dispatchModule.dispatchSendExecutionContract, "function");
  assert.equal("dispatchToAgent" in dispatchModule, false);
  assert.equal("dispatchDirectInboxContract" in dispatchModule, false);
  assert.equal("dispatchWorkerPoolContract" in dispatchModule, false);
  assert.equal("dispatchSharedInboxContract" in dispatchModule, false);
});

test("contract flow store no longer exports pending planner dispatch compatibility helpers", async () => {
  const flowStoreModule = await import("../lib/store/contract-flow-store.js");

  assert.equal("getPendingPlannerDispatch" in flowStoreModule, false);
  assert.equal("rememberPendingPlannerDispatch" in flowStoreModule, false);
  assert.equal("forgetPendingPlannerDispatch" in flowStoreModule, false);
  assert.equal("getPendingPlannerDispatchCount" in flowStoreModule, false);
  assert.equal("snapshotPendingPlannerDispatches" in flowStoreModule, false);
  assert.equal("clearPendingPlannerDispatchStore" in flowStoreModule, false);
});

test("unified system_action delivery routing modules exist in lib/routing", async () => {
  const unifiedFiles = [
    "delivery-result.js",
    "delivery-protocols.js",
    "delivery-system-action-contract-result.js",
    "delivery-system-action-chain.js",
    "delivery-system-action-transport.js",
    "delivery-system-action-helpers.js",
    "delivery-system-action-ticket.js",
    "delivery-system-action-review-verdict.js",
  ];

  for (const fileName of unifiedFiles) {
    await access(join(process.cwd(), "lib", "routing", fileName));
  }
});

test("collaboration policy imports without legacy bridge path", async () => {
  await assert.doesNotReject(() => import("../lib/collaboration-policy.js"));
});

test("system_action contract delivery imports without duplicate route exports", async () => {
  await assert.doesNotReject(() => import("../lib/routing/delivery-system-action-contract-result.js"));
});

test("canonical runtime and active test prompts no longer mention outbox/system_action.json", async () => {
  const files = [
    join(process.cwd(), "lib", "store", "execution-trace-store.js"),
    join(process.cwd(), "tests", "suite-direct-service.js"),
    join(process.cwd(), "tests", "delegation-early-check-paths.test.js"),
    join(process.cwd(), "tests", "contractor-loop-permission.test.js"),
    join(process.cwd(), "tests", "suite-agent-model.js"),
    join(process.cwd(), "lib", "soul-template-builder.js"),
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    assert.equal(content.includes("outbox/system_action.json"), false, `${filePath} still mentions outbox/system_action.json`);
  }
});
