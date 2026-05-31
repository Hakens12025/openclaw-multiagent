import test from "node:test";
import assert from "node:assert/strict";

import { composeEffectiveProfile } from "../lib/effective-profile-composer.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { buildProgressPayload } from "../lib/transport/sse.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import {
  clearTrackingStore,
  rememberTrackingState,
  snapshotTrackingSessions,
} from "../lib/store/tracker-store.js";

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  clearTrackingStore();
});

test("config tools remain the single truth even when agent-card projects broader tools", () => {
  const profile = composeEffectiveProfile({
    config: {
      agents: {
        defaults: {
          skills: ["platform-map"],
        },
      },
    },
    agentConfig: {
      id: "worker-tight",
      role: "executor",
      workspace: "~/.openclaw/workspaces/worker-tight",
      tools: {
        allow: ["read", "write", "edit"],
      },
    },
    card: {
      id: "worker-tight",
      role: "executor",
      capabilities: {
        tools: ["read", "write", "edit", "web_search", "web_fetch", "browser"],
      },
    },
  });

  assert.deepEqual(
    profile.capabilities?.tools,
    ["read", "write", "edit"],
    "effective profile should honor CLI/runtime tools truth over card projection",
  );
});

test("runtime registry retains effective tools truth for downstream consumers", () => {
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "worker-tight",
          role: "executor",
          workspace: "~/.openclaw/workspaces/worker-tight",
          tools: {
            allow: ["read", "write", "edit"],
          },
        },
      ],
    },
  });

  const runtimeConfig = runtimeAgentConfigs.get("worker-tight");

  assert.deepEqual(
    runtimeConfig?.capabilities?.tools,
    ["read", "write", "edit"],
    "runtime registry should preserve effective tools truth for router/operator/automation consumers",
  );
});

test("tracking, SSE, and runtime snapshot expose the same ioObservation payload", () => {
  const now = Date.now();
  const sessionKey = `agent:worker-tight:io-truth:${now}`;
  const ioObservation = {
    version: 1,
    input: {
      contractId: "TC-IO-TRUTH",
      task: "monitor exact agent input and output",
      outputPath: "/tmp/io-truth.md",
      effectiveTools: ["read", "write", "edit"],
    },
    output: {
      primaryOutputPath: "/tmp/io-truth.md",
      artifactPaths: ["/tmp/io-truth.md"],
      textPreview: "hello from worker",
    },
  };

  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "worker-tight",
    status: "running",
    startMs: now - 1000,
    toolCalls: [],
    recentToolEvents: [],
    toolCallTotal: 0,
    lastLabel: "处理中",
    activityCursor: null,
    runtimeObservation: null,
    ioObservation,
    stageProjection: null,
    cursor: "0/0",
    pct: 0,
    estimatedPhase: "",
    contract: {
      id: "TC-IO-TRUTH",
      task: "monitor exact agent input and output",
      assignee: "worker-tight",
      status: "running",
      createdAt: now - 1500,
      updatedAt: now - 500,
    },
  });

  const trackingSnapshot = snapshotTrackingSessions(now)[sessionKey];
  const payload = buildProgressPayload({
    ...rememberedTrackingState(sessionKey),
  });

  assert.deepEqual(trackingSnapshot?.ioObservation, ioObservation);
  assert.deepEqual(payload.ioObservation, ioObservation);
});

function rememberedTrackingState(sessionKey) {
  return snapshotToTrackingState(sessionKey);
}

function snapshotToTrackingState(sessionKey) {
  const state = snapshotTrackingSessions();
  const entry = state[sessionKey];
  return {
    sessionKey,
    agentId: entry?.agentId || null,
    parentSession: null,
    startMs: Date.now() - (entry?.elapsedMs || 0),
    toolCalls: [],
    recentToolEvents: entry?.recentToolEvents || [],
    toolCallTotal: entry?.toolCallCount || 0,
    lastLabel: entry?.lastLabel || null,
    status: entry?.status || null,
    contract: {
      id: entry?.workItemId || null,
      task: entry?.task || null,
      assignee: entry?.agentId || null,
      status: entry?.status || null,
    },
    artifactContext: null,
    activityCursor: entry?.activityCursor || null,
    runtimeObservation: entry?.runtimeObservation || null,
    ioObservation: entry?.ioObservation || null,
    stageProjection: null,
    cursor: entry?.cursor || null,
    pct: entry?.pct ?? null,
    estimatedPhase: "",
  };
}
