/**
 * synthesized-collab-events.test.js — 文本路合成事件入账 + 计划覆写留痕
 * (spec 决议3 OMIT-01 / 决议22 OMIT-11)
 *
 * 覆盖:
 *   1. recordSynthesizedCollabEvent:kind:collab × channel:text、synthesized:true、
 *      args 全量、受理结果 → outcome(ok/refused/error)映射
 *   2. recordSynthesizedInternalEvent:kind:internal × channel:fc、synthesized:true
 *   3. 合成行对 B5 合流保持惰性:receipt 无 accepted → 既不再合成结果、
 *      也不误伤文本标记去重
 *   4. consume_system_action:文本路动作执行后落合成事件;trace 合流来的动作
 *      (fromTrace)免除重复记账
 *   5. extract_output_markers:已有 stagePlan 被输出标记新 plan 替换 →
 *      stage_plan_overwritten 内部合成事件(含新旧来源与阶段数);无旧 plan 不留痕
 *   6. 顺序护栏:consume/extract 在主 stage 段,close_session_trace 在 finally 段
 *      → 合成事件必然先于 close 哨兵落账
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 文件账退役批:证据账唯一在 records DB,先种沙箱库再动态 import(模块图被 mock 锁住)。
const SANDBOX = mkdtempSync(join(tmpdir(), "synth-collab-test-"));
process.env.OPENCLAW_RECORD_DB ||= join(SANDBOX, "records.db");

// 真 systemActionConsume 会走 role-policy + 实际派发;测试里换成录参桩,
// 只验证 lifecycle 侧的记账行为。
const consumeCalls = [];
mock.module("../lib/system-action/system-action-consumer.js", {
  namedExports: {
    systemActionConsume: async ({ injectedAction }) => {
      consumeCalls.push(injectedAction);
      return {
        status: "dispatched",
        actionType: injectedAction?.type || null,
        targetAgent: injectedAction?.params?.targetAgent || null,
      };
    },
  },
});

const {
  recordSynthesizedCollabEvent,
  recordSynthesizedInternalEvent,
} = await import("../lib/evidence/evidence-bridge.js");
const {
  openSessionTrace, appendTraceEvent, clearSessionTraceMemory,
} = await import("../lib/evidence/session-trace-store.js");
const { buildTraceEvent } = await import("../lib/evidence/trace-event-schema.js");
const { readSessionCollabFacts } = await import("../lib/evidence/session-trace-reader.js");
const {
  synthesizeTraceSystemActionResults,
  filterMarkersAgainstTraceFacts,
} = await import("../lib/system-action/system-action-trace-merge.js");
const {
  AGENT_END_MAIN_STAGES,
  AGENT_END_FINALLY_STAGES,
} = await import("../lib/lifecycle/agent-end/stage-definitions.js");
const { tryReadTraceEventsFromDb } = await import("../lib/record-plane/record-reader.js");

const logger = { info() {}, warn() {}, error() {} };

function findStage(stages, id) {
  const stage = stages.find((entry) => entry.id === id);
  assert.ok(stage, `expected stage ${id}`);
  return stage;
}

// 账本自愈开账后首条恒为 open 哨兵(session-trace-store 的不变式),
// 事件断言一律跳过哨兵行。
async function readTraceRecords(sessionKey, { includeSentinels = false } = {}) {
  const records = tryReadTraceEventsFromDb(sessionKey) ?? [];
  if (includeSentinels) return records;
  return records
    .filter((record) => record.kind !== "session_open" && record.kind !== "session_close");
}

async function withTraceDir(run) {
  await run(SANDBOX);
}

test.afterEach(() => {
  clearSessionTraceMemory();
  consumeCalls.length = 0;
});

// ── 1. bridge:collab 合成事件形状 + outcome 映射 ─────────────────────────────

test("recordSynthesizedCollabEvent 落 collab/text + synthesized:true,args 全量入账", async () => {
  await withTraceDir(async () => {
    const sessionKey = "agent:worker:c:SYN-1";
    await recordSynthesizedCollabEvent({
      sessionKey, agentId: "worker",
      name: "assign_task",
      args: { targetAgent: "worker2", instruction: "整理巡检清单" },
      result: { status: "dispatched", actionType: "assign_task" },
      contractId: "SYN-1",
    });
    const records = await readTraceRecords(sessionKey);
    const record = records[records.length - 1];
    assert.equal(record.kind, "collab");
    assert.equal(record.channel, "text");
    assert.equal(record.synthesized, true);
    assert.equal(record.outcome, "ok");
    assert.equal(record.args.instruction, "整理巡检清单");
    assert.equal(record.result.receipt.status, "dispatched");
    assert.equal(record.contractId, "SYN-1");
  });
});

test("recordSynthesizedCollabEvent outcome 映射:策略拒绝=refused,派发失败=error", async () => {
  await withTraceDir(async () => {
    const sessionKey = "agent:worker:c:SYN-2";
    await recordSynthesizedCollabEvent({
      sessionKey, agentId: "worker", name: "assign_task",
      // rolePolicyRejected 结果同时带 error → refused 判定必须先行
      result: { status: "dispatch_error", error: "role denied", rolePolicyRejected: true },
    });
    await recordSynthesizedCollabEvent({
      sessionKey, agentId: "worker", name: "wake_agent",
      result: { status: "dispatch_error", error: "boom" },
    });
    const records = await readTraceRecords(sessionKey);
    assert.equal(records[0].outcome, "refused");
    assert.equal(records[1].outcome, "error");
  });
});

// ── 2. bridge:internal 合成事件形状 ──────────────────────────────────────────

test("recordSynthesizedInternalEvent 落 internal/fc + synthesized:true", async () => {
  await withTraceDir(async () => {
    const sessionKey = "agent:planner:c:SYN-3";
    await recordSynthesizedInternalEvent({
      sessionKey, agentId: "planner",
      name: "stage_plan_overwritten",
      args: { previousStageCount: 2, nextStageCount: 3 },
      contractId: "SYN-3",
    });
    const [record] = await readTraceRecords(sessionKey);
    assert.equal(record.kind, "internal");
    assert.equal(record.channel, "fc");
    assert.equal(record.synthesized, true);
    assert.equal(record.name, "stage_plan_overwritten");
    assert.equal(record.args.nextStageCount, 3);
  });
});

// ── 3. 合成行对 B5 合流保持惰性 ──────────────────────────────────────────────

test("合成 collab 行 receipt 无 accepted:不再合成结果、也不误伤文本标记去重", async () => {
  await withTraceDir(async () => {
    const sessionKey = "agent:worker:c:SYN-4";
    await openSessionTrace(sessionKey, { agentId: "worker" });
    await recordSynthesizedCollabEvent({
      sessionKey, agentId: "worker", name: "assign_task",
      args: { targetAgent: "worker2" },
      result: { status: "dispatched", actionType: "assign_task" },
    });
    const facts = await readSessionCollabFacts(sessionKey);
    assert.equal(facts.length, 1, "合成行应能被读回(kind:collab)");
    assert.equal(await synthesizeTraceSystemActionResults(facts).then((r) => r.length), 0,
      "无 accepted:true 的合成行统统免于二次合成");
    const markers = [{ type: "assign_task", params: { targetAgent: "worker2" } }];
    assert.equal(filterMarkersAgainstTraceFacts(markers, facts).length, 1,
      "合成行对标记去重保持惰性(文本路重试语义原样)");
  });
});

// ── 4. consume_system_action:文本路入账 + 合流免重复 ─────────────────────────

test("consume_system_action:文本路动作落合成事件,trace 合流动作免除重复记账", async () => {
  await withTraceDir(async () => {
    const sessionKey = "agent:worker:c:SYN-5";
    const contractId = "SYN-5";
    await openSessionTrace(sessionKey, { agentId: "worker", contractId });
    // 中场 L1 FC 已执行的协作动作(真实受理凭证 accepted:true)
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: "collab", channel: "fc", name: "assign_task",
      argsDigest: { targetAgent: "worker2", message: "干活" },
      resultDigest: { receipt: { accepted: true, status: "dispatched", actionType: "assign_task", targetAgent: "worker2" } },
      outcome: "ok", agentId: "worker", sessionKey, contractId,
    }));

    const context = {
      event: { success: true },
      sessionKey,
      agentId: "worker",
      api: {},
      logger,
      trackingState: { contract: { id: contractId } },
      effectiveContractData: { id: contractId },
      executionObservation: { contractId },
      _outputContent: "汇报\n[ACTION] delegate worker2 — 干活\n[ACTION] wake worker3 — 醒醒\n",
    };
    await findStage(AGENT_END_MAIN_STAGES, "consume_system_action").run(context);

    // 与 FC 事实同 (intent,target) 的 delegate 标记被过滤 → 只执行 wake
    assert.equal(consumeCalls.length, 1);
    assert.equal(consumeCalls[0].type, "wake_agent");
    // 终态阶梯拿到两条结果:合流的 assign_task(fromTrace) + 文本路 wake
    assert.equal(context.systemActionResults.length, 2);
    assert.equal(context.systemActionResults[0].fromTrace, true);

    const synthesizedRecords = (await readTraceRecords(sessionKey))
      .filter((record) => record.synthesized === true);
    assert.equal(synthesizedRecords.length, 1, "合流动作免除重复记账,只有文本路 wake 入账");
    const [record] = synthesizedRecords;
    assert.equal(record.kind, "collab");
    assert.equal(record.channel, "text");
    assert.equal(record.name, "wake_agent");
    assert.equal(record.args.targetAgent, "worker3");
    assert.equal(record.outcome, "ok");
    assert.equal(record.contractId, contractId);
  });
});

// ── 5. extract_output_markers:计划覆写留痕 ──────────────────────────────────

test("extract_output_markers:旧 stagePlan 被新 plan 替换 → stage_plan_overwritten 留痕", async () => {
  await withTraceDir(async (dir) => {
    const sessionKey = "agent:planner:c:SYN-6";
    const contractId = `SYN-6-${Date.now()}`; // control-plane 无此正本 → 快照突变走兜底 warn
    const outputPath = join(dir, "out.md");
    await writeFile(outputPath, "# 计划\n[STAGE] 调研\n[STAGE] 实现\n[STAGE] 验收\n", "utf8");
    const previousPlan = {
      contractId, version: 1,
      stages: [{ id: "stage-1", label: "旧阶段" }],
    };
    const context = {
      event: { success: true },
      sessionKey,
      agentId: "planner",
      logger,
      trackingState: { contract: { id: contractId, stagePlan: previousPlan } },
      effectiveContractData: { id: contractId, stagePlan: previousPlan },
      executionObservation: { contractId, primaryOutputPath: outputPath },
    };
    await findStage(AGENT_END_MAIN_STAGES, "extract_output_markers").run(context);

    const records = await readTraceRecords(sessionKey);
    const overwrite = records.find((record) => record.name === "stage_plan_overwritten");
    assert.ok(overwrite, "应有覆写留痕事件");
    assert.equal(overwrite.kind, "internal");
    assert.equal(overwrite.channel, "fc");
    assert.equal(overwrite.synthesized, true);
    assert.equal(overwrite.contractId, contractId);
    assert.deepEqual(overwrite.args, {
      previousSource: "contract_snapshot",
      nextSource: "output_markers",
      previousStageCount: 1,
      nextStageCount: 3,
    });
    // 留痕捕获发生在内存镜像被新 plan 覆盖之前,但镜像最终仍是新 plan
    assert.equal(context.trackingState.contract.stagePlan.stages.length, 3);
  });
});

test("extract_output_markers:无旧 stagePlan → 首次建 plan 免留痕", async () => {
  await withTraceDir(async (dir) => {
    const sessionKey = "agent:planner:c:SYN-7";
    const contractId = `SYN-7-${Date.now()}`;
    const outputPath = join(dir, "out.md");
    await writeFile(outputPath, "[STAGE] 唯一阶段\n", "utf8");
    const context = {
      event: { success: true },
      sessionKey,
      agentId: "planner",
      logger,
      trackingState: { contract: { id: contractId } },
      effectiveContractData: { id: contractId },
      executionObservation: { contractId, primaryOutputPath: outputPath },
    };
    await findStage(AGENT_END_MAIN_STAGES, "extract_output_markers").run(context);
    const records = await readTraceRecords(sessionKey);
    assert.equal(records.find((record) => record.name === "stage_plan_overwritten"), undefined);
  });
});

// ── 6. 顺序护栏:合成事件 → close 哨兵 → 考官 → commit(STOP-03 前移)────────

test("顺序:consume/extract → close → commit 在主段有序;finally 只留 close backstop", () => {
  const mainIds = AGENT_END_MAIN_STAGES.map((stage) => stage.id);
  for (const id of ["extract_output_markers", "consume_system_action", "close_session_trace", "commit_success_terminal"]) {
    assert.ok(mainIds.includes(id), `主段应含 ${id}`);
  }
  // 合成事件写者(consume/extract)先于 close 哨兵 → 合成事件必然入账。
  // 这两条是 close 留在主段的**唯一**理由:判决面已于 2026-08-09 拔除,原先
  // "考官须在 close 之后、commit 之前"那条理由随之作废,但本顺序约束仍在。
  assert.ok(mainIds.indexOf("extract_output_markers") < mainIds.indexOf("close_session_trace"));
  assert.ok(mainIds.indexOf("consume_system_action") < mainIds.indexOf("close_session_trace"));
  assert.ok(mainIds.indexOf("close_session_trace") < mainIds.indexOf("commit_success_terminal"));
  assert.equal(mainIds.includes("examine_session"), false, "判决面已拔除,主段不应再有考官 stage");

  const finallyIds = AGENT_END_FINALLY_STAGES.map((stage) => stage.id);
  assert.ok(finallyIds.includes("close_session_trace_backstop"), "finally 应保留 close backstop(主段早夭兜底)");
  assert.equal(finallyIds.includes("examine_session_backstop"), false, "考官 backstop 随判决面拔除");
  // backstop 凭 context 旗标防重入:主段已收官 → 跳过(恰好执行一次)。
  const closeBackstop = AGENT_END_FINALLY_STAGES.find((stage) => stage.id === "close_session_trace_backstop");
  assert.equal(closeBackstop.match({ trackingState: {}, evidenceTraceClosed: true }), false);
  assert.equal(closeBackstop.match({ trackingState: {} }), true);
});

test("主段 close_session_trace 落唯一 close 哨兵并立旗标,backstop 被旗标跳过", async () => {
  await withTraceDir(async () => {
    const sessionKey = "agent:worker:c:CLOSE-1";
    await openSessionTrace(sessionKey, { agentId: "worker", contractId: "CLOSE-1" });
    const context = {
      sessionKey,
      event: { success: true },
      trackingState: { agentId: "worker" },
      logger,
    };
    const mainClose = findStage(AGENT_END_MAIN_STAGES, "close_session_trace");
    assert.equal(mainClose.match(context), true);
    await mainClose.run(context);
    assert.equal(context.evidenceTraceClosed, true);
    const backstop = AGENT_END_FINALLY_STAGES.find((stage) => stage.id === "close_session_trace_backstop");
    assert.equal(backstop.match(context), false, "主段已收官,backstop 跳过");
    const records = await readTraceRecords(sessionKey, { includeSentinels: true });
    assert.equal(records.filter((record) => record.kind === "session_close").length, 1, "close 哨兵恰好一枚");
    assert.equal(records[records.length - 1].kind, "session_close");
    assert.equal(records[records.length - 1].success, true);
  });
});
