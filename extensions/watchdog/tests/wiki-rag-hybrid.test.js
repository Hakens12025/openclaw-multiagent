/**
 * wiki-rag-hybrid.test.js — hybrid 检索的纯函数组件(无 ollama 依赖,进 gate)
 *
 * 词法 scorer(ASCII token + CJK bigram)+ RRF 融合。live hybrid recall delta 在 wiki-rag-recall.test.js
 * (无 ollama 则 skip)。这里用合成 index 单测组件,确定性。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { searchWikiRagLexical, lexicalTermsForQuery } from "../lib/operator/wiki-rag-store.js";
import { rrfFuse } from "../lib/operator/wiki-rag-search.js";

// ── lexicalTermsForQuery:ASCII 词 + CJK bigram ────────────────────────────────

test("lexicalTermsForQuery：ASCII 整词 + CJK 字符 bigram(中文无空格靠 bigram)", () => {
  const t = lexicalTermsForQuery("harness gate 传送带原则");
  assert.ok(t.asciiTokens.includes("harness"));
  assert.ok(t.asciiTokens.includes("gate"));
  // 传送带原则 → bigram 传送/送带/带原/原则
  assert.ok(t.cjkBigrams.includes("传送"));
  assert.ok(t.cjkBigrams.includes("原则"));
  assert.ok(!t.asciiTokens.includes("a"), "单字符 ASCII 不入(min 2)");
});

// ── searchWikiRagLexical:合成 index,无 ollama ─────────────────────────────────

const INDEX = {
  chunks: [
    { sourcePath: "concepts/conveyor-belt.md", heading: "传送带原则", text: "传送带:inbox/outbox + graph 授权派工,agent 读 inbox 处理写 outbox", vector: [] },
    { sourcePath: "concepts/harness.md", heading: "harness", text: "harness 四种模块 guard collector gate normalizer 质量门控", vector: [] },
    { sourcePath: "concepts/loop.md", heading: "loop", text: "loop 重复派工,LoopSpec maxRounds 收敛", vector: [] },
  ],
};

test("searchWikiRagLexical：ASCII 术语 query → 命中含该词的 chunk", async () => {
  const r = await searchWikiRagLexical("harness gate 模块", { topK: 3, index: INDEX });
  assert.equal(r[0].sourcePath, "concepts/harness.md", "harness/gate → harness.md 居首");
  assert.ok(r.every((x) => x.score > 0), "返回项分 > 0");
});

test("searchWikiRagLexical：中文短语 query → CJK bigram 命中", async () => {
  const r = await searchWikiRagLexical("传送带 inbox 派工", { topK: 3, index: INDEX });
  assert.equal(r[0].sourcePath, "concepts/conveyor-belt.md", "传送带/inbox → conveyor-belt.md 居首");
});

test("searchWikiRagLexical：无匹配词 → 空(不返噪声)", async () => {
  const r = await searchWikiRagLexical("xyzzy 完全不相关 qwerty", { topK: 3, index: INDEX });
  assert.equal(r.length, 0);
});

test("searchWikiRagLexical：输出形状 {sourcePath,heading,text,score}(与向量一致)", async () => {
  const r = await searchWikiRagLexical("loop maxRounds", { topK: 1, index: INDEX });
  assert.equal(r[0].sourcePath, "concepts/loop.md");
  assert.ok("heading" in r[0] && "text" in r[0] && "score" in r[0]);
});

// ── rrfFuse:Reciprocal Rank Fusion ────────────────────────────────────────────

const mk = (sp) => ({ sourcePath: sp, heading: "h", text: "" });

test("rrfFuse：两表都出现的文档 > 单表文档(名次融合)", () => {
  const vec = [mk("A"), mk("B"), mk("C")]; // A rank0
  const lex = [mk("B"), mk("D"), mk("A")]; // B rank0
  const fused = rrfFuse([vec, lex], { topK: 4 });
  const order = fused.map((f) => f.sourcePath);
  // A(在两表) + B(在两表) 应排在 C/D(各仅一表)之前
  assert.ok(order.indexOf("A") < order.indexOf("C"), "A(双表) > C(单表)");
  assert.ok(order.indexOf("B") < order.indexOf("D"), "B(双表) > D(单表)");
  assert.equal(fused.length, 4, "A/B/C/D 去重后 4 个");
});

test("rrfFuse：按 sourcePath#heading 去重(同 path 不同 heading 算两条)", () => {
  const a1 = { sourcePath: "x.md", heading: "一", text: "" };
  const a2 = { sourcePath: "x.md", heading: "二", text: "" };
  const fused = rrfFuse([[a1, a2], [a2]], { topK: 5 });
  assert.equal(fused.length, 2, "x.md#一 与 x.md#二 是两条");
  assert.equal(fused[0].heading, "二", "x.md#二 出现两次 → RRF 分更高居首");
});

test("rrfFuse：空表/null 安全(不抛)", () => {
  assert.deepEqual(rrfFuse([[], null], { topK: 3 }), []);
  assert.deepEqual(rrfFuse([], { topK: 3 }), []);
});

// ── 查询改写 rewriteQuery(纯函数,进 gate)──────────────────────────────────────
import { rewriteQuery } from "../lib/operator/wiki-rag-search.js";

test("rewriteQuery：剥离中文填充词,保留真术语", () => {
  assert.equal(rewriteQuery("我想知道 harness 的四种模块是什么"), "harness 四种模块");
  assert.equal(rewriteQuery("什么是传送带原则"), "传送带原则");
  assert.equal(rewriteQuery("请问 operator 怎么样"), "operator");
});

test("rewriteQuery：保护 WHY 意图(为什么/为何不被 是什么/什么是 误伤)", () => {
  // '为什么是 X' 不能被剥成 '为 X'
  const r = rewriteQuery("为什么决定让 graph 作为运行时真值");
  assert.ok(r.includes("为什么"), "为什么 应保留(WHY 语料携带决策意图)");
  assert.ok(r.includes("graph"));
});

test("rewriteQuery：全填充词 → 回退原文(不清空)", () => {
  const orig = "是什么";
  assert.equal(rewriteQuery(orig), orig, "改写后 <2 字符 → 回退原文,不返空");
});
