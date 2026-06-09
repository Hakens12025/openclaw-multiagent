/**
 * knowledge-base.test.js — 多知识库注册表(Phase 1a 地基)
 *
 * KB 注册表 + searchKb(复用 hybrid 检索)+ inspect.knowledge_bases 面。
 * 注册表/规格是纯函数(进 gate);searchKb 的 live 检索无 ollama 则 skip。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  listKnowledgeBaseSpecs,
  getKnowledgeBaseSpec,
  searchKb,
  summarizeKnowledgeBases,
} from "../lib/operator/knowledge-base.js";
import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-inspector.js";
import { embedText } from "../lib/operator/wiki-rag-embed.js";

let ollamaUp = false;
try { await embedText("probe", {}); ollamaUp = true; } catch { ollamaUp = false; }

test("注册表:内置种子库 wiki(global)", async () => {
  const specs = await listKnowledgeBaseSpecs();
  const wiki = specs.find((s) => s.id === "wiki");
  assert.ok(wiki, "应有内置 wiki 库");
  assert.equal(wiki.scope, "global");
  assert.equal(wiki.kind, "builtin");
  assert.ok(wiki.sources.includes("wiki"));
});

test("getKnowledgeBaseSpec:命中 / 未知→null", async () => {
  assert.equal((await getKnowledgeBaseSpec("wiki"))?.id, "wiki");
  assert.equal(await getKnowledgeBaseSpec("does-not-exist"), null);
});

test("searchKb:未知库 → ok:false + error(不抛)", async () => {
  const r = await searchKb("nope", "任意查询", { topK: 3 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.deepEqual(r.results, []);
});

test("inspect.knowledge_bases:已注册 inspect 面 + 返回 wiki 库", async () => {
  const s = getCliSystemSurface("inspect.knowledge_bases");
  assert.ok(s, "surface 应注册");
  assert.equal(s.family, "inspect");
  const data = await inspectCliSystemSurface({ surfaceId: "inspect.knowledge_bases" });
  assert.ok(data.counts.total >= 1);
  const wiki = data.knowledgeBases.find((k) => k.id === "wiki");
  assert.ok(wiki, "概览应含 wiki 库");
  assert.equal(typeof wiki.chunkCount, "number");
});

test("summarizeKnowledgeBases:形状(counts + knowledgeBases[])", async () => {
  const data = await summarizeKnowledgeBases();
  assert.ok(typeof data.counts.total === "number");
  assert.ok(Array.isArray(data.knowledgeBases));
});

// searchKb 真检索(复用 hybrid)— 无 ollama 则 skip。
test("live: searchKb(wiki) 复用 hybrid 返回结果(skip if ollama down)", { skip: !ollamaUp }, async () => {
  const r = await searchKb("wiki", "harness guard collector gate normalizer", { topK: 3 });
  assert.equal(r.ok, true);
  assert.ok(r.results.length > 0);
  assert.ok(r.results.some((x) => x.sourcePath === "concepts/harness.md"), "harness 查询应命中 harness.md");
});
