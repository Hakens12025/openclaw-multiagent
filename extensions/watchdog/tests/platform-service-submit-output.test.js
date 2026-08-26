/**
 * platform-service-submit-output.test.js — submit_output 的语义锁。
 *
 * 它守的是一条判据:**没读过文档的新 agent 能不能表达"我失败了"**。
 * v181 刀1 之前只能靠写 outbox/runtime_result.json 这个私有约定文件名;
 * 本工具把那一件事收成 L1。梯子是 L1(工具) > L3(文件) > 无声明(按产物证据推断)。
 *
 * Run: node --test --experimental-test-module-mocks tests/platform-service-submit-output.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PLATFORM_SERVICE_TOOLS,
  listExposedPlatformServiceTools,
  listPlatformServiceToolNames,
  isExposedPlatformServiceTool,
} from "../lib/system-action/platform-service-tools.js";
import {
  buildPlatformServiceTools,
  listPlatformServiceToolFaceNames,
} from "../lib/system-action/platform-service-toolface.js";
import { collectWorkerOutbox } from "../lib/routing/mailbox/runtime-mailbox-outbox-handlers.js";
import { rememberTrackingState, deleteTrackingSession } from "../lib/store/tracker-store.js";
import { agentWorkspace } from "../lib/state.js";

const logger = { info() {}, warn() {}, error() {} };

async function seedOutbox(agentId, files) {
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  await mkdir(outboxDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(outboxDir, name), body, "utf8");
  }
  return outboxDir;
}

async function cleanup(agentId, extraPaths = []) {
  for (const p of extraPaths) await rm(p, { force: true }).catch(() => {});
  await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
}

// ── 表与工具面的对称 ────────────────────────────────────────────────────────

test("service table exposes only submit_output; plan and progress stay reserved", () => {
  assert.deepEqual(listPlatformServiceToolNames(), ["submit_output", "submit_plan", "report_progress"]);
  assert.deepEqual(listExposedPlatformServiceTools(), ["submit_output"]);
  // 缓建行必须在场:它们让"已知但未开放"与"未知"可区分,并且避免动两次表
  // (该表要被 before_tool_call 的白名单并集消费)。
  const deferred = PLATFORM_SERVICE_TOOLS.filter((row) => !row.exposedAsTool).map((row) => row.tool);
  assert.deepEqual(deferred, ["submit_plan", "report_progress"]);
});

test("tool face equals the table's exposed set (same lock health checks at runtime)", () => {
  assert.deepEqual(listPlatformServiceToolFaceNames().sort(), listExposedPlatformServiceTools().sort());
});

test("the service family carries no role dimension", () => {
  // 协作族按角色裁剪(它能动别人);本族只能动自己,给它接角色线等于凭空造授权真值。
  for (const row of PLATFORM_SERVICE_TOOLS) {
    assert.equal("roles" in row, false, `${row.tool} must not carry a role list`);
  }
  assert.equal(isExposedPlatformServiceTool("submit_output"), true);
  assert.equal(isExposedPlatformServiceTool("submit_plan"), false);
  assert.equal(isExposedPlatformServiceTool("assign_task"), false, "collaboration tools are a separate family");
});

// ── 工具行为 ───────────────────────────────────────────────────────────────

function toolFor(sessionKey) {
  const [tool] = buildPlatformServiceTools({ sessionKey, logger });
  return tool;
}

test("submit_output rejects an unknown status and points at the fallback path", async () => {
  const sessionKey = `agent:submit-output-bad:${Date.now()}`;
  rememberTrackingState(sessionKey, { agentId: "submit-output-bad" });
  try {
    const { details } = await toolFor(sessionKey).execute("call-1", { status: "finished" });
    assert.equal(details.accepted, false);
    assert.match(details.error, /status must be one of/);
    // 降级路的发现点挂在拒绝上——教程刻意不进主提示词。
    assert.match(details.fallback, /runtime_result\.json/);
  } finally {
    deleteTrackingSession(sessionKey);
  }
});

test("submit_output records the declaration on the tracking state; a second call supersedes", async () => {
  const sessionKey = `agent:submit-output-ok:${Date.now()}`;
  const state = { agentId: "submit-output-ok" };
  rememberTrackingState(sessionKey, state);
  try {
    // awaiting_input/hold 已随假等待态删除:缺外部信息也声明 failed,reason 写清缺什么。
    const first = await toolFor(sessionKey).execute("call-1", {
      status: "failed",
      reason: "缺上游的数据口径",
    });
    assert.equal(first.details.accepted, true);
    assert.equal(first.details.status, "failed");
    assert.equal(first.details.superseded, undefined);
    assert.deepEqual(state.submittedOutput, {
      status: "failed",
      summary: null,
      reason: "缺上游的数据口径",
    });

    // 后到覆写先到(与 stagePlan 三源覆写同一取舍:信息量单调递增)。
    const second = await toolFor(sessionKey).execute("call-2", { status: "failed", reason: "上游给不出" });
    assert.equal(second.details.accepted, true);
    assert.equal(second.details.superseded, true);
    assert.equal(state.submittedOutput.status, "failed");
  } finally {
    deleteTrackingSession(sessionKey);
  }
});

test("submit_output refuses when there is no active tracking session", async () => {
  const { details } = await toolFor(`agent:nobody:${Date.now()}`).execute("call-1", { status: "failed" });
  assert.equal(details.accepted, false);
  assert.match(details.error, /no active tracking session/);
});

// ── 采集侧梯子:L1 > L3 ─────────────────────────────────────────────────────

test("collection takes the tool declaration over the runtime_result file", async () => {
  const agentId = `worker-submit-output-${Date.now()}`;
  const outboxDir = await seedOutbox(agentId, {
    "deliverable.md": "# 半成品\n\n做到一半卡住了。\n",
    // L3 文件说 completed,L1 工具说 failed —— 工具赢。
    "runtime_result.json": JSON.stringify({ version: 1, status: "completed", summary: "全做完了" }),
  });
  let artifactPaths = [];
  try {
    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["deliverable.md", "runtime_result.json"],
      logger,
      declaredOutput: { status: "failed", summary: "卡在上游口径", reason: "拿不到字段定义" },
    });
    artifactPaths = result?.artifactPaths || [];
    assert.equal(result.stageRunResult.status, "failed", "L1 声明必须压过 L3 文件");
    assert.equal(result.stageRunResult.summary, "卡在上游口径");
    assert.equal(result.stageRunResult.feedback, "拿不到字段定义");
    // 工具刻意不接管产物:artifacts 仍由 outbox 扫描决定。
    assert.ok(artifactPaths.length > 0, "产物仍按 outbox 扫描采集");
  } finally {
    await cleanup(agentId, artifactPaths);
  }
});

test("a tool declaration counts as an explicit runtime result for the hard-stop gate", async () => {
  const agentId = `worker-explicit-${Date.now()}`;
  const outboxDir = await seedOutbox(agentId, { "note.md": "# 交付\n" });
  let artifactPaths = [];
  try {
    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["note.md"],
      logger,
      declaredOutput: { status: "completed", summary: "做完了", reason: null },
    });
    artifactPaths = result?.artifactPaths || [];
    // hard-stop-terminalize 靠这个布尔区分"agent 真的交代了"与"平台按默认值兜出来的"。
    // 没有它,声明过结果的会话在硬停时会被当成从未交代过。
    assert.equal(result.executionObservation?.explicitRuntimeResult ?? result.explicitRuntimeResult, true);
  } finally {
    await cleanup(agentId, artifactPaths);
  }
});

test("no declaration and no file still collects on defaults (the token is not required)", async () => {
  const agentId = `worker-no-decl-${Date.now()}`;
  const outboxDir = await seedOutbox(agentId, { "out.md": "# 产出\n" });
  let artifactPaths = [];
  try {
    const result = await collectWorkerOutbox({ agentId, outboxDir, files: ["out.md"], logger });
    artifactPaths = result?.artifactPaths || [];
    assert.ok(artifactPaths.length > 0, "无任何声明也要收产物——这正是 v181 刀1 拆掉的闸");
    assert.equal(result.explicitRuntimeResult ?? false, false, "没声明就不该冒充显式声明");
  } finally {
    await cleanup(agentId, artifactPaths);
  }
});
