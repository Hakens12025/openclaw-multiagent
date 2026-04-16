import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRandomPresetRuntime,
  resolveRandomPresetCandidateSet,
  buildSystemRandomRunSingleOptions,
  buildLoopRandomRunSingleOptions,
  buildUnsupportedRandomPresetResult,
} from "../lib/test-runs.js";

test("buildRandomPresetRuntime sorts candidate set and picks a stable chosen agent", () => {
  const runtime = buildRandomPresetRuntime({
    preset: { family: "user-random" },
    caseDef: { id: "simple-03" },
    candidateSet: ["worker-b", "controller", "worker-a"],
    seed: "seed-fixed",
  });

  assert.deepEqual(runtime.candidateSet, ["controller", "worker-a", "worker-b"]);
  assert.equal(runtime.seed, "seed-fixed");
  assert.ok(runtime.chosenAgent);
  assert.equal(runtime.actualPath, "unresolved");
});

test("buildUnsupportedRandomPresetResult returns a blocked random result", () => {
  const result = buildUnsupportedRandomPresetResult({
    testCase: { id: "simple-03", message: "你好" },
    family: "system-random",
    reason: "system-random runtime object is not implemented yet",
  });

  assert.equal(result.pass, false);
  assert.equal(result.blocked, true);
  assert.equal(result.errorCode, "E_RANDOM_CAPABILITY_BLOCKED");
  assert.equal(result.randomRuntime.family, "system-random");
});

test("buildSystemRandomRunSingleOptions dispatches through formal ingress with explicit dispatch owner", async () => {
  const calls = [];
  const options = buildSystemRandomRunSingleOptions({
    replyTo: {
      agentId: "test-run",
      sessionKey: "test-run:TR-1",
    },
    randomRuntime: {
      family: "system-random",
      chosenAgent: "worker2",
    },
    runtimeContext: {
      api: {},
      enqueue() { return true; },
      wakePlanner() {},
    },
    logger: null,
    dispatchAcceptIngressMessageFn: async (message, payload) => {
      calls.push({ message, payload });
      return { ok: true, contractId: "TC-1" };
    },
  });

  const result = await options.sendMessage("formal system random");

  assert.equal(typeof options.sendMessage, "function");
  assert.equal(result.contractId, "TC-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, "formal system random");
  assert.equal(calls[0].payload.replyTo.agentId, "test-run");
  assert.equal(calls[0].payload.dispatchOwnerAgentId, "worker2");
  assert.equal(calls[0].payload.source, "system");
});

test("resolveRandomPresetCandidateSet narrows system-random to agents with outgoing graph edges", () => {
  const candidates = resolveRandomPresetCandidateSet({
    preset: {
      family: "system-random",
      runtimeMode: "random",
    },
    runtimeAgentIds: ["controller", "planner", "worker"],
    graph: {
      edges: [
        { from: "controller", to: "planner", gate: "default" },
        { from: "planner", to: "worker", gate: "default" },
      ],
    },
  });

  assert.deepEqual(candidates, ["controller", "planner"]);
});

test("resolveRandomPresetCandidateSet excludes active loop members from system-random", () => {
  const candidates = resolveRandomPresetCandidateSet({
    preset: {
      family: "system-random",
      runtimeMode: "random",
    },
    runtimeAgentIds: ["controller", "planner", "worker-3", "worker-4"],
    graph: {
      edges: [
        { from: "controller", to: "planner", gate: "default" },
        { from: "planner", to: "worker", gate: "default" },
        { from: "worker-3", to: "worker-4", gate: "default" },
        { from: "worker-4", to: "worker-3", gate: "default" },
      ],
    },
    activeLoops: [
      {
        active: true,
        nodes: ["worker-3", "worker-4"],
      },
    ],
  });

  assert.deepEqual(candidates, ["controller", "planner"]);
});

test("resolveRandomPresetCandidateSet narrows loop-random to active loop members", () => {
  const candidates = resolveRandomPresetCandidateSet({
    preset: {
      family: "loop-random",
      runtimeMode: "random",
    },
    runtimeAgentIds: ["controller", "planner", "worker-3", "worker-4"],
    graph: {
      edges: [
        { from: "controller", to: "planner", gate: "default" },
        { from: "planner", to: "worker", gate: "default" },
        { from: "worker-3", to: "worker-4", gate: "default" },
        { from: "worker-4", to: "worker-3", gate: "default" },
      ],
    },
    activeLoops: [
      {
        id: "loop-workers",
        active: true,
        nodes: ["worker-3", "worker-4"],
      },
    ],
  });

  assert.deepEqual(candidates, ["worker-3", "worker-4"]);
});

test("buildLoopRandomRunSingleOptions starts the resolved loop from the chosen member", async () => {
  const calls = [];
  const options = buildLoopRandomRunSingleOptions({
    randomRuntime: {
      family: "loop-random",
      resolvedLoopId: "loop-worker-pair",
      chosenLoopMember: "worker-4",
    },
    runtimeContext: {
      api: {
        runtime: {
          system: {
            requestHeartbeatNow() {},
          },
        },
      },
      enqueue() { return true; },
      wakePlanner() {},
    },
    logger: null,
    startRuntimeLoopFn: async (payload) => {
      calls.push(payload);
      return {
        ok: true,
        action: "started",
        contractId: "TC-LOOP-1",
        loopId: "loop-worker-pair",
        currentStage: "worker-4",
      };
    },
  });

  const result = await options.sendMessage("formal loop random");

  assert.equal(typeof options.sendMessage, "function");
  assert.equal(result.contractId, "TC-LOOP-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.payload?.loopId, "loop-worker-pair");
  assert.equal(calls[0]?.payload?.startAgent, "worker-4");
  assert.equal(calls[0]?.payload?.requestedTask, "formal loop random");
});
