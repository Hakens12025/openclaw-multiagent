// Tests: lib/evidence/evidence-bridge.js — 证据桥(DB 真值时代)。
// 文件账退役批:证据唯一在 records DB,断言改读 DB;桥的"绝不外抛"纪律不变。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "evidence-bridge-test-"));
process.env.OPENCLAW_RECORD_DB ||= join(SANDBOX, "records.db");

import {
  recordToolCallEvidence, recordRefusedToolCall,
} from "../lib/evidence/evidence-bridge.js";
import { clearSessionTraceMemory } from "../lib/evidence/session-trace-store.js";
import {
  closeRecordReadersForTests,
  tryReadTraceEventsFromDb,
} from "../lib/record-plane/record-reader.js";
import { clearRecordWriterStateForTests } from "../lib/record-plane/record-writer.js";
import { closeRecordDatabasesForTests } from "../lib/record-plane/database.js";

test.afterEach(() => { clearSessionTraceMemory(); });

async function readLedger(sessionKey) {
  const rows = tryReadTraceEventsFromDb(sessionKey);
  assert.notEqual(rows, null, "沙箱 records DB 必须可读");
  return rows;
}

test("recordToolCallEvidence appends internal/fc ok event with digests", async () => {
  const sessionKey = "agent:worker:c:TC-20";
  await recordToolCallEvidence({
    sessionKey, agentId: "worker", toolName: "write",
    params: { path: "/tmp/r.md", content: "hi" },
    event: { result: { content: [{ type: "text", text: "ok" }] } },
    contractId: "TC-20",
  });
  const rows = await readLedger(sessionKey);
  const record = rows[rows.length - 1];
  assert.equal(record.kind, "internal");
  assert.equal(record.channel, "fc");
  assert.equal(record.outcome, "ok");
  assert.equal(record.args.path, "/tmp/r.md");
  assert.match(record.args.hash, /^[0-9a-f]{64}$/);
});

test("recordRefusedToolCall appends refused event with blockReason", async () => {
  const sessionKey = "agent:worker:c:TC-21";
  await recordRefusedToolCall({
    sessionKey, agentId: "worker", toolName: "write",
    params: { path: "/etc/passwd" },
    blockReason: "安全策略:写入工作面限定为当前任务文件。",
  });
  const rows = await readLedger(sessionKey);
  const record = rows[rows.length - 1];
  assert.equal(record.outcome, "refused");
  assert.match(record.result.blockReason, /安全策略/);
});

test("bridge never throws even when the records DB is broken", async () => {
  const broken = join(SANDBOX, "not-a-dir", "records.db");
  writeFileSync(join(SANDBOX, "not-a-dir"), "x"); // 占住路径,让 mkdir 递归必炸
  const seeded = process.env.OPENCLAW_RECORD_DB;
  process.env.OPENCLAW_RECORD_DB = broken;
  clearRecordWriterStateForTests();
  closeRecordDatabasesForTests();
  closeRecordReadersForTests();
  try {
    await assert.doesNotReject(recordToolCallEvidence({
      sessionKey: "agent:worker:c:TC-22", agentId: "worker",
      toolName: "read", params: {}, event: {},
    }));
  } finally {
    if (seeded === undefined) delete process.env.OPENCLAW_RECORD_DB; // 守恒恢复:undefined 写回会变字符串 "undefined"(cwd 脏库根因)
    else process.env.OPENCLAW_RECORD_DB = seeded;
    clearRecordWriterStateForTests();
    closeRecordDatabasesForTests();
    closeRecordReadersForTests();
  }
});

test("collab tools record kind:collab with whole args and the receipt as result", async () => {
  const sessionKey = "agent:worker:c:TC-23";
  const receipt = { accepted: true, status: "dispatched", actionType: "assign_task", contractId: "DIRECT-7" };
  await recordToolCallEvidence({
    sessionKey, agentId: "worker", toolName: "assign_task",
    params: { targetAgent: "worker2", message: "整理巡检清单并输出 markdown" },
    event: { result: { content: [{ type: "text", text: JSON.stringify(receipt) }] } },
    contractId: "TC-23",
  });
  const rows = await readLedger(sessionKey);
  const record = rows[rows.length - 1];
  assert.equal(record.kind, "collab");
  assert.equal(record.channel, "fc");
  // args 全量不摘:message 原文在账
  assert.equal(record.args.message, "整理巡检清单并输出 markdown");
  assert.equal(record.result.receipt.contractId, "DIRECT-7");
});

// ── 被拒调用一事一记(2026-08-19)──────────────────────────────────────────────
// 守卫拦下一次调用后,宿主把 blockReason 当成工具错误回给 agent,after_tool_call
// 会带着同一次调用再来一趟。live 实测被拒调用的 83%(813/981)因此在账上记了两遍,
// 占 trace 盘面 11.7%。留 refused 那条(它带 blockReason,语义强于降级后的 error)。

test("被守卫拒掉的调用只记一条 refused,after 的 error 不再补记", async () => {
  const sessionKey = "agent:worker:c:TC-DEDUP";
  const params = { path: "/outside/scope.md" };
  await recordRefusedToolCall({
    sessionKey, agentId: "worker", toolName: "read", params,
    blockReason: "路径限制:worker 的读取范围是 inbox/ 目录", contractId: "TC-DEDUP",
  });
  // 宿主把同一条理由当工具错误回来,after_tool_call 照常触发
  await recordToolCallEvidence({
    sessionKey, agentId: "worker", toolName: "read", params,
    event: { error: "路径限制:worker 的读取范围是 inbox/ 目录" },
    contractId: "TC-DEDUP",
  });

  const calls = (await readLedger(sessionKey)).filter((r) => r.name === "read");
  assert.equal(calls.length, 1, "同一次被拒调用只该在账上留一条");
  assert.equal(calls[0].outcome, "refused", "留下的应是语义更强的 refused");
  assert.match(calls[0].result?.blockReason || "", /路径限制/, "拒绝理由要保住");
});

test("去重只挡配对的那一条:真错误、换参数、连续两次被拒都照记", async () => {
  const sessionKey = "agent:worker:c:TC-DEDUP2";
  // ① 与任何 refused 无关的真错误,必须照记 —— 去重不能吃掉真实失败
  await recordToolCallEvidence({
    sessionKey, agentId: "worker", toolName: "read",
    params: { path: "missing.md" },
    event: { error: "ENOENT" },
  });
  // ② 拒了 A,来的 error 却是 B:参数不同,指纹不匹配,B 照记
  await recordRefusedToolCall({
    sessionKey, agentId: "worker", toolName: "read",
    params: { path: "/blocked/a.md" }, blockReason: "越界",
  });
  await recordToolCallEvidence({
    sessionKey, agentId: "worker", toolName: "read",
    params: { path: "/other/b.md" },
    event: { error: "boom" },
  });
  // ③ 同一调用连着被拒两次 → 两条 refused,一条都不能少
  await recordRefusedToolCall({
    sessionKey, agentId: "worker", toolName: "read",
    params: { path: "/blocked/c.md" }, blockReason: "越界",
  });
  await recordRefusedToolCall({
    sessionKey, agentId: "worker", toolName: "read",
    params: { path: "/blocked/c.md" }, blockReason: "越界",
  });

  const rows = (await readLedger(sessionKey)).filter((r) => r.name === "read");
  const errors = rows.filter((r) => r.outcome === "error");
  const refused = rows.filter((r) => r.outcome === "refused");
  assert.equal(errors.length, 2, "真错误与未配对的 error 都要在账上(ENOENT + boom)");
  assert.equal(refused.length, 3, "三次拒绝三条记录(a 一次、c 两次)");
});
