/**
 * session-trace-capture.test.js — 会话账本**捕获面**的行为锁。
 *
 * 捕获面记录的是**事实**(谁调了什么工具、写了什么文件),不是结论。判决面于 2026-08-09
 * 被整体拔除,但这两条锁跟判决无关,是从 session-examiner.test.js 迁过来的:
 *   N1 —— 证人按 contractId 定界:同一 sessionKey 被多份合约复用时(重复派工),
 *         A 的证据不得为 B 作证。这是**执行面污染保护**。
 *   N3 —— 账本自愈开账:首条记录非 open 时自动补哨兵,否则账本永久缺开哨兵。
 *
 * 文件账退役批:账本唯一在 records DB,断言读 DB。
 * Run: node --test tests/session-trace-capture.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "trace-capture-test-"));
process.env.OPENCLAW_RECORD_DB ||= join(SANDBOX, "records.db");

import {
  openSessionTrace, appendTraceEvent, closeSessionTrace, clearSessionTraceMemory,
} from "../lib/evidence/session-trace-store.js";
import { readSessionCollabFacts } from "../lib/evidence/session-trace-reader.js";
import { buildTraceEvent } from "../lib/evidence/trace-event-schema.js";
import { tryReadTraceEventsFromDb } from "../lib/record-plane/record-reader.js";

test.afterEach(() => {
  clearSessionTraceMemory();
});

function writeEvent(sessionKey, path, hash = "a".repeat(64), contractId = null) {
  return buildTraceEvent({
    kind: "internal", channel: "fc", name: "write",
    argsDigest: { path, bytes: 100, hash }, outcome: "ok",
    agentId: "worker", sessionKey, contractId,
  });
}

test("跨合约共账本:collab 证人按 contractId 定界(N1 执行面污染)", async () => {
  const sessionKey = "agent:planner:contract:shared";
  await openSessionTrace(sessionKey, { agentId: "planner", contractId: "TC-A" });
  await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "collab", channel: "fc", name: "assign_task",
    argsDigest: { targetAgent: "worker2" },
    resultDigest: { receipt: { accepted: true, status: "dispatched" } },
    outcome: "ok", agentId: "planner", sessionKey, contractId: "TC-A",
  }));
  await appendTraceEvent(sessionKey, writeEvent(sessionKey, "output/a.md", "a".repeat(64), "TC-A"));
  await closeSessionTrace(sessionKey, { success: true });

  // 合约 B 复用同一 sessionKey(重复派工):A 的动作不得算到 B 头上。
  assert.equal((await readSessionCollabFacts(sessionKey, { contractId: "TC-B" })).length, 0);
  assert.equal((await readSessionCollabFacts(sessionKey, { contractId: "TC-A" })).length, 1);
});

test("账本自愈开账:首条记录非 open 时自动补哨兵(N3)", async () => {
  const sessionKey = "agent:controller:main";
  await appendTraceEvent(sessionKey, writeEvent(sessionKey, "notes.md"));
  const rows = tryReadTraceEventsFromDb(sessionKey);
  assert.notEqual(rows, null);
  assert.equal(rows[0].kind, "session_open", "首条应为自愈补写的 open 哨兵");
  assert.equal(rows[0].lazy, true);
  assert.equal(rows[1].name, "write");
});
