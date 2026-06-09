/**
 * wiki-rag-faithfulness.test.js — 122 P1-3:生成侧评测(faithfulness / context-precision)
 *
 * judgeFn 注入边界 → 用 fake judge 确定式进 gate(不碰真 LLM,避免冷加载超时)。
 * parseJudgeJson 防御式解析(<think>/代码围栏/截断)单测。live 本地 qwen judge 走单独 smoke,不入 gate。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateFaithfulness, evaluateContextPrecision } from "../lib/operator/wiki-rag-eval.js";
import { parseJudgeJson } from "../lib/operator/wiki-rag-judge.js";

function fakeSearch(ctxByQuery) {
  return async (q) => ({ ok: true, results: (ctxByQuery[q] || []).map((t) => ({ sourcePath: "x.md", text: t })) });
}

// ── faithfulness ──
test("evaluateFaithfulness:答案被 context 支撑→faithful;未支撑→不;聚合率正确", async () => {
  const faithJudge = async ({ context, answer }) => ({ supported: context.some((c) => c.includes(answer)) });
  const r = await evaluateFaithfulness(
    [
      { query: "q1", answer: "200" }, // context 含 "200" → supported
      { query: "q2", answer: "999" }, // context 无 "999" → 不支撑
      { query: "q3" },                 // 无 answer → 被过滤(不进 perCase)
    ],
    fakeSearch({ q1: ["目标价 200"], q2: ["目标价 200"], q3: ["x"] }),
    faithJudge,
    { topK: 3, votes: 1 },
  );
  assert.equal(r.total, 2, "无 answer 的 case 被过滤");
  assert.equal(r.faithfulness, 0.5);
  assert.equal(r.perCase.find((p) => p.query === "q1").faithful, true);
  assert.equal(r.perCase.find((p) => p.query === "q2").faithful, false);
});

test("evaluateFaithfulness:多票严格多数(2/3 supported → faithful)", async () => {
  let n = 0;
  const votingJudge = async () => ({ supported: (n++ % 3) !== 2 }); // 每 3 票: true,true,false
  const r = await evaluateFaithfulness(
    [{ query: "q1", answer: "a" }],
    fakeSearch({ q1: ["ctx"] }),
    votingJudge,
    { topK: 1, votes: 3 },
  );
  assert.equal(r.perCase[0].votes, 3);
  assert.equal(r.perCase[0].supportedCount, 2);
  assert.equal(r.perCase[0].faithful, true); // 2*2 > 3
});

// ── context precision ──
test("evaluateContextPrecision:相关 chunk / 召回总数,跨 case 均值", async () => {
  const relJudge = async ({ chunk }) => ({ relevant: chunk.includes("rel") });
  const r = await evaluateContextPrecision(
    [{ query: "q1" }],
    fakeSearch({ q1: ["rel-1", "noise", "rel-2"] }),
    relJudge,
    { topK: 3 },
  );
  assert.equal(r.perCase[0].retrieved, 3);
  assert.equal(r.perCase[0].relevant, 2);
  assert.ok(Math.abs(r.contextPrecision - 2 / 3) < 1e-9);
});

// ── 防御式 JSON 解析 ──
test("parseJudgeJson:干净/<think>包裹/代码围栏/截断兜底/垃圾→null", () => {
  assert.deepEqual(parseJudgeJson('{"supported":true}'), { supported: true });
  assert.deepEqual(parseJudgeJson('<think>我想想…</think>{"supported":false}'), { supported: false });
  assert.deepEqual(parseJudgeJson('```json\n{"relevant":true}\n```'), { relevant: true });
  assert.deepEqual(parseJudgeJson('{"supported":true'), { supported: true }); // 截断补 }
  assert.equal(parseJudgeJson("没有 json"), null);
  assert.equal(parseJudgeJson(""), null);
});
