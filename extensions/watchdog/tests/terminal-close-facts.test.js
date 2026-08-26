/**
 * terminal-close-facts.test.js — 事实收口的语义锁(接替 contract-outcome-runtime-result-boundary)。
 *
 * 判决面重做后收口只认三类事实:agent 声明(转述)、中断事实、交付事实。
 * 判决面(lib/judgment)只在甲方期望存在时被问一次;零期望不冒充合格也不代拦。
 *
 * 四条被保住的旧语义(措辞变了,结论一字不变):
 *   1. 声明 failed 就是失败 —— 盘上有什么都不翻案(转述原话)
 *   2. 声明 completed 不算数 —— 没有交付物照样失败
 *   3. contract.output 是默认交付落点
 *   4. 甲方 requiredFiles 每条都要盘上兑现,缺一即失败并点名差哪
 *
 * Run: node --test --experimental-test-module-mocks tests/terminal-close-facts.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";

import { resolveTerminalOutcome } from "../lib/contract/terminal-outcome.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

function tracking(contract, submittedOutput = null) {
  return { contract, ...(submittedOutput ? { submittedOutput } : {}) };
}

test("agent 声明 failed → 失败,转述原话,产物在场也不翻案", async () => {
  const outputPath = `/tmp/declared-failed-${Date.now()}.md`;
  await writeFile(outputPath, "有一份看起来完整的产物。\n", "utf8");
  try {
    const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
      trackingState: tracking(
        { id: "TC-DECLARED-FAILED", output: outputPath },
        { status: "failed", reason: "上游数据口径拿不到" },
      ),
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: outputPath },
    });
    assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
    assert.equal(terminalOutcome.source, "declaration");
    assert.match(terminalOutcome.reason, /上游数据口径/);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("L3 文件声明 failed 同样被转述(降级路仍然承重)", async () => {
  const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
    trackingState: tracking({ id: "TC-FILE-FAILED" }),
    contractData: null,
    executionObservation: {
      collected: true,
      stageRunResult: { version: 1, status: "failed", summary: "model could not produce a valid answer" },
    },
  });
  assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
  assert.equal(terminalOutcome.source, "declaration");
  assert.match(terminalOutcome.reason, /could not produce/);
});

test("声明 completed 不算数:零交付物照样失败", async () => {
  const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
    trackingState: tracking({ id: "TC-CLAIMED-EMPTY" }, { status: "completed", summary: "全做完了" }),
    contractData: null,
    executionObservation: { collected: false, artifactPaths: [] },
  });
  assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
  assert.match(terminalOutcome.reason, /no deliverable/);
});

test("contract.output 是默认交付落点:落点有真产物即完成", async () => {
  const outputPath = `/tmp/default-output-${Date.now()}.md`;
  await writeFile(outputPath, "Final answer from default output artifact.\n", "utf8");
  try {
    const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
      trackingState: tracking({ id: "TC-DEFAULT-OUTPUT", output: outputPath }),
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: outputPath },
    });
    assert.equal(terminalStatus, CONTRACT_STATUS.COMPLETED);
    assert.equal(terminalOutcome.source, "deliverable");
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("落点声明了但盘上空空 → 失败并说明缺什么", async () => {
  const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
    trackingState: tracking({ id: "TC-OUTPUT-MISSING", output: `/tmp/never-written-${Date.now()}.md` }),
    contractData: null,
    executionObservation: { collected: false },
  });
  assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
  assert.match(terminalOutcome.reason, /missing_file/);
});

test("甲方 requiredFiles 逐条兑现:缺一即失败,点名差哪个", async () => {
  const presentPath = `/tmp/present-${Date.now()}.md`;
  const missingPath = `/tmp/missing-${Date.now()}.md`;
  await writeFile(presentPath, "Primary artifact exists.\n", "utf8");
  try {
    const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
      trackingState: tracking({
        id: "TC-REQUIRED-FILES",
        completionCriteria: { requiredFiles: [presentPath, missingPath] },
      }),
      contractData: null,
      executionObservation: { collected: true, artifactPaths: [presentPath] },
    });
    assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
    assert.equal(terminalOutcome.source, "expectation_check");
    assert.match(terminalOutcome.reason, /missing_file/);
    assert.ok(terminalOutcome.reason.includes(missingPath), "要点名缺的是哪个文件");
  } finally {
    await unlink(presentPath).catch(() => {});
  }
});

test("中断且无声明 → 失败(产物含义不确定);中断但声明了 completed 且有产物 → 采信", async () => {
  const outputPath = `/tmp/halted-declared-${Date.now()}.md`;
  await writeFile(outputPath, "做完那一刻正好被预算切断。\n", "utf8");
  try {
    const silent = await resolveTerminalOutcome({
      trackingState: tracking({ id: "TC-HALT-SILENT", output: outputPath }),
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: outputPath },
      halted: true,
    });
    assert.equal(silent.terminalStatus, CONTRACT_STATUS.FAILED);
    assert.equal(silent.terminalOutcome.source, "halt");

    const declared = await resolveTerminalOutcome({
      trackingState: tracking(
        { id: "TC-HALT-DECLARED", output: outputPath },
        { status: "completed", summary: "已完成,正好触顶" },
      ),
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: outputPath },
      halted: true,
    });
    assert.equal(declared.terminalStatus, CONTRACT_STATUS.COMPLETED);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("采集侧默认合成的 completed 不当声明采信(平台不代填)", async () => {
  // 采集对缺声明轮次会以 status:"completed" 默认值合成 stageRunResult。
  // 它不是 agent 说的 —— 收口不得把它当声明,仍按交付事实走。
  const { terminalStatus } = await resolveTerminalOutcome({
    trackingState: tracking({ id: "TC-SYNTHETIC-COMPLETED" }),
    contractData: null,
    executionObservation: {
      collected: false,
      stageRunResult: { version: 1, status: "completed", summary: null, artifacts: [] },
    },
  });
  assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
});

test("assign 期望(expectations.requiredArtifacts)缺失即失败:断供修复的消费线(2026-08-12)", async () => {
  const presentPath = `/tmp/close-facts-exp-present-${Date.now()}.md`;
  await writeFile(presentPath, "在场产物\n", "utf8");
  try {
    const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
      trackingState: tracking({
        id: "TC-EXPECTATIONS-MISS",
        output: presentPath,
        expectations: { requiredArtifacts: [{ path: `/tmp/close-facts-exp-missing-${Date.now()}.md` }] },
      }),
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: presentPath },
    });
    assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
    assert.equal(terminalOutcome.source, "expectation_check");
    assert.deepEqual(terminalOutcome.expectationCheck, { checked: 1, missing: 1 });
  } finally {
    await unlink(presentPath).catch(() => {});
  }
});

test("assign 期望齐全:照常 COMPLETED 且留核对痕迹 expectationCheck", async () => {
  const artifactPath = `/tmp/close-facts-exp-ok-${Date.now()}.md`;
  await writeFile(artifactPath, "期望产物在场\n", "utf8");
  try {
    const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
      trackingState: tracking({
        id: "TC-EXPECTATIONS-OK",
        output: artifactPath,
        expectations: { requiredArtifacts: [{ path: artifactPath }] },
      }),
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: artifactPath },
    });
    assert.equal(terminalStatus, CONTRACT_STATUS.COMPLETED);
    assert.deepEqual(terminalOutcome.expectationCheck, { checked: 1, missing: 0 });
  } finally {
    await unlink(artifactPath).catch(() => {});
  }
});

test("零期望不留痕:expectationCheck 为 null(不冒充核对过)", async () => {
  const outputPath = `/tmp/close-facts-exp-none-${Date.now()}.md`;
  await writeFile(outputPath, "无期望交付\n", "utf8");
  try {
    const { terminalOutcome } = await resolveTerminalOutcome({
      trackingState: tracking({ id: "TC-EXPECTATIONS-NONE", output: outputPath }),
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: outputPath },
    });
    assert.equal(terminalOutcome.expectationCheck, null);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});
