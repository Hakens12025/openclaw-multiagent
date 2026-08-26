/**
 * knowledge-agent-search.test.js — Phase 5 v154:per-agent KB consumer
 *
 * searchAgentKnowledge = 跨「该 agent 绑定库 ∪(可选)global」聚合检索(复用 searchKb,名次交错合并)。
 * 纯路径进 gate:选库过滤(零 if(agentId==='xxx'))、round-robin 合并(score 跨库不强排)、默认关。
 * live(无 ollama 则 skip):注册 agent 库 → 建 → searchAgentKnowledge 返回标注 kbId 的合并结果。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  selectAgentKnowledgeBases,
  mergeAgentKbResults,
  searchAgentKnowledge,
} from "../lib/knowledge/knowledge-base.js";
import { addKnowledgeBaseSource, removeKnowledgeBase } from "../lib/knowledge/knowledge-base-registry.js";
import { buildKbIndex } from "../lib/knowledge/knowledge-base.js";
import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { knowledgeBaseIndexFile } from "../lib/control-plane/control-plane-paths.js";
import { embedText } from "../lib/knowledge/wiki-rag-embed.js";

let ollamaUp = false;
try { await embedText("probe", {}); ollamaUp = true; } catch { ollamaUp = false; }

const SPECS = [
  { id: "a", scope: "agent", agentId: "X", label: "A" },
  { id: "b", scope: "agent", agentId: "Y", label: "B" },
  { id: "wiki", scope: "global", label: "Wiki" },
];

// ── selectAgentKnowledgeBases(纯,零 if(agentId==='xxx'))──
test("selectAgentKnowledgeBases:绑定该 agent 的库 + includeGlobal 门控", () => {
  assert.deepEqual(selectAgentKnowledgeBases(SPECS, "X").map((s) => s.id), ["a"]);            // 仅自己的 agent 库
  assert.deepEqual(selectAgentKnowledgeBases(SPECS, "X", { includeGlobal: true }).map((s) => s.id), ["a", "wiki"]);
  assert.deepEqual(selectAgentKnowledgeBases(SPECS, "Z").map((s) => s.id), []);               // 没绑库 → 空(默认关)
  assert.deepEqual(selectAgentKnowledgeBases(SPECS, "Z", { includeGlobal: true }).map((s) => s.id), ["wiki"]);
  assert.deepEqual(selectAgentKnowledgeBases(SPECS, "").map((s) => s.id), []);                // 空 agentId → 不命中 agent 库
});

// ── mergeAgentKbResults(纯,round-robin,不跨库强排)──
test("mergeAgentKbResults:名次交错 + 标注 kbId + 低分库不被高分库霸榜", () => {
  const perKb = [
    { kbId: "a", kbLabel: "A", scope: "agent", results: [{ sourcePath: "a1", score: 0.9 }, { sourcePath: "a2", score: 0.8 }] },
    { kbId: "b", kbLabel: "B", scope: "agent", results: [{ sourcePath: "b1", score: 0.02 }] }, // 量纲悬殊
  ];
  const merged = mergeAgentKbResults(perKb, { topK: 5 });
  assert.deepEqual(merged.map((r) => r.sourcePath), ["a1", "b1", "a2"]); // A#1,B#1,A#2 交错
  assert.ok(merged.every((r) => r.kbId && r.scope));                     // 每条带来源标注
  assert.equal(merged.find((r) => r.sourcePath === "b1").kbId, "b");
  // topK 截断
  assert.equal(mergeAgentKbResults(perKb, { topK: 2 }).length, 2);
});

// ── 默认关(无绑库 agent 行为零变化)──
test("searchAgentKnowledge:无绑库 agent → 空结果/bases(默认关,不吃 global)", async () => {
  const r = await searchAgentKnowledge(`nobody-${Date.now()}`, "任意查询", { topK: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.deepEqual(r.results, []);
  assert.deepEqual(r.bases, []);
});

// ── 绑定发现(注册 agent 库 → bases 反映;确定式,不需 ollama)──
test("searchAgentKnowledge:绑定库被该 agentId 发现、不被别的 agent 看到", async () => {
  const agentId = `agt-${Date.now()}`;
  const kbId = `agtkb-${Date.now()}`;
  try {
    await addKnowledgeBaseSource(kbId, "/tmp/nonexistent-source", { label: "私有库", scope: "agent", agentId });
    const mine = await searchAgentKnowledge(agentId, "q", { topK: 3 });
    assert.ok(mine.bases.some((b) => b.id === kbId), "owner agent 应看到自己的库");
    assert.equal(mine.bases.find((b) => b.id === kbId).scope, "agent");
    const other = await searchAgentKnowledge("someone-else", "q", { topK: 3 });
    assert.ok(!other.bases.some((b) => b.id === kbId), "别的 agent 不应看到该私有库(隔离)");
  } finally {
    await removeKnowledgeBase(kbId).catch(() => {});
  }
});

// ── surface 注册 ──
test("inspect.knowledge_agent_search 注册(operator/UI 验证入口)", () => {
  const s = getCliSystemSurface("inspect.knowledge_agent_search");
  assert.ok(s, "应注册");
  assert.equal(s.family, "inspect");
  assert.equal(s.operatorExecutable, false); // 验证面,非 belt agent 读通道
});

// ── live:两库聚合检索(skip if ollama down)──
test("live: searchAgentKnowledge 跨绑定库聚合 + 标注(skip if ollama down)", { skip: !ollamaUp }, async () => {
  const agentId = `agtl-${Date.now()}`;
  const dir1 = await mkdtemp(join(tmpdir(), "agtkb1-"));
  const dir2 = await mkdtemp(join(tmpdir(), "agtkb2-"));
  const kb1 = `agtkb1-${Date.now()}`;
  const kb2 = `agtkb2-${Date.now()}`;
  try {
    await writeFile(join(dir1, "deploy.md"), "# 运维\n用 launchctl kickstart 重启网关,端口 18789。\n");
    await writeFile(join(dir2, "rag.md"), "# 检索\nRAG 用 hybrid 向量 cosine + 词法 BM25 RRF 融合。\n");
    await addKnowledgeBaseSource(kb1, dir1, { label: "运维库", scope: "agent", agentId });
    await addKnowledgeBaseSource(kb2, dir2, { label: "检索库", scope: "agent", agentId });
    await buildKbIndex(kb1, { force: true });
    await buildKbIndex(kb2, { force: true });

    const r = await searchAgentKnowledge(agentId, "重启网关 RAG 融合", { topK: 6 });
    assert.equal(r.ok, true);
    assert.equal(r.bases.length, 2, "应发现 2 个绑定库");
    assert.ok(r.results.length > 0, "应有合并结果");
    assert.ok(r.results.every((x) => x.kbId), "每条结果带 kbId 标注");
    const kbIds = new Set(r.results.map((x) => x.kbId));
    assert.ok(kbIds.has(kb1) && kbIds.has(kb2), "结果应来自两个库(交错合并)");
    assert.equal(r.byKb.length, 2, "byKb 分组视图");
  } finally {
    await removeKnowledgeBase(kb1).catch(() => {});
    await removeKnowledgeBase(kb2).catch(() => {});
    await rm(knowledgeBaseIndexFile(kb1), { force: true }).catch(() => {});
    await rm(knowledgeBaseIndexFile(kb2), { force: true }).catch(() => {});
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});
