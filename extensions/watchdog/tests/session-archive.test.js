/**
 * session-archive.test.js — agent session 持久归档（只读观测档）
 *
 * 覆盖：
 *   1. archiveAgentSession：写 .jsonl 副本 + index.json，按 sessionId 去重（更新已有项不丢历史）
 *   2. archiveAgentSession：缺前置/无 live session/源 .jsonl 不存在 → 不抛、archived:false
 *   3. listAgentSessions：合并 live + archive，按 sessionId 去重（live 优先），按 updatedAt 倒序
 *   4. listAgentSessions：live 被清后仍能从 archive 列出历史 session
 *   5. readSessionTranscript：live → archive 回退
 *   6. agent_end finally：archive_session 阶段接入且归档失败不破坏 finally 链（静态护栏）
 *
 * 归档 archivedAt 用 sessions.json 的 updatedAt（非 Date.now），比较可复现，无需剔时间戳。
 * fixtures 写到 ~/.openclaw 下唯一命名目录，finally 清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  archiveAgentSession,
  listArchivedSessions,
  archiveIndexFile,
  archiveSessionJsonl,
  archiveAgentDir,
} from "../lib/lifecycle/session-archive.js";
import { listAgentSessions } from "../lib/agent/agent-session-store.js";
import { readSessionTranscript } from "../lib/agent/agent-session-transcript.js";

const OC_ROOT = join(homedir(), ".openclaw");

function liveSessionsDir(agentId) {
  return join(OC_ROOT, "agents", agentId, "sessions");
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

async function cleanupAgent(agentId) {
  await rm(join(OC_ROOT, "agents", agentId), { recursive: true, force: true });
  await rm(archiveAgentDir(agentId), { recursive: true, force: true });
}

// ── 1. archiveAgentSession 写入 + index 去重 ──────────────────────────────────

test("archiveAgentSession：写 .jsonl 副本 + index.json，archivedAt=sessions.json updatedAt", async () => {
  const agentId = `__arc_write_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-a", updatedAt: 111 });
  try {
    const result = await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-1", contractId: "tc-1" });
    assert.deepEqual(result, { archived: true, sessionId: "sid-a" });
    // .jsonl 副本落盘
    assert.equal(existsSync(archiveSessionJsonl(agentId, "sid-a")), true, "归档 .jsonl 应存在");
    // index.json 内容
    const index = JSON.parse(await readFile(archiveIndexFile(agentId), "utf8"));
    assert.equal(index.length, 1);
    assert.deepEqual(index[0], {
      sessionId: "sid-a",
      sessionKey: "agent:x:contract:tc-1",
      contractId: "tc-1",
      updatedAt: 111,
      archivedAt: 111,
    });
  } finally {
    await cleanupAgent(agentId);
  }
});

test("archiveAgentSession：同 sessionId 再归档 → 去重更新 updatedAt/contractId，不新增项", async () => {
  const agentId = `__arc_dedup_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-a", updatedAt: 100 });
  try {
    await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-1", contractId: "tc-1" });
    // live 更新 updatedAt + contractId 后再归档
    await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-2", sessionId: "sid-a", updatedAt: 200 });
    await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-2", contractId: "tc-2" });

    const index = await listArchivedSessions(agentId);
    assert.equal(index.length, 1, "同 sessionId 去重，仍 1 项");
    assert.equal(index[0].updatedAt, 200, "updatedAt 应更新为最新");
    assert.equal(index[0].contractId, "tc-2", "contractId 应更新");
    assert.equal(index[0].archivedAt, 200, "archivedAt 跟随最新 updatedAt");
  } finally {
    await cleanupAgent(agentId);
  }
});

test("archiveAgentSession：不同 sessionId 累积为历史多项（不丢旧项）", async () => {
  const agentId = `__arc_hist_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-1", updatedAt: 100 });
  try {
    await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-1", contractId: "tc-1" });
    // 模拟下一轮：新的 sessionId（如 session-clean 后重建）
    await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-2", sessionId: "sid-2", updatedAt: 200 });
    await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-2", contractId: "tc-2" });

    const index = await listArchivedSessions(agentId);
    assert.equal(index.length, 2, "两个不同 sessionId 应累积");
    const ids = index.map((i) => i.sessionId).sort();
    assert.deepEqual(ids, ["sid-1", "sid-2"]);
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 2. archiveAgentSession 兜底（不抛）────────────────────────────────────────

test("archiveAgentSession：缺前置 / 无 live session / 源 .jsonl 缺失 → archived:false 不抛", async () => {
  // 缺 agentId / sessionKey
  assert.deepEqual(
    await archiveAgentSession({ sessionKey: "k" }),
    { archived: false, sessionId: null, reason: "missing_agent_or_key" },
  );
  assert.deepEqual(
    await archiveAgentSession({ agentId: "a" }),
    { archived: false, sessionId: null, reason: "missing_agent_or_key" },
  );
  // 无 live sessions.json
  const r1 = await archiveAgentSession({ agentId: "__no_agent_arc__", sessionKey: "k" });
  assert.equal(r1.archived, false);
  assert.equal(r1.reason, "no_live_session");

  // sessions.json 有条目但 .jsonl 缺失 → jsonl_copy_failed，不抛
  const agentId = `__arc_nojsonl_${Date.now()}__`;
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sessions.json"), JSON.stringify({ "agent:x:contract:tc-1": { sessionId: "sid-x", updatedAt: 5 } }), "utf8");
  try {
    const r2 = await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-1", contractId: "tc-1" });
    assert.equal(r2.archived, false);
    assert.match(r2.reason, /jsonl_copy_failed/);
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 3 + 4. listAgentSessions 合并 / live 被清后 archive 仍可见 ──────────────────

test("listAgentSessions：合并 live + archive，按 sessionId 去重（live 优先），倒序", async () => {
  const agentId = `__arc_merge_${Date.now()}__`;
  // archive 里有 sid-old（updatedAt 50）和 sid-shared（archive updatedAt 60）
  await mkdir(archiveAgentDir(agentId), { recursive: true });
  await writeFile(archiveIndexFile(agentId), JSON.stringify([
    { sessionId: "sid-old", sessionKey: "agent:x:contract:tc-old", contractId: "tc-old", updatedAt: 50, archivedAt: 50 },
    { sessionId: "sid-shared", sessionKey: "agent:x:contract:tc-shared", contractId: "tc-shared", updatedAt: 60, archivedAt: 60 },
  ]), "utf8");
  // live 里有 sid-shared（updatedAt 900，应优先）和 sid-new（updatedAt 800）
  const dir = liveSessionsDir(agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sessions.json"), JSON.stringify({
    "agent:x:contract:tc-shared": { sessionId: "sid-shared", updatedAt: 900, model: "live-model", totalTokens: 42 },
    "agent:x:contract:tc-new": { sessionId: "sid-new", updatedAt: 800, model: "m2", totalTokens: 9 },
  }), "utf8");
  try {
    const list = await listAgentSessions(agentId);
    assert.equal(list.length, 3, "去重后 sid-shared/sid-new/sid-old = 3");
    // 倒序：900 > 800 > 50
    assert.deepEqual(list.map((s) => s.sessionId), ["sid-shared", "sid-new", "sid-old"]);
    // sid-shared 取 live（model/totalTokens 来自 live，updatedAt=900）
    const shared = list.find((s) => s.sessionId === "sid-shared");
    assert.equal(shared.updatedAt, 900, "shared 应取 live updatedAt");
    assert.equal(shared.model, "live-model", "shared 应取 live model");
    assert.equal(shared.totalTokens, 42);
    // sid-old 来自 archive（model/totalTokens null）
    const old = list.find((s) => s.sessionId === "sid-old");
    assert.equal(old.model, null);
    assert.equal(old.contractId, "tc-old");
  } finally {
    await cleanupAgent(agentId);
  }
});

test("listAgentSessions：live 被清后仍能从 archive 列出历史 session", async () => {
  const agentId = `__arc_liveclean_${Date.now()}__`;
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId: "sid-h", updatedAt: 321 });
  try {
    await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-1", contractId: "tc-1" });
    // 模拟 session-clean：删 live sessions 目录
    await rm(liveSessionsDir(agentId), { recursive: true, force: true });
    const list = await listAgentSessions(agentId);
    assert.equal(list.length, 1, "live 清掉后仍能从 archive 列出");
    assert.equal(list[0].sessionId, "sid-h");
    assert.equal(list[0].contractId, "tc-1");
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 5. readSessionTranscript live → archive 回退 ──────────────────────────────

test("readSessionTranscript：live 在时读 live；live 被清后回退 archive", async () => {
  const agentId = `__arc_tr_${Date.now()}__`;
  const sessionId = "sid-tr";
  const jsonlLines = [
    JSON.stringify({ type: "message", timestamp: "2026-05-30T00:00:00.000Z", message: { role: "user", content: "from-live" } }),
  ];
  await writeLiveSession(agentId, { sessionKey: "agent:x:contract:tc-1", sessionId, updatedAt: 1, jsonlLines });
  try {
    // live 在 → 读到
    const trLive = await readSessionTranscript(agentId, sessionId);
    assert.equal(trLive.messages.length, 1);
    assert.equal(trLive.messages[0].text, "from-live");

    // 归档后删 live → 回退 archive
    await archiveAgentSession({ agentId, sessionKey: "agent:x:contract:tc-1", contractId: "tc-1" });
    await rm(liveSessionsDir(agentId), { recursive: true, force: true });
    const trArchive = await readSessionTranscript(agentId, sessionId);
    assert.equal(trArchive.messages.length, 1, "live 清掉后应回退 archive");
    assert.equal(trArchive.messages[0].text, "from-live", "归档副本内容一致");

    // 两处皆无 → 兜底空结构（messages/referencedFiles 空；delivery 字段独立存在）
    await cleanupAgent(agentId);
    const trNone = await readSessionTranscript(agentId, sessionId);
    assert.equal(trNone.sessionId, sessionId);
    assert.equal(trNone.agentId, agentId);
    assert.deepEqual(trNone.messages, []);
    assert.deepEqual(trNone.referencedFiles, []);
    assert.equal(typeof trNone.delivery.isTerminal, "boolean", "delivery 字段独立存在");
  } finally {
    await cleanupAgent(agentId);
  }
});

// ── 6. agent_end 接入（静态护栏：阶段接入 + 包 try/catch 不冒泡）────────────────

test("agent-end finally：archive_session 阶段接入且归档失败被吞（不破坏 finally 链）", async () => {
  const src = await readFile(new URL("../lib/lifecycle/agent-end-stage-definitions.js", import.meta.url), "utf8");
  assert.match(src, /archiveAgentSession/, "应 import 并调用 archiveAgentSession");
  assert.match(src, /id:\s*"archive_session"/, "应有 archive_session 阶段");
  // archive_session 调用包在 try/catch 内（不冒泡破坏 finally 链）
  assert.match(src, /try\s*\{[\s\S]*archiveAgentSession[\s\S]*\}\s*catch/, "archiveAgentSession 调用应包在 try/catch 内");
  // archive_session 应在 finalize_session 之前（先归档再 finalize）
  const archiveIdx = src.indexOf('id: "archive_session"');
  const finalizeIdx = src.indexOf('id: "finalize_session"');
  assert.ok(archiveIdx >= 0 && finalizeIdx >= 0 && archiveIdx < finalizeIdx, "archive_session 应在 finalize_session 之前");
});

test("session-archive：archiveAgentSession 内部 try/catch 吞错（绝不抛，源头护栏）", async () => {
  const src = await readFile(new URL("../lib/lifecycle/session-archive.js", import.meta.url), "utf8");
  // 顶层 try 包整个函数体 + catch 返回 archived:false 而非 throw
  assert.match(src, /export async function archiveAgentSession[\s\S]*?try\s*\{/, "函数体应整段 try 包裹");
  assert.match(src, /catch\s*\(error\)\s*\{[\s\S]*archived:\s*false/, "catch 应返回 archived:false（不抛）");
});
