// Tests: lib/record-plane/ — 阶段2 第一刀:全局序方案 c(gseq ≡ records AUTOINCREMENT id,
// 不造取号机)+ boots 元表。
//
// 锁四件事:
//   ① 同进程两次写入,返回的 gseq 递增且等于该行 id;bootId 落到 records 行上;
//   ② 同进程 bootId 一致,boots 表恰好一行;
//   ③ 模拟"第二个进程"(resetRecordBootIdForTests 清进程级缓存)→ 新 bootId,
//      gseq 延续增长不重置,boots 表两行 —— "跨重启连续"回归锁;
//   ④ 对账器输出含全局序水位行(min/max gseq + boots 数)。
//
// Run: node --test tests/record-gseq.test.js


import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 本文件锁的是 gseq/boots 的【绝对值】(boots 恰好一行、maxGseq 等于本文件写入),
// 而 npm test 的 OPENCLAW_RECORD_DB 是全测试文件进程共享的(/tmp/openclaw-test-records),
// 别文件的影子写会把 boots 行数与 gseq 顶高 —— 必须换到本文件私有库。
// record-writer 每次写入惰性 resolveRecordDbPath(),在任何写入前覆盖即生效;
// 对账器子进程经 process.env 继承同一私有库。
process.env.OPENCLAW_RECORD_DB = join(mkdtempSync(join(tmpdir(), "record-gseq-")), "records.db");

import { openDatabase } from "../lib/record-plane/database.js";
import { getGlobalRange } from "../lib/record-plane/record-reader.js";
import {
  getRecordBootId,
  resetRecordBootIdForTests,
  shadowRunEvent,
  shadowTraceEvent,
} from "../lib/record-plane/record-writer.js";

const SCRIPTS_DIR = new URL("../scripts/", import.meta.url).pathname;

function runEvent(seq, runId = "r-gseq") {
  return {
    seq, ts: Date.now(), threadId: "t-gseq", runId,
    type: "run_triggered", payload: { origin: "record-gseq-test" },
  };
}

// ── ① 同进程两次写入:gseq 递增且等于 id ──────────────────────────────────────

test("gseq: two writes in one process get increasing gseq equal to row id", () => {
  const first = shadowRunEvent(runEvent(1));
  const second = shadowRunEvent(runEvent(2));
  assert.ok(first && second, "shadow writes must return { gseq, bootId }");
  assert.ok(Number.isInteger(first.gseq) && Number.isInteger(second.gseq));
  assert.ok(second.gseq > first.gseq, `gseq must increase: ${first.gseq} -> ${second.gseq}`);

  const db = openDatabase();
  const rows = db.prepare(
    "SELECT id, bootId FROM records WHERE kind = 'run_event' AND runId = 'r-gseq' ORDER BY id",
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, first.gseq);  // gseq ≡ AUTOINCREMENT id
  assert.equal(rows[1].id, second.gseq);
  assert.equal(rows[0].bootId, first.bootId); // bootId 落列
  assert.equal(rows[1].bootId, second.bootId);
});

// ── ② 同进程 bootId 一致,boots 表恰好一行 ────────────────────────────────────

test("bootId: stable within one process, boots table has exactly one row", () => {
  const trace = shadowTraceEvent({
    seq: 1, ts: Date.now(), sessionKey: "agent:worker:gseq-boot",
    kind: "internal", name: "read", hash: "hash-gseq-boot-1", prevHash: null,
  });
  assert.ok(trace);
  assert.equal(trace.bootId, getRecordBootId());

  const db = openDatabase();
  const boots = db.prepare("SELECT bootId, startedAt FROM boots").all();
  assert.equal(boots.length, 1);
  assert.equal(boots[0].bootId, getRecordBootId());
  assert.ok(Number.isInteger(boots[0].startedAt));
});

// ── ③ 模拟第二个进程:新 bootId,gseq 延续不重置(跨重启连续回归锁) ─────────────

test("gseq: simulated second process gets new bootId, gseq keeps growing (no reset)", () => {
  const before = getGlobalRange();
  assert.ok(before && before.boots === 1 && Number.isInteger(before.maxGseq));
  const firstBootId = getRecordBootId();

  resetRecordBootIdForTests(); // = 进程重启:进程级缓存清空
  const third = shadowRunEvent(runEvent(3));
  assert.ok(third);
  assert.notEqual(third.bootId, firstBootId, "new process must issue a new bootId");
  assert.ok(third.gseq > before.maxGseq, `gseq must continue across boots: ${before.maxGseq} -> ${third.gseq}`);

  const after = getGlobalRange();
  assert.equal(after.boots, 2); // boots 元表两行 = 两个 boot
  assert.equal(after.maxGseq, third.gseq);
  assert.equal(after.minGseq, before.minGseq);
});

// ── ④ 对账器输出含全局序水位行 ────────────────────────────────────────────────

test("reconcile: output ends with global watermark line (min/max gseq, boots)", () => {
  // 本测试文件进程中已有 shadow 写入(DB 侧有行、文件侧无 → 有差异,退出码 1 属预期),
  // 只锁水位行的存在与数值,不锁退出码。
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(SCRIPTS_DIR, "record-reconcile.js")], {
      env: process.env, // 种子环境(OPENCLAW_RECORD_DB / THREADS_DIR / TRACE_DIR)随环境继承
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stdout = String(error.stdout || ""); // 有差异时退出码 1,输出仍在 stdout
  }
  const range = getGlobalRange();
  assert.ok(range, "getGlobalRange must succeed on the seeded DB");
  assert.match(stdout, /全局序水位/);
  assert.match(stdout, new RegExp(`gseq \\[${range.minGseq} \\.\\. ${range.maxGseq}\\]`));
  assert.match(stdout, new RegExp(`boots ${range.boots} 个`));
});
