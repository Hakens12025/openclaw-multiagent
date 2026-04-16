import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { collectReviewerOutbox } from "../lib/routing/runtime-mailbox-outbox-handlers.js";
import { runtimeAgentConfigs } from "../lib/state.js";

const logger = { info() {}, warn() {}, error() {} };

function cleanup() {
  runtimeAgentConfigs.clear();
}

async function setupOutbox(outboxDir, fileName, content) {
  await mkdir(outboxDir, { recursive: true });
  await writeFile(join(outboxDir, fileName), JSON.stringify(content));
}

test("collectReviewerOutbox normalizes code_verdict.json into unified reviewerResult", async () => {
  const tmpDir = join(tmpdir(), `eval-outbox-verdict-${Date.now()}`);
  const outboxDir = join(tmpDir, "outbox");
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          { id: "test-eval", binding: { roleRef: "reviewer", workspace: { configured: tmpDir } } },
          { id: "worker-a", binding: { roleRef: "executor", workspace: { configured: tmpDir }, policies: { specialized: true } } },
        ],
      },
    });

    await setupOutbox(outboxDir, "code_verdict.json", {
      verdict: "reject",
      feedback: "variable naming issue",
      issues: [{ severity: "error", description: "foo is undefined", line: 42 }],
      score: 35,
      rework_target: "worker-a",
      dead_ends_to_add: ["approach-x"],
    });

    const result = await collectReviewerOutbox({
      agentId: "test-eval",
      outboxDir,
      files: ["code_verdict.json"],
      logger,
      manifest: null,
    });

    assert.equal(result.collected, true);
    assert.ok(result.reviewerResult, "should have reviewerResult");
    assert.equal(result.reviewerResult.verdict, "fail");
    assert.equal(result.reviewerResult.continueHint, "rework");
    assert.equal(result.reviewerResult.score, 35);
    assert.equal(result.reviewerResult.reworkTarget, "worker-a");
    assert.equal(result.reviewerResult.findings.length, 1);
    assert.equal(result.reviewerResult.findings[0].message, "foo is undefined");
    assert.equal(result.artifactKind, "code_review");
    assert.equal(result.stageCompletion.transition.kind, "advance");
  } finally {
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("collectReviewerOutbox normalizes next_action.json into unified reviewerResult", async () => {
  const tmpDir = join(tmpdir(), `eval-outbox-action-${Date.now()}`);
  const outboxDir = join(tmpDir, "outbox");
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          { id: "test-eval", binding: { roleRef: "reviewer", workspace: { configured: tmpDir } } },
        ],
      },
    });

    await setupOutbox(outboxDir, "next_action.json", {
      action: "conclude",
      feedback: "task complete, all objectives met",
      round_summary: "final round",
    });

    const result = await collectReviewerOutbox({
      agentId: "test-eval",
      outboxDir,
      files: ["next_action.json"],
      logger,
      manifest: null,
    });

    assert.equal(result.collected, true);
    assert.ok(result.reviewerResult, "should have reviewerResult");
    assert.equal(result.reviewerResult.verdict, "pass");
    assert.equal(result.reviewerResult.continueHint, "conclude");
    assert.equal(result.artifactKind, null);
    assert.equal(result.stageCompletion.transition.kind, "conclude");
  } finally {
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("collectReviewerOutbox produces same executionObservation shape for both paths", async () => {
  const tmpDir = join(tmpdir(), `eval-outbox-shape-${Date.now()}`);
  const outboxDir = join(tmpDir, "outbox");
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          { id: "test-eval", binding: { roleRef: "reviewer", workspace: { configured: tmpDir } } },
        ],
      },
    });

    await setupOutbox(outboxDir, "code_verdict.json", {
      verdict: "approve",
      feedback: "looks good",
    });

    const result = await collectReviewerOutbox({
      agentId: "test-eval",
      outboxDir,
      files: ["code_verdict.json"],
      logger,
      manifest: null,
    });

    const expectedKeys = [
      "collected", "files", "artifactPaths", "primaryOutputPath",
      "reviewerResult", "reviewVerdict", "artifactKind",
      "stageRunResult", "stageCompletion",
    ];
    for (const key of expectedKeys) {
      assert.ok(key in result, `executionObservation should have "${key}"`);
    }
    assert.equal(result.reviewerResult.verdict, "pass");
    assert.equal(result.reviewerResult.continueHint, "continue");
    assert.equal(result.stageCompletion.transition.kind, "follow_graph");
  } finally {
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
