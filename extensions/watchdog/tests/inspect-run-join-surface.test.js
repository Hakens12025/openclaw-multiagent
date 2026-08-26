// inspect-run-join-surface.test.js — inspect.run_join surface（run 两店全景拼接出闸）
//
// 锁定：
//   ① surface 已注册（catalog + INSPECT_SOURCES 分发），family=inspect 只读
//   ② 三种钥匙(runId/contractId/threadId)都能定位 → joinRunRecords 全景
//     （events + traces + participants + recordSource）
//   ③ 认不出的 id → { found:false } 不炸；三者全缺 → 参数错误

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectCliSystemSurface, getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import {
  recordContractHome,
  resolveThreadsRoot,
  runDirFor,
} from "../lib/archive/thread-tree-store.js";
import { writeRunEvents, writeTraceEvent } from "../lib/record-plane/record-writer.js";

test("inspect.run_join: surface 注册合规", () => {
  const surface = getCliSystemSurface("inspect.run_join");
  assert.ok(surface, "inspect.run_join 必须在 catalog 注册");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `inspect.run_join 必须通过冻结 schema: ${problems.join("; ")}`);
});

test("inspect.run_join: 双写数据 → events+traces+recordSource 全景", async () => {
  const stamp = Date.now();
  const threadId = `t-rjs-${stamp}`;
  const runId = `r-rjs-${stamp}`;
  const contractId = `TC-RJS-${stamp}`;
  const sessionKey = `agent:probe-rjs:contract:${contractId.toLowerCase()}`;
  try {
    const runDir = runDirFor({ threadId, runId });
    await mkdir(runDir, { recursive: true });
    await recordContractHome(contractId, { threadId, runId });
    await writeFile(join(runDir, "run.json"), JSON.stringify({ threadId, runId, closed: true }), "utf8");

    const base = 1_700_000_000_000;
    writeRunEvents([
      { seq: 1, ts: base, threadId, runId, type: "run_triggered", contractId },
      { seq: 2, ts: base + 10, threadId, runId, type: "contract_created", contractId,
        agentId: "probe-rjs", sessionKey, causeRefs: [{ runId, seq: 1 }] },
    ]);
    writeTraceEvent(
      { seq: 1, kind: "internal", channel: "fc", name: "read", args: { path: "inbox/contract.json" },
        outcome: "ok", sessionKey, agentId: "probe-rjs", ts: base + 20 },
      { anchorRunId: runId, anchorSeq: 2 },
    );

    // 三种钥匙都开得了门
    for (const params of [{ runId }, { contractId }, { threadId }]) {
      const joined = await inspectCliSystemSurface({ surfaceId: "inspect.run_join", params });
      assert.equal(joined.target.threadId, threadId, `经 ${JSON.stringify(params)} 定位`);
      assert.equal(joined.target.runId, runId);
      assert.equal(joined.stats.events, 2, "事件账两行");
      assert.equal(joined.stats.toolCalls, 1, "证据账一次工具调用");
      assert.equal(joined.recordSource.events, "db");
      assert.equal(joined.recordSource.traces, "db");
      assert.ok(Array.isArray(joined.events) && Array.isArray(joined.traces), "events+traces 合一");
    }
  } finally {
    await rm(join(resolveThreadsRoot(), threadId), { recursive: true, force: true });
  }
});

test("inspect.run_join: 认不出的 id → found:false；全缺 → 参数错误", async () => {
  const missing = await inspectCliSystemSurface({
    surfaceId: "inspect.run_join",
    params: { runId: "r-no-such-run-anywhere" },
  });
  assert.equal(missing.found, false, "认不出要明说 found:false");

  await assert.rejects(
    () => inspectCliSystemSurface({ surfaceId: "inspect.run_join", params: {} }),
    /runId|contractId|threadId/,
    "三者全缺必须报参数错误",
  );
});
