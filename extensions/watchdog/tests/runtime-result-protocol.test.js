import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AGENT_ROLE,
} from "../lib/agent/agent-metadata.js";
import {
  getCapabilityPreset,
} from "../lib/capability/capability-preset-registry.js";
import {
  ARTIFACT_TYPES,
  RUNTIME_RESULT_FILE,
  OUTBOX_COMMIT_KINDS,
} from "../lib/protocol-primitives.js";
import * as protocolPrimitives from "../lib/protocol-primitives.js";
import { observeCanonicalRuntimeResultCommit } from "../lib/protocol-commit-observer.js";
import { buildOutputIoObservation } from "../lib/io-observation.js";
import { agentWorkspace } from "../lib/state.js";

test("runtime result is the only agent-facing outbox result artifact", () => {
  assert.equal(RUNTIME_RESULT_FILE, "runtime_result.json");
  assert.equal(ARTIFACT_TYPES.RUNTIME_RESULT, "runtime_result");
  assert.equal("STAGE_RESULT" in ARTIFACT_TYPES, false);
  assert.equal(OUTBOX_COMMIT_KINDS.EXECUTION_RESULT, "execution_result");
  assert.equal("normalizeOutboxCommitManifest" in protocolPrimitives, false);
});

test("runtime-capable roles expose runtime result output format only", () => {
  for (const role of [AGENT_ROLE.EXECUTOR, AGENT_ROLE.RESEARCHER, AGENT_ROLE.AGENT]) {
    const outputFormats = getCapabilityPreset(role).outputFormats;

    assert.equal(outputFormats.includes("runtime-result-json"), true);
    assert.equal(outputFormats.includes("stage-result-json"), false);
    assert.equal(outputFormats.includes("contract-result-json"), false);
  }
});

test("runtime result commit observation uses runtime result naming only", async () => {
  const agentId = `runtime-result-observer-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const trackingState = {};

  try {
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, RUNTIME_RESULT_FILE), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "runtime result committed",
    }), "utf8");

    const observed = await observeCanonicalRuntimeResultCommit({
      trackingState,
      agentId,
      observedAt: 123,
    });

    assert.equal(observed?.type, "runtime_result");
    assert.equal(observed?.fileName, RUNTIME_RESULT_FILE);
    assert.ok(trackingState.runtimeObservation?.runtimeResultCommit);
    assert.equal("stageResultCommit" in trackingState.runtimeObservation, false);
  } finally {
    await rm(agentWorkspace(agentId), { recursive: true, force: true });
  }
});

test("output io observation exposes runtime result path naming only", async () => {
  const observation = await buildOutputIoObservation({
    executionObservation: {
      collected: true,
      primaryOutputPath: null,
      artifactPaths: [],
      stageRunResult: {
        status: "completed",
        summary: "runtime result committed",
        artifacts: [],
        metadata: {
          sourceRuntimeResultPath: "/tmp/runtime_result.json",
        },
      },
    },
    observedAt: 456,
  });

  assert.equal(observation?.output?.runtimeResultPath, "/tmp/runtime_result.json");
  assert.equal("stageResultPath" in observation.output, false);
});
