import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractContractArtifact,
  extractContractScore,
  extractContractSummary,
} from "../lib/automation/automation-result-extractors.js";
import { readContractCompletionArtifact } from "../lib/contract/contracts.js";
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

// 回路运行时退役(2026-08-18)：原先此处还有两条 loopRuntime 版的同型用例
// （extractLoopRuntime* / deriveLoopRuntimeTerminalStatus）。四个 extractor 的唯一调用方
// handleAutomationLoopRuntimeTerminal 已整删，函数随之消失，用例同批移除。
// 它们守的 workflowConclusion / researchConclusion 旧方言拒绝锁不留缺口 ——
// 上面两条合约版用例守的是同一条锁，且合约是 automation 轮次终态的唯一真值面。

// harness 模块证据派生（buildBaseEvidence）已随 harness 全退役整删（v226 / 2026-08-23）。
// 它守的「terminalOutcome 优先于 workflowConclusion/researchConclusion/stage 残留」终态真值
// 优先级锁不留缺口：上面的 automation extractor 两条用例与下面的 contract completion artifact
// 两条用例守同一条锁，且这两处是终态真值在退役后系统里仅存的消费者。

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
