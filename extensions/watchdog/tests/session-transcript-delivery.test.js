/**
 * session-transcript-delivery.test.js — transcript.delivery（末位 agent 用户最终接收消息）
 *
 * 覆盖：
 *   1. 叶子 agent（无出边）+ 产出件存在 → delivery.isTerminal:true + available:true + content
 *   2. 非叶子（有出边，真实 graph 的 controller/planner/worker）→ isTerminal:false
 *   3. 叶子但产出件缺失 → isTerminal:true + available:false + content:null
 *   4. 大产出件 → content 截断到 40000 + truncated:true
 *   5. graph 读失败（mock loadGraph 抛错）→ delivery:{isTerminal:false} 不抛
 *   6. live 产出件被清 → 回退 workflow-trace 快照；皆无 → available:false
 *
 * 叶子判定走真实 graph（loadGraph）：graph 中不存在的 agentId 必然无出边 = 叶子，
 * 用它做叶子用例，不污染真实拓扑；非叶子用真实 graph 里有出边的节点（运行时断言）。
 * 产出件大小写不敏感（contractId 小写 tc-，文件名可 TC-）已由 resolveCaseInsensitive 处理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readSessionTranscript } from "../lib/agent/agent-session-transcript.js";
import { loadGraph, getEdgesFrom } from "../lib/agent/agent-graph.js";

const OC_ROOT = join(homedir(), ".openclaw");
const OUTPUT_DIR = join(OC_ROOT, "control-plane", "output");

// graph 中不存在的 agentId → 必然无出边 = 叶子（不污染真实拓扑）
const LEAF_AGENT = `__delivery_leaf_${Date.now()}__`;

async function writeOutput(contractId, body) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const p = join(OUTPUT_DIR, `${contractId}.md`);
  await writeFile(p, body, "utf8");
  return p;
}

// ── 1. 叶子 + 产出件存在 ───────────────────────────────────────────────────────

test("delivery：叶子 agent（无出边）+ 产出件存在 → isTerminal:true + available:true + content", async () => {
  const contractId = `tc-deliv-${Date.now()}`;
  const outputPath = await writeOutput(contractId, "用户最终收到的内容");
  try {
    const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId });
    assert.equal(tr.delivery.isTerminal, true, "graph 中不存在的 agent 无出边 = 叶子 = 末位");
    assert.equal(tr.delivery.available, true, "产出件存在 → available:true");
    assert.equal(tr.delivery.content, "用户最终收到的内容");
    assert.equal(tr.delivery.contentChars, "用户最终收到的内容".length);
    assert.equal(tr.delivery.outputPath, outputPath, "outputPath 应指向产出件正本");
    assert.equal(tr.delivery.truncated, false);
  } finally {
    await rm(outputPath, { force: true });
  }
});

test("delivery：叶子 + 产出件文件名大小写不同（tc- vs TC-）仍能命中", async () => {
  const upper = `TC-DELIV-CASE-${Date.now()}`;
  const lower = upper.toLowerCase();
  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = join(OUTPUT_DIR, `${upper}.md`);
  await writeFile(outputPath, "case-insensitive body", "utf8");
  try {
    // contractId 用小写，文件名是大写 → resolveCaseInsensitive 命中
    const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId: lower });
    assert.equal(tr.delivery.available, true, "大小写不敏感应命中");
    assert.equal(tr.delivery.content, "case-insensitive body");
  } finally {
    await rm(outputPath, { force: true });
  }
});

// ── 2. 非叶子 → isTerminal:false ───────────────────────────────────────────────

test("delivery：非叶子 agent（有出边）→ isTerminal:false", async () => {
  const graph = await loadGraph();
  // 真实 graph 里取一个有出边的节点（controller/planner/worker 之一）
  const nonLeaf = graph.edges.map((e) => e.from).find((id) => getEdgesFrom(graph, id).length > 0);
  if (!nonLeaf) {
    // graph 无任何出边（极端空 graph），跳过该断言场景
    assert.ok(true, "当前 graph 无出边节点，跳过非叶子用例");
    return;
  }
  const tr = await readSessionTranscript(nonLeaf, "any-sid", { contractId: "tc-whatever" });
  assert.deepEqual(tr.delivery, { isTerminal: false }, "有出边 → 非末位 → isTerminal:false");
});

// ── 3. 叶子但产出件缺失 ────────────────────────────────────────────────────────

test("delivery：叶子但产出件缺失 → isTerminal:true + available:false + content:null", async () => {
  const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId: "tc-never-exists-xyz" });
  assert.equal(tr.delivery.isTerminal, true);
  assert.equal(tr.delivery.available, false, "产出件缺失 → available:false");
  assert.equal(tr.delivery.content, null);
  assert.equal(tr.delivery.contentChars, 0);
});

test("delivery：叶子但无 contractId → isTerminal:true + available:false（无从解析产出件）", async () => {
  const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId: null });
  assert.equal(tr.delivery.isTerminal, true);
  assert.equal(tr.delivery.available, false);
  assert.equal(tr.delivery.outputPath, null, "无 contractId 时 outputPath 为 null");
});

// ── 4. 大产出件截断 ────────────────────────────────────────────────────────────

test("delivery：大产出件 content 截断到 40000 + truncated:true", async () => {
  const contractId = `tc-big-${Date.now()}`;
  const body = "y".repeat(40000 + 321);
  const outputPath = await writeOutput(contractId, body);
  try {
    const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId });
    assert.equal(tr.delivery.available, true);
    assert.equal(tr.delivery.content.length, 40000, "超上限应 slice 到 40000");
    assert.equal(tr.delivery.contentChars, 40000);
    assert.equal(tr.delivery.truncated, true);
    assert.equal(tr.delivery.content, body.slice(0, 40000));
  } finally {
    await rm(outputPath, { force: true });
  }
});

// ── 5. graph 读失败 → isTerminal:false 不抛 ────────────────────────────────────

test("delivery：graph 读取抛错 → delivery:{isTerminal:false} 不抛（try/catch 兜底）", async () => {
  // 用 mock.module 替换 agent-graph 依赖，使 loadGraph 抛错（--experimental-test-module-mocks 已开启），
  // 再动态 import 一份新的 transcript 模块拿到被 mock 的依赖绑定。
  const { mock } = await import("node:test");
  const mocked = mock.module("../lib/agent/agent-graph.js", {
    namedExports: {
      loadGraph: () => { throw new Error("boom: graph unreadable"); },
      getEdgesFrom: () => [],
    },
  });
  try {
    const freshMod = await import(`../lib/agent/agent-session-transcript.js?graphfail=${Date.now()}`);
    const tr = await freshMod.readSessionTranscript("__deliv_mockfail__", "any", { contractId: "tc-x" });
    assert.deepEqual(tr.delivery, { isTerminal: false }, "graph 抛错时 delivery 兜底 isTerminal:false，且不抛");
  } finally {
    mocked.restore();
  }
});

// ── 6. live 产出件被清 → 回退 workflow-trace 快照 ──────────────────────────────

const TRACE_DIR = join(OC_ROOT, "control-plane", "workflow-trace");

async function writeTraceOutput(contractId, body) {
  const dir = join(TRACE_DIR, contractId);
  await mkdir(dir, { recursive: true });
  const p = join(dir, "output.md");
  await writeFile(p, body, "utf8");
  return p;
}

test("delivery：live 产出件在 → 优先读 live（outputPath 指向 output 目录）", async () => {
  const contractId = `tc-livefirst-${Date.now()}`;
  const livePath = await writeOutput(contractId, "LIVE 内容");
  const tracePath = await writeTraceOutput(contractId, "TRACE 内容");
  try {
    const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId });
    assert.equal(tr.delivery.available, true);
    assert.equal(tr.delivery.content, "LIVE 内容", "live 在时应优先读 live");
    assert.ok(tr.delivery.outputPath.includes("/control-plane/output/"), "outputPath 应指向 live output 目录");
  } finally {
    await rm(livePath, { force: true });
    await rm(join(TRACE_DIR, contractId), { recursive: true, force: true });
  }
});

test("delivery：live 被清 → 回退 workflow-trace 快照（outputPath 指向 trace）", async () => {
  const contractId = `tc-fallback-${Date.now()}`;
  const tracePath = await writeTraceOutput(contractId, "快照里的最终件");
  try {
    // 不写 live output，只有快照
    const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId });
    assert.equal(tr.delivery.isTerminal, true);
    assert.equal(tr.delivery.available, true, "live 缺应回退快照命中");
    assert.equal(tr.delivery.content, "快照里的最终件");
    assert.equal(tr.delivery.outputPath, tracePath, "outputPath 应指向 workflow-trace 快照");
  } finally {
    await rm(join(TRACE_DIR, contractId), { recursive: true, force: true });
  }
});

test("delivery：live + 快照皆无 → available:false", async () => {
  const contractId = `tc-bothgone-${Date.now()}`;
  const tr = await readSessionTranscript(LEAF_AGENT, "any-sid", { contractId });
  assert.equal(tr.delivery.isTerminal, true);
  assert.equal(tr.delivery.available, false, "两处皆无 → available:false");
  assert.equal(tr.delivery.content, null);
});
