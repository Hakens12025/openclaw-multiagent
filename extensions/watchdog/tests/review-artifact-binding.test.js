import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hasActionableHeartbeatWork } from "../lib/heartbeat-gate.js";
import {
  bindInboxArtifactContext,
  createTrackingState,
} from "../lib/session-bootstrap.js";
import { applyTrackingStageProjection } from "../lib/stage-projection.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { buildProgressPayload } from "../lib/transport/sse.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function restoreRuntimeConfigs(previousRuntimeConfigs) {
  runtimeAgentConfigs.clear();
  for (const [key, value] of previousRuntimeConfigs.entries()) {
    runtimeAgentConfigs.set(key, value);
  }
}

test("bindInboxArtifactContext binds reviewer code_review inbox payload into tracking artifactContext", async () => {
  const agentId = `review-bind-agent-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const reviewRequestPath = join(inboxDir, "code_review.json");
  const trackingState = createTrackingState({
    sessionKey: `agent:${agentId}:review-bind`,
    agentId,
    parentSession: null,
  });
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);

  const payload = {
    protocol: {
      version: 1,
      transport: "code_review.json",
      source: "request_review",
      route: "system_action",
      intentType: "request_review",
    },
    source: {
      agentId: "worker-source",
      sessionKey: "agent:worker-source:main",
      contractId: "TC-REVIEW-BIND",
    },
    request: {
      instruction: "请审查当前实现并给出 verdict",
      requestedAt: Date.now(),
    },
    replyTo: {
      agentId: "worker-source",
      sessionKey: "agent:worker-source:main",
    },
    returnContext: {
      sourceAgentId: "worker-source",
      sourceSessionKey: "agent:worker-source:main",
      intentType: "request_review",
    },
    domain: "generic",
  };

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role: "reviewer",
      workspace: workspaceDir,
      specialized: false,
      gateway: false,
      protected: false,
      ingressSource: null,
      capabilities: {},
      skills: [],
      effectiveExecutionPolicy: null,
    });

    await mkdir(inboxDir, { recursive: true });
    await writeFile(reviewRequestPath, JSON.stringify(payload, null, 2), "utf8");

    const result = await bindInboxArtifactContext({
      agentId,
      trackingState,
      logger,
    });

    assert.equal(result?.kind, "code_review");
    assert.equal(result?.path, reviewRequestPath);
    assert.equal(trackingState.artifactContext?.kind, "code_review");
    assert.equal(trackingState.artifactContext?.protocol?.transport, "code_review.json");
    assert.equal(trackingState.artifactContext?.request?.instruction, "请审查当前实现并给出 verdict");
    assert.equal(trackingState.artifactContext?.source?.contractId, "TC-REVIEW-BIND");
  } finally {
    restoreRuntimeConfigs(previousRuntimeConfigs);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("hasActionableHeartbeatWork treats reviewer code_review inbox payload as actionable work", async () => {
  const agentId = `review-heartbeat-agent-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const reviewRequestPath = join(inboxDir, "code_review.json");
  const trackingState = createTrackingState({
    sessionKey: `agent:${agentId}:review-heartbeat`,
    agentId,
    parentSession: null,
  });
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role: "reviewer",
      workspace: workspaceDir,
      specialized: false,
      gateway: false,
      protected: false,
      ingressSource: null,
      capabilities: {},
      skills: [],
      effectiveExecutionPolicy: null,
    });

    await mkdir(inboxDir, { recursive: true });
    await writeFile(reviewRequestPath, JSON.stringify({
      protocol: {
        transport: "code_review.json",
        source: "request_review",
      },
    }, null, 2), "utf8");

    const actionable = await hasActionableHeartbeatWork(
      agentId,
      trackingState,
      trackingState.sessionKey,
    );

    assert.equal(actionable, true);
  } finally {
    restoreRuntimeConfigs(previousRuntimeConfigs);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("bindInboxArtifactContext ignores executor code_review inbox payload", async () => {
  const agentId = `executor-review-bind-agent-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const reviewRequestPath = join(inboxDir, "code_review.json");
  const trackingState = createTrackingState({
    sessionKey: `agent:${agentId}:executor-review-bind`,
    agentId,
    parentSession: null,
  });
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role: "executor",
      workspace: workspaceDir,
      specialized: true,
      gateway: false,
      protected: false,
      ingressSource: null,
      capabilities: {
        routerHandlerId: "executor_contract",
      },
      skills: [],
      effectiveExecutionPolicy: null,
    });

    await mkdir(inboxDir, { recursive: true });
    await writeFile(reviewRequestPath, JSON.stringify({
      protocol: {
        transport: "code_review.json",
        source: "request_review",
      },
    }, null, 2), "utf8");

    const result = await bindInboxArtifactContext({
      agentId,
      trackingState,
      logger,
    });

    assert.equal(result, null);
    assert.equal(trackingState.artifactContext, null);
  } finally {
    restoreRuntimeConfigs(previousRuntimeConfigs);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("hasActionableHeartbeatWork ignores executor code_review inbox payload and keeps empty reviewer idle", async () => {
  const executorId = `executor-review-heartbeat-${Date.now()}`;
  const reviewerId = `reviewer-empty-heartbeat-${Date.now()}`;
  const executorWorkspace = agentWorkspace(executorId);
  const reviewerWorkspace = agentWorkspace(reviewerId);
  const executorInboxDir = join(executorWorkspace, "inbox");
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set(executorId, {
      id: executorId,
      role: "executor",
      workspace: executorWorkspace,
      specialized: true,
      gateway: false,
      protected: false,
      ingressSource: null,
      capabilities: {
        routerHandlerId: "executor_contract",
      },
      skills: [],
      effectiveExecutionPolicy: null,
    });
    runtimeAgentConfigs.set(reviewerId, {
      id: reviewerId,
      role: "reviewer",
      workspace: reviewerWorkspace,
      specialized: false,
      gateway: false,
      protected: false,
      ingressSource: null,
      capabilities: {},
      skills: [],
      effectiveExecutionPolicy: null,
    });

    await mkdir(executorInboxDir, { recursive: true });
    await mkdir(join(reviewerWorkspace, "inbox"), { recursive: true });
    await writeFile(join(executorInboxDir, "code_review.json"), JSON.stringify({
      protocol: {
        transport: "code_review.json",
        source: "request_review",
      },
    }, null, 2), "utf8");

    const executorActionable = await hasActionableHeartbeatWork(
      executorId,
      createTrackingState({
        sessionKey: `agent:${executorId}:main`,
        agentId: executorId,
        parentSession: null,
      }),
      `agent:${executorId}:main`,
    );
    const reviewerActionable = await hasActionableHeartbeatWork(
      reviewerId,
      createTrackingState({
        sessionKey: `agent:${reviewerId}:main`,
        agentId: reviewerId,
        parentSession: null,
      }),
      `agent:${reviewerId}:main`,
    );

    assert.equal(executorActionable, false);
    assert.equal(reviewerActionable, false);
  } finally {
    restoreRuntimeConfigs(previousRuntimeConfigs);
    await rm(executorWorkspace, { recursive: true, force: true });
    await rm(reviewerWorkspace, { recursive: true, force: true });
  }
});

test("reviewer artifactContext projects protocol-defined stage truth and progress payload semantics", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:reviewer:main",
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
      contractId: "TC-REVIEW-OBS",
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
      id: "ticket-review-1",
    },
    operatorContext: {
      conversationId: "conv-review",
    },
    domain: "generic",
    runtimeDiagnostics: null,
  };

  const projection = applyTrackingStageProjection(trackingState);
  const payload = buildProgressPayload(trackingState);

  assert.equal(projection?.source, "artifact_context");
  assert.equal(projection?.confidence, "protocol");
  assert.deepEqual(projection?.stagePlan, ["代码审查"]);
  assert.equal(projection?.currentStage, "code_review");
  assert.equal(projection?.currentStageLabel, "代码审查");
  assert.equal(projection?.cursor, "0/1");
  assert.equal(projection?.pct, 0);

  assert.equal(payload.hasContract, false);
  assert.equal(payload.workItemKind, "artifact_backed");
  assert.equal(payload.workItemId, "artifact:code_review:agent:reviewer:main");
  assert.equal(payload.task, "代码审查: 请审查当前实现并给出 verdict");
  assert.equal(payload.taskType, "request_review");
  assert.equal(payload.protocolEnvelope, "code_review");
  assert.equal(payload.replyTo?.agentId, "worker-source");
  assert.equal(payload.upstreamReplyTo?.agentId, "controller");
  assert.equal(payload.returnContext?.sourceAgentId, "worker-source");
  assert.equal(payload.systemActionDeliveryTicket?.id, "ticket-review-1");
  assert.equal(payload.createdAt, 1234567890);
  assert.equal(payload.artifactKind, "code_review");
  assert.equal(payload.artifactDomain, "generic");
  assert.equal(payload.artifactSource?.contractId, "TC-REVIEW-OBS");
  assert.equal(payload.artifactRequest?.instruction, "请审查当前实现并给出 verdict");
});
