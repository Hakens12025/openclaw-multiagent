// tests/batch4-hardstop-tree-commit.test.js — 批④刀3 D5 行为锁:硬停树轮收口链。
//   ①投影记提交落盘路径:树 outbox 内的成功写 → committedWritePath = 树内物理文件;
//     contract.output 命中 → committedWritePath = 该落点。
//   ②deriveHardStopCommitInfo 树轮换底:outputCommitted 且投影带落盘文件时,
//     commitPath = 投影落盘文件(树轮 contract.output 地址无文件,拿它当 commitPath
//     会被 reconcile 的 commit_file_missing 短路,硬停树轮收口单腿化)。
//
// Run: node --test tests/batch4-hardstop-tree-commit.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  clearSessionProgress,
  getSessionProgress,
  openSessionProgress,
  recordProgressToolCall,
} from "../lib/evidence/session-progress-projection.js";
import { participantOutboxDirFor } from "../lib/archive/thread-tree-store.js";
import { resolvePhysicalWorkspacePath } from "../lib/state/state-agent-helpers.js";
import { deriveHardStopCommitInfo } from "../hooks/after-tool-call.js";
import { RUNTIME_RESULT_FILE } from "../lib/protocol/protocol-primitives.js";

test("①投影记提交落盘路径:树内命中与 contract.output 命中各记各的实际落点", () => {
  const agentId = "b4hs-proj-agent";
  const lineage = { threadId: "t-b4hs", runId: `r-${Date.now()}` };
  const contract = { id: "TC-B4HS-PROJ", output: "/tmp/nowhere/TC-B4HS-PROJ.md", lineage };
  const treeOutboxDir = resolvePhysicalWorkspacePath(
    participantOutboxDirFor(lineage, agentId, contract.id),
  );

  // 树内命中
  const treeKey = `agent:${agentId}:tree:${Date.now()}`;
  openSessionProgress(treeKey, contract, { agentId });
  const treeWritePath = join(treeOutboxDir, "report.md");
  assert.equal(recordProgressToolCall(treeKey, { tool: "write", targetPath: treeWritePath }), true);
  const treeProgress = getSessionProgress(treeKey);
  assert.equal(treeProgress.outputCommitted, true);
  assert.equal(treeProgress.committedWritePath, treeWritePath, "树内命中记树内物理落点");
  clearSessionProgress(treeKey);

  // contract.output 命中
  const outKey = `agent:${agentId}:out:${Date.now()}`;
  openSessionProgress(outKey, contract, { agentId });
  assert.equal(recordProgressToolCall(outKey, { tool: "write", targetPath: contract.output }), true);
  assert.equal(getSessionProgress(outKey).committedWritePath, contract.output, "output 命中记该落点");
  clearSessionProgress(outKey);
});

test("②deriveHardStopCommitInfo:树轮 commitPath = 投影落盘文件,真目录轮回退 contract.output", () => {
  const agentId = "b4hs-derive-agent";
  const trackingState = { contract: { output: "/tmp/nowhere/out.md" } };

  // 树轮:outputCommitted + committedWritePath → commitPath 用树内实际文件,allowMissing=false
  const treeCommit = deriveHardStopCommitInfo({
    agentId,
    trackingState,
    traceVerdict: { outputCommitted: true, committedWritePath: "/threads/t/runs/r/participants/a/outbox-c/report.md" },
  });
  assert.equal(treeCommit.type, "loop_hard_stop_output");
  assert.equal(treeCommit.commitPath, "/threads/t/runs/r/participants/a/outbox-c/report.md");
  assert.equal(treeCommit.allowMissing, false);

  // 真目录轮:无投影落盘文件 → 照旧 contract.output
  const legacyCommit = deriveHardStopCommitInfo({
    agentId,
    trackingState,
    traceVerdict: { outputCommitted: true },
  });
  assert.equal(legacyCommit.commitPath, "/tmp/nowhere/out.md");
  assert.equal(legacyCommit.allowMissing, false);

  // 未提交轮:terminal 腿 + allowMissing=true(语义不变)
  const uncommitted = deriveHardStopCommitInfo({
    agentId,
    trackingState: { contract: {} },
    traceVerdict: { outputCommitted: false },
  });
  assert.equal(uncommitted.type, "loop_hard_stop_terminal");
  assert.equal(uncommitted.allowMissing, true);
  assert.ok(uncommitted.commitPath.endsWith(RUNTIME_RESULT_FILE));
});
