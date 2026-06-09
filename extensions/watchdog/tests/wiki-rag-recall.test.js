/**
 * wiki-rag-recall.test.js — wiki-RAG 召回率评测
 *
 * 两部分:
 *  ① 确定性单测(总跑,进 gate): fake searchFn 验 evaluateWikiRagRecall 的 recall@k / MRR / 命中数学。
 *  ② live 评测(无 ollama 则 skip,复用 wiki-rag-store.test 的 embedText probe 模式):
 *     真 searchWiki 跑 24 例评测集,打印 recall 报告,断言 hybrid 回归地板(recall@10>=0.85 / @5>=0.65 / MRR>=0.5)
 *     + 查询改写救回填充词重的查询。
 *
 * 实测基线: 纯向量(v140)recall@1≈29% @5≈58% @10≈71% MRR≈0.41;
 *           HYBRID(v142,向量+词法 RRF,默认)recall@1≈42% @5≈79% @10≈96% MRR≈0.60。
 * searchWiki 现为 hybrid,故地板按 hybrid 基线抬高。地板低于基线=只抓真回归(如 RAG 挂了→归零),
 * 不因 embedding 抖动 flaky(同模型同文本→同向量 + 词法确定)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { evaluateWikiRagRecall, formatRecallReport } from "../lib/operator/wiki-rag-eval.js";
import { searchWiki } from "../lib/operator/wiki-rag-search.js";
import { embedText } from "../lib/operator/wiki-rag-embed.js";

let ollamaUp = false;
try {
  await embedText("probe", {});
  ollamaUp = true;
} catch {
  ollamaUp = false;
}

// ── ① 确定性数学单测(无 ollama 依赖)──────────────────────────────────────────

test("evaluateWikiRagRecall：recall@k / MRR / 命中数学正确", async () => {
  const cases = [
    { query: "qA", expectedSourcePath: "a.md", category: "x" },
    { query: "qB", expectedSourcePath: "b.md", category: "x" },
    { query: "qC", expectedSourcePath: "c.md", category: "y" },
    { query: "qD", expectedSourcePath: "d.md", category: "y" },
  ];
  const fake = {
    qA: ["a.md", "z.md"],                       // rank 0
    qB: ["z.md", "y.md", "b.md"],               // rank 2
    qC: ["z.md", "y.md"],                       // miss
    qD: ["z.md", "y.md", "w.md", "v.md", "d.md"], // rank 4
  };
  const searchFn = async (q) => ({ ok: true, results: (fake[q] || []).map((sp) => ({ sourcePath: sp })) });
  const r = await evaluateWikiRagRecall(cases, searchFn, { ks: [1, 3, 5, 10], topK: 10 });

  assert.equal(r.total, 4);
  assert.equal(r.recallAt[1], 0.25, "只有 A 在 rank0 → recall@1=1/4");
  assert.equal(r.recallAt[3], 0.5, "A(0)+B(2) → recall@3=2/4");
  assert.equal(r.recallAt[5], 0.75, "A+B+D(4) → recall@5=3/4");
  assert.equal(r.recallAt[10], 0.75, "C 永远 miss → 上限 3/4");
  // MRR = (1/1 + 1/3 + 0 + 1/5)/4
  assert.ok(Math.abs(r.mrr - (1 + 1 / 3 + 0 + 1 / 5) / 4) < 1e-9, "MRR 数学");
  // 命中标记
  assert.equal(r.perCase.find((p) => p.query === "qC").hit, false);
  assert.equal(r.perCase.find((p) => p.query === "qA").rank, 0);
});

test("evaluateWikiRagRecall：searchFn 返回 ok:false(降级)→ 该例 0 命中,不抛", async () => {
  const cases = [{ query: "q", expectedSourcePath: "a.md" }];
  const r = await evaluateWikiRagRecall(cases, async () => ({ ok: false, degraded: true, results: [] }), { topK: 10 });
  assert.equal(r.recallAt[10], 0);
  assert.equal(r.perCase[0].hit, false);
});

// ── ② live 评测(无 ollama → skip)──────────────────────────────────────────────

test("live: wiki-RAG recall over eval set (skip if ollama down)", { skip: !ollamaUp }, async () => {
  const fx = JSON.parse(await readFile(new URL("./fixtures/wiki-rag-eval-set.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(fx.cases) && fx.cases.length >= 20, "评测集应≥20 例");

  const r = await evaluateWikiRagRecall(fx.cases, searchWiki, { topK: fx.topK || 10 });
  // 打印报告(运行 RAG 严格度的可见度量)。
  console.log("\n" + formatRecallReport(r) + "\n");

  // 回归地板(按 hybrid 基线 recall@10≈96%/@5≈79%/MRR≈0.60 抬高,留余量只抓真回归):
  assert.ok(r.recallAt[10] >= 0.85, `recall@10=${(r.recallAt[10] * 100).toFixed(1)}% 应≥85%(hybrid 回归地板)`);
  assert.ok(r.recallAt[5] >= 0.65, `recall@5=${(r.recallAt[5] * 100).toFixed(1)}% 应≥65%`);
  assert.ok(r.mrr >= 0.5, `MRR=${r.mrr.toFixed(3)} 应≥0.50`);
});

// 查询改写救回:填充词重的查询(此前 miss)经 searchWiki 内置改写 → 命中(skip if ollama down)。
test("live: 查询改写救回填充词重的查询(harness 落空查询 → top-5)", { skip: !ollamaUp }, async () => {
  const r = await searchWiki("我想知道 harness 的四种模块是什么", { topK: 5 });
  assert.equal(r.ok, true);
  const hit = r.results.some((x) => x.sourcePath === "concepts/harness.md");
  assert.ok(hit, `改写后 harness.md 应进 top-5,实际: ${r.results.map((x) => x.sourcePath).join(", ")}`);
});
