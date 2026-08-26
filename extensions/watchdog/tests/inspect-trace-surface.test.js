// inspect-trace-surface.test.js — inspect.trace surface（trace 证据账出闸）
//
// 锁定：
//   ① surface 已注册（catalog + INSPECT_SOURCES 分发），family=inspect 只读
//   ② sessionKey → records DB trace_event 行（含展示/对齐所需字段：
//      seq/ts/name/outcome + anchorRunId/anchorSeq + gseq），按 (seq,id) 升序
//   ③ 无数据 sessionKey → 空数组，不炸；缺 sessionKey → 参数错误

import test from "node:test";
import assert from "node:assert/strict";

import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import { writeTraceEvent } from "../lib/record-plane/record-writer.js";

const SESSION_KEY = "agent:probe-trace:contract:tc-trace-1";
const RUN_ID = "r-trace-anchor-1";

test("inspect.trace: surface 注册合规", () => {
  const surface = getCliSystemSurface("inspect.trace");
  assert.ok(surface, "inspect.trace 必须在 catalog 注册");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `inspect.trace 必须通过冻结 schema: ${problems.join("; ")}`);
});

test("inspect.trace: 双写数据 → 返回行（含锚点与 gseq，按序）", async () => {
  const stamp = Date.now();
  const sessionKey = `${SESSION_KEY}-${stamp}`;
  const base = 1_700_000_000_000;
  writeTraceEvent(
    { seq: 0, kind: "session_open", sessionKey, agentId: "probe-trace", ts: base },
    { anchorRunId: RUN_ID, anchorSeq: 1 },
  );
  writeTraceEvent(
    { seq: 1, kind: "internal", channel: "fc", name: "read", args: { path: "a" },
      outcome: "ok", sessionKey, agentId: "probe-trace", ts: base + 10 },
    { anchorRunId: RUN_ID, anchorSeq: 2 },
  );

  const rows = await inspectCliSystemSurface({
    surfaceId: "inspect.trace",
    params: { sessionKey },
  });
  assert.ok(Array.isArray(rows), "返回行数组");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1], "按 (seq,id) 升序");
  const tool = rows[1];
  assert.equal(tool.name, "read");
  assert.equal(tool.outcome, "ok");
  assert.equal(tool.anchorRunId, RUN_ID, "锚点 runId 随行");
  assert.equal(tool.anchorSeq, 2, "锚点 seq 随行");
  assert.ok(Number.isInteger(tool.gseq) && tool.gseq > 0, "gseq(≡records.id) 随行");
});

test("inspect.trace: 无数据 sessionKey → 空数组不炸；缺参数 → 报错", async () => {
  const rows = await inspectCliSystemSurface({
    surfaceId: "inspect.trace",
    params: { sessionKey: "agent:no-such-session:contract:none" },
  });
  assert.deepEqual(rows, [], "无数据返回空数组");

  await assert.rejects(
    () => inspectCliSystemSurface({ surfaceId: "inspect.trace", params: {} }),
    /sessionKey/,
    "缺 sessionKey 必须报参数错误",
  );
});
