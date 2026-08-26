/**
 * session-archive.test.js — agent session 树内归档（只读观测档）+ 树内读回退
 *
 * 覆盖：
 *   1. archiveSessionToRunTree：写树内 .jsonl 副本（participants/<agent>/session-<sid>.jsonl）
 *      + 登记 session-home-index（resolveSessionHome 可查回 home）
 *   2. archiveSessionToRunTree：无谱系（无合约轮次）→ 跳过不归档（no_run_home）
 *   3. archiveSessionToRunTree：缺前置/无 live session/源 .jsonl 不存在 → 不抛、archived:false
 *   4. listAgentSessions：合并 live + session-index 树内归档条目，按 sessionId 去重（live 优先），按 updatedAt 倒序
 *   5. listAgentSessions：live 被清后仍能从树内归档（经 session-index）列出历史 session
 *   6. readSessionTranscript：live → 树内归档副本回退（经 session-index 找家）
 *   7. agent_end finally：archive_session 阶段接入且归档失败不破坏 finally 链（静态护栏）
 *
 * 树内 fixtures 落 seed-tree-stores 隔离根；live fixtures 写到 ~/.openclaw 下
 * 唯一命名目录，finally 清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { archiveSessionToRunTree } from "../lib/lifecycle/run-tree-archive.js";
import { resolveSessionHome } from "../lib/archive/session-home-index.js";
import { resolveThreadsRoot } from "../lib/archive/thread-tree-store.js";
import { listAgentSessions } from "../lib/agent/agent-session-store.js";
import { readSessionTranscript } from "../lib/agent/agent-session-transcript.js";

const OC_ROOT = join(homedir(), ".openclaw");

function liveSessionsDir(agentId) {
  return join(OC_ROOT, "agents", agentId, "sessions");
}

function participantDir(lineage, agentId) {
  return join(resolveThreadsRoot(), lineage.threadId, "runs", lineage.runId, "participants", agentId);
}

// 写一个 live session fixture（sessions.json + <sid>.jsonl）
async function writeLiveSession(agentId, { sessionKey, sessionId, updatedAt, model = "m1", totalTokens = 3, jsonlLines = null }) {
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  const sessions = {
    [sessionKey]: { sessionId, updatedAt, model, totalTokens },
  };
  await writeFile(join(dir, "sessions.json"), JSON.stringify(sessions), "utf8");
  const lines = jsonlLines || [
    JSON.stringify({ type: "message", timestamp: "2026-05-30T00:00:00.000Z", message: { role: "user", content: "hi" } }),
  ];
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.join("\n"), "utf8");
}

async function cleanupAgent(agentId, lineage = null) {
  await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
  if (lineage?.threadId) {
    await rm(join(resolveThreadsRoot(), lineage.threadId), { recursive: true, force: true });
  }
}

// ── 1. archiveSessionToRunTree 树内写入 + 索引登记 ────────────────────────────

test("archiveSessionToRunTree：写 participants/<agent>/session-<sid>.jsonl + 登记 session index", async () => {
  const agentId = `__arc_write_${Date.now()}__`;
  const lineage = { threadId: "t-arcwrite", runId: `r-${Date.now()}-aw` };
  const sessionId = `sid-aw-${Date.now()}`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId, updatedAt: 111 });
  try {
    const result = await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-1", lineage });
    assert.deepEqual(result, { archived: true, sessionId });
    // 树内 .jsonl 副本落盘
    const destJsonl = join(participantDir(lineage, agentId), `session-${sessionId}.jsonl`);
    assert.equal(existsSync(destJsonl), true, "树内归档 .jsonl 应存在");
    // session-home-index 可查回 home
    const home = resolveSessionHome(sessionId);
    assert.ok(home, "session index 应有登记");
    assert.equal(home.threadId, lineage.threadId);
    assert.equal(home.runId, lineage.runId);
    assert.equal(home.agentId, agentId);
    assert.equal(home.sessionKey, "agent:x:contract:tc-1");
    assert.equal(home.ts, 111, "ts 应取 sessions.json 的 updatedAt");
  } finally {
    await cleanupAgent(agentId, lineage);
  }
});

test("archiveSessionToRunTree：同 sessionId 再归档 → 覆盖树内副本（保最新），幂等不抛", async () => {
  const agentId = `__arc_dedup_${Date.now()}__`;
  const lineage = { threadId: "t-arcdedup", runId: `r-${Date.now()}-ad` };
  const sessionId = `sid-ad-${Date.now()}`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId, updatedAt: 100, jsonlLines: ["A"] });
  try {
    await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-1", lineage });
    await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId, updatedAt: 200, jsonlLines: ["B"] });
    const second = await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-1", lineage });
    assert.deepEqual(second, { archived: true, sessionId });
    const destJsonl = join(participantDir(lineage, agentId), `session-${sessionId}.jsonl`);
    assert.equal(await readFile(destJsonl, "utf8"), "B", "重归档应覆盖为最新内容");
  } finally {
    await cleanupAgent(agentId, lineage);
  }
});

// ── 2. 无谱系 → 不归档（批③B 裁定：无合约会话无 run 家）─────────────────────

test("archiveSessionToRunTree：无谱系 → 跳过不归档（no_run_home）", async () => {
  const agentId = `__arc_nolineage_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:main", sessionId: "sid-nl", updatedAt: 1 });
  try {
    assert.deepEqual(
      await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:main" }),
      { archived: false, sessionId: null, reason: "no_run_home" },
    );
    // 谱系不全（缺 runId）同样无家
    assert.deepEqual(
      await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:main", lineage: { threadId: "t-only" } }),
      { archived: false, sessionId: null, reason: "no_run_home" },
    );
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 3. archiveSessionToRunTree 兜底（不抛）───────────────────────────────────

test("archiveSessionToRunTree：缺前置 / 无 live session / 源 .jsonl 缺失 → archived:false 不抛", async () => {
  const lineage = { threadId: "t-arcguard", runId: `r-${Date.now()}-ag` };
  // 缺 agentId / sessionKey
  assert.deepEqual(
    await archiveSessionToRunTree({ sessionKey: "k", lineage }),
    { archived: false, sessionId: null, reason: "missing_agent_or_key" },
  );
  assert.deepEqual(
    await archiveSessionToRunTree({ agentId: "a", lineage }),
    { archived: false, sessionId: null, reason: "missing_agent_or_key" },
  );
  // 无 live sessions.json
  const r1 = await archiveSessionToRunTree({ agentId: "__no_agent_arc__", sessionKey: "k", lineage });
  assert.equal(r1.archived, false);
  assert.equal(r1.reason, "no_live_session");

  // sessions.json 有条目但 .jsonl 缺失 → jsonl_copy_failed，不抛
  const agentId = `__arc_nojsonl_${Date.now()}__`;
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sessions.json"), JSON.stringify({ "agent:x:contract:tc-1": { sessionId: "sid-x", updatedAt: 5 } }), "utf8");
  try {
    const r2 = await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-1", lineage });
    assert.equal(r2.archived, false);
    assert.match(r2.reason, /jsonl_copy_failed/);
  } finally {
    await cleanupAgent(agentId, lineage);
  }
});

// ── 4 + 5. listAgentSessions 合并树内归档索引 / live 被清后归档仍可见 ──────────

test("listAgentSessions：合并 live + session-index 归档条目，按 sessionId 去重（live 优先），倒序", async () => {
  const agentId = `__arc_merge_${Date.now()}__`;
  const lineage = { threadId: "t-arcmerge", runId: `r-${Date.now()}-am` };
  try {
    // 树内归档里有 sid-old（ts 50）和 sid-shared（ts 60）——经真实归档段落树+登记索引
    await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-old", sessionId: "sid-old", updatedAt: 50 });
    await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-old", lineage });
    await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-shared", sessionId: "sid-shared", updatedAt: 60 });
    await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-shared", lineage });
    // live 里有 sid-shared（updatedAt 900，应优先）和 sid-new（updatedAt 800）
    const dir = liveSessionsDir(agentId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sessions.json"), JSON.stringify({
      "agent:x:contract:tc-shared": { sessionId: "sid-shared", updatedAt: 900, model: "live-model", totalTokens: 42 },
      "agent:x:contract:tc-new": { sessionId: "sid-new", updatedAt: 800, model: "m2", totalTokens: 9 },
    }), "utf8");

    const list = await listAgentSessions(agentId);
    assert.equal(list.length, 3, "去重后 sid-shared/sid-new/sid-old = 3");
    // 倒序：900 > 800 > 50
    assert.deepEqual(list.map((s) => s.sessionId), ["sid-shared", "sid-new", "sid-old"]);
    // sid-shared 取 live（model/totalTokens 来自 live，updatedAt=900）
    const shared = list.find((s) => s.sessionId === "sid-shared");
    assert.equal(shared.updatedAt, 900, "shared 应取 live updatedAt");
    assert.equal(shared.model, "live-model", "shared 应取 live model");
    assert.equal(shared.totalTokens, 42);
    // sid-old 来自树内归档索引（model/totalTokens null，contractId 由 sessionKey 解析）
    const old = list.find((s) => s.sessionId === "sid-old");
    assert.equal(old.model, null);
    assert.equal(old.contractId, "tc-old");
    assert.equal(old.updatedAt, 50, "归档条目 updatedAt 取索引 ts");
  } finally {
    await cleanupAgent(agentId, lineage);
  }
});

test("listAgentSessions：live 被清后仍能从树内归档（session-index）列出历史 session", async () => {
  const agentId = `__arc_liveclean_${Date.now()}__`;
  const lineage = { threadId: "t-arcliveclean", runId: `r-${Date.now()}-al` };
  try {
    await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-h", updatedAt: 321 });
    await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-1", lineage });
    // 清 live（session-clean 情形）
    await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });

    const list = await listAgentSessions(agentId);
    assert.equal(list.length, 1, "live 缺席时仍能从树内归档列出");
    assert.equal(list[0].sessionId, "sid-h");
    assert.equal(list[0].contractId, "tc-1");
    assert.equal(list[0].updatedAt, 321);
  } finally {
    await cleanupAgent(agentId, lineage);
  }
});

// ── 6. readSessionTranscript live → 树内归档副本回退 ──────────────────────────

test("readSessionTranscript：live 在时读 live；live 被清后回退树内归档副本", async () => {
  const agentId = `__arc_tr_${Date.now()}__`;
  const lineage = { threadId: "t-arctr", runId: `r-${Date.now()}-at` };
  const sessionId = `sid-tr-${Date.now()}`;
  const jsonlLines = [
    JSON.stringify({ type: "message", timestamp: "2026-05-30T00:00:00.000Z", message: { role: "user", content: "from-live" } }),
  ];
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId, updatedAt: 1, jsonlLines });
  try {
    // live 在 → 读到
    const trLive = await readSessionTranscript(agentId, sessionId);
    assert.equal(trLive.messages.length, 1);
    assert.equal(trLive.messages[0].text, "from-live");

    // 归档进树（participants/<agent>/session-<sid>.jsonl + session-index）+ 删 live → 回退树内副本
    await archiveSessionToRunTree({ agentId, sessionKey: "agent:x:contract:tc-1", lineage });
    await rm(liveSessionsDir(agentId), { recursive: true, force: true });
    const trArchive = await readSessionTranscript(agentId, sessionId);
    assert.equal(trArchive.messages.length, 1, "live 清掉后应回退树内归档副本");
    assert.equal(trArchive.messages[0].text, "from-live", "归档副本内容一致");

    // 两处皆无（树也清）→ 兜底空结构（messages/referencedFiles 空；delivery 字段独立存在）
    await cleanupAgent(agentId, lineage);
    const trNone = await readSessionTranscript(agentId, sessionId);
    assert.equal(trNone.sessionId, sessionId);
    assert.equal(trNone.agentId, agentId);
    assert.deepEqual(trNone.messages, []);
    assert.deepEqual(trNone.referencedFiles, []);
    assert.equal(typeof trNone.delivery.isTerminal, "boolean", "delivery 字段独立存在");
  } finally {
    await cleanupAgent(agentId, lineage);
  }
});

// ── 7. agent_end 接入（静态护栏：阶段接入 + 包 try/catch 不冒泡）────────────────

test("agent-end finally：archive_session 阶段接入且归档失败被吞（不破坏 finally 链）", async () => {
  const src = await readFile(new URL("../lib/lifecycle/agent-end/stage-definitions.js", import.meta.url), "utf8");
  assert.match(src, /archiveSessionToRunTree/, "应 import 并调用 archiveSessionToRunTree");
  assert.match(src, /id:\s*"archive_session"/, "应有 archive_session 阶段");
  // archive_session 调用包在 try/catch 内（不冒泡破坏 finally 链）
  assert.match(src, /try\s*\{[\s\S]*archiveSessionToRunTree[\s\S]*\}\s*catch/, "archiveSessionToRunTree 调用应包在 try/catch 内");
  // 归档落点取谱系（无谱系轮次由归档器内部跳过）
  assert.match(src, /lineage:\s*context\.trackingState\?\.contract\?\.lineage/, "应传 trackingState.contract.lineage");
  // archive_session 应在 finalize_session 之前（先归档再 finalize）
  const archiveIdx = src.indexOf('id: "archive_session"');
  const finalizeIdx = src.indexOf('id: "finalize_session"');
  assert.ok(archiveIdx >= 0 && finalizeIdx >= 0 && archiveIdx < finalizeIdx, "archive_session 应在 finalize_session 之前");
});

test("run-tree-archive：archiveSessionToRunTree 内部 try/catch 吞错（绝不抛，源头护栏）", async () => {
  const src = await readFile(new URL("../lib/lifecycle/run-tree-archive.js", import.meta.url), "utf8");
  // 顶层 try 包整个函数体 + catch 返回 archived:false 而非 throw
  assert.match(src, /export async function archiveSessionToRunTree[\s\S]*?try\s*\{/, "函数体应整段 try 包裹");
  assert.match(src, /catch\s*\(error\)\s*\{[\s\S]*archived:\s*false/, "catch 应返回 archived:false（不抛）");
});
