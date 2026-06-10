/**
 * formal-check-runner.test.js — CheckResult 引擎行为校验
 *
 * add 时硬校验：fail/blocked/skip 必须带已注册码（否则抛）；pass 必须省略码。
 * runCheck 计时 + 捕获抛错→fail；markBlocked 批量阻塞；summarize 判定语义。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createCheckContext,
  runCheck,
  markBlocked,
  summarizeChecks,
  CHECK_STATUSES,
} from "../lib/formal-runtime/checks/check-runner.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("addCheck：pass 最小输入归一化（evidence 默认空串，durationMs 默认 0）", () => {
  const ctx = createCheckContext({ presetId: "health" });
  const added = ctx.addCheck({ id: "graph.node-roster", subsystem: "graph", title: "all endpoints configured", status: "pass" });
  assert.equal(ctx.presetId, "health");
  assert.equal(ctx.checks.length, 1);
  assert.deepEqual(added, { id: "graph.node-roster", subsystem: "graph", title: "all endpoints configured", status: "pass", evidence: "", durationMs: 0 });
  assert.ok(Object.isFrozen(added));
});

test("addCheck：fail 无码 / 未注册码 → 抛；pass 带码 → 抛", () => {
  const ctx = createCheckContext({ presetId: "health" });
  assert.throws(
    () => ctx.addCheck({ id: "graph.x", subsystem: "graph", title: "t", status: "fail" }),
    /requires an error code/,
  );
  assert.throws(
    () => ctx.addCheck({ id: "graph.x", subsystem: "graph", title: "t", status: "fail", code: "E-MADEUP-123" }),
    /unregistered error code "E-MADEUP-123"/,
  );
  assert.throws(
    () => ctx.addCheck({ id: "graph.x", subsystem: "graph", title: "t", status: "pass", code: "E-GRAPH-001" }),
    /pass must omit code/,
  );
  assert.equal(ctx.checks.length, 0, "rejected checks must not be stored");
});

test("addCheck：skip/blocked 带已注册码合法；坏 id/status 抛", () => {
  const ctx = createCheckContext({});
  const skip = ctx.addCheck({ id: "knowledge.recall-floor", subsystem: "knowledge", title: "recall floors", status: "skip", code: "E-KNOWLEDGE-SKIP", evidence: "ollama down" });
  assert.equal(skip.status, "skip");
  assert.equal(skip.code, "E-KNOWLEDGE-SKIP");

  const blocked = ctx.addCheck({ id: "sse.connect", subsystem: "sse", title: "stream connect", status: "blocked", code: "E-RUNNER-003", evidence: "gateway down" });
  assert.equal(blocked.code, "E-RUNNER-003");

  assert.throws(() => ctx.addCheck({ id: "no-dot", subsystem: "x", title: "t", status: "pass" }), /subsys\.check-name/);
  assert.throws(() => ctx.addCheck({ id: "a.b", subsystem: "x", title: "t", status: "maybe" }), /invalid status/);
});

test("runCheck：fn 正常返回 → pass 且计时；返回字符串作为 evidence", async () => {
  const ctx = createCheckContext({ presetId: "health" });
  const timed = await runCheck(ctx, { id: "gateway.runtime", subsystem: "gateway", title: "runtime probe", code: "E-GW-005" }, async () => {
    await sleep(15);
    return "trackingSessions=0 dispatchQueue=0";
  });
  assert.equal(timed.status, "pass");
  assert.equal(timed.evidence, "trackingSessions=0 dispatchQueue=0");
  assert.equal(timed.code, undefined, "pass must not carry the descriptor code");
  assert.ok(timed.durationMs >= 5, `expected timing captured, got ${timed.durationMs}ms`);
  assert.equal(ctx.checks[0], timed);
});

test("runCheck：fn 抛错 → fail，用 descriptor 码，错误消息进 evidence", async () => {
  const ctx = createCheckContext({});
  const failed = await runCheck(ctx, { id: "graph.edge-integrity", subsystem: "graph", title: "edge endpoints", code: "E-GRAPH-001" }, async () => {
    throw new Error("edge worker-x→ghost references unknown agent");
  });
  assert.equal(failed.status, "fail");
  assert.equal(failed.code, "E-GRAPH-001");
  assert.match(failed.evidence, /threw: edge worker-x→ghost references unknown agent/);
});

test("runCheck：fn 返回对象可声明 skip/fail，未带码时回落 descriptor 码", async () => {
  const ctx = createCheckContext({});
  const skipped = await runCheck(ctx, { id: "loop.cycle-present", subsystem: "loop", title: "registered cycle", code: "E-LOOP-001" }, async () => ({
    status: "skip", code: "E-LOOP-SKIP", evidence: "no registered loop in graph",
  }));
  assert.equal(skipped.status, "skip");
  assert.equal(skipped.code, "E-LOOP-SKIP");

  const failed = await runCheck(ctx, { id: "loop.budget-echo", subsystem: "loop", title: "budget echo", code: "E-LOOP-002" }, async () => ({
    status: "fail", evidence: "budgetSource.maxRounds=declared, expected default",
  }));
  assert.equal(failed.code, "E-LOOP-002", "fail without explicit code falls back to descriptor code");
});

test("runCheck：descriptor 码未注册 → 立刻抛（typo 不许潜伏到失败时）", async () => {
  const ctx = createCheckContext({});
  await assert.rejects(
    runCheck(ctx, { id: "graph.x", subsystem: "graph", title: "t", code: "E-TYPO-001" }, async () => {}),
    /unregistered error code "E-TYPO-001"/,
  );
});

test("markBlocked：前置死亡批量阻塞，reason 进每条 evidence", () => {
  const ctx = createCheckContext({ presetId: "health" });
  const blocked = markBlocked(ctx, [
    { id: "inspect.surface-roundtrip", subsystem: "inspect", title: "inspect surfaces" },
    { id: "sse.connect", subsystem: "sse", title: "stream connect" },
  ], "E-RUNNER-003", "gateway unreachable on :18789");

  assert.equal(blocked.length, 2);
  assert.equal(ctx.checks.length, 2);
  for (const check of blocked) {
    assert.equal(check.status, "blocked");
    assert.equal(check.code, "E-RUNNER-003");
    assert.equal(check.evidence, "gateway unreachable on :18789");
  }
});

test("summarize：判定语义 — fail 或 blocked 即 FAIL；skip 不影响 PASS", () => {
  const ctx = createCheckContext({});
  ctx.addCheck({ id: "a.b", subsystem: "a", title: "t", status: "pass", durationMs: 10 });
  ctx.addCheck({ id: "a.c", subsystem: "a", title: "t", status: "skip", code: "E-KNOWLEDGE-SKIP" });
  assert.deepEqual(ctx.summarize(), { total: 2, pass: 1, fail: 0, skip: 1, blocked: 0, durationMs: 10, verdict: "PASS" });

  ctx.addCheck({ id: "a.d", subsystem: "a", title: "t", status: "blocked", code: "E-RUNNER-005", evidence: "prereq a.b2 failed" });
  assert.equal(ctx.summarize().verdict, "FAIL", "blocked alone must not report PASS");

  assert.deepEqual(summarizeChecks([]), { total: 0, pass: 0, fail: 0, skip: 0, blocked: 0, durationMs: 0, verdict: "PASS" });
  assert.deepEqual(CHECK_STATUSES, ["pass", "fail", "skip", "blocked"]);
});
