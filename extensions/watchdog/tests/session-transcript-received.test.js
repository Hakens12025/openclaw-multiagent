/**
 * session-transcript-received.test.js — transcript.received（系统投递给 agent 的合约）
 *
 * received = 「系统/上游发来什么」，即系统投递到该 agent inbox 的合约。来源优先级：
 *   1. inbox 快照 control-plane/workflow-trace/<contractId>/<agentId>/inbox/contract.json（首选）
 *   2. live workspaces/<agentId>/inbox/contract.json（回退）
 *   3. 正本 control-plane/contracts/<contractId>.json|.md（回退，大小写不敏感）
 *
 * 覆盖：
 *   1. inbox 快照存在 → source='inbox-snapshot' + task + raw
 *   2. 快照缺 → 回退 live-inbox
 *   3. 快照+live 缺 → 回退 contract 正本
 *   4. 皆无 → available:false
 *   5. 无 contractId → available:false
 *   6. 大合约 raw 截断 40000 + truncated:true
 *   7. .md 正本（非 JSON）→ task:null、raw 仍给原文
 *
 * fixtures 写到 ~/.openclaw 下唯一命名目录，finally 清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readSessionTranscript } from "../lib/agent/agent-session-transcript.js";
import { compactHomePath } from "../lib/agent/agent-enrollment-discovery.js";

const OC_ROOT = join(homedir(), ".openclaw");
const TRACE_DIR = join(OC_ROOT, "control-plane", "workflow-trace");
const CONTRACTS_DIR = join(OC_ROOT, "control-plane", "contracts");

const AGENT = "__received_agent__";

function liveInboxPath(agentId) {
  return join(OC_ROOT, "workspaces", agentId, "inbox", "contract.json");
}

async function writeInboxSnapshot(contractId, agentId, payload) {
  const dir = join(TRACE_DIR, contractId, agentId, "inbox");
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

async function writeContract(contractId, ext, payload) {
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const p = join(CONTRACTS_DIR, `${contractId}.${ext}`);
  await writeFile(p, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return p;
}

async function cleanup(contractId, agentId) {
  await rm(join(TRACE_DIR, contractId), { recursive: true, force: true });
  await rm(join(OC_ROOT, "workspaces", agentId), { recursive: true, force: true });
  await rm(join(CONTRACTS_DIR, `${contractId}.json`), { force: true });
  await rm(join(CONTRACTS_DIR, `${contractId}.md`), { force: true });
}

// ── 1. inbox 快照（首选）───────────────────────────────────────────────────────

test("received：inbox 快照存在 → source='inbox-snapshot' + task + raw", async () => {
  const contractId = `tc-recv-snap-${Date.now()}`;
  const payload = { id: contractId, task: "系统投递的任务正文", assignee: AGENT };
  await writeInboxSnapshot(contractId, AGENT, payload);
  // 同时写 live-inbox + contract，验证快照优先级最高
  await writeLiveInbox(AGENT, { id: contractId, task: "live 不应被选" });
  await writeContract(contractId, "json", { id: contractId, task: "contract 不应被选" });
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "inbox-snapshot", "快照应优先");
    assert.equal(tr.received.task, "系统投递的任务正文", "应解析出 contract.task");
    assert.equal(tr.received.contractId, contractId);
    assert.equal(tr.received.raw, JSON.stringify(payload), "raw 应为合约 JSON 原文");
    assert.equal(tr.received.truncated, false);
    assert.ok(tr.received.path.includes("/workflow-trace/"), "path 应指向 inbox 快照");
  } finally {
    await cleanup(contractId, AGENT);
  }
});

// ── 2. 快照缺 → live-inbox ─────────────────────────────────────────────────────

test("received：inbox 快照缺 → 回退 live-inbox", async () => {
  const contractId = `tc-recv-live-${Date.now()}`;
  await writeLiveInbox(AGENT, { id: contractId, task: "live inbox 的任务" });
  await writeContract(contractId, "json", { id: contractId, task: "contract 不应被选" });
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "live-inbox", "快照缺应回退 live-inbox");
    assert.equal(tr.received.task, "live inbox 的任务");
    assert.equal(tr.received.path, compactHomePath(liveInboxPath(AGENT)));
  } finally {
    await cleanup(contractId, AGENT);
  }
});

// ── 3. 快照+live 缺 → contract 正本 ────────────────────────────────────────────

test("received：快照+live 缺 → 回退 contract 正本（.json）", async () => {
  const contractId = `tc-recv-contract-${Date.now()}`;
  await writeContract(contractId, "json", { id: contractId, task: "正本里的任务" });
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "contract", "前两者缺应回退 contract 正本");
    assert.equal(tr.received.task, "正本里的任务");
    assert.ok(tr.received.path.includes("/control-plane/contracts/"), "path 应指向正本");
  } finally {
    await cleanup(contractId, AGENT);
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
  // 构造一个 JSON 序列化后超过 40000 字符的合约（task 塞大字符串）
  const bigTask = "z".repeat(40000 + 200);
  const payload = { id: contractId, task: bigTask };
  const rawFull = JSON.stringify(payload);
  await writeInboxSnapshot(contractId, AGENT, payload);
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.truncated, true, "超上限应 truncated:true");
    assert.equal(tr.received.raw.length, 40000, "raw 应 slice 到 40000");
    assert.equal(tr.received.raw, rawFull.slice(0, 40000));
    // task 仍能从完整 JSON 解析出（解析用的是完整 raw，截断只作用于返回的 raw 字段）
    assert.equal(tr.received.task, bigTask, "task 解析自完整 JSON");
  } finally {
    await cleanup(contractId, AGENT);
  }
});

// ── 7. .md 正本（非 JSON）→ task:null、raw 给原文 ──────────────────────────────

test("received：.md 正本（非 JSON）→ task:null、raw 给原文", async () => {
  const contractId = `tc-recv-md-${Date.now()}`;
  await writeContract(contractId, "md", "# 合约\n这是 markdown 正本，不是 JSON");
  try {
    const tr = await readSessionTranscript(AGENT, "sid", { contractId });
    assert.equal(tr.received.available, true);
    assert.equal(tr.received.source, "contract");
    assert.equal(tr.received.task, null, "非 JSON → task:null");
    assert.equal(tr.received.raw, "# 合约\n这是 markdown 正本，不是 JSON", "raw 仍给原文");
  } finally {
    await cleanup(contractId, AGENT);
  }
});
