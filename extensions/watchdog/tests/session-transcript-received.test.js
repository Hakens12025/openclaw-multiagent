/**
 * session-transcript-received.test.js — transcript.received（系统投递给 agent 的合约）
 *
 * received = 「系统/上游发来什么」，即系统投递到该 agent inbox 的合约。来源优先级：
 *   1. inbox 快照 threads/{t}/runs/{r}/participants/<agentId>/inbox-<contractId>/contract.json
 *      （首选，经 contract-index 找 run 家）
 *   2. live workspaces/<agentId>/inbox/contract.json（回退）
 *   3. 共享合约正本（回退，resolveSharedContractPathById 经 contract-index 走树）
 *
 * 覆盖：
 *   1. inbox 快照存在 → source='inbox-snapshot' + task + raw
 *   2. 快照缺 → 回退 live-inbox
 *   3. 快照+live 缺 → 回退 contract 正本（树店）
 *   4. 皆无 → available:false
 *   5. 无 contractId → available:false
 *   6. 大合约 raw 截断 40000 + truncated:true
 *   7. 正本非 JSON → task:null、raw 仍给原文
 *
 * 树内 fixtures 落 seed-tree-stores 隔离根；live fixtures 写到 ~/.openclaw 下
 * 唯一命名目录，finally 清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readSessionTranscript } from "../lib/agent/agent-session-transcript.js";
import { compactHomePath } from "../lib/agent/agent-enrollment-discovery.js";
import { recordContractHome, resolveThreadsRoot } from "../lib/archive/thread-tree-store.js";

const OC_ROOT = join(homedir(), ".openclaw");

const AGENT = "__received_agent__";

function liveInboxPath(agentId) {
  return join(OC_ROOT, "workspaces", agentId, "inbox", "contract.json");
}

// 每个 case 独立 lineage（thread 名带 cid 尾巴保唯一），登记 contract-index 后按树内布局落 fixture。
function lineageFor(contractId) {
  return { threadId: `t-recv-${contractId.slice(-8)}`, runId: `r-${contractId.slice(-8)}` };
}

function runDir(lineage) {
  return join(resolveThreadsRoot(), lineage.threadId, "runs", lineage.runId);
}

// 树内 inbox 快照：participants/<agentId>/inbox-<cid>/contract.json（写者 = agent_end snapshotInboxToRunTree）
async function writeInboxSnapshot(lineage, contractId, agentId, payload) {
  await recordContractHome(contractId, lineage);
  const dir = join(runDir(lineage), "participants", agentId, `inbox-${contractId}`);
  await mkdir(dir, { recursive: true });
  const p = join(dir, "contract.json");
  await writeFile(p, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return p;
}

async function writeLiveInbox(agentId, payload) {
  const dir = join(OC_ROOT, "workspaces", agentId, "inbox");
  await mkdir(dir, { recursive: true });
  const p = join(dir, "contract.json");
  await writeFile(p, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return p;
}

// 共享合约正本（树店）：threads/{t}/runs/{r}/contracts/<cid>.json + contract-index 登记
async function writeContract(lineage, contractId, payload) {
  await recordContractHome(contractId, lineage);
  const dir = join(runDir(lineage), "contracts");
  await mkdir(dir, { recursive: true });
  const p = join(dir, `${contractId}.json`);
  await writeFile(p, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return p;
}

async function cleanup(lineage, agentId) {
  await rm(join(resolveThreadsRoot(), lineage.threadId), { recursive: true, force: true });
  await rm(join(OC_ROOT, "workspaces", agentId), { recursive: true, force: true });
}

// ── 1. inbox 快照（首选）───────────────────────────────────────────────────────

test("received：inbox 快照存在 → source='inbox-snapshot' + task + raw", async () => {
  const contractId = `tc-recv-snap-${Date.now()}`;
  const lineage = lineageFor(contractId);
  const payload = { id: contractId, task: "系统投递的任务正文", assignee: AGENT };
  await writeInboxSnapshot(lineage, contractId, AGENT, payload);
  // 同时写 live-inbox + contract 正本，验证快照优先级最高
  await writeLiveInbox(AGENT, { id: contractId, task: "live 不应被选" });
  await writeContract(lineage, contractId, { id: contractId, task: "contract 不应被选" });
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "inbox-snapshot", "快照应优先");
    assert.equal(tr.received.task, "系统投递的任务正文", "应解析出 contract.task");
    assert.equal(tr.received.contractId, contractId);
    assert.equal(tr.received.raw, JSON.stringify(payload), "raw 应为合约 JSON 原文");
    assert.equal(tr.received.truncated, false);
    assert.ok(tr.received.path.includes(`/participants/${AGENT}/inbox-${contractId}/`), "path 应指向树内 inbox 快照");
  } finally {
    await cleanup(lineage, AGENT);
  }
});

// ── 2. 快照缺 → live-inbox ─────────────────────────────────────────────────────

test("received：inbox 快照缺 → 回退 live-inbox", async () => {
  const contractId = `tc-recv-live-${Date.now()}`;
  const lineage = lineageFor(contractId);
  await writeLiveInbox(AGENT, { id: contractId, task: "live inbox 的任务" });
  await writeContract(lineage, contractId, { id: contractId, task: "contract 不应被选" });
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "live-inbox", "快照缺应回退 live-inbox");
    assert.equal(tr.received.task, "live inbox 的任务");
    assert.equal(tr.received.path, compactHomePath(liveInboxPath(AGENT)));
  } finally {
    await cleanup(lineage, AGENT);
  }
});

// ── 3. 快照+live 缺 → contract 正本 ────────────────────────────────────────────

test("received：快照+live 缺 → 回退 contract 正本（树店 .json）", async () => {
  const contractId = `tc-recv-contract-${Date.now()}`;
  const lineage = lineageFor(contractId);
  await writeContract(lineage, contractId, { id: contractId, task: "正本里的任务" });
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "contract", "前两者缺应回退 contract 正本");
    assert.equal(tr.received.task, "正本里的任务");
    assert.ok(tr.received.path.includes(`/runs/${lineage.runId}/contracts/`), "path 应指向树内正本");
  } finally {
    await cleanup(lineage, AGENT);
  }
});

// ── 4 + 5. 皆无 / 无 contractId → available:false ──────────────────────────────

test("received：三源皆无 → available:false", async () => {
  const contractId = `tc-recv-none-${Date.now()}`;
  const tr = await readSessionTranscript(AGENT, "sid", { contractId });
  assert.deepEqual(tr.received, { available: false }, "三源皆无 → available:false");
});

test("received：无 contractId → available:false", async () => {
  const tr = await readSessionTranscript(AGENT, "sid", { contractId: null });
  assert.deepEqual(tr.received, { available: false }, "无 contractId → available:false");
});

// ── 6. 大合约 raw 截断 ─────────────────────────────────────────────────────────

test("received：大合约 raw 截断到 40000 + truncated:true", async () => {
  const contractId = `tc-recv-big-${Date.now()}`;
  const lineage = lineageFor(contractId);
  // 构造一个 JSON 序列化后超过 40000 字符的合约（task 塞大字符串）
  const bigTask = "z".repeat(40000 + 200);
  const payload = { id: contractId, task: bigTask };
  const rawFull = JSON.stringify(payload);
  await writeInboxSnapshot(lineage, contractId, AGENT, payload);
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.truncated, true, "超上限应 truncated:true");
    assert.equal(tr.received.raw.length, 40000, "raw 应 slice 到 40000");
    assert.equal(tr.received.raw, rawFull.slice(0, 40000));
    // task 仍能从完整 JSON 解析出（解析用的是完整 raw，截断只作用于返回的 raw 字段）
    assert.equal(tr.received.task, bigTask, "task 解析自完整 JSON");
  } finally {
    await cleanup(lineage, AGENT);
  }
});

// ── 7. 正本非 JSON → task:null、raw 给原文 ─────────────────────────────────────

test("received：正本内容非 JSON → task:null、raw 给原文", async () => {
  const contractId = `tc-recv-md-${Date.now()}`;
  const lineage = lineageFor(contractId);
  await writeContract(lineage, contractId, "# 合约\n这不是 JSON 正文");
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "contract");
    assert.equal(tr.received.task, null, "非 JSON → task:null");
    assert.equal(tr.received.raw, "# 合约\n这不是 JSON 正文", "raw 仍给原文");
  } finally {
    await cleanup(lineage, AGENT);
  }
});
