/**
 * knowledge-eval-ghost.test.js — Phase 5 v153:ghostHitRate + asOf 点时评测 + undecided 弃权
 *
 * 全用 fake searchFn(无 ollama,确定式)。验证 evaluateWikiRagRecall 的三个扩展皆可选、向后兼容:
 * recall@k 对幽灵结论失明 → ghostHitRate 补;undecided 不计入 recall;case.asOf 透传给 searchFn。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateWikiRagRecall } from "../lib/operator/wiki-rag-eval.js";
import { normalizeKnowledgeEvalSet } from "../lib/operator/knowledge-eval-registry.js";

// fake searchFn:按 query 返回固定路径;记录收到的 asOf。
function fakeSearch(byQuery, captured = {}) {
  return async (query, { topK, asOf } = {}) => {
    captured[query] = asOf ?? null;
    return { ok: true, results: (byQuery[query] || []).map((p) => ({ sourcePath: p })) };
  };
}

test("向后兼容:无新字段 → ghostHitRate=null,abstained=0,recall 不变", async () => {
  const r = await evaluateWikiRagRecall(
    [{ query: "q1", expectedSourcePath: "a.md" }, { query: "q2", expectedSourcePath: "b.md" }],
    fakeSearch({ q1: ["a.md", "x.md"], q2: ["y.md", "b.md"] }),
    { ks: [1, 3], topK: 5 },
  );
  assert.equal(r.ghostHitRate, null);
  assert.equal(r.abstained, 0);
  assert.equal(r.evaluated, 2);
  assert.equal(r.recallAt[1], 0.5); // q1@0 命中,q2@1 不在 top1
  assert.equal(r.recallAt[3], 1);
});

test("ghostHitRate:有 ghost 标注的 case,幽灵进 top-k → 计入(越低越好)", async () => {
  const r = await evaluateWikiRagRecall([
    { query: "q1", expectedSourcePath: "a.md", ghostSourcePaths: ["ghost1.md"] }, // ghost 在结果 → 命中
    { query: "q2", expectedSourcePath: "b.md", ghostSourcePaths: ["ghost2.md"] }, // ghost 不在 → 不命中
  ], fakeSearch({ q1: ["a.md", "ghost1.md"], q2: ["b.md", "other.md"] }), { ks: [1, 3], topK: 5 });
  assert.equal(r.ghostEvaluated, 2);
  assert.equal(r.ghostHitRate, 0.5); // 2 个里 1 个幽灵命中
  // recall 不受 ghost 影响(expected 都在 top)
  assert.equal(r.recallAt[3], 1);
});

test("undecided:不计入 recall 分母,单独报 abstained", async () => {
  const r = await evaluateWikiRagRecall([
    { query: "q1", expectedSourcePath: "a.md" },                          // 命中
    { query: "q2", expectedSourcePath: "b.md" },                          // 不命中
    { query: "q3", expectedSourcePath: "c.md", verdictStatus: "undecided" }, // 排除
  ], fakeSearch({ q1: ["a.md"], q2: ["z.md"], q3: ["c.md"] }), { ks: [1], topK: 5 });
  assert.equal(r.total, 3);
  assert.equal(r.evaluated, 2);
  assert.equal(r.abstained, 1);
  assert.equal(r.recallAt[1], 0.5); // 2 个 scored 里 1 命中(q3 即便命中也不算)
});

test("asOf:case 的 asOf 透传给 searchFn(点时评测)", async () => {
  const captured = {};
  await evaluateWikiRagRecall(
    [{ query: "q1", expectedSourcePath: "a.md", asOf: "2026-01-01" }, { query: "q2", expectedSourcePath: "b.md" }],
    fakeSearch({ q1: ["a.md"], q2: ["b.md"] }, captured),
    { ks: [1], topK: 5 },
  );
  assert.equal(captured.q1, "2026-01-01");
  assert.equal(captured.q2, null); // 未声明 → null
});

test("normalizeKnowledgeEvalSet:case 携带 asOf/verdictStatus/ghostSourcePaths(非法 verdict→null)", () => {
  const set = normalizeKnowledgeEvalSet({
    kbId: "k", evalSetId: "e",
    cases: [
      { query: "q1", expectedSourcePath: "a.md", asOf: "2026-01-01", verdictStatus: "resolved_wrong", ghostSourcePaths: ["g.md", ""] },
      { query: "q2", expectedSourcePath: "b.md", verdictStatus: "BOGUS" }, // 非法 → null
    ],
  });
  assert.equal(set.cases[0].asOf, "2026-01-01");
  assert.equal(set.cases[0].verdictStatus, "resolved_wrong");
  assert.deepEqual(set.cases[0].ghostSourcePaths, ["g.md"]); // 空串剔除
  assert.equal(set.cases[1].verdictStatus, null);
  assert.deepEqual(set.cases[1].ghostSourcePaths, []);
});
