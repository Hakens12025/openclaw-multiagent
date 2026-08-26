// contract-lineage.test.js — 谱系锁测试(备忘录142 §三/§五/§九;批② 更新工厂兜底锁)。
// 锁四件事:铸造格式与确定性、inheritLineage 源缺失→null(继承点不造假谱系)、
// 建约工厂兜底铸孤儿线(批②:缺席不再 null,每约必有家)、tracker 回填【只落 threadId,绝不触碰
// trackingState.runId】——那是 loop epoch key 的实例代号,与谱系 runId 同名异物,
// 覆写会让 loop 全轮同 epoch、硬停标记跨轮逃逸(2026-08-14 批①审查抓获)。

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyContractLineageToTracking,
  buildLineage,
  inheritLineage,
  mintRunId,
  mintThreadId,
  normalizeLineage,
} from "../lib/contract/contract-lineage.js";
import { createDirectRequestEnvelope } from "../lib/protocol/protocol-primitives.js";
import {
  createTrackingState,
  toTrackingContract,
} from "../lib/session/session-tracking-state.js";

const OUTPUT_DIR = join(tmpdir(), "openclaw-contract-lineage-test");

test("mintThreadId/mintRunId 铸造格式(§九:身份=hash,ts 只做展示)", () => {
  assert.match(mintThreadId(), /^t-[0-9a-f]{8}$/);
  assert.match(mintThreadId("conversation:qq:12345"), /^t-[0-9a-f]{8}$/);
  assert.match(mintRunId(), /^r-\d+-[0-9a-f]{6}$/);
  assert.match(mintRunId(1723600000000), /^r-1723600000000-[0-9a-f]{6}$/);
});

test("mintThreadId 有种子确定性派生(同线同 id),异种子异线,无种子随机", () => {
  assert.equal(mintThreadId("conversation:qq:12345"), mintThreadId("conversation:qq:12345"));
  assert.equal(mintThreadId("schedule:daily-report"), mintThreadId("schedule:daily-report"));
  assert.notEqual(mintThreadId("conversation:qq:12345"), mintThreadId("conversation:qq:54321"));
  // 无种子 = 随机新线(4 字节熵,两次相同的概率可忽略)
  assert.notEqual(mintThreadId(), mintThreadId());
  // 空白种子等同无种子路径,仍产合法格式
  assert.match(mintThreadId("   "), /^t-[0-9a-f]{8}$/);
});

test("mintRunId 每次触发铸新(run 边界靠谱系传染,不靠时间窗)", () => {
  assert.notEqual(mintRunId(), mintRunId());
});

test("normalizeLineage 防御式归一:非法/空载→null,缺失位补 null", () => {
  assert.equal(normalizeLineage(null), null);
  assert.equal(normalizeLineage(undefined), null);
  assert.equal(normalizeLineage("t-deadbeef"), null);
  assert.equal(normalizeLineage({}), null);
  assert.equal(normalizeLineage({ threadId: "", runId: "   " }), null);
  assert.equal(normalizeLineage({ threadId: 42, runId: { nested: true } }), null);
  assert.deepEqual(
    normalizeLineage({ threadId: "t-deadbeef" }),
    { threadId: "t-deadbeef", runId: null },
  );
  assert.deepEqual(
    normalizeLineage({ runId: "r-1-abcdef", extra: "dropped" }),
    { threadId: null, runId: "r-1-abcdef" },
  );
});

test("buildLineage 归一铸造结果", () => {
  const lineage = buildLineage({ threadId: mintThreadId("loop:review-loop"), runId: mintRunId() });
  assert.match(lineage.threadId, /^t-[0-9a-f]{8}$/);
  assert.match(lineage.runId, /^r-\d+-[0-9a-f]{6}$/);
  assert.equal(buildLineage({}), null);
  assert.equal(buildLineage(), null);
});

test("inheritLineage 源约缺失/无谱系 → null(过渡期旧约合法态,不造假谱系)", () => {
  assert.equal(inheritLineage(null), null);
  assert.equal(inheritLineage(undefined), null);
  assert.equal(inheritLineage({ id: "TC-1-abc" }), null);
  assert.equal(inheritLineage({ id: "TC-1-abc", lineage: null }), null);

  const source = { id: "TC-1-abc", lineage: { threadId: "t-11223344", runId: "r-9-aabbcc" } };
  assert.deepEqual(inheritLineage(source), { threadId: "t-11223344", runId: "r-9-aabbcc" });
});

test("DIRECT 工厂:显式谱系原样落约,缺席 → 批② 工厂兜底铸孤儿线(每约必有家)", () => {
  const lineage = buildLineage({ threadId: mintThreadId("conversation:qq:777"), runId: mintRunId() });
  const withLineage = createDirectRequestEnvelope({
    agentId: "worker-a",
    sessionKey: "agent:worker-a:lineage-test",
    message: "带谱系的直派工单",
    outputDir: OUTPUT_DIR,
    lineage,
  });
  assert.deepEqual(withLineage.lineage, lineage);

  // 批② 新规(树店全覆盖):谱系缺席不再落 null,工厂铸孤儿线 —— 兜底发生在工厂,
  // 不发生在继承点(inheritLineage 仍不造假,见下一测试)。
  const withoutLineage = createDirectRequestEnvelope({
    agentId: "worker-a",
    sessionKey: "agent:worker-a:lineage-test",
    message: "无谱系的直派工单",
    outputDir: OUTPUT_DIR,
  });
  assert.match(withoutLineage.lineage.threadId, /^t-[0-9a-f]{8}$/);
  assert.match(withoutLineage.lineage.runId, /^r-\d+-[0-9a-f]{6}$/);
});

test("assign 子约继承:同 run 传染(轻装置:源约 → inheritLineage → DIRECT 工厂)", () => {
  const sourceContract = {
    id: "TC-1723600000000-aaaaaa",
    lineage: buildLineage({ threadId: mintThreadId("conversation:qq:888"), runId: mintRunId() }),
  };
  const child = createDirectRequestEnvelope({
    agentId: "worker-b",
    sessionKey: "agent:worker-b:lineage-test",
    message: "assign_task 子约",
    outputDir: OUTPUT_DIR,
    lineage: inheritLineage(sourceContract),
  });
  assert.equal(child.lineage.runId, sourceContract.lineage.runId);
  assert.equal(child.lineage.threadId, sourceContract.lineage.threadId);

  // 旧源约(无谱系)派生 → 继承点不造假(inheritLineage=null),但批② 工厂兜底
  // 铸孤儿线:子约有家且【不冒认】源约所在线。
  const legacyChild = createDirectRequestEnvelope({
    agentId: "worker-b",
    sessionKey: "agent:worker-b:lineage-test",
    message: "旧约派生的子约",
    outputDir: OUTPUT_DIR,
    lineage: inheritLineage({ id: "TC-legacy" }),
  });
  assert.match(legacyChild.lineage.threadId, /^t-[0-9a-f]{8}$/);
  assert.match(legacyChild.lineage.runId, /^r-\d+-[0-9a-f]{6}$/);
  assert.notEqual(legacyChild.lineage.threadId, sourceContract.lineage.threadId);
});

test("toTrackingContract 白名单抄写 lineage(tracker 视角不丢字段)", () => {
  const lineage = buildLineage({ threadId: mintThreadId("schedule:s1"), runId: mintRunId() });
  const tracked = toTrackingContract({
    id: "TC-1723600000000-bbbbbb",
    task: "抄写测试",
    lineage,
  }, "/tmp/openclaw-lineage-test/contract.json");
  assert.deepEqual(tracked.lineage, lineage);

  const trackedLegacy = toTrackingContract({
    id: "TC-legacy",
    task: "旧约",
  }, "/tmp/openclaw-lineage-test/contract.json");
  assert.equal(trackedLegacy.lineage, null);
});

test("tracker 回填:只落 threadId,trackingState.runId 绝不被谱系触碰(epoch key 原料)", () => {
  const lineage = buildLineage({ threadId: mintThreadId("automation:auto-1"), runId: mintRunId() });

  const backfilled = createTrackingState({
    sessionKey: "agent:worker-c:lineage-test",
    agentId: "worker-c",
    parentSession: null,
  });
  const randomRunId = backfilled.runId;
  assert.match(randomRunId, /^[0-9a-f]{12}$/);
  assert.equal(backfilled.threadId, null);

  applyContractLineageToTracking(backfilled, { id: "TC-x", lineage });
  assert.equal(backfilled.runId, randomRunId, "谱系不得覆写 tracker 实例代号(loop 轮次毒化防护的不变量)");
  assert.equal(backfilled.threadId, lineage.threadId);

  const untouched = createTrackingState({
    sessionKey: "agent:worker-c:lineage-test-2",
    agentId: "worker-c",
    parentSession: null,
  });
  const untouchedRunId = untouched.runId;
  applyContractLineageToTracking(untouched, { id: "TC-legacy" });
  assert.equal(untouched.runId, untouchedRunId);
  assert.equal(untouched.threadId, null);

  // 部分谱系(只有 threadId):runId 不被清空
  const partial = createTrackingState({
    sessionKey: "agent:worker-c:lineage-test-3",
    agentId: "worker-c",
    parentSession: null,
  });
  const partialRunId = partial.runId;
  applyContractLineageToTracking(partial, { id: "TC-y", lineage: { threadId: "t-01020304" } });
  assert.equal(partial.runId, partialRunId);
  assert.equal(partial.threadId, "t-01020304");
});
