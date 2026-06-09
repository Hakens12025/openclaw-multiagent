import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import { agentWorkspace, apiRef, cfg, runtimeAgentConfigs, setApiRef } from "../lib/state.js";
import { INTENT_TYPES, createDirectRequestEnvelope } from "../lib/protocol-primitives.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";
import { getRoleOutputDirectives } from "../lib/role-spec-registry.js";
import {
  SEMANTIC_WORKFLOWS,
  inferSemanticWorkflow,
} from "../lib/runtime-workflow-semantics.js";
import { deliveryRunTerminal } from "../lib/routing/delivery-terminal.js";
import { normalizeSystemActionDeliveryDiagnostic } from "../lib/lifecycle/runtime-diagnostics.js";
import {
  buildSystemActionDeliveryResult,
  buildRuntimeDeliveryResultSource,
  resolveTerminalUserFacingResultContent,
  resolveRuntimeResultOutputPath,
  summarizeDeliveryResultPayload,
  buildRuntimeResultDeliveryTask,
} from "../lib/routing/delivery-result.js";
import { buildProgressPayload } from "../lib/transport/sse.js";
import {
  CONTRACT_STATUS,
  SYSTEM_ACTION_STATUS,
} from "../lib/core/runtime-status.js";
import {
  buildDeferredSystemActionFollowUp,
} from "../lib/system-action/system-action-runtime-ledger.js";
import {
  buildAgentsTemplate,
  buildHeartbeatTemplate,
  buildOutboxCommitExample,
  buildPlatformGuideTemplate,
} from "../lib/platform-doc-builder.js";
import { deliveryRunSystemActionRuntimeResult } from "../lib/routing/delivery-system-action-runtime-result.js";
import { deliveryEnqueueSystemActionReturn } from "../lib/routing/delivery-system-action-transport.js";
import { SYSTEM_ACTION_DELIVERY_IDS } from "../lib/routing/delivery-protocols.js";
import {
  clearSystemActionDeliveryTicketStore,
  registerSystemActionDeliveryTicket,
} from "../lib/routing/delivery-system-action-ticket.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const WATCHDOG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OPENCLAW_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function readWorkspaceDirectoryEntriesIfPresent() {
  try {
    return await readdir(join(OPENCLAW_ROOT, "workspaces"), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

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
    assert.match(delivery, /delivery:system_action_runtime_result/);
    assert.match(delivery, /delivery:system_action_review_verdict/);
    assert.match(delivery, /replyTo/);
  } finally {
    runtimeAgentConfigs.clear();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("planner platform guidance uses minimal runtime_result commit semantics", () => {
  const manifest = buildOutboxCommitExample(AGENT_ROLE.PLANNER);

  assert.match(manifest, /"status": "completed"/);
  assert.match(manifest, /"summary"/);
  assert.doesNotMatch(manifest, /"transition"/);
  assert.doesNotMatch(manifest, /"completion"/);
  assert.doesNotMatch(manifest, /_manifest\.json/);
});

test("startup sync does not overwrite a no-marker legacy planner soul", async () => {
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

    // SOUL is user-owned: sync never touches it and never lists it in the managed manifest.
    assert.equal(updates.find((entry) => entry.name === "SOUL.md"), undefined, "SOUL not part of managed manifest");
    assert.equal(soul, legacySoul);
    assert.doesNotMatch(soul, /managed-by-watchdog:agent-bootstrap/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("reviewer IDENTITY keeps review persona without embedding shared-contract IO protocol", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-reviewer-guidance-"));

  try {
    await syncAgentWorkspaceGuidance({
      agentId: "reviewer-guidance",
      role: "reviewer",
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });

    // ④role: reviewer persona now lives in the managed IDENTITY.md (not SOUL).
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");

    assert.match(identity, /## Role/);
    assert.match(identity, /Reviewer node|review/i, "reviewer persona keeps review stance");
    assert.doesNotMatch(identity, /inbox\/contract\.json/);
    assert.doesNotMatch(identity, /outbox\/stage_result\.json/);
    assert.doesNotMatch(identity, /outbox\/contract_result\.json/);
    assert.doesNotMatch(identity, /HEARTBEAT_OK/);

    // SOUL is user-owned; sync does not seed it (only bootstrap does).
    await assert.rejects(access(join(workspaceDir, "SOUL.md")), "sync does not write a SOUL");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("execution IDENTITY stays role-only while wake output directives carry the contract entrypoint", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-executor-soul-boundary-"));

  try {
    await syncAgentWorkspaceGuidance({
      agentId: "worker-boundary",
      role: "executor",
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });

    // ④role persona lives in IDENTITY.md; it must not carry contract IO protocol.
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
    // ⑥wake 产出格式(数据驱动 getRoleOutputDirectives 替代旧 bundled dispatchInstruction)。
    const outputDirectives = getRoleOutputDirectives(AGENT_ROLE.EXECUTOR).join("\n");

    assert.match(identity, /## Role/);
    assert.doesNotMatch(identity, /inbox\/contract\.json/);
    assert.doesNotMatch(identity, /outbox\/runtime_result\.json/);
    assert.doesNotMatch(identity, /outbox\/stage_result\.json/);
    assert.doesNotMatch(identity, /outbox\/contract_result\.json/);
    assert.doesNotMatch(identity, /HEARTBEAT_OK/);
    assert.match(outputDirectives, /user-facing deliverable/i);
    assert.doesNotMatch(outputDirectives, /outbox\/stage_result\.json/);
    assert.doesNotMatch(outputDirectives, /outbox\/contract_result\.json/);
    assert.doesNotMatch(outputDirectives, /contract\.output/);
    assert.doesNotMatch(outputDirectives, /\[ACTION\]/);
    assert.doesNotMatch(outputDirectives, /[\u4e00-\u9fff]/u);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("managed guidance distinguishes current session from system contract wake semantics", () => {
  const agents = buildAgentsTemplate("bridge-office", "bridge", ["system-action"]);
  const heartbeat = buildHeartbeatTemplate();
  const platformGuide = buildPlatformGuideTemplate("bridge-office", "bridge", ["system-action"], { edges: [] }, []);

  assert.doesNotMatch(agents, /2\. `inbox\/contract\.json`/);
  assert.match(agents, /当前会话输入/);
  assert.doesNotMatch(heartbeat, /检查 `inbox\/contract\.json`（唯一任务输入）/);
  assert.match(heartbeat, /以本轮系统唤醒信息为准/);
  assert.doesNotMatch(platformGuide, /第一入口永远是 `inbox\/contract\.json`/);
  assert.match(platformGuide, /用户直达/);
  assert.match(platformGuide, /系统派工/);
  assert.match(platformGuide, /\[ACTION\]/);
});

test("execution-layer guidance prunes generic workspace scaffold files", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-execution-scaffold-"));

  try {
    await writeFile(join(workspaceDir, "AGENTS.md"), "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n", "utf8");
    await writeFile(join(workspaceDir, "BOOTSTRAP.md"), "# BOOTSTRAP.md - Hello, World\n", "utf8");
    await writeFile(join(workspaceDir, "IDENTITY.md"), "# IDENTITY.md - Who Am I?\n", "utf8");
    await writeFile(join(workspaceDir, "USER.md"), "# USER.md - About Your Human\n", "utf8");
    await writeFile(join(workspaceDir, "TOOLS.md"), "# TOOLS.md - Local Notes\n", "utf8");

    await syncAgentWorkspaceGuidance({
      agentId: "worker-clean",
      role: "executor",
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });

    // IDENTITY.md is now MANAGED (④role persona carrier) for execution-layer agents too:
    // the default scaffold is upgraded to the managed persona, not pruned.
    await access(join(workspaceDir, "IDENTITY.md"));
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
    assert.match(identity, /managed-by-watchdog:agent-bootstrap/);
    assert.match(identity, /## Role/);
    await access(join(workspaceDir, "HEARTBEAT.md"));
    await assert.rejects(access(join(workspaceDir, "AGENTS.md")));
    await assert.rejects(access(join(workspaceDir, "BOOTSTRAP.md")));
    await assert.rejects(access(join(workspaceDir, "USER.md")));
    await assert.rejects(access(join(workspaceDir, "TOOLS.md")));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("bridge guidance replaces generic AGENTS scaffold with managed template", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-bridge-agents-upgrade-"));

  try {
    await writeFile(join(workspaceDir, "AGENTS.md"), "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n", "utf8");

    const updates = await syncAgentWorkspaceGuidance({
      agentId: "bridge-office",
      role: "bridge",
      skills: ["system-action"],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });

    const agents = await readFile(join(workspaceDir, "AGENTS.md"), "utf8");
    const agentUpdate = updates.find((entry) => entry.name === "AGENTS.md");

    assert.equal(agentUpdate?.updated, true);
    assert.match(agents, /managed-by-watchdog:agent-bootstrap/);
    assert.match(agents, /你运行在 OpenClaw 平台里/);
    assert.match(agents, /处理 delivery 语义时再查 `DELIVERY\.md`/);
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
  assert.equal(createTaskFollowUp.workflow, "delivery:system_action_runtime_result");
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

test("terminal delivery wakes non-gateway agents with unified terminal-delivery semantics", async () => {
  const targetAgentId = `terminal-worker-${Date.now()}`;
  const contractId = `TC-TERMINAL-WAKE-${Date.now()}`;
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const previousHooksToken = cfg.hooksToken;
  const heartbeatCalls = [];

  runtimeAgentConfigs.clear();
  runtimeAgentConfigs.set(targetAgentId, {
    id: targetAgentId,
    role: "executor",
    gateway: false,
    ingressSource: null,
    specialized: false,
    skills: [],
  });

  try {
    cfg.hooksToken = "";
    const result = await deliveryRunTerminal({
      status: "completed",
      startMs: Date.now() - 1000,
      toolCallTotal: 0,
      contract: {
        id: contractId,
        task: "terminal wake semantic contract",
        replyTo: {
          kind: "agent",
          agentId: targetAgentId,
          sessionKey: `agent:${targetAgentId}:main`,
        },
        terminalOutcome: {
          status: "completed",
          summary: "terminal wake semantic",
          reason: "done",
        },
      },
    }, {
      runtime: {
        system: {
          requestHeartbeatNow(payload) {
            heartbeatCalls.push(payload);
          },
        },
      },
    }, {
      info() {},
      warn() {},
      error() {},
    });

    assert.equal(result.ok, true);
    assert.equal(heartbeatCalls.length, 1);
    assert.equal(
      heartbeatCalls[0]?.wakeEnvelope?.semanticType,
      "terminal_delivery_ready",
    );
    assert.equal(heartbeatCalls[0]?.wakeEnvelope?.deliveryId, `DL-${contractId}`);
    assert.equal(heartbeatCalls[0]?.wakeEnvelope?.contractId, contractId);
    assert.equal(
      heartbeatCalls[0]?.reason,
      "领取当前结果。",
    );
  } finally {
    cfg.hooksToken = previousHooksToken;
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(agentWorkspace(targetAgentId), { recursive: true, force: true });
  }
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

test("terminal user-facing result extracts explicit answer from artifact without full artifact body", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-terminal-user-facing-"));
  const artifactPath = join(artifactDir, "result.md");
  await writeFile(
    artifactPath,
    [
      "# 任务响应",
      "",
      "## 合约信息",
      "- 合约ID: TC-1",
      "- 执行节点: worker2",
      "",
      "**回复内容**：",
      "",
      "你好！很高兴收到你的消息。有什么我可以帮助你的吗？",
      "",
      "---",
      "*此响应由 worker2 自动生成*",
    ].join("\n"),
    "utf8",
  );

  try {
    const message = await resolveTerminalUserFacingResultContent({
      contract: {
        status: "completed",
        terminalOutcome: {
          status: "completed",
          source: "completion_criteria",
          summary: "已响应用户问候，任务完成",
          reason: "artifact verified",
          artifact: artifactPath,
        },
        executionObservation: {
          collected: true,
          primaryOutputPath: artifactPath,
        },
      },
    });

    assert.equal(message, "你好！很高兴收到你的消息。有什么我可以帮助你的吗？");
    assert.doesNotMatch(message, /worker2/u);
    assert.doesNotMatch(message, /合约ID/u);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("terminal user-facing result extracts final answer from unlabeled artifact metadata", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-terminal-unlabeled-answer-"));
  const artifactPath = join(artifactDir, "result.md");
  await writeFile(
    artifactPath,
    [
      "# 问候响应",
      "",
      "您好！我是执行节点 worker2，已收到您的问候。",
      "",
      "**任务信息：**",
      "- 合约编号：TC-1778744946950-f619ac",
      "- 接收时间：2026-05-14 15:49:06 (Asia/Shanghai)",
      "- 执行状态：已完成",
      "",
      "感谢您的问候！如有其他任务需要处理，请随时指示。",
    ].join("\n"),
    "utf8",
  );

  try {
    const message = await resolveTerminalUserFacingResultContent({
      contract: {
        status: "completed",
        terminalOutcome: {
          status: "completed",
          source: "completion_criteria",
          summary: "已成功完成问候响应任务。接收到用户问候「你好」，并已生成并交付响应文档。",
          reason: "artifact verified",
          artifact: artifactPath,
        },
      },
    });

    assert.equal(message, "感谢您的问候！如有其他任务需要处理，请随时指示。");
    assert.doesNotMatch(message, /worker2/u);
    assert.doesNotMatch(message, /合约编号/u);
    assert.doesNotMatch(message, /执行状态/u);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("terminal user-facing result extracts final answer from ioObservation preview", async () => {
  const message = await resolveTerminalUserFacingResultContent({
    contract: {
      status: "completed",
      terminalOutcome: {
        status: "completed",
        source: "completion_criteria",
        summary: "已成功完成问候响应任务。接收到用户问候「你好」，并已生成并交付响应文档。",
        reason: "artifact verified",
        artifact: "/tmp/openclaw-missing-terminal-artifact.md",
      },
      runtimeDiagnostics: {
        ioObservation: {
          output: {
            textPreview: "# 问候响应 您好！我是执行节点 worker2，已收到您的问候。 **任务信息：** - 合约编号：TC-1778744946950-f619ac - 接收时间：2026-05-14 15:49:06 (Asia/Shanghai) - 执行状态：已完成 感谢您的问候！如有其他任务需要处理，请随时指示。",
          },
        },
      },
    },
  });

  assert.equal(message, "感谢您的问候！如有其他任务需要处理，请随时指示。");
  assert.doesNotMatch(message, /worker2/u);
  assert.doesNotMatch(message, /合约编号/u);
  assert.doesNotMatch(message, /执行状态/u);
});

test("terminal user-facing result keeps delivery content from compact ioObservation preview", async () => {
  const message = await resolveTerminalUserFacingResultContent({
    contract: {
      status: "completed",
      terminalOutcome: {
        status: "completed",
        source: "completion_criteria",
        summary: "消息送达任务已完成。收到并处理任务消息「你好」，已按契约要求交付产物至指定输出路径。",
        reason: "artifact verified",
        artifact: "/tmp/openclaw-missing-compact-preview-artifact.md",
      },
      runtimeDiagnostics: {
        ioObservation: {
          output: {
            textPreview: "# 任务交付 ## 合约信息 - **合约ID**: TC-1778747751294-7c22bb - **任务**: 你好 - **执行节点**: worker2 - **执行时间**: 2026-05-14 16:35:51 (Asia/Shanghai) ## 任务状态 - **状态**: ✅ 已完成 - **阶段**: 消息送达 ## 交付内容 已收到并处理任务消息「你好」。消息送达任务已完成。 --- *本文件由 worker2 执行节点生成*",
          },
        },
      },
    },
  });

  assert.equal(message, "已收到并处理任务消息「你好」。消息送达任务已完成。");
  assert.doesNotMatch(message, /worker2/u);
  assert.doesNotMatch(message, /合约ID/u);
  assert.doesNotMatch(message, /执行时间/u);
});

test("terminal user-facing result ignores structured runtime_result userFacingResult metadata", async () => {
  const message = await resolveTerminalUserFacingResultContent({
    contract: {
      status: "completed",
      terminalOutcome: {
        status: "completed",
        source: "completion_criteria",
        summary: "任务完成标识",
      },
      executionObservation: {
        collected: true,
        stageRunResult: {
          status: "completed",
          userFacingResult: "今天是星期四。",
          summary: "已回答星期问题",
        },
      },
    },
  });

  assert.equal(message, "");
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

test("system_action delivery task copy stays positive and minimal", () => {
  const task = buildRuntimeResultDeliveryTask({
    header: "runtime 已收到子流程结果。",
    successInstruction: "请基于子流程结果继续处理。",
    awaitingInputInstruction: "子流程等待补充信息。请整理所需输入并回复上游。",
    failureInstruction: "子流程已收口为失败。请整理下一步处理建议。",
    taskSummary: "collect evidence",
    terminalStatus: CONTRACT_STATUS.FAILED,
    outcome: {
      status: CONTRACT_STATUS.FAILED,
      reason: "tool_write_failed",
      clarification: "runtime incident: tool write failed",
    },
  });

  assert.match(task, /子流程已收口为失败/u);
  assert.doesNotMatch(task, /失败原因|缺失|未提供|tool_write_failed|runtime incident/u);
});

test("deliveryRunTerminal does not expose completed terminalOutcome metadata when no artifact file exists", async () => {
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
    assert.equal(delivered.resultSummary, "(任务完成)");
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("deliveryRunTerminal hides internal completion reasons in non-success delivery copy", async () => {
  const gatewayAgentId = `delivery-failure-gateway-${Date.now()}`;
  const contractId = `TC-TERMINAL-FAILURE-${Date.now()}`;
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
      status: "failed",
      startMs: Date.now() - 1000,
      toolCallTotal: 0,
      lastLabel: "missing runtime_result: contract.output missing completion_criteria evidence",
      contract: {
        id: contractId,
        task: "terminal failure must not expose protocol details",
        output: "",
        replyTo: {
          kind: "agent",
          agentId: gatewayAgentId,
          sessionKey: `agent:${gatewayAgentId}:main`,
        },
        terminalOutcome: {
          status: "failed",
          source: "completion_criteria",
          reason: "missing runtime_result: contract.output missing completion_criteria evidence",
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
    assert.match(delivered.resultSummary, /任务失败/u);
    assert.doesNotMatch(delivered.resultSummary, /runtime_result|contract\.output|completion_criteria|missing runtime|未满足 contract/iu);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("deliveryRunTerminal keeps non-success terminal reasons out of user-facing delivery copy", async () => {
  const gatewayAgentId = `delivery-failure-reason-gateway-${Date.now()}`;
  const contractId = `TC-TERMINAL-FAULT-${Date.now()}`;
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
      status: "failed",
      startMs: Date.now() - 1000,
      toolCallTotal: 0,
      lastLabel: "tool write failed",
      contract: {
        id: contractId,
        task: "terminal failure must stay generic",
        output: "",
        replyTo: {
          kind: "agent",
          agentId: gatewayAgentId,
          sessionKey: `agent:${gatewayAgentId}:main`,
        },
        terminalOutcome: {
          status: "failed",
          source: "loop_runtime",
          reason: "tool_write_failed",
          clarification: "runtime incident: tool write failed",
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
    assert.equal(delivered.resultSummary, "❌ 任务失败\n任务未完成。");
    assert.doesNotMatch(delivered.resultSummary, /tool_write_failed|runtime incident|loop_runtime/iu);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("deliveryRunTerminal keeps output path policy details out of user-facing delivery copy", async () => {
  const gatewayAgentId = `delivery-output-policy-gateway-${Date.now()}`;
  const contractId = `TC-TERMINAL-PATH-POLICY-${Date.now()}`;
  const workspaceDir = agentWorkspace(gatewayAgentId);
  const unsafeArtifactPath = join(workspaceDir, "private", `${contractId}.md`);
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
        task: "terminal output path policy must stay internal",
        output: "",
        replyTo: {
          kind: "agent",
          agentId: gatewayAgentId,
          sessionKey: `agent:${gatewayAgentId}:main`,
        },
        terminalOutcome: {
          status: "completed",
          source: "completion_criteria",
          artifact: unsafeArtifactPath,
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
    assert.equal(delivered.resultSummary, "(任务完成)");
    assert.equal(delivered.outputPath, "");
    assert.doesNotMatch(delivered.resultSummary, /安全策略|非法|已拦截|PATH TRAVERSAL/iu);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("deliveryRunTerminal persists extracted user answer instead of full artifact body", async () => {
  const gatewayAgentId = `delivery-artifact-summary-${Date.now()}`;
  const contractId = `TC-TERMINAL-ARTIFACT-SUMMARY-${Date.now()}`;
  const workspaceDir = agentWorkspace(gatewayAgentId);
  const artifactPath = join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`);
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
    await mkdir(CONTROL_PLANE_PATHS.outputDir, { recursive: true });
    await writeFile(
      artifactPath,
      [
        "# 任务响应",
        "",
        "## 任务信息",
        "- 合约编号：TC-1",
        "- 执行节点：worker2",
        "",
        "## 回复内容",
        "",
        "你好！很高兴收到你的消息。有什么我可以帮助你的吗？",
      ].join("\n"),
      "utf8",
    );

    const result = await deliveryRunTerminal({
      status: "completed",
      startMs: Date.now() - 1000,
      toolCallTotal: 0,
      contract: {
        id: contractId,
        task: "terminal summary with artifact contract",
        output: artifactPath,
        replyTo: {
          kind: "agent",
          agentId: gatewayAgentId,
          sessionKey: `agent:${gatewayAgentId}:main`,
        },
        terminalOutcome: {
          status: "completed",
          source: "completion_criteria",
          summary: "已响应用户问候，任务完成",
          reason: "artifact verified",
          artifact: artifactPath,
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
    assert.equal(delivered.resultSummary, "你好！很高兴收到你的消息。有什么我可以帮助你的吗？");
    assert.doesNotMatch(delivered.resultSummary, /worker2/u);
    assert.equal(delivered.outputPath, artifactPath);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(artifactPath, { force: true });
  }
});

test("system_action delivery exact-session wake uses unified delivery resume semantics", async () => {
  const targetAgentId = `delivery-return-target-${Date.now()}`;
  const targetSessionKey = `agent:${targetAgentId}:hook:${Date.now()}`;
  const originalHooksToken = cfg.hooksToken;
  const originalApiRef = apiRef;
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const heartbeatCalls = [];
  clearTrackingStore();

  try {
    cfg.hooksToken = "";
    setApiRef({
      runtime: {
        system: {
          requestHeartbeatNow(payload) {
            heartbeatCalls.push({ ...payload, via: "global_api_ref" });
          },
        },
      },
    });
    runtimeAgentConfigs.set(targetAgentId, {
      id: targetAgentId,
      role: "executor",
      gateway: false,
      ingressSource: null,
      specialized: false,
      skills: [],
    });
    const deliveryTicketId = `DT-${Date.now()}`;
    const contract = createDirectRequestEnvelope({
      agentId: targetAgentId,
      sessionKey: targetSessionKey,
      replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
      message: "return payload",
      outputDir: join(agentWorkspace(targetAgentId), "output"),
      source: "assign_task",
    });
    contract.systemActionDeliveryTicket = { id: deliveryTicketId };
    const trackingState = createTrackingState({
      sessionKey: targetSessionKey,
      agentId: targetAgentId,
      parentSession: null,
    });
    trackingState.contract = {
      id: contract.id,
      status: "running",
    };
    rememberTrackingState(targetSessionKey, trackingState);

    const result = await deliveryEnqueueSystemActionReturn({
      lane: SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
      targetAgent: targetAgentId,
      contract,
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      wake: {
        targetSessionKey,
      },
    });

    assert.equal(result.wake?.ok, true);
    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls.some((payload) => payload.reason === "direct_request_resume"), false);
    assert.equal(
      heartbeatCalls[0]?.wakeEnvelope?.semanticType,
      "system_action_delivery_resume",
    );
    assert.equal(
      heartbeatCalls[0]?.wakeEnvelope?.deliveryTicketId,
      deliveryTicketId,
    );
    assert.equal(
      heartbeatCalls[0]?.reason,
      "处理当前返回结果。",
    );
  } finally {
    cfg.hooksToken = originalHooksToken;
    setApiRef(originalApiRef);
    clearTrackingStore();
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(agentWorkspace(targetAgentId), { recursive: true, force: true });
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
      systemActionDelivery: { workflow: "delivery:system_action_runtime_result" },
      systemActionDeliveryTicket: { id: "ticket-1" },
    },
  });

  assert.deepEqual(payload.systemActionDelivery, { workflow: "delivery:system_action_runtime_result" });
  assert.deepEqual(payload.systemActionDeliveryTicket, { id: "ticket-1" });
  assert.equal("runtimeReturn" in payload, false);
  assert.equal("runtimeReturnTicket" in payload, false);
});

test("runtime surface exposes only unified delivery event names", () => {
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_DELIVERY_FAILED, "system_action_delivery_failed");
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_RUNTIME_RESULT_DELIVERED, "system_action_runtime_result_delivered");
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_ASSIGN_TASK_RESULT_DELIVERED, "system_action_assign_task_result_delivered");
  assert.equal(EVENT_TYPE.SYSTEM_ACTION_REVIEW_VERDICT_DELIVERED, "system_action_review_verdict_delivered");
  assert.equal("RUNTIME_BRIDGE_FAILED" in EVENT_TYPE, false);
  assert.equal("EXECUTION_RESULT_RETURNED" in EVENT_TYPE, false);
  assert.equal("ASSIGN_TASK_RESULT_RETURNED" in EVENT_TYPE, false);
  assert.equal("REVIEW_VERDICT_RETURNED" in EVENT_TYPE, false);
});

test("system_action delivery result and diagnostics expose deliveryTicketId only", () => {
  const result = buildSystemActionDeliveryResult({
    deliveryId: "delivery:system_action_runtime_result",
    deliveryTicketId: "ticket-123",
  });
  const diagnostic = normalizeSystemActionDeliveryDiagnostic(result);

  assert.equal(result.deliveryTicketId, "ticket-123");
  assert.equal("returnTicketId" in result, false);
  assert.equal(diagnostic?.deliveryTicketId, "ticket-123");
  assert.equal("returnTicketId" in (diagnostic || {}), false);
});

test("system_action runtime delivery reads result content from executionObservation artifacts", async () => {
  const targetAgent = `delivery-target-${Date.now()}`;
  const workspaceDir = agentWorkspace(targetAgent);
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-delivery-artifact-"));
  const artifactPath = join(artifactDir, "result.md");
  const artifactContent = "artifact-backed result content";
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  await writeFile(artifactPath, artifactContent, "utf8");
  await clearSystemActionDeliveryTicketStore();

  try {
    runtimeAgentConfigs.set(targetAgent, {
      id: targetAgent,
      role: "executor",
      gateway: false,
      ingressSource: null,
      specialized: false,
      skills: [],
    });
    const deliveryTicket = await registerSystemActionDeliveryTicket({
      lane: "delivery:system_action_runtime_result",
      intentType: INTENT_TYPES.CREATE_TASK,
      sourceAgentId: "worker-a",
      sourceSessionKey: "agent:worker-a:main",
      sourceContractId: "TC-SYSTEM-ACTION-RESULT",
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
    });
    await deliveryRunSystemActionRuntimeResult({
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
        systemActionDeliveryTicket: deliveryTicket,
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
    assert.equal(delivered.systemActionDelivery?.deliveryTicketId, deliveryTicket.id);
  } finally {
    await clearSystemActionDeliveryTicketStore();
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("system_action runtime delivery without ticket does not enqueue fallback route", async () => {
  const targetAgent = `delivery-no-ticket-${Date.now()}`;
  const workspaceDir = agentWorkspace(targetAgent);
  await clearSystemActionDeliveryTicketStore();

  try {
    const result = await deliveryRunSystemActionRuntimeResult({
      trackingState: {
        agentId: "worker-a",
        contract: {
          id: "TC-SYSTEM-ACTION-NO-TICKET",
          task: "must not fallback",
        },
      },
      contractData: {
        id: "TC-SYSTEM-ACTION-NO-TICKET",
        task: "must not fallback",
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
        reason: "should not deliver",
      },
      api: null,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

    assert.equal(result.handled, false);
    assert.equal(result.error, null);
    await assert.rejects(readFile(join(workspaceDir, "inbox", "contract.json"), "utf8"));
  } finally {
    await clearSystemActionDeliveryTicketStore();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("delivery control-plane source files no longer mention legacy runtime return residue", async () => {
  const files = [
    join(WATCHDOG_ROOT, "lib", "routing", "dispatch-transport.js"),
    join(WATCHDOG_ROOT, "lib", "runtime-workflow-semantics.js"),
    join(WATCHDOG_ROOT, "lib", "workspace-guidance-writer.js"),
    join(WATCHDOG_ROOT, "lib", "harness", "harness-module-evidence.js"),
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
  const workspacesDir = join(OPENCLAW_ROOT, "workspaces");
  const workspaceEntries = await readWorkspaceDirectoryEntriesIfPresent();
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
  const workspacesDir = join(OPENCLAW_ROOT, "workspaces");
  const entries = await readWorkspaceDirectoryEntriesIfPresent();
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
    access(join(WATCHDOG_ROOT, "lib", "runtime-direct-inbox.js")),
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
      access(join(WATCHDOG_ROOT, "lib", "bridge", fileName)),
    );
  }
});

test("legacy pool compatibility shell file is removed", async () => {
  await assert.rejects(
    access(join(WATCHDOG_ROOT, "lib", "routing", "pool.js")),
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
    "delivery-system-action-runtime-result.js",
    "delivery-system-action-chain.js",
    "delivery-system-action-transport.js",
    "delivery-system-action-helpers.js",
    "delivery-system-action-ticket.js",
    "delivery-system-action-review-verdict.js",
  ];

  for (const fileName of unifiedFiles) {
    await access(join(WATCHDOG_ROOT, "lib", "routing", fileName));
  }
});

test("collaboration policy imports without legacy bridge path", async () => {
  await assert.doesNotReject(() => import("../lib/collaboration-policy.js"));
});

test("system_action runtime delivery imports without duplicate route exports", async () => {
  await assert.doesNotReject(() => import("../lib/routing/delivery-system-action-runtime-result.js"));
});

test("canonical runtime and active test prompts no longer mention outbox/system_action.json", async () => {
  const files = [
    join(WATCHDOG_ROOT, "lib", "store", "execution-trace-store.js"),
    join(WATCHDOG_ROOT, "lib", "formal-runtime", "suite-direct-service.js"),
    join(WATCHDOG_ROOT, "tests", "delegation-early-check-paths.test.js"),
    join(WATCHDOG_ROOT, "tests", "contractor-loop-permission.test.js"),
    join(WATCHDOG_ROOT, "tests", "suite-agent-model.js"),
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    assert.equal(content.includes("outbox/system_action.json"), false, `${filePath} still mentions outbox/system_action.json`);
  }
});
