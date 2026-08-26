/**
 * knowledge-eval-pairing.test.js — 评测"可配对"三件套(全 fake searchFn,零 ollama、零索引)
 *
 * ① perCase 落盘形状:runKnowledgeEval 的摘要必须带 {query,rank,hit},否则两次 run 只剩聚合
 *    百分比可比,配对检验算不出来。用一个不存在的 kbId → searchKb 直接 ok:false 返回(不碰 ollama)。
 * ② diffRecallRanks:降级/升级判定,重点是 rank=-1 的序(未命中最差),别把 hit→miss 漏报。
 * ③ keywordCoverage:expectedKeywords 接上后的正交指标,且不得改动 recall/MRR。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateWikiRagRecall, diffRecallRanks, formatRecallReport } from "../lib/knowledge/wiki-rag-eval.js";
import { saveKnowledgeEvalSet, deleteKnowledgeEvalSet } from "../lib/knowledge/knowledge-eval-registry.js";
import { runKnowledgeEval, listKnowledgeEvalRuns } from "../lib/knowledge/knowledge-eval-runner.js";

// fake searchFn:按 query 查预置的 [sourcePath, text] 列表。不碰 ollama。
function fakeSearch(table) {
  return async (query) => ({
    ok: true,
    results: (table[query] || []).map(([sourcePath, text = ""]) => ({ sourcePath, text })),
  });
}

// ── ② diffRecallRanks(纯函数)──

test("diffRecallRanks:top-k 内降级(rank0→rank3)被列出,rank 数字如实带出", () => {
  const base = [{ query: "q1", rank: 0, hit: true, expected: "a.md" }];
  const next = [{ query: "q1", rank: 3, hit: true, expected: "a.md" }];
  const d = diffRecallRanks(base, next);
  assert.equal(d.demotions.length, 1);
  assert.equal(d.promotions.length, 0);
  assert.deepEqual(d.demotions[0], { query: "q1", rankBefore: 0, rankAfter: 3, expected: "a.md" });
  assert.equal(d.paired, 1);
});

test("diffRecallRanks:hit→miss 是最严重降级(直接比 2 < -1 会漏报)", () => {
  const d = diffRecallRanks([{ query: "q", rank: 2, hit: true }], [{ query: "q", rank: -1, hit: false }]);
  assert.equal(d.demotions.length, 1);
  assert.equal(d.demotions[0].rankAfter, -1);
  assert.equal(d.promotions.length, 0);
});

test("diffRecallRanks:miss→hit 是升级,不能被 -1 < 3 误判成降级", () => {
  const d = diffRecallRanks([{ query: "q", rank: -1, hit: false }], [{ query: "q", rank: 3, hit: true }]);
  assert.equal(d.demotions.length, 0);
  assert.equal(d.promotions.length, 1);
  assert.equal(d.promotions[0].rankBefore, -1);
});

test("diffRecallRanks:名次不变不算变化;两边都 miss 也不算", () => {
  const d = diffRecallRanks(
    [{ query: "a", rank: 1 }, { query: "b", rank: -1 }],
    [{ query: "a", rank: 1 }, { query: "b", rank: -1 }],
  );
  assert.equal(d.demotions.length, 0);
  assert.equal(d.promotions.length, 0);
  assert.equal(d.paired, 2);
});

test("diffRecallRanks:配不上的 query 记 unpaired,不猜测", () => {
  const d = diffRecallRanks([{ query: "old", rank: 0 }], [{ query: "new", rank: 5 }]);
  assert.equal(d.paired, 0);
  assert.equal(d.unpaired, 1);
  assert.equal(d.demotions.length, 0);
});

test("diffRecallRanks:空基线/非数组 → 零变化,不抛", () => {
  assert.equal(diffRecallRanks([], [{ query: "q", rank: 0 }]).demotions.length, 0);
  assert.equal(diffRecallRanks(null, null).paired, 0);
  assert.equal(diffRecallRanks(undefined, [{ query: "q", rank: 0 }]).unpaired, 1);
});

// ── ② formatRecallReport 的降级段 ──

test("formatRecallReport:不给基线 → 报告不含 baseline 段(向后兼容单参数调用)", async () => {
  const r = await evaluateWikiRagRecall(
    [{ query: "q1", expectedSourcePath: "a.md" }],
    fakeSearch({ q1: [["a.md"], ["b.md"]] }),
    { topK: 10 },
  );
  const text = formatRecallReport(r);
  assert.ok(!text.includes("vs baseline"));
  assert.ok(text.includes("recall@1: 100.0%"));
});

test("formatRecallReport:给了基线 → 打印 top-5 内的降级(此前只打印 rank=-1 的 miss)", async () => {
  // q1 仍在 top-5(rank2),hit=true → misses 段完全看不到它;降级段必须看得到。
  const r = await evaluateWikiRagRecall(
    [{ query: "q1", expectedSourcePath: "a.md" }],
    fakeSearch({ q1: [["x.md"], ["y.md"], ["a.md"]] }),
    { topK: 10 },
  );
  assert.equal(r.perCase[0].hit, true); // 前提:它不是 miss
  const text = formatRecallReport(r, { baselinePerCase: [{ query: "q1", rank: 0, hit: true }] });
  assert.ok(!text.includes("misses ("), "hit 的例子不该出现在 misses 段");
  assert.ok(text.includes("1 demoted"), text);
  assert.ok(text.includes("rank0 → rank2"), text);
});

test("formatRecallReport:hit→miss 的降级显示成 miss 而不是 rank-1", async () => {
  const r = await evaluateWikiRagRecall(
    [{ query: "q1", expectedSourcePath: "a.md" }],
    fakeSearch({ q1: [["x.md"]] }),
    { topK: 10 },
  );
  const text = formatRecallReport(r, { baselinePerCase: [{ query: "q1", rank: 0 }] });
  assert.ok(text.includes("rank0 → miss"), text);
});

// ── ③ keywordCoverage ──

test("keywordCoverage:按 case 覆盖率取均值,大小写不敏感,只看 text", async () => {
  const cases = [
    { query: "q1", expectedSourcePath: "a.md", expectedKeywords: ["inbox", "outbox"] }, // 2/2
    { query: "q2", expectedSourcePath: "b.md", expectedKeywords: ["LoopSpec", "缺失词"] }, // 1/2
  ];
  const r = await evaluateWikiRagRecall(cases, fakeSearch({
    q1: [["a.md", "走 INBOX 再写 outbox"]],            // 大小写不同也算命中
    q2: [["b.md", "loopspec 定义重复派工"]],
  }), { topK: 10 });
  assert.equal(r.perCase[0].keywordHits, 2);
  assert.equal(r.perCase[1].keywordHits, 1);
  assert.equal(r.keywordEvaluated, 2);
  assert.equal(r.keywordCoverage, 0.75); // (2/2 + 1/2) / 2
});

test("keywordCoverage:无人标关键词 → null(与 ghostHitRate 同模式),不是 0", async () => {
  const r = await evaluateWikiRagRecall(
    [{ query: "q1", expectedSourcePath: "a.md" }],
    fakeSearch({ q1: [["a.md", "任意正文"]] }),
    { topK: 10 },
  );
  assert.equal(r.keywordCoverage, null);
  assert.equal(r.keywordEvaluated, 0);
  assert.equal(r.perCase[0].keywordTotal, 0);
});

test("keywordCoverage 与 recall 正交:文件对了但段落错了 → recall@1=100% 而覆盖率=0", async () => {
  const r = await evaluateWikiRagRecall(
    [{ query: "q1", expectedSourcePath: "a.md", expectedKeywords: ["claim", "queue"] }],
    fakeSearch({ q1: [["a.md", "这一段讲的是完全无关的内容"]] }),
    { topK: 10 },
  );
  assert.equal(r.recallAt[1], 1);       // recall 对切分错段完全失明
  assert.equal(r.keywordCoverage, 0);   // 覆盖率抓到了
});

test("keywordCoverage 不改动 recall/MRR:同一批 case 加不加 expectedKeywords 结果逐字段相同", async () => {
  const search = fakeSearch({ q1: [["x.md"], ["a.md"]], q2: [["b.md"]] });
  const bare = [
    { query: "q1", expectedSourcePath: "a.md" },
    { query: "q2", expectedSourcePath: "b.md" },
  ];
  const withKw = bare.map((c) => ({ ...c, expectedKeywords: ["无关词"] }));
  const a = await evaluateWikiRagRecall(bare, search, { topK: 10 });
  const b = await evaluateWikiRagRecall(withKw, search, { topK: 10 });
  assert.deepEqual(a.recallAt, b.recallAt);
  assert.equal(a.mrr, b.mrr);
  assert.deepEqual(a.byCategory, b.byCategory);
  assert.equal(a.evaluated, b.evaluated);
});

test("keywordCoverage:undecided 的 case 不计入(与 recall 口径一致)", async () => {
  const r = await evaluateWikiRagRecall([
    { query: "q1", expectedSourcePath: "a.md", expectedKeywords: ["命中词"], verdictStatus: "undecided" },
    { query: "q2", expectedSourcePath: "b.md", expectedKeywords: ["缺失词"] },
  ], fakeSearch({ q1: [["a.md", "命中词在此"]], q2: [["b.md", "无"]] }), { topK: 10 });
  assert.equal(r.keywordEvaluated, 1);  // 只算 q2
  assert.equal(r.keywordCoverage, 0);
});

// ── ① perCase 落盘(写 live runs store;kbId 唯一,不碰 ollama)──
// 用不存在的 kbId:searchKb 查不到 spec 直接返回 {ok:false},根本不会走到 embed。

test("runKnowledgeEval:摘要落盘 perCase{query,rank,hit},且第二次 run 能配上基线", async () => {
  const kbId = `evpair-${Date.now()}`;
  const evalSetId = "base";
  try {
    await saveKnowledgeEvalSet({
      kbId, evalSetId, label: "配对形状",
      cases: [
        { query: "q1", expectedSourcePath: "a.md", category: "ops" },
        { query: "q2", expectedSourcePath: "b.md", category: "ops" },
      ],
    });

    const first = await runKnowledgeEval(kbId, evalSetId);
    assert.equal(first.ok, true);
    assert.equal(first.run.degraded, true);          // 无此 KB → 检索降级,但 run 照常完成
    assert.equal(first.baselineRunId, null);         // 首次无基线

    const [stored] = await listKnowledgeEvalRuns({ kbId, evalSetId, limit: 1 });
    assert.ok(Array.isArray(stored.perCase), "摘要必须带 perCase,否则无法配对");
    assert.equal(stored.perCase.length, stored.total);
    assert.deepEqual(Object.keys(stored.perCase[0]).sort(), ["hit", "query", "rank"]);
    assert.deepEqual(stored.perCase.map((p) => p.query), ["q1", "q2"]);
    assert.equal(stored.perCase[0].rank, -1);
    assert.ok(!("topPaths" in stored.perCase[0]), "topPaths 不该落盘(控体积)");

    const second = await runKnowledgeEval(kbId, evalSetId);
    assert.equal(second.baselineRunId, first.run.runId);  // 自动配上一次 run
    assert.deepEqual(second.demotions, []);               // 两次都 miss → 无变化
    assert.deepEqual(second.promotions, []);
  } finally {
    await deleteKnowledgeEvalSet(kbId, evalSetId).catch(() => {});
  }
});
