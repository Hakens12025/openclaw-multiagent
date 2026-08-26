import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllSessionProgress,
  clearSessionProgress,
  getSessionProgress,
  openSessionProgress,
  recordProgressToolCall,
} from "../lib/evidence/session-progress-projection.js";
import { getSessionCount, trackToolCall } from "../lib/runtime/execution-hard-stop-registry.js";

test.afterEach(() => {
  clearAllSessionProgress();
});

test("blocked write attempts do not mark contract.output as committed", () => {
  const sessionKey = `agent:worker:test:${Date.now()}`;
  const outputPath = `/tmp/${Date.now()}-trace-output.md`;

  openSessionProgress(sessionKey, { id: "TC-progress-output-guard", output: outputPath });
  recordProgressToolCall(sessionKey, { tool: "write", targetPath: outputPath, writeSucceeded: false });

  assert.equal(getSessionProgress(sessionKey)?.outputCommitted, false);
});

test("successful write to contract.output commits the artifact", () => {
  const sessionKey = `agent:worker:test-commit:${Date.now()}`;
  const outputPath = `/tmp/${Date.now()}-committed.md`;

  openSessionProgress(sessionKey, { id: "TC-progress-commit", output: outputPath });
  assert.equal(
    recordProgressToolCall(sessionKey, {
      tool: "Write",
      targetPath: `/workspace/prefix${outputPath}`,
      writeSucceeded: true,
    }),
    true,
    "解析后的绝对路径包含合约 output 片段即算命中",
  );

  const progress = getSessionProgress(sessionKey);
  assert.equal(progress.outputCommitted, true);
  assert.equal(progress.writeCount, 1);
  assert.equal(progress.lastWritePath, `/workspace/prefix${outputPath}`);
  assert.equal(progress.contractId, "TC-progress-commit");
});

test("writes to unrelated paths count as writes but leave the artifact uncommitted", () => {
  const sessionKey = `agent:worker:test-miss:${Date.now()}`;

  openSessionProgress(sessionKey, { id: "TC-progress-miss", output: "/tmp/expected-output.md" });
  assert.equal(
    recordProgressToolCall(sessionKey, { tool: "edit", targetPath: "/tmp/scratch.md" }),
    false,
  );

  const progress = getSessionProgress(sessionKey);
  assert.equal(progress.outputCommitted, false);
  assert.equal(progress.writeCount, 1);
  assert.equal(progress.totalCalls, 1);
});

test("off-track needs an output expectation plus 15 uncommitted tool calls", () => {
  const sessionKey = `agent:worker:test-offtrack:${Date.now()}`;

  openSessionProgress(sessionKey, { id: "TC-progress-offtrack", output: "/tmp/never-written.md" });
  for (let i = 0; i < 14; i++) {
    recordProgressToolCall(sessionKey, { tool: "read", targetPath: "/tmp/whatever.md" });
  }
  assert.equal(getSessionProgress(sessionKey).offTrack, false);

  recordProgressToolCall(sessionKey, { tool: "read", targetPath: "/tmp/whatever.md" });
  const progress = getSessionProgress(sessionKey);
  assert.equal(progress.totalCalls, 15);
  assert.equal(progress.offTrack, true);
});

test("a contract without output never goes off-track", () => {
  const sessionKey = `agent:worker:test-no-output:${Date.now()}`;

  openSessionProgress(sessionKey, { id: "TC-progress-no-output" });
  for (let i = 0; i < 20; i++) {
    recordProgressToolCall(sessionKey, { tool: "read", targetPath: "/tmp/x.md" });
  }

  const progress = getSessionProgress(sessionKey);
  assert.equal(progress.totalCalls, 20);
  assert.equal(progress.offTrack, false);
});

// 活语义护栏:未开账的会话必须查不到判定,凭空补 outputCommitted:false 会改写硬停与转发。
test("sessions that were never opened stay absent from the projection", () => {
  const sessionKey = `agent:main:never-opened:${Date.now()}`;

  assert.equal(getSessionProgress(sessionKey), null);
  assert.equal(recordProgressToolCall(sessionKey, { tool: "write", targetPath: "/tmp/x.md" }), false);
  assert.equal(getSessionProgress(sessionKey), null, "记账不得惰性开账");
});

test("invalid session keys are inert on every entry point", () => {
  assert.equal(openSessionProgress("", { output: "/tmp/x.md" }), null);
  assert.equal(openSessionProgress(null, {}), null);
  assert.equal(recordProgressToolCall("   ", { tool: "write", targetPath: "/tmp/x.md" }), false);
  assert.equal(getSessionProgress(undefined), null);
  assert.equal(clearSessionProgress(""), false);
});

// 清葬回归护栏:两个永假/死桥字段退役后不得回流。
test("projection shape omits retired fields (systemActionSeen / delegationReceipt / traceHash)", () => {
  const sessionKey = `agent:worker:test-retired:${Date.now()}`;

  openSessionProgress(sessionKey, { id: "TC-progress-retired", output: `/tmp/${Date.now()}-retired.md` });
  const progress = getSessionProgress(sessionKey);

  assert.ok(progress);
  assert.equal("systemActionSeen" in progress, false);
  assert.equal("delegationReceipt" in progress, false);
  // 哈希链归证据面账本(session-trace-store)所有,投影不再自算。
  assert.equal("traceHash" in progress, false);
});

test("retired delegation bridge is no longer exported", async () => {
  const projectionModule = await import("../lib/evidence/session-progress-projection.js");
  assert.equal("recordDelegationIntent" in projectionModule, false);
});

// 继承自退役 store 的耦合:清账同时清 loop-detection 计数器(收官只调这一个点)。
test("clearing progress also clears the loop-detection counters for that session", () => {
  const sessionKey = `agent:worker:test-loop-clear:${Date.now()}`;

  openSessionProgress(sessionKey, { id: "TC-progress-loop-clear", output: "/tmp/x.md" });
  trackToolCall(sessionKey, "read", { path: "/tmp/x.md" });
  const loopSessionsBefore = getSessionCount();
  assert.ok(loopSessionsBefore > 0);

  assert.equal(clearSessionProgress(sessionKey), true);
  assert.equal(getSessionProgress(sessionKey), null);
  assert.equal(getSessionCount(), loopSessionsBefore - 1);
});

test("clearAllSessionProgress reports the cleared count and drains loop sessions", () => {
  openSessionProgress("agent:worker:bulk-a", { id: "A", output: "/tmp/a.md" });
  openSessionProgress("agent:worker:bulk-b", { id: "B", output: "/tmp/b.md" });
  trackToolCall("agent:worker:bulk-a", "read", { path: "/tmp/a.md" });

  assert.equal(clearAllSessionProgress(), 2);
  assert.equal(getSessionProgress("agent:worker:bulk-a"), null);
  assert.equal(getSessionCount(), 0);
});
