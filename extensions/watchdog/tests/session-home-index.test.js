// Tests: 会话 id→run 家索引(批③B 新能力锁,2026-08-16 审验补齐)。
//   rebuildSessionIndex 是 boot 无条件全索引重写——回归会每次 boot 静默丢元数据,
//   必须锁: 全树扫描正确性/同 home 保元数据/异 home 置 null/非会话文件不误收/
//   键小写归一而文件名保原串(与 contract-index 同规)。
//
// Run: node --test tests/session-home-index.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  recordSessionHome,
  resolveSessionHome,
  listSessionHomes,
  rebuildSessionIndex,
  resolveSessionIndexFile,
} from "../lib/archive/session-home-index.js";
import { ensureRunScaffold, participantDirFor } from "../lib/archive/thread-tree-store.js";

async function seedParticipantSession(lineage, agentId, sessionId, { extras = [] } = {}) {
  await ensureRunScaffold(lineage);
  const dir = participantDirFor(lineage, agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `session-${sessionId}.jsonl`), "{}\n", "utf8");
  for (const name of extras) {
    await writeFile(join(dir, name), "x\n", "utf8");
  }
}

test("recordSessionHome/resolveSessionHome:登记查询,键小写归一,值保原串", async () => {
  const lineage = { threadId: "t-shidx", runId: "r-1-shidx" };
  await recordSessionHome({
    sessionId: "SID-Alpha", sessionKey: "agent:planner:contract:tc-x", agentId: "planner",
    lineage, ts: 1000,
  });
  const hit = resolveSessionHome("sid-alpha"); // 小写查询也必须命中
  assert.equal(hit.sessionId, "SID-Alpha", "登记原串必须保留(文件名用它)");
  assert.equal(hit.threadId, "t-shidx");
  assert.equal(hit.sessionKey, "agent:planner:contract:tc-x");
  assert.equal(resolveSessionHome("sid-nope"), null);
});

test("rebuildSessionIndex:全树扫描重建,同 home 保元数据,异 home 置 null,非会话文件不误收", async () => {
  const lineageA = { threadId: "t-shreb", runId: "r-1-aa" };
  const lineageB = { threadId: "t-shreb", runId: "r-2-bb" };
  // 树上两个会话副本 + 干扰文件(prompt sidecar / delivery 快照 / 杂文件)
  await seedParticipantSession(lineageA, "planner", "SID-KEEP", {
    extras: ["session-SID-KEEP.prompt.json", "delivery-TC-1.md", "notes.txt"],
  });
  await seedParticipantSession(lineageB, "worker", "SID-MOVED");

  // 现存索引: SID-KEEP 同 home(元数据应保留);SID-MOVED 登记在旧 home(异于树上实际 → 元数据置 null)
  await recordSessionHome({
    sessionId: "SID-KEEP", sessionKey: "agent:planner:contract:tc-keep", agentId: "planner",
    lineage: lineageA, ts: 111,
  });
  await recordSessionHome({
    sessionId: "SID-MOVED", sessionKey: "agent:worker:contract:tc-moved", agentId: "worker",
    lineage: { threadId: "t-shreb", runId: "r-1-aa" }, ts: 222, // 旧 home ≠ 树上实际 r-2-bb
  });

  const result = await rebuildSessionIndex();
  const all = listSessionHomes();
  const ids = all.map((entry) => entry.sessionId).sort();
  assert.ok(ids.includes("SID-KEEP") && ids.includes("SID-MOVED"), "树上两会话必须全部入索引");
  assert.ok(result.entries >= 2);

  const kept = resolveSessionHome("SID-KEEP");
  assert.equal(kept.sessionKey, "agent:planner:contract:tc-keep", "同 home 重建必须保留 sessionKey 元数据");
  assert.equal(kept.ts, 111, "同 home 重建必须保留 ts 元数据");
  assert.equal(kept.runId, "r-1-aa");

  const moved = resolveSessionHome("SID-MOVED");
  assert.equal(moved.runId, "r-2-bb", "重建以树为准(home 四元承重)");
  assert.equal(moved.sessionKey, null, "异 home 不可反推的元数据必须置 null 不造假");
  assert.equal(moved.ts, null);

  // 干扰文件绝不入索引
  assert.equal(resolveSessionHome("SID-KEEP.prompt"), null);
  const raw = await readFile(resolveSessionIndexFile(), "utf8");
  assert.ok(!raw.includes("delivery-TC-1"), "delivery 快照不得混进会话索引");
  assert.ok(!raw.includes("notes"), "杂文件不得混进会话索引");
});
