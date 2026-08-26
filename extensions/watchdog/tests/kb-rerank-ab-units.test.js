/**
 * kb-rerank-ab-units.test.js — rerank A/B 测量台的纯函数 + rerankResults 默认等价冻结锚点。
 *
 * 覆盖三件事:
 * ① 池内救回判定 classifyRerankOutcome / 聚合 rescueSummary(18.5pp 空间兑现率的判定核心);
 * ② 断点续跑清单 pendingQueries + 状态指纹 fingerprintMatches;
 * ③ rerankResults 新增 maxCandidates 注入后的**默认等价证明**:默认调用(省略 maxCandidates)的
 *    候选截断/重排/退化行为全部冻成手工推导的字面量 —— 24 上限(prompt 只到 [24])、applyRanking
 *    的重排+补回+topN、失败退化原序 —— 与既往行为逐字节一致。锚点是第三方字面量而非两路互比,
 *    任何一边漂移都会红。宽集注入(maxCandidates=池全量)则 30 候选全数进入 prompt、全数返回。
 *
 * 【锚点的手工推导】30 个候选 c1..c30,默认档 list = 前 24 个(wiki-rag-rerank.js:52 的
 * MAX_RERANK_CANDIDATES);ranking [24,2,30]:24→c24、2→c2、30→1-based 序号 30 越出 24 候选被忽略
 * (applyRanking:40 的边界检查);LLM 漏的按原序补回(c1,c3,c4,…);topN=5 切 5 →
 * [c24, c2, c1, c3, c4]。失败/空 ranking → 原序前 topN。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRerankOutcome,
  pendingQueries,
  fingerprintMatches,
  rescueSummary,
} from "../scripts/kb-rerank-ab.js";
import { rerankResults } from "../lib/knowledge/wiki-rag-rerank.js";

// ── ① 池内救回判定(关键点③的判定核心)────────────────────────────────────────

test("classifyRerankOutcome:五种结局逐例冻结(rank 口径 0-based,-1=未进 top-K)", () => {
  const CASES = [
    // [输入, 期望结局, 说明]
    [{ goldInPool: false, baseRank: -1, rerankRank: -1 }, "out-of-pool", "池外:重排无从救"],
    [{ goldInPool: true, baseRank: -1, rerankRank: 3 }, "rescued", "池内、基线 miss、rerank 进 top-K = 兑现"],
    [{ goldInPool: true, baseRank: -1, rerankRank: 0 }, "rescued", "救回到 rank0 也是 rescued"],
    [{ goldInPool: true, baseRank: -1, rerankRank: -1 }, "unrescued", "池里有,重排也没救回"],
    [{ goldInPool: true, baseRank: 2, rerankRank: -1 }, "lost", "基线在 top-K、rerank 后掉出 = 伤害"],
    [{ goldInPool: true, baseRank: 2, rerankRank: 0 }, "held", "两臂都在 top-K(名次前移)"],
    [{ goldInPool: true, baseRank: 0, rerankRank: 9 }, "held", "两臂都在 top-K(名次后移仍是 held)"],
  ];
  for (const [input, expected, why] of CASES) {
    assert.equal(classifyRerankOutcome(input), expected, why);
  }
});

test("classifyRerankOutcome:防御边界 —— goldInPool 非 true 一律 out-of-pool;rank 缺失按 miss 计", () => {
  assert.equal(classifyRerankOutcome({}), "out-of-pool");
  assert.equal(classifyRerankOutcome(), "out-of-pool");
  assert.equal(classifyRerankOutcome({ goldInPool: "yes", baseRank: 0, rerankRank: 0 }), "out-of-pool", "只认 goldInPool===true");
  assert.equal(classifyRerankOutcome({ goldInPool: true }), "unrescued", "两 rank 都缺 → 两臂 miss");
  assert.equal(classifyRerankOutcome({ goldInPool: true, baseRank: undefined, rerankRank: 1 }), "rescued");
  assert.equal(classifyRerankOutcome({ goldInPool: true, baseRank: 1.5, rerankRank: 1 }), "rescued", "非整数 rank 按 miss 计");
});

test("rescueSummary:聚合计数逐字段冻结;scored:false 排除;poolOnly=rescued+unrescued", () => {
  const records = [
    { scored: true, goldInPool: true, baseRank: -1, rerankRank: 2 }, // rescued
    { scored: true, goldInPool: true, baseRank: -1, rerankRank: -1 }, // unrescued
    { scored: true, goldInPool: true, baseRank: 1, rerankRank: -1 }, // lost
    { scored: true, goldInPool: true, baseRank: 0, rerankRank: 0 }, // held
    { scored: true, goldInPool: false, baseRank: -1, rerankRank: -1 }, // out-of-pool
    { scored: false, goldInPool: true, baseRank: -1, rerankRank: 0 }, // undecided → 排除
  ];
  assert.deepEqual(rescueSummary(records), {
    scored: 5,
    rescued: 1,
    unrescued: 1,
    lost: 1,
    held: 1,
    outOfPool: 1,
    poolOnly: 2,
    rescueRate: 0.5,
  });
});

test("rescueSummary:空集与缺 scored 键的记录(scored 缺省 = 计分)", () => {
  assert.deepEqual(rescueSummary([]), {
    scored: 0, rescued: 0, unrescued: 0, lost: 0, held: 0, outOfPool: 0, poolOnly: 0, rescueRate: null,
  });
  assert.deepEqual(rescueSummary(null).scored, 0);
  const one = rescueSummary([{ goldInPool: true, baseRank: -1, rerankRank: 1 }]);
  assert.equal(one.scored, 1);
  assert.equal(one.rescued, 1);
  assert.equal(one.rescueRate, 1);
});

// ── ② 断点续跑清单 + 状态指纹(关键点②)──────────────────────────────────────

test("pendingQueries:fixture 序保留,completed 已有的跳过", () => {
  const cases = [{ query: "q1" }, { query: "q2" }, { query: "q3" }];
  assert.deepEqual(pendingQueries(cases, { q2: {} }).map((c) => c.query), ["q1", "q3"]);
  assert.deepEqual(pendingQueries(cases, {}).map((c) => c.query), ["q1", "q2", "q3"]);
  assert.deepEqual(pendingQueries(cases, { q1: {}, q2: {}, q3: {} }), []);
});

test("pendingQueries:防御边界 —— 空 query/缺 query 的 case 剔除;孤儿键与 null completed 无碍", () => {
  assert.deepEqual(pendingQueries([{ query: "" }, { query: "q4" }, {}], {}).map((c) => c.query), ["q4"]);
  assert.deepEqual(pendingQueries([{ query: "q1" }], null).map((c) => c.query), ["q1"]);
  // completed 里 fixture 已删的孤儿键:与清单无关
  assert.deepEqual(
    pendingQueries([{ query: "q1" }, { query: "q2" }, { query: "q3" }], { zombie: {}, q3: {} }).map((c) => c.query),
    ["q1", "q2"],
  );
  assert.deepEqual(pendingQueries(null, {}), []);
});

test("fingerprintMatches:五键逐一比对;多余键忽略;缺臂即失配", () => {
  const fp = { kbId: "memos", chunkCount: 3642, wide: 40, topK: 10, model: "qwen3:8b" };
  assert.equal(fingerprintMatches(fp, { ...fp }), true);
  assert.equal(fingerprintMatches(fp, { ...fp, chunkCount: 3643 }), false, "索引重建 → 另一个世界");
  assert.equal(fingerprintMatches(fp, { ...fp, wide: 80 }), false);
  assert.equal(fingerprintMatches(fp, { ...fp, topK: 5 }), false);
  assert.equal(fingerprintMatches(fp, { ...fp, model: "qwen3:14b" }), false);
  assert.equal(fingerprintMatches(fp, { ...fp, kbId: "wiki" }), false);
  assert.equal(fingerprintMatches(fp, { ...fp, extra: 1 }), true, "指纹外的键与判定无关");
  assert.equal(fingerprintMatches(null, fp), false);
  assert.equal(fingerprintMatches(fp, null), false);
});

// ── ③ rerankResults 默认等价冻结锚点(关键点①的等价证明)─────────────────────

const CANDS = Object.freeze(Array.from({ length: 30 }, (_, i) => ({
  sourcePath: `kb/c${i + 1}.md`,
  heading: `h${i + 1}`,
  text: `text ${i + 1}`,
})));

test("默认档(省略 maxCandidates):候选截到 24、重排+补回+topN 逐字面量等于手工推导锚点", async () => {
  let prompt = null;
  const fake = async (p) => { prompt = p; return { ranking: [24, 2, 30] }; };
  const out = await rerankResults("q", [...CANDS], { topN: 5, chatJson: fake });
  // 手工推导:list=c1..c24;24→c24、2→c2、30 越界忽略;补回 c1,c3,c4,…;切 5。
  assert.deepEqual(
    out.map((r) => r.sourcePath),
    ["kb/c24.md", "kb/c2.md", "kb/c1.md", "kb/c3.md", "kb/c4.md"],
  );
  assert.ok(prompt.includes("[24] h24: text 24"), "第 24 个候选在 prompt 里");
  assert.equal(prompt.includes("[25]"), false, "第 25 个候选被 MAX_RERANK_CANDIDATES 截掉(默认行为如旧)");
});

test("默认档:失败/空 ranking → 原序前 topN(优雅退化路径同样冻结)", async () => {
  const boom = async () => { throw new Error("down"); };
  assert.deepEqual(
    (await rerankResults("q", [...CANDS], { topN: 3, chatJson: boom })).map((r) => r.sourcePath),
    ["kb/c1.md", "kb/c2.md", "kb/c3.md"],
  );
  const empty = async () => ({ ranking: [] });
  assert.deepEqual(
    (await rerankResults("q", [...CANDS], { topN: 2, chatJson: empty })).map((r) => r.sourcePath),
    ["kb/c1.md", "kb/c2.md"],
  );
});

test("宽集注入(maxCandidates=池全量):30 候选全数进入 prompt、全数返回,脚本侧再切 10", async () => {
  let prompt = null;
  const fake = async (p) => { prompt = p; return { ranking: [30, 29] }; };
  const out = await rerankResults("q", [...CANDS], { topN: CANDS.length, maxCandidates: CANDS.length, chatJson: fake });
  assert.equal(out.length, 30, "topN=池全量 → 一个都没被内部 slice 吃掉");
  assert.deepEqual(out.slice(0, 3).map((r) => r.sourcePath), ["kb/c30.md", "kb/c29.md", "kb/c1.md"]);
  assert.equal(out[29].sourcePath, "kb/c28.md", "补回队尾是原序最后一个未被点名的");
  assert.ok(prompt.includes("[25] h25: text 25"), "第 25 个候选进入 prompt(默认档到不了这里)");
  assert.ok(prompt.includes("[30] h30: text 30"), "第 30 个候选进入 prompt");
  // 「返回后再切 10」的测量语义:池尾的 gold 被救进 top-10
  assert.equal(out.slice(0, 10).findIndex((r) => r.sourcePath === "kb/c30.md"), 0);
});

test("maxCandidates 防御值(0/NaN)回落默认 24 上限", async () => {
  for (const maxCandidates of [0, NaN]) {
    let prompt = null;
    const fake = async (p) => { prompt = p; return { ranking: [] }; };
    await rerankResults("q", [...CANDS], { topN: 5, maxCandidates, chatJson: fake });
    assert.ok(prompt.includes("[24]"), `maxCandidates=${String(maxCandidates)} 仍喂到 24`);
    assert.equal(prompt.includes("[25]"), false, `maxCandidates=${String(maxCandidates)} 上限如旧`);
  }
});
