// terminal-chain-trace-merge.test.js — 终态链 × trace 事实合流(B5 两源合流)。
// 文件账退役批:证据账唯一在 records DB(撕裂尾行概念随文件层退役)。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "trace-merge-test-"));
process.env.OPENCLAW_RECORD_DB ||= join(SANDBOX, "records.db");

import { readSessionCollabFacts } from "../lib/evidence/session-trace-reader.js";
import {
  openSessionTrace, appendTraceEvent, clearSessionTraceMemory,
} from "../lib/evidence/session-trace-store.js";
import { buildTraceEvent } from "../lib/evidence/trace-event-schema.js";
import {
  filterMarkersAgainstTraceFacts,
  synthesizeTraceSystemActionResults,
} from "../lib/system-action/system-action-trace-merge.js";

test.afterEach(() => {
  clearSessionTraceMemory();
});

async function seedCollabTrace(sessionKey, { receipt }) {
  await openSessionTrace(sessionKey, { agentId: "worker" });
  await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "collab", channel: "fc", name: "assign_task",
    argsDigest: { targetAgent: "worker2", message: "整理清单" },
    resultDigest: { receipt },
    outcome: "ok",
    agentId: "worker", sessionKey,
  }));
}

test("reader surfaces collab facts from an OPEN (unclosed) chain — close sentinel lands after lifecycle", async () => {
  const sessionKey = "agent:worker:c:TC-B5-1";
  await seedCollabTrace(sessionKey, {
    receipt: { accepted: true, status: "dispatched", actionType: "assign_task", contractId: "DIRECT-5", deliveryTicketId: "SADT-5", deferredCompletion: true, targetAgent: "worker2" },
  });
  const facts = await readSessionCollabFacts(sessionKey);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].name, "assign_task");
  assert.equal(facts[0].receipt?.contractId, "DIRECT-5");
  assert.equal(facts[0].args?.targetAgent, "worker2");
});

test("reader degrades to empty on missing session, internal events excluded", async () => {
  assert.deepEqual(await readSessionCollabFacts("agent:none:c:TC-void"), []);

  const sessionKey = "agent:worker:c:TC-B5-2";
  await seedCollabTrace(sessionKey, { receipt: { accepted: true, status: "queued" } });
  await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal", channel: "fc", name: "write",
    argsDigest: { path: "/tmp/x" }, outcome: "ok",
    agentId: "worker", sessionKey,
  }));

  const facts = await readSessionCollabFacts(sessionKey);
  assert.equal(facts.length, 1, "collab facts only — internal events excluded");
});

test("synthesis turns accepted facts into systemActionResults; ticket status refreshes deferredCompletion", async () => {
  const facts = [
    {
      name: "assign_task",
      args: { targetAgent: "worker2" },
      receipt: { accepted: true, status: "dispatched", actionType: "assign_task", contractId: "DIRECT-6", deliveryTicketId: "SADT-6", deferredCompletion: true, targetAgent: "worker2" },
    },
    {
      name: "wake_agent",
      args: { targetAgent: "nobody" },
      receipt: { accepted: false, status: "invalid_state", code: "invalid_state", reason: "graph disallows" },
    },
  ];
  const results = await synthesizeTraceSystemActionResults(facts, {
    ticketLookup: async (id) => (id === "SADT-6" ? { id, status: "resolved" } : null),
  });
  // 拒绝的受理不合成(它没有产生执行面副作用,标记路可自由重试)
  assert.equal(results.length, 1);
  assert.equal(results[0].actionType, "assign_task");
  assert.equal(results[0].contractId, "DIRECT-6");
  assert.equal(results[0].fromTrace, true);
  // 票据已 resolved → 中场回流已完成,终态不再走 deferred
  assert.equal(results[0].deferredCompletion, false);

  const stillActive = await synthesizeTraceSystemActionResults(facts, {
    ticketLookup: async () => ({ status: "active" }),
  });
  assert.equal(stillActive[0].deferredCompletion, true);
});

test("marker dedupe: text [ACTION] matching an already-executed collab fact is dropped; rejected facts do not block retries", () => {
  const facts = [
    { name: "assign_task", args: { targetAgent: "worker2" }, receipt: { accepted: true, status: "dispatched" } },
    { name: "wake_agent", args: { targetAgent: "worker3" }, receipt: { accepted: false, status: "invalid_state" } },
  ];
  const markers = [
    { type: "assign_task", params: { targetAgent: "worker2", message: "重复派工" } },
    { type: "assign_task", params: { targetAgent: "worker9", message: "另一个目标" } },
    { type: "wake_agent", params: { targetAgent: "worker3" } },
  ];
  const kept = filterMarkersAgainstTraceFacts(markers, facts);
  assert.deepEqual(kept.map((marker) => `${marker.type}:${marker.params.targetAgent}`), [
    "assign_task:worker9",
    "wake_agent:worker3",
  ]);
});
