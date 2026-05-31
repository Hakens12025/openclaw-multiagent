import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractContractArtifact,
  extractContractScore,
  extractContractSummary,
  extractLoopRuntimeArtifact,
  extractLoopRuntimeScore,
  extractLoopRuntimeSummary,
  deriveLoopRuntimeTerminalStatus,
} from "../lib/automation/automation-result-extractors.js";
import { readContractCompletionArtifact } from "../lib/contracts.js";
import { buildBaseEvidence } from "../lib/harness/harness-module-evidence.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

test("automation result extractors prefer terminalOutcome over legacy terminal dialects", () => {
  const contract = {
    task: "legacy should not override terminal truth",
    workflowConclusion: {
      score: 91,
      artifactPath: "/tmp/legacy-workflow.md",
      summary: "legacy workflow summary",
    },
    researchConclusion: {
      score: 77,
      artifactPath: "/tmp/legacy-research.md",
      summary: "legacy research summary",
    },
    terminalOutcome: {
      score: 0.82,
      artifact: "/tmp/canonical-terminal.md",
      summary: "canonical terminal summary",
      reason: "canonical terminal reason",
    },
  };

  assert.equal(extractContractScore(contract), 0.82);
  assert.equal(extractContractArtifact(contract), "/tmp/canonical-terminal.md");
  assert.equal(extractContractSummary(contract), "canonical terminal summary");
});

test("automation result extractors do not fall back to legacy workflowConclusion or researchConclusion", () => {
  const contract = {
    task: "summary should fall back to task when no canonical terminal truth exists",
    workflowConclusion: {
      score: 91,
      artifactPath: "/tmp/legacy-workflow.md",
      summary: "legacy workflow summary",
    },
    researchConclusion: {
      score: 77,
      artifactPath: "/tmp/legacy-research.md",
      summary: "legacy research summary",
    },
  };

  assert.equal(extractContractScore(contract), null);
  assert.equal(extractContractArtifact(contract), null);
  assert.equal(
    extractContractSummary(contract),
    "summary should fall back to task when no canonical terminal truth exists",
  );
});

test("loop runtime result extractors prefer feedbackOutput over legacy workflowConclusion or researchConclusion", () => {
  const loopRuntime = {
    workflowConclusion: {
      score: 91,
      artifactPath: "/tmp/legacy-workflow.md",
      summary: "legacy workflow summary",
      status: "failed",
    },
    researchConclusion: {
      score: 77,
      artifactPath: "/tmp/legacy-research.md",
      summary: "legacy research summary",
      status: "completed",
    },
    feedbackOutput: {
      score: 0.82,
      feedback: "canonical loop runtime summary",
      result: {
        score: 0.83,
        status: "cancelled",
      },
    },
    conclusionArtifact: {
      path: "/tmp/canonical-loop-runtime.md",
    },
  };

  assert.equal(extractLoopRuntimeScore(loopRuntime), 0.83);
  assert.equal(extractLoopRuntimeArtifact(loopRuntime), "/tmp/canonical-loop-runtime.md");
  assert.equal(extractLoopRuntimeSummary(loopRuntime), "canonical loop runtime summary");
  assert.equal(deriveLoopRuntimeTerminalStatus(loopRuntime), CONTRACT_STATUS.CANCELLED);
});

test("loop runtime result extractors do not fall back to legacy workflowConclusion or researchConclusion", () => {
  const loopRuntime = {
    workflowConclusion: {
      score: 91,
      artifactPath: "/tmp/legacy-workflow.md",
      summary: "legacy workflow summary",
      status: "failed",
    },
    researchConclusion: {
      score: 77,
      artifactPath: "/tmp/legacy-research.md",
      summary: "legacy research summary",
      status: "completed",
    },
    requestedTask: "loop runtime fallback should use requestedTask when canonical feedback is absent",
  };

  assert.equal(extractLoopRuntimeScore(loopRuntime), null);
  assert.equal(extractLoopRuntimeArtifact(loopRuntime), null);
  assert.equal(
    extractLoopRuntimeSummary(loopRuntime),
    "loop runtime fallback should use requestedTask when canonical feedback is absent",
  );
  assert.equal(deriveLoopRuntimeTerminalStatus(loopRuntime), CONTRACT_STATUS.COMPLETED);
});

test("harness base evidence prefers terminalOutcome over legacy workflow conclusion residue", () => {
  const evidence = buildBaseEvidence({
    startedAt: 100,
  }, {
    terminalOutcome: {
      artifact: "/tmp/canonical-terminal.md",
      testsPassed: false,
      verdict: "fail",
      reason: "canonical terminal failure",
    },
    workflowConclusion: {
      artifactPath: "/tmp/legacy-workflow.md",
      testsPassed: true,
      verdict: "pass",
      reason: "legacy workflow reason",
    },
    researchConclusion: {
      artifactPath: "/tmp/legacy-research.md",
      testsPassed: true,
      verdict: "pass",
      reason: "legacy research reason",
    },
  }, {
    terminalStatus: CONTRACT_STATUS.FAILED,
    finalizedAt: 300,
  });

  assert.equal(evidence.artifact.path, "/tmp/canonical-terminal.md");
  assert.equal(evidence.artifact.source, "terminalOutcome.artifact");
  assert.equal(evidence.testSignal.status, "failed");
  assert.equal(evidence.testSignal.source, "terminalOutcome.testsPassed");
  assert.equal(evidence.failureClass, "failed");
});

test("harness base evidence ignores legacy top-level stage residue when canonical executionObservation is absent", () => {
  const evidence = buildBaseEvidence({
    startedAt: 100,
  }, {
    terminalOutcome: {
      artifact: "/tmp/canonical-terminal.md",
      summary: "canonical terminal summary",
    },
    stageRunResult: {
      status: "completed",
      primaryArtifactPath: "/tmp/legacy-stage.md",
      summary: "legacy stage summary",
    },
    stageCompletion: {
      status: "completed",
      feedback: "legacy stage feedback",
    },
  }, {
    terminalStatus: CONTRACT_STATUS.COMPLETED,
    finalizedAt: 300,
  });

  assert.equal(evidence.stageResult, null);
  assert.equal(evidence.stageCompletion, null);
  assert.equal(evidence.artifact.path, "/tmp/canonical-terminal.md");
  assert.equal(evidence.artifact.source, "terminalOutcome.artifact");
});

test("contract completion artifact reader prefers terminalOutcome artifact over legacy output fallback", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-terminal-artifact-reader-"));
  const artifactPath = join(artifactDir, "canonical-terminal.md");
  await writeFile(artifactPath, "canonical artifact content", "utf8");

  try {
    const artifact = await readContractCompletionArtifact(`TC-TERMINAL-ARTIFACT-${Date.now()}`, {
      output: "/tmp/non-existent-legacy-output.md",
      terminalOutcome: {
        artifact: artifactPath,
      },
    });

    assert.deepEqual(artifact, {
      type: "text",
      content: "canonical artifact content",
      mimeType: "text/markdown",
    });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("contract completion artifact reader returns sanitized user-facing artifact content", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-terminal-artifact-sanitize-"));
  const artifactPath = join(artifactDir, "metadata-heavy-terminal.md");
  await writeFile(artifactPath, [
    "# 任务交付",
    "## 合约信息",
    "- 合约ID: TC-RAW-A2A",
    "- 执行节点: worker2",
    "## 交付内容",
    "今天是星期日。",
    "---",
    "*本文件由 worker2 执行节点生成*",
  ].join("\n"), "utf8");

  try {
    const artifact = await readContractCompletionArtifact(`TC-RAW-A2A-${Date.now()}`, {
      status: CONTRACT_STATUS.COMPLETED,
      output: artifactPath,
      terminalOutcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "completion_criteria",
        summary: "任务完成标识",
      },
    });

    assert.deepEqual(artifact, {
      type: "text",
      content: "今天是星期日。",
      mimeType: "text/markdown",
    });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
