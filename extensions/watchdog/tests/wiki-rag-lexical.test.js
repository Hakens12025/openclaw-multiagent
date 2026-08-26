/**
 * wiki-rag-lexical.test.js — 词法打分内核四档模式(全纯,零 ollama,零索引)
 *
 * 第一顺位要证的事:**默认档与今天逐字节等价**。证法有两层,缺一不可:
 *   ① 硬编码期望值([8,4,3,0] 等整数)—— 冻结"今天"的具体数字,自比自恒真的对照进不来;
 *   ② 再与生产函数 searchWikiRagLexical(wiki-rag-store.js:517)跑同一份合成索引对拍。
 * 只有 ① 没 ② 时,期望值可能一开始就抄错;只有 ② 没 ① 时,两边一起漂移测不出来。
 *
 * 其余档位的期望值来自**独立复写公式**的一次性推导(不 import 本模块),浮点用 1e-12 容差;
 * 档位之间的消融恒等式(tf=1 → idf-tf ≡ idf;b=0 → bm25 ≡ idf-tf)可以逐位相等,直接精确断言。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { lexicalTermsForQuery, searchWikiRagLexical } from "../lib/knowledge/wiki-rag-store.js";
import {
  buildLexicalScorer,
  resolveLexicalScoringMode,
  LEXICAL_SCORING_MODES,
  DEFAULT_LEXICAL_SCORING_MODE,
  DEFAULT_BM25_K1,
  DEFAULT_BM25_B,
} from "../lib/knowledge/wiki-rag-lexical.js";

const closeTo = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) <= 1e-12, `${msg || ""} 实得 ${actual} 期望 ${expected}`);

// ── fixture 1:主查询 ─────────────────────────────────────────────────────────
// 手算依据(query "harness gate 传送带" → ascii ["harness","gate"] + bigram ["传送","送带"]):
//   harness.md  hay 含 harness(词长≥4 → 3;heading 也含 → +2)+ gate(词长 4 → 3;heading 不含)= 8
//   conveyor-belt.md  传送(1 + heading 含 → +1)+ 送带(1 + heading 含 → +1)= 4
//   loop.md     harness(3;heading "loop" 不含 → +0)= 3
//   other.md    一个词项都不命中 = 0
const CHUNKS = [
  { sourcePath: "wiki/concepts/harness.md", heading: "harness 模块", text: "harness gate collector normalizer" },
  { sourcePath: "wiki/concepts/conveyor-belt.md", heading: "传送带原则", text: "传送带 是 派工 原语" },
  { sourcePath: "wiki/concepts/loop.md", heading: "loop", text: "loop 重复派工 与 harness 无关" },
  { sourcePath: "wiki/concepts/other.md", heading: "无关页", text: "完全 不 相关 的 内容" },
];
const QUERY = "harness gate 传送带";
const TERMS = lexicalTermsForQuery(QUERY);

const EXISTENCE_EXPECTED = [8, 4, 3, 0];
// df: harness 2(harness.md/loop.md)、gate 1、传送 1、送带 1;N=4 → idf=log(1+N/df)
const IDF_EXPECTED = [10.321375180642848, 6.437751649736401, 3.2958368660043287, 0];
// 反证用:若 IDF 顺手抹掉 heading 加成,harness.md 会是 3*idf(harness)+3*idf(gate)
const IDF_WITHOUT_HEADING_BONUS = 8.12415060330663;

const scoreAll = (scorer, chunks = CHUNKS) => chunks.map(scorer);

// ── 默认档 = 今天 ────────────────────────────────────────────────────────────

test("默认档 existence:分值逐位等于硬编码的今日期望", () => {
  assert.deepEqual(scoreAll(buildLexicalScorer(TERMS, CHUNKS)), EXISTENCE_EXPECTED);
});

test("默认档 existence:与生产 searchWikiRagLexical 对拍,同块同分", async () => {
  const produced = await searchWikiRagLexical(QUERY, { topK: 10, index: { chunks: CHUNKS } });
  const scorer = buildLexicalScorer(TERMS, CHUNKS);
  // 生产侧带 score>0 召回闸,零分块不出现 → 只比对出现的块
  assert.equal(produced.length, 3, "前提:生产侧滤掉了 other.md");
  for (const row of produced) {
    const chunk = CHUNKS.find((c) => c.sourcePath === row.sourcePath);
    assert.equal(scorer(chunk), row.score, `${row.sourcePath} 与生产分值一致`);
  }
  // 顺带确认硬编码期望确实就是生产真值(两层证据在这里合拢)
  assert.deepEqual(produced.map((r) => r.score), [8, 4, 3]);
});

test("默认档三种写法(省略 options / mode:undefined / 显式 existence)同分", () => {
  const omitted = scoreAll(buildLexicalScorer(TERMS, CHUNKS));
  const undef = scoreAll(buildLexicalScorer(TERMS, CHUNKS, { mode: undefined }));
  const explicit = scoreAll(buildLexicalScorer(TERMS, CHUNKS, { mode: DEFAULT_LEXICAL_SCORING_MODE }));
  assert.deepEqual(omitted, EXISTENCE_EXPECTED);
  assert.deepEqual(undef, EXISTENCE_EXPECTED);
  assert.deepEqual(explicit, EXISTENCE_EXPECTED);
});

test("默认档不读候选集:候选集里埋雷也照常打分(统计遍开销与今天一致)", () => {
  const POISON = [{ heading: "x", get text() { throw new Error("默认档读了候选集"); } }];
  assert.deepEqual(scoreAll(buildLexicalScorer(TERMS, POISON)), EXISTENCE_EXPECTED);
  // 反证雷是真的:idf 档要扫候选集,必然踩爆
  assert.throws(() => buildLexicalScorer(TERMS, POISON, { mode: "idf" }), /默认档读了候选集/);
});

// ── 档位表与非法档位名 ───────────────────────────────────────────────────────

test("模式表:四档齐全、null 原型、冻结,默认档在表内", () => {
  assert.deepEqual(Object.keys(LEXICAL_SCORING_MODES).sort(), ["bm25", "existence", "idf", "idf-tf"]);
  assert.equal(Object.getPrototypeOf(LEXICAL_SCORING_MODES), null, "null 原型 → 表本身取不到原型成员");
  assert.equal(LEXICAL_SCORING_MODES.constructor, undefined);
  assert.ok(Object.isFrozen(LEXICAL_SCORING_MODES));
  assert.ok(Object.hasOwn(LEXICAL_SCORING_MODES, DEFAULT_LEXICAL_SCORING_MODE), "默认档常量必须是表里的真档位");
});

test("非法档位名(constructor/__proto__/未知/非字符串)回落默认档,分值仍是今日期望", () => {
  for (const bogus of ["constructor", "__proto__", "toString", "valueOf", "BM25", "", null, 7, {}]) {
    assert.equal(resolveLexicalScoringMode(bogus), DEFAULT_LEXICAL_SCORING_MODE, `档位名 ${String(bogus)}`);
    const scores = scoreAll(buildLexicalScorer(TERMS, CHUNKS, { mode: bogus }));
    assert.ok(scores.every(Number.isFinite), `档位名 ${String(bogus)} 产生了 NaN → 会被召回闸清空`);
    assert.deepEqual(scores, EXISTENCE_EXPECTED, `档位名 ${String(bogus)} 未回落到默认档`);
  }
});

// ── idf 档 ───────────────────────────────────────────────────────────────────

test("idf 档:分值等于独立推导的期望,且结构权重(词长 + 标题加成)原样保留", () => {
  const scores = scoreAll(buildLexicalScorer(TERMS, CHUNKS, { mode: "idf" }));
  scores.forEach((s, i) => closeTo(s, IDF_EXPECTED[i], CHUNKS[i].sourcePath));
  // 若 IDF 把 heading 加成吃掉,harness.md 会掉到 8.124…;差值远大于容差 → 加成确实还在
  assert.ok(Math.abs(scores[0] - IDF_WITHOUT_HEADING_BONUS) > 1, "heading 加成被 IDF 改造掉了");
  // 稀有词 gate(df=1)权重高于常见词 harness(df=2):同为词长≥4,单位结构权重下 IDF 拉开差距
  assert.ok(scores[1] > scores[2], "两个 bigram 的稀有词 > loop.md 的单个常见词");
});

test("idf 严格为正:全库共有词仍贡献正分,过得了 score>0 召回闸", () => {
  const COMMON = ["一", "二", "三", "四"].map((n, i) => ({
    sourcePath: `kb/${i}.md`, heading: `H${i}`, text: `openclaw ${n}号`,
  }));
  const terms = lexicalTermsForQuery("openclaw");
  const scores = scoreAll(buildLexicalScorer(terms, COMMON, { mode: "idf" }), COMMON);
  // df=N=4 → idf=log(1+4/4)=log2;结构权重 3(词长≥4,heading 不含)→ 3*log2
  scores.forEach((s) => closeTo(s, 3 * Math.log(2), "全库共有词"));
  assert.equal(scores.filter((s) => s > 0).length, 4, "召回闸 .filter(score>0) 会留下全部 4 块");
  // 被否掉的两支在同一处境下的取值,写死在这里当回归护栏
  assert.equal(Math.log(4 / 4), 0, "log(N/df) 在 df=N 时归零 → 召回闸会删光");
  assert.ok(Math.log((4 - 4 + 0.5) / (4 + 0.5)) < 0, "经典 BM25 IDF 在 df=N 时为负 → 命中反成惩罚");
});

// ── idf-tf 档 ────────────────────────────────────────────────────────────────
// fixture 2:p.md 里 alpha 出现 3 次,q.md 出现 1 次,其余完全对称。
// existence 与 idf 都判两块同分(存在性看不出"提了 3 次"),tf 档才把它们拉开。
const TF_CHUNKS = [
  { sourcePath: "kb/p.md", heading: "P页", text: "alpha alpha alpha beta" },
  { sourcePath: "kb/q.md", heading: "Q页", text: "alpha beta" },
];
const TF_TERMS = lexicalTermsForQuery("alpha beta");
const TF_IDF_EXPECTED = [4.1588830833596715, 4.1588830833596715];      // 3*log2 + 3*log2,两块同分
const TF_IDFTF_EXPECTED = [5.347135392891007, 4.1588830833596715];     // k1=1.2:tf=3 抬起 p,tf=1 的 q 不变
const TF_BM25_EXPECTED = [5.158842984505778, 4.385502343199654];       // b=0.3:长块(25 字符)压、短块(13)抬

test("idf-tf:tf=1 的块与 idf 档逐位相同(饱和因子在 tf=1 归一)", () => {
  const idf = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "idf" }), TF_CHUNKS);
  const idfTf = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "idf-tf" }), TF_CHUNKS);
  idf.forEach((s, i) => closeTo(s, TF_IDF_EXPECTED[i], "idf 档"));
  idfTf.forEach((s, i) => closeTo(s, TF_IDFTF_EXPECTED[i], "idf-tf 档"));
  assert.equal(idfTf[1], idf[1], "q.md 每词只出现一次 → 两档逐位相等");
  assert.equal(idf[0], idf[1], "前提:idf 档判这两块同分,tf 才是唯一变量");
  assert.ok(idfTf[0] > idfTf[1], "alpha 出现 3 次的块被抬到前面");
  // 饱和:3 次命中带来的增益远低于线性 3 倍
  assert.ok(idfTf[0] < idf[0] * 3, "词频饱和,增益不是线性 3 倍");
});

test("idf-tf:词频按非重叠子串计数(CJK 叠字不被放大)", () => {
  const CJK = [{ sourcePath: "kb/cjk.md", heading: "标题", text: "啊啊啊啊" }];
  const terms = lexicalTermsForQuery("啊啊");
  const score = buildLexicalScorer(terms, CJK, { mode: "idf-tf" })(CJK[0]);
  closeTo(score, 0.9530773732699248, "非重叠 tf=2");
  assert.ok(Math.abs(score - 1.0892312837370568) > 1e-6, "重叠计数会记成 tf=3,分值应当不同");
});

// ── bm25 档 ──────────────────────────────────────────────────────────────────

test("bm25:b=0 时与 idf-tf 逐位相同(长度归一的消融)", () => {
  const idfTf = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "idf-tf" }), TF_CHUNKS);
  const noLength = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25", b: 0 }), TF_CHUNKS);
  assert.deepEqual(noLength, idfTf, "b=0 → 归一因子恒为 1 → 两档逐位相等");
});

test("bm25 默认 b:长块降权、短块升权,分值等于独立推导的期望", () => {
  const bm25 = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25" }), TF_CHUNKS);
  bm25.forEach((s, i) => closeTo(s, TF_BM25_EXPECTED[i], "bm25 档"));
  const idfTf = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "idf-tf" }), TF_CHUNKS);
  assert.ok(bm25[0] < idfTf[0], "长块(hay 25 字符 > 均长 19)被压");
  assert.ok(bm25[1] > idfTf[1], "短块(hay 13 字符 < 均长 19)被抬");
  assert.ok(bm25.every((s) => s > 0), "长度归一不会把命中块打到零分以下");
});

// ── 参数防御 ────────────────────────────────────────────────────────────────

test("k1/b 取到非法值时回落到导出的默认常量,不产 NaN", () => {
  const good = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25", k1: DEFAULT_BM25_K1, b: DEFAULT_BM25_B }), TF_CHUNKS);
  for (const bad of [
    { k1: NaN, b: NaN }, { k1: null, b: null }, { k1: "abc", b: "" },
    { k1: 0, b: -0.5 }, { k1: -3, b: 1.5 }, { k1: Infinity, b: Infinity }, { k1: [], b: {} },
  ]) {
    const scores = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25", ...bad }), TF_CHUNKS);
    assert.ok(scores.every(Number.isFinite), `参数 ${JSON.stringify(bad)} 产生了 NaN/Infinity`);
    assert.deepEqual(scores, good, `参数 ${JSON.stringify(bad)} 未回落到默认常量`);
  }
});

test("k1/b 接受合法数值与数字字符串,且真的改变分值", () => {
  const base = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25" }), TF_CHUNKS);
  const numeric = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25", k1: 0.5, b: 0.9 }), TF_CHUNKS);
  const stringy = scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25", k1: "0.5", b: "0.9" }), TF_CHUNKS);
  assert.deepEqual(stringy, numeric, "配置里的数字字符串与数字等价");
  assert.notDeepEqual(numeric, base, "换参数应当换分值");
  assert.ok(numeric.every(Number.isFinite));
  // b=1 是合法边界(完全按长度比归一)
  assert.ok(scoreAll(buildLexicalScorer(TF_TERMS, TF_CHUNKS, { mode: "bm25", b: 1 }), TF_CHUNKS).every(Number.isFinite));
});

// ── 退化输入 ────────────────────────────────────────────────────────────────

test("退化输入:空候选集 / 空词项 / 缺字段块,四档都不抛、不产 NaN", () => {
  for (const mode of Object.keys(LEXICAL_SCORING_MODES)) {
    // 候选集为空或不是数组:统计遍拿不到语料,分值仍须有限且非负(idf 档靠 N 下限 1 保住正分)
    for (const chunks of [[], null, undefined, "not-an-array"]) {
      const score = buildLexicalScorer(TERMS, chunks, { mode })(CHUNKS[0]);
      assert.ok(Number.isFinite(score), `${mode} 档在候选集 ${String(chunks)} 下产生了 NaN`);
      assert.ok(score > 0, `${mode} 档命中块被打到零分 → 召回闸会静默删掉它`);
    }
    // 词项为空 / 形状不对 → 0 分(与今天 searchWikiRagLexical:521 的早退语义一致)
    for (const terms of [{ asciiTokens: [], cjkBigrams: [] }, {}, null, undefined]) {
      assert.equal(buildLexicalScorer(terms, CHUNKS, { mode })(CHUNKS[0]), 0, `${mode} 档空词项应当 0 分`);
    }
    // 块缺字段 / 不是对象
    for (const chunk of [{}, { text: null, heading: null }, null, undefined]) {
      const score = buildLexicalScorer(TERMS, CHUNKS, { mode })(chunk);
      assert.equal(score, 0, `${mode} 档空块应当 0 分`);
    }
  }
});

test("同一个 scorer 可重复调用,结果稳定(纯函数,无内部状态漂移)", () => {
  for (const mode of Object.keys(LEXICAL_SCORING_MODES)) {
    const scorer = buildLexicalScorer(TERMS, CHUNKS, { mode });
    assert.deepEqual(scoreAll(scorer), scoreAll(scorer), `${mode} 档两次调用应当同值`);
  }
});
