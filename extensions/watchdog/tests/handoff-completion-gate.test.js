/**
 * handoff-completion-gate.test.js — 中间 handoff 完成校验
 *
 * 即将转发给下一环时，若本环产物文件存在但内容为空/过短 → 不转发，判 terminal(retryable)。
 * 防止"agent 自以为做完、实际没产出实质交付物"被传送带原样推给下游。
 * 只作用于"有产物文件但内容过短"；无文件 / 内容充足 → 放行（返回 null）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveIncompleteHandoffGate } from "../lib/lifecycle/agent-end-graph-route.js";

function ctx(primaryOutputPath) {
  return { executionObservation: { primaryOutputPath } };
}

test("产物为空 → terminal(incomplete_output, retryable)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-handoff-empty-"));
  const p = join(dir, "out.md");
  await writeFile(p, "   \n  ", "utf8"); // 仅空白
  try {
    const gate = await resolveIncompleteHandoffGate(ctx(p), "worker");
    assert.ok(gate, "空产物应被拦");
    assert.equal(gate.action, "terminal");
    assert.equal(gate.reason, "incomplete_output");
    assert.equal(gate.routed, false);
    assert.equal(gate.terminalOutcome.status, "failed");
    assert.equal(gate.terminalOutcome.retryable, true);
    assert.match(gate.terminalOutcome.summary, /worker/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("产物过短(< 24 字) → terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-handoff-short-"));
  const p = join(dir, "out.md");
  await writeFile(p, "完成", "utf8"); // 2 字，占位非交付
  try {
    const gate = await resolveIncompleteHandoffGate(ctx(p), "worker2");
    assert.ok(gate, "过短产物应被拦");
    assert.equal(gate.reason, "incomplete_output");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("产物充足(>= 24 字) → 放行(null)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-handoff-ok-"));
  const p = join(dir, "out.md");
  await writeFile(p, "这是一份有实质内容的工作简报，包含任务理解、交付大纲与阶段计划。", "utf8");
  try {
    assert.equal(await resolveIncompleteHandoffGate(ctx(p), "worker"), null, "充足内容应放行");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("复用 context._outputContent(extract_output_markers 已读),不重复读盘", async () => {
  // 无真实文件，只给缓存正文：过短 → 拦;充足 → 放行。证明走缓存而非读盘。
  const shortCtx = { _outputContent: "ok", executionObservation: { primaryOutputPath: "/no/such/__x__.md" } };
  const gate = await resolveIncompleteHandoffGate(shortCtx, "worker");
  assert.ok(gate, "缓存正文过短应被拦(未因文件不存在而放行)");
  assert.equal(gate.reason, "incomplete_output");

  const okCtx = { _outputContent: "这是一份有实质内容的工作简报，含理解/大纲/阶段计划。", executionObservation: { primaryOutputPath: "/no/such/__x__.md" } };
  assert.equal(await resolveIncompleteHandoffGate(okCtx, "worker"), null, "缓存正文充足应放行");
});

test("无产物文件 / 路径缺失 → 放行(null，交既有 progress gate)", async () => {
  assert.equal(await resolveIncompleteHandoffGate(ctx(null), "worker"), null);
  assert.equal(await resolveIncompleteHandoffGate(ctx("/no/such/file/__x__.md"), "worker"), null);
  assert.equal(await resolveIncompleteHandoffGate({}, "worker"), null);
});
