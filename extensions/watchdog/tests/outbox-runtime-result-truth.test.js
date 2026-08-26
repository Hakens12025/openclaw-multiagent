import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  collectWorkerOutbox,
} from "../lib/routing/mailbox/runtime-mailbox-outbox-handlers.js";
import { agentWorkspace } from "../lib/state.js";
import {
  buildInitialTaskStagePlan,
  buildInitialTaskStageRuntime,
} from "../lib/stage/task-stage-plan.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function writeActiveContract(agentId, contract) {
  const inboxDir = join(agentWorkspace(agentId), "inbox");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify(contract, null, 2), "utf8");
}

async function cleanupWorkspace(agentId, artifactPaths = []) {
  for (const artifactPath of artifactPaths) {
    await rm(artifactPath, { force: true }).catch(() => {});
  }
  await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
}

test("collectWorkerOutbox reads a submitted runtime_result and collects its declared artifacts", async () => {
  const agentId = `worker-runtime-result-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-${Date.now()}`;
  const outputFileName = `${contractId}.md`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["完成用户目标"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  let artifactPaths = [];

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "回答今天星期几",
      assignee: agentId,
      output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, outputFileName), "今天是星期二。\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "Answered the weekday question.",
      artifacts: [{
        type: "text_output",
        path: outputFileName,
        label: "final_answer",
        primary: true,
        required: true,
      }],
      primaryArtifactPath: outputFileName,
      completion: {
        status: "completed",
        transition: { kind: "follow_graph", reason: "completed" },
      },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", outputFileName],
      logger,
    });
    artifactPaths = result.artifactPaths || [];

    assert.equal(result.collected, true);
    assert.equal(result.explicitRuntimeResult, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
    assert.equal(result.stageCompletion?.transition?.kind, "follow_graph");
    assert.equal(result.primaryOutputPath?.endsWith(`/${outputFileName}`), true);
  } finally {
    await cleanupWorkspace(agentId, artifactPaths);
  }
});

test("collectWorkerOutbox ignores legacy dual-truth result files without blocking the real artifact", async () => {
  const agentId = `worker-runtime-result-reject-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-REJECT-${Date.now()}`;

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "legacy result should not be accepted",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, "legacy.md"), "legacy output\n", "utf8");
    await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "legacy stage result",
    }), "utf8");
    await writeFile(join(outboxDir, "contract_result.json"), JSON.stringify({
      status: "completed",
      summary: "legacy contract result",
    }), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["stage_result.json", "contract_result.json", "legacy.md"],
      logger,
    });

    // 遗留双真值文件不再阻断采集——阻断正是取消提交令牌那一刀拆掉的病。
    // 但它们仍然不是交付物:真产物照收,遗留结果文件被当控制载荷排除。
    assert.equal(result.collected, true, "真产物不该因为旁边躺着遗留结果文件而收不上来");
    assert.deepEqual(result.files, ["legacy.md"]);
  } finally {
    await cleanupWorkspace(agentId);
  }
});

test("collectWorkerOutbox collects artifacts without requiring a submit token", async () => {
  const agentId = `worker-runtime-result-silent-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-SILENT-${Date.now()}`;
  const warnings = [];
  const recordingLogger = {
    info() {},
    warn(message) { warnings.push(String(message)); },
    error() {},
  };

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "missing runtime_result should be explained",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, "draft.md"), "some draft output\n", "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["draft.md"],
      logger: recordingLogger,
    });

    // 采集不再要求提交令牌。要 agent 额外写一个约定文件名才肯收它的产出,是把平台
    // 自己的记账义务外包给 agent——live 实测这条闸让写对了内容的轮次整轮判空。
    assert.equal(result.collected, true, "没有提交令牌也要收下真产物");
    assert.deepEqual(result.files, ["draft.md"]);
    assert.deepEqual(warnings, [], "正常交付不该再报缺令牌");
    // explicitRuntimeResult 是「本轮真有一份可用的提交声明」,不是「采集成功了」。
    // hard-stop-terminalize.js:99 拿它当硬停会话能否判完成的闸;取消令牌后
    // stageRunResult 恒有值,这里若写死 true 会让那道闸的两个析取项同时恒真,
    // 什么都没声明的硬停会话就会被判成 completed。
    assert.equal(result.executionObservation?.explicitRuntimeResult ?? result.explicitRuntimeResult, false,
      "没有提交声明时该标志必须为 false,否则硬停闸失效");
  } finally {
    await cleanupWorkspace(agentId);
  }
});

test("collectWorkerOutbox carries stage truth through runtime_result without extra outbox files", async () => {
  const agentId = `runtime-result-truth-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-${Date.now()}`;
  const notesFileName = `${contractId}-notes.md`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["Deliver implementation"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  let artifactPaths = [];

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "Deliver the current implementation",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, notesFileName), "Implementation needs one regression test.\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "Delivery completed.",
      artifacts: [{
        type: "notes",
        path: notesFileName,
        label: "delivery_notes",
        primary: true,
        required: true,
      }],
      primaryArtifactPath: notesFileName,
      completion: {
        status: "completed",
        transition: { kind: "follow_graph", reason: "delivery_completed" },
      },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", notesFileName],
      logger,
    });
    artifactPaths = result.artifactPaths || [];

    assert.equal(result.collected, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
  } finally {
    await cleanupWorkspace(agentId, artifactPaths);
  }
});

test("上一轮残件按会话起点隔离,不再混进本轮产物包(live 复现 2026-08-05)", async () => {
  const { collectRuntimeResult } = await import("../lib/routing/mailbox/runtime-mailbox-outbox-helpers.js");
  const { mkdtemp, writeFile: wf, readdir, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");

  const outboxDir = await mkdtemp(j(tmpdir(), "stale-outbox-"));
  const sessionStartMs = Date.now();

  // 上一轮残件:mtime 早于本会话起点
  await wf(j(outboxDir, "stale-from-previous.md"), "上一份合约的残留", "utf8");
  const past = new Date(sessionStartMs - 600_000);
  await utimes(j(outboxDir, "stale-from-previous.md"), past, past);

  // 本轮产物 + runtime_result
  await wf(j(outboxDir, "fresh-deliverable.md"), "本轮交付物", "utf8");
  await wf(j(outboxDir, "runtime_result.json"), JSON.stringify({
    status: "completed", summary: "done", artifacts: [],
  }), "utf8");

  const result = await collectRuntimeResult({
    agentId: "worker-stale-test",
    outboxDir,
    files: await readdir(outboxDir),
    logger: { info() {}, warn() {} },
    activeContract: { id: "TC-STALE-GATE", createdAt: sessionStartMs },
    sessionStartMs,
  });

  const collectedNames = (result.files || []).map((file) => file.name || file.fileName || file);
  const flat = JSON.stringify(collectedNames);
  assert.ok(!flat.includes("stale-from-previous"), `残件不得进本轮产物: ${flat}`);
  assert.ok(flat.includes("fresh-deliverable"), `本轮产物应照常采集: ${flat}`);
  const leftovers = await readdir(outboxDir);
  assert.ok(!leftovers.includes("stale-from-previous.md"), "残件应被移入隔离目录");
  assert.ok(leftovers.includes(".stale"), "隔离目录应存在(可恢复,不删除)");
});

test("会话起点缺席时退到 runtime_result 落盘时刻作基准(闸独立于传参链路)", async () => {
  const { collectRuntimeResult } = await import("../lib/routing/mailbox/runtime-mailbox-outbox-helpers.js");
  const { mkdtemp, writeFile: wf, readdir, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");

  const outboxDir = await mkdtemp(j(tmpdir(), "stale-fallback-"));
  await wf(j(outboxDir, "ancient.md"), "上一轮残留", "utf8");
  const ancient = new Date(Date.now() - 3_600_000);
  await utimes(j(outboxDir, "ancient.md"), ancient, ancient);
  await wf(j(outboxDir, "today.md"), "本轮交付", "utf8");
  await wf(j(outboxDir, "runtime_result.json"), JSON.stringify({ status: "completed", summary: "ok", artifacts: [] }), "utf8");

  const result = await collectRuntimeResult({
    agentId: "worker-fallback-test",
    outboxDir,
    files: await readdir(outboxDir),
    logger: { info() {}, warn() {} },
    activeContract: { id: "TC-FALLBACK" },
    // sessionStartMs 刻意缺席:模拟 live 里传参链路给不出会话起点的情形
  });

  const flat = JSON.stringify((result.files || []).map((f) => f.name || f.fileName || f));
  assert.ok(!flat.includes("ancient"), `无会话起点时也应挡住残件: ${flat}`);
  assert.ok(flat.includes("today"), `本轮产物照常采集: ${flat}`);
});
