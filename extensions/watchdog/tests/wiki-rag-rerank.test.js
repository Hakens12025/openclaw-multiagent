/**
 * wiki-rag-rerank.test.js — 122 P0-2:LLM-as-reranker(默认关,优雅退化)
 *
 * applyRanking 纯函数;rerankResults 用 fake chatJson 确定式(不碰真 LLM);
 * hybridSearchOverIndex rerank===false → 行为同旧(默认关零回归)。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyRanking, rerankResults } from "../lib/knowledge/wiki-rag-rerank.js";
import { hybridSearchOverIndex } from "../lib/knowledge/wiki-rag-search.js";

const R = (id) => ({ sourcePath: `${id}.md`, heading: id, text: `text-${id}` });

// ── applyRanking(纯)──
test("applyRanking:按 ranking 重排 + LLM 漏的按原序补回(不丢)+ 去重 + topN", () => {
  const list = [R("a"), R("b"), R("c"), R("d")];
  // ranking 把 c,a 提前;b,d 未列 → 补在后面原序
  assert.deepEqual(applyRanking(list, [3, 1], 5).map((r) => r.heading), ["c", "a", "b", "d"]);
  // 越界/重复序号忽略
  assert.deepEqual(applyRanking(list, [2, 2, 99, 0], 5).map((r) => r.heading), ["b", "a", "c", "d"]);
  // topN 截断
  assert.deepEqual(applyRanking(list, [4], 2).map((r) => r.heading), ["d", "a"]);
  // 空 ranking → 原序
  assert.deepEqual(applyRanking(list, [], 3).map((r) => r.heading), ["a", "b", "c"]);
});

// ── rerankResults(fake chatJson)──
test("rerankResults:LLM 返 ranking → 重排;抛错/无 ranking → 原序前 topN(优雅退化)", async () => {
  const list = [R("a"), R("b"), R("c")];
  const okChat = async () => ({ ranking: [2, 3, 1] });
  assert.deepEqual((await rerankResults("q", list, { chatJson: okChat, topN: 3 })).map((r) => r.heading), ["b", "c", "a"]);
  // LLM 抛 → 原序
  const throwChat = async () => { throw new Error("ollama down"); };
  assert.deepEqual((await rerankResults("q", list, { chatJson: throwChat, topN: 2 })).map((r) => r.heading), ["a", "b"]);
  // 无 ranking 字段 → 原序
  const badChat = async () => ({ nope: true });
  assert.deepEqual((await rerankResults("q", list, { chatJson: badChat, topN: 3 })).map((r) => r.heading), ["a", "b", "c"]);
  // 单条/空 → 直接返回(不调 LLM)
  assert.equal((await rerankResults("q", [R("a")], { chatJson: throwChat })).length, 1);
});

// ── hybridSearchOverIndex 默认关零回归 ──
test("hybridSearchOverIndex:rerank===false → 不 rerank(默认关,结果不带 reranked 标志)", async () => {
  // 合成索引 + 词法路径(不需 ollama);rerank:false 显式关
  const index = {
    model: "x", builtAt: "t",
    chunks: [
      { id: "1", sourcePath: "deploy.md", heading: "部署", text: "用 launchctl kickstart 重启网关 端口 18789", hash: "h1" },
      { id: "2", sourcePath: "rag.md", heading: "检索", text: "hybrid 向量 cosine 词法 BM25 RRF", hash: "h2" },
    ],
  };
  const r = await hybridSearchOverIndex("重启网关 端口", index, { topK: 2, rerank: false });
  assert.equal(r.ok, true);
  assert.equal(r.reranked, undefined, "默认关 → 无 reranked 标志");
  assert.ok(r.results.length >= 1);
});
