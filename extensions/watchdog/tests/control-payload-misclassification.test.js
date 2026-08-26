import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRuntimeControlPayload,
  isToolOutcomeError,
} from "../lib/delivery/runtime-user-facing-output.js";
import { normalizeExecutionObservation } from "../lib/stage/execution-observation.js";
import { join } from "node:path";

const LONG_DELIVERABLE = [
  "# 平台运维复盘报告",
  "本轮任务中工具调用曾被拦截,拦截原因为「runtime 语义:contract-backed session 的第一步是读取当前会话自己的 inbox/contract.json」。",
  "根据系统提示完成绑定后,后续读写恢复正常。以下为正式交付内容:",
  "…".repeat(160),
  "结论:交付物完整,流程符合规范。",
].join("\n");

test("long deliverables quoting blockReason phrases are not control noise", () => {
  assert.ok(LONG_DELIVERABLE.length > 200);
  assert.equal(classifyRuntimeControlPayload(LONG_DELIVERABLE), null);
});

test("short guidance echoes are still classified as control_text", () => {
  assert.equal(
    classifyRuntimeControlPayload("runtime 语义:请读取当前会话自己的 inbox/contract.json"),
    "control_text",
  );
  assert.equal(classifyRuntimeControlPayload("根据系统提示,已停止。"), "control_text");
});

test("anchored patterns keep working regardless of length", () => {
  assert.equal(
    classifyRuntimeControlPayload(`[ACTION] review reviewer1 ${"x".repeat(300)}`),
    "control_text",
  );
});

test("isToolOutcomeError ignores control phrases in successful results", () => {
  const successEvent = {
    result: { content: [{ type: "text", text: `已读取文件。内容含 runtime 语义 提示。${"y".repeat(50)}` }] },
  };
  assert.equal(isToolOutcomeError(successEvent), false);
});

test("isToolOutcomeError still detects structural and anchored error signals", () => {
  assert.equal(isToolOutcomeError({ error: "boom" }), true);
  assert.equal(isToolOutcomeError({ result: { status: "ERROR" } }), true);
  assert.equal(isToolOutcomeError({
    result: { content: [{ type: "text", text: "Error: ENOENT no such file" }] },
  }), true);
  assert.equal(isToolOutcomeError({
    result: { content: [{ type: "text", text: "{\"status\":\"error\",\"tool\":\"write\"}" }] },
  }), true);
});

test("collected reflects real collection only — fallback and error never flip it", () => {
  const fallbackOnly = normalizeExecutionObservation(
    { collected: false, error: "runtime_result missing" },
    { fallbackPrimaryOutputPath: "/tmp/contract-output.md" },
  );
  assert.equal(fallbackOnly.collected, false);
  assert.equal(fallbackOnly.primaryOutputPath, "/tmp/contract-output.md");
  assert.equal(fallbackOnly.primaryOutputPathSource, "contract_output_fallback");

  const genuinelyCollected = normalizeExecutionObservation(
    { collected: false, primaryOutputPath: "/tmp/real.md", files: ["real.md"] },
    { fallbackPrimaryOutputPath: "/tmp/contract-output.md" },
  );
  assert.equal(genuinelyCollected.collected, true);
  assert.equal(genuinelyCollected.primaryOutputPathSource, "collected");
});

