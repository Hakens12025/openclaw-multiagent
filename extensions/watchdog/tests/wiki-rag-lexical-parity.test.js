/**
 * wiki-rag-lexical-parity.test.js — 词法腿「接线后默认档 ↔ 接线前行为」的等价证明 + 接线断言。
 *
 * 【这份测试要挡住的事】searchWikiRagLexical(wiki-rag-store.js:507)接入
 * buildLexicalScorer(wiki-rag-lexical.js:134)之后,默认行为发生了任何一位的偏移。
 *
 * 【为什么用冻结锚点而非两路互比】"两条路互等"这类断言在两条路一起改坏时依然为真,
 * 它挡住的只有单边漂移。所以本文件把**整行输出**冻成一份字面量 EXPECTED_ROWS(手工推导 + 逐字段写死),
 * 让两条路各自与这个第三方锚点比对:
 *   ① 生产 searchWikiRagLexical(...)  === EXPECTED_ROWS   ← 钉住"接线后的默认档 = 接线前"
 *   ② 独立参考实现(buildLexicalScorer + 同一套闸/序/切) === EXPECTED_ROWS   ← 三角互证
 * 两条各自对锚点成立 ⇒ 彼此等价,且任何一边单独漂移都会红。
 *
 * 【环境隔离】接线后的配置读盘走 OC = $HOME/.openclaw/openclaw.json。本文件在加载任何 lib
 * 模块之前把 HOME 指到临时目录(state-paths.js 在 import 时固化 OC),两个目的:
 *   a) 配置断言与本机 openclaw.json 解耦 —— 主控翻真配置激活 idf 后,本文件依旧绿;
 *   b) 伪配置把 embedBaseUrl 指向无监听端口 → hybrid 的向量腿确定性降级,全程零 ollama 往返。
 *
 * 【锚点的手工推导】query "harness gate 传送带"
 *   → asciiTokens ["harness","gate"]、cjkBigrams ["传送","送带"](lexicalTermsForQuery,store.js:492)
 *   结构权重 ASCII =(词长≥4 ? 3 : 1)+(heading 命中 ? 2 : 0);CJK = 1 +(heading 命中 ? 1 : 0)
 *   a: harness 3+2=5、gate 3、传送 1、送带 1                        → 10
 *   b: 传送 1+1=2、送带 1+1=2                                        → 4
 *   c: harness 3(heading "loop" 无命中)                            → 3
 *   d: gate 3+2=5                                                    → 5
 *   e: 一个词项都无命中                                              → 0(被 score>0 闸排除在外)
 *   f: harness 3                                                     → 3
 *   c(第二节): harness 3                                            → 3
 *   h: text 为 null,hay 退化成 heading;harness 3+2=5                → 5
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 环境隔离(必须先于任何 lib import 生效,故本文件全部 lib import 走动态形式)──
const FAKE_HOME = await mkdtemp(join(tmpdir(), "wiki-rag-parity-home-"));
const FAKE_OC = join(FAKE_HOME, ".openclaw");
await mkdir(FAKE_OC, { recursive: true });
// 端口 1 无监听:fetch 立刻 ECONNREFUSED → embedText 抛 → hybrid 确定性走词法-only 降级。
const DEAD_EMBED = { embedBaseUrl: "http://127.0.0.1:1" };
async function writeFakeConfig(wikiRag = {}) {
  const payload = { watchdog: { wikiRag: { ...DEAD_EMBED, ...wikiRag } } };
  await writeFile(join(FAKE_OC, "openclaw.json"), JSON.stringify(payload), "utf8");
}
await writeFakeConfig(); // 默认伪配置:无 lexicalScoring 键 = 缺省档
process.env.HOME = FAKE_HOME;

const { lexicalTermsForQuery, searchWikiRagLexical } = await import("../lib/knowledge/wiki-rag-store.js");
const { buildLexicalScorer, resolveWikiRagLexicalConfig } = await import("../lib/knowledge/wiki-rag-lexical.js");
const { hybridSearchOverIndex } = await import("../lib/knowledge/wiki-rag-search.js");

after(async () => { await rm(FAKE_HOME, { recursive: true, force: true }); });

// ── fixture ──────────────────────────────────────────────────────────────────
// 覆盖:heading 加成、短/长 ASCII 词、CJK bigram、零命中块、同分并列(跨页 + 同页)、
// text 缺失、meta 有无、索引块上的多余字段(vector/sha 应当被行投影丢弃)。
const CHUNKS = Object.freeze([
  { sourcePath: "kb/a.md", heading: "harness 模块", text: "harness gate 传送带 collector", vector: [0.1, 0.2], sha: "aaa" },
  { sourcePath: "kb/b.md", heading: "传送带原则", text: "传送带 是 派工 原语", meta: { source: "wiki", time: "2026-01-01" }, vector: [0.3] },
  { sourcePath: "kb/c.md", heading: "loop", text: "loop 与 harness 无关" },
  { sourcePath: "kb/d.md", heading: "gate 说明", text: "gate 是 闸门" },
  { sourcePath: "kb/e.md", heading: "无关页", text: "完全 另 一 回事" },
  { sourcePath: "kb/f.md", heading: "X", text: "harness 说明" },
  { sourcePath: "kb/c.md", heading: "另一节", text: "harness 备注" },
  { sourcePath: "kb/h.md", heading: "harness 标题", text: null },
]);
const QUERY = "harness gate 传送带";
const INDEX = { chunks: [...CHUNKS] };

// ── 冻结锚点:整行、全字段、全序 ─────────────────────────────────────────────
// 排序键 = 分值降序 → sourcePath 升序 → heading 升序(compareByScoreThenPath,store.js:447)。
// 5 分并列:kb/d.md < kb/h.md;3 分并列:kb/c.md 的两节在前(heading "loop" < "另一节"),kb/f.md 在后。
const EXPECTED_ROWS = Object.freeze([
  { sourcePath: "kb/a.md", heading: "harness 模块", text: "harness gate 传送带 collector", score: 10 },
  { sourcePath: "kb/d.md", heading: "gate 说明", text: "gate 是 闸门", score: 5 },
  { sourcePath: "kb/h.md", heading: "harness 标题", text: "", score: 5 },
  { sourcePath: "kb/b.md", heading: "传送带原则", text: "传送带 是 派工 原语", score: 4, meta: { source: "wiki", time: "2026-01-01" } },
  { sourcePath: "kb/c.md", heading: "loop", text: "loop 与 harness 无关", score: 3 },
  { sourcePath: "kb/c.md", heading: "另一节", text: "harness 备注", score: 3 },
  { sourcePath: "kb/f.md", heading: "X", text: "harness 说明", score: 3 },
]);

// idf 档的冻结名次(docs/rag-idf-wiring-plan.md §7.1;闭式分值推导见文件末尾的 idf 闭式测试)。
const EXPECTED_IDF_ORDER = Object.freeze(["kb/a.md", "kb/d.md", "kb/b.md", "kb/h.md", "kb/c.md", "kb/c.md", "kb/f.md"]);

// ── 独立参考实现 ─────────────────────────────────────────────────────────────
// 与生产 searchWikiRagLexical(store.js:507)同构但独立成文,作三角互证的第二路。
// compareByScoreThenPath 在 store.js 内部未导出,这里按 store.js:447-456 原样复刻
// (kb-replay.js 已有同款复刻先例);复刻是否忠实由 EXPECTED_ROWS 的序验收。
function compareByScoreThenPath(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ap = a.sourcePath || "";
  const bp = b.sourcePath || "";
  if (ap !== bp) return ap < bp ? -1 : 1;
  const ah = a.heading || "";
  const bh = b.heading || "";
  if (ah !== bh) return ah < bh ? -1 : 1;
  return 0;
}

function referenceLexicalSearch(queryText, { topK = 5, index = null, scoring = null } = {}) {
  const chunks = Array.isArray(index?.chunks) ? index.chunks : [];
  const terms = lexicalTermsForQuery(queryText);
  if (terms.asciiTokens.length === 0 && terms.cjkBigrams.length === 0) return [];
  const scoreOf = buildLexicalScorer(terms, chunks, scoring || {});
  return chunks
    .map((rec) => ({
      sourcePath: rec.sourcePath,
      heading: rec.heading,
      text: rec.text || "",
      score: scoreOf(rec),
      ...(rec.meta ? { meta: rec.meta } : {}),
    }))
    .filter((r) => r.score > 0)
    .sort(compareByScoreThenPath)
    .slice(0, Math.max(1, Number(topK) || 5));
}

// ── ① 生产路 vs 锚点 ─────────────────────────────────────────────────────────

test("生产 searchWikiRagLexical 的整行输出逐字段等于冻结锚点", async () => {
  const produced = await searchWikiRagLexical(QUERY, { topK: 10, index: INDEX });
  assert.deepEqual(produced, EXPECTED_ROWS);
});

// ── ② 参考实现 vs 同一锚点 ───────────────────────────────────────────────────

test("参考实现(buildLexicalScorer 默认档)的整行输出逐字段等于同一份冻结锚点", () => {
  assert.deepEqual(referenceLexicalSearch(QUERY, { topK: 10, index: INDEX }), EXPECTED_ROWS);
});

test("两条路彼此逐字段相等(由 ①② 各自锚定后的推论,单独成立也有价值)", async () => {
  const produced = await searchWikiRagLexical(QUERY, { topK: 10, index: INDEX });
  assert.deepEqual(referenceLexicalSearch(QUERY, { topK: 10, index: INDEX }), produced);
});

// ── 调用形态:缺省/空/显式 existence/非法档位名,全部落在默认档 = 锚点 ────────
// 非法名含原型成员名("constructor"/"__proto__"):resolveLexicalScoringMode 回落默认档,
// 这正是接线硬要求 ③ 的可测形式 —— 配置写错时词法腿退到已验证的旧行为,而非静默清零。

test("scoring 缺省/null/空对象/显式 existence/非法档位名:七种写法同锚点", async () => {
  const FORMS = [
    {}, { scoring: null }, { scoring: {} }, { scoring: { mode: "existence" } },
    { scoring: { mode: "constructor" } }, { scoring: { mode: "__proto__" } }, { scoring: { mode: "BM25" } },
  ];
  for (const options of FORMS) {
    const produced = await searchWikiRagLexical(QUERY, { topK: 10, index: INDEX, ...options });
    assert.deepEqual(produced, EXPECTED_ROWS, `生产路 ${JSON.stringify(options)}`);
    assert.deepEqual(referenceLexicalSearch(QUERY, { topK: 10, index: INDEX, ...options }), EXPECTED_ROWS, `参考实现 ${JSON.stringify(options)}`);
  }
});

// ── 行投影:多余字段丢弃、meta 键的有无 ──────────────────────────────────────

test("行投影只保留 {sourcePath,heading,text,score}(+meta);索引上的 vector/sha 被丢弃", async () => {
  for (const [label, rows] of [
    ["生产路", await searchWikiRagLexical(QUERY, { topK: 10, index: INDEX })],
    ["参考实现", referenceLexicalSearch(QUERY, { topK: 10, index: INDEX })],
  ]) {
    for (const row of rows) {
      const keys = Object.keys(row).sort();
      const expected = row.sourcePath === "kb/b.md"
        ? ["heading", "meta", "score", "sourcePath", "text"]
        : ["heading", "score", "sourcePath", "text"];
      assert.deepEqual(keys, expected, `${label} ${row.sourcePath} 的字段集`);
    }
    // 无 meta 的块:meta 键整体缺席(而非 meta:undefined),旧索引向后兼容靠的正是这个
    assert.equal(Object.hasOwn(rows[0], "meta"), false, `${label} 无 meta 的行`);
    // 有 meta 的块:同一个对象原样透传
    assert.deepEqual(rows[3].meta, { source: "wiki", time: "2026-01-01" }, `${label} 有 meta 的行`);
  }
});

// ── 确定性:输入顺序洗牌后输出恒定 ───────────────────────────────────────────

test("候选顺序洗牌后,两条路的输出仍逐字段等于锚点(并列由 sourcePath/heading 定序)", async () => {
  const shuffled = { chunks: [...CHUNKS].reverse() };
  assert.deepEqual(await searchWikiRagLexical(QUERY, { topK: 10, index: shuffled }), EXPECTED_ROWS);
  assert.deepEqual(referenceLexicalSearch(QUERY, { topK: 10, index: shuffled }), EXPECTED_ROWS);
});

// ── topK 夹取与空词项早退 ────────────────────────────────────────────────────

test("topK 夹取行为逐例冻结(Math.max(1, Number(topK) || 5) 的全部分支)", async () => {
  const CASES = [[undefined, 5], [0, 5], [NaN, 5], ["3", 3], [-3, 1], [1, 1], [10, 7], [999, 7]];
  for (const [topK, count] of CASES) {
    const produced = await searchWikiRagLexical(QUERY, { topK, index: INDEX });
    assert.equal(produced.length, count, `生产路 topK=${String(topK)}`);
    assert.deepEqual(produced, EXPECTED_ROWS.slice(0, count), `生产路 topK=${String(topK)} 的行`);
    assert.deepEqual(referenceLexicalSearch(QUERY, { topK, index: INDEX }), EXPECTED_ROWS.slice(0, count), `参考实现 topK=${String(topK)}`);
  }
});

test("查询无可用词项 → 两条路都早退成空数组(候选集连扫都省了)", async () => {
  for (const query of ["!!! ???", "  ", "", null]) {
    assert.deepEqual(await searchWikiRagLexical(query, { topK: 5, index: INDEX }), [], `生产路 ${JSON.stringify(query)}`);
    assert.deepEqual(referenceLexicalSearch(query, { topK: 5, index: INDEX }), [], `参考实现 ${JSON.stringify(query)}`);
  }
});

test("索引缺失 chunks / 形状异常 → 参考实现返回空,与生产路的空索引语义一致", () => {
  for (const index of [{ chunks: [] }, { chunks: null }, {}, null]) {
    assert.deepEqual(referenceLexicalSearch(QUERY, { topK: 5, index }), [], `索引 ${JSON.stringify(index)}`);
  }
});

// ── 召回闸定理:idf 档下 score>0 的**集合**与 existence 完全相同,变的只有序 ──
// 这条是 docs/rag-idf-wiring-plan.md §4 论证的可执行形式:
// 每个命中词项的贡献 = 结构权重(≥1)× IDF(≥log2>0)⇒ 命中即正分 ⇒ .filter(score>0) 的留存集恒等。
// 真实语料侧同一探针:wiki 24/24 查询、memos 81/81 计分查询,两档留存集逐块相同(2026-08-11 实测)。

test("idf 档:score>0 的留存集与 existence 逐块相同,仅名次重排", () => {
  const terms = lexicalTermsForQuery(QUERY);
  const existence = buildLexicalScorer(terms, CHUNKS);
  const idf = buildLexicalScorer(terms, CHUNKS, { mode: "idf" });

  const keep = (scorer) => CHUNKS.filter((c) => scorer(c) > 0).map((c) => `${c.sourcePath}#${c.heading}`);
  const EXPECTED_KEPT = [
    "kb/a.md#harness 模块", "kb/b.md#传送带原则", "kb/c.md#loop", "kb/d.md#gate 说明",
    "kb/f.md#X", "kb/c.md#另一节", "kb/h.md#harness 标题",
  ];
  assert.deepEqual(keep(existence), EXPECTED_KEPT, "existence 留存集");
  assert.deepEqual(keep(idf), EXPECTED_KEPT, "idf 留存集");
  assert.equal(EXPECTED_KEPT.length, EXPECTED_ROWS.length, "留存集大小与锚点行数一致");

  // 序确实变了(否则本条断言退化成"改了个寂寞"):existence 是 a,d,h,b,…;idf 是 a,d,b,h,…
  const idfOrder = referenceLexicalSearch(QUERY, { topK: 10, index: INDEX, scoring: { mode: "idf" } }).map((r) => r.sourcePath);
  assert.deepEqual(idfOrder, [...EXPECTED_IDF_ORDER]);
  assert.deepEqual(EXPECTED_ROWS.map((r) => r.sourcePath), ["kb/a.md", "kb/d.md", "kb/h.md", "kb/b.md", "kb/c.md", "kb/c.md", "kb/f.md"]);
});

test("idf 档分值等于独立推导的闭式(N=8;df: harness 5、gate/传送/送带 各 2)", () => {
  const terms = lexicalTermsForQuery(QUERY);
  const idf = buildLexicalScorer(terms, CHUNKS, { mode: "idf" });
  const idfHarness = Math.log(1 + 8 / 5); // log(2.6)
  const idfRare = Math.log(1 + 8 / 2);    // log(5),gate/传送/送带 同 df
  const EXPECTED = [
    5 * idfHarness + 3 * idfRare + 1 * idfRare + 1 * idfRare, // a
    2 * idfRare + 2 * idfRare,                                 // b
    3 * idfHarness,                                            // c
    5 * idfRare,                                               // d
    0,                                                         // e
    3 * idfHarness,                                            // f
    3 * idfHarness,                                            // c 第二节
    5 * idfHarness,                                            // h
  ];
  CHUNKS.forEach((chunk, i) => {
    assert.ok(Math.abs(idf(chunk) - EXPECTED[i]) <= 1e-12, `${chunk.sourcePath} 实得 ${idf(chunk)} 期望 ${EXPECTED[i]}`);
  });
  assert.ok(EXPECTED.filter((v) => v > 0).length === 7, "8 块里 7 块命中,与 existence 档的 7 块吻合");
});

// ═══ 以下为接线后断言(docs/rag-idf-wiring-plan.md §7)═══════════════════════

// §7.1 生产函数吃 scoring 入参:idf 档名次 = 冻结序(此前由参考实现算出并冻结)。

test("接线 §7.1:生产 searchWikiRagLexical 的 idf 档名次等于冻结序,整行等于参考实现", async () => {
  const produced = await searchWikiRagLexical(QUERY, { topK: 10, index: INDEX, scoring: { mode: "idf" } });
  assert.deepEqual(produced.map((r) => r.sourcePath), [...EXPECTED_IDF_ORDER]);
  assert.deepEqual(produced, referenceLexicalSearch(QUERY, { topK: 10, index: INDEX, scoring: { mode: "idf" } }));
});

// §7.2 配置解析:override 路纯参数(与磁盘无关),读盘路对着伪配置断言(与本机配置无关)。

test("接线 §7.2a:resolveWikiRagLexicalConfig 的 override 路 —— 合法档位原样归一,k1/b 透传", async () => {
  assert.deepEqual(await resolveWikiRagLexicalConfig({ mode: "existence" }), { mode: "existence", k1: 1.2, b: 0.3 });
  assert.deepEqual(await resolveWikiRagLexicalConfig({ mode: "idf" }), { mode: "idf", k1: 1.2, b: 0.3 });
  assert.deepEqual(await resolveWikiRagLexicalConfig({ mode: "bm25", k1: 2, b: 0.5 }), { mode: "bm25", k1: 2, b: 0.5 });
  assert.deepEqual(await resolveWikiRagLexicalConfig({ mode: "idf-tf", k1: "1.5" }), { mode: "idf-tf", k1: 1.5, b: 0.3 });
});

test("接线 §7.2b:非法档位名(constructor/__proto__/BM25/数字/空)一律回落 existence 默认三元组", async () => {
  const FALLBACK = { mode: "existence", k1: 1.2, b: 0.3 };
  for (const mode of ["constructor", "__proto__", "BM25", "tfidf", 42, "", null, undefined]) {
    assert.deepEqual(await resolveWikiRagLexicalConfig({ mode }), FALLBACK, `mode=${String(mode)}`);
  }
  // k1/b 是垃圾值 → finiteNumber 取不到 → 回默认常量(档位不受牵连)
  assert.deepEqual(await resolveWikiRagLexicalConfig({ mode: "bm25", k1: "abc", b: NaN }), { mode: "bm25", k1: 1.2, b: 0.3 });
});

test("接线 §7.2c:读盘路(override=null)对着伪配置 —— 缺省键回落 existence;写入 idf 即生效;非法名回落", async () => {
  await writeFakeConfig(); // 无 lexicalScoring 键
  assert.deepEqual(await resolveWikiRagLexicalConfig(null), { mode: "existence", k1: 1.2, b: 0.3 }, "缺省键");
  await writeFakeConfig({ lexicalScoring: "idf", lexicalK1: 1.6, lexicalB: 0.4 });
  assert.deepEqual(await resolveWikiRagLexicalConfig(null), { mode: "idf", k1: 1.6, b: 0.4 }, "写入 idf");
  await writeFakeConfig({ lexicalScoring: "constructor" });
  assert.deepEqual(await resolveWikiRagLexicalConfig(null), { mode: "existence", k1: 1.2, b: 0.3 }, "非法名回落");
  await writeFakeConfig(); // 复位
});

// §7.3 hybrid 合成入口:词法-only 降级下,默认路 = 显式 existence = 硬编码 RRF 行。
// RRF 单表融合的分值 = 1/(60+rank)(wiki-rag-search.js RRF_K=60),序 = 词法序 → 可整行冻结。

const EXPECTED_HYBRID_EXISTENCE = Object.freeze({
  ok: true,
  degraded: true, // 伪配置的 embedBaseUrl 指向死端口 → 向量腿降级,确定性成立
  results: [
    { sourcePath: "kb/a.md", heading: "harness 模块", text: "harness gate 传送带 collector", score: 1 / 60 },
    { sourcePath: "kb/d.md", heading: "gate 说明", text: "gate 是 闸门", score: 1 / 61 },
    { sourcePath: "kb/h.md", heading: "harness 标题", text: "", score: 1 / 62 },
    { sourcePath: "kb/b.md", heading: "传送带原则", text: "传送带 是 派工 原语", score: 1 / 63, meta: { source: "wiki", time: "2026-01-01" } },
    { sourcePath: "kb/c.md", heading: "loop", text: "loop 与 harness 无关", score: 1 / 64 },
  ],
});

const EXPECTED_HYBRID_IDF = Object.freeze({
  ok: true,
  degraded: true,
  results: [
    { sourcePath: "kb/a.md", heading: "harness 模块", text: "harness gate 传送带 collector", score: 1 / 60 },
    { sourcePath: "kb/d.md", heading: "gate 说明", text: "gate 是 闸门", score: 1 / 61 },
    { sourcePath: "kb/b.md", heading: "传送带原则", text: "传送带 是 派工 原语", score: 1 / 62, meta: { source: "wiki", time: "2026-01-01" } },
    { sourcePath: "kb/h.md", heading: "harness 标题", text: "", score: 1 / 63 },
    { sourcePath: "kb/c.md", heading: "loop", text: "loop 与 harness 无关", score: 1 / 64 },
  ],
});

test("接线 §7.3a:hybrid 默认路(配置缺省)= 显式 existence = 硬编码 RRF 行(新增入参未改默认合成路径)", async () => {
  await writeFakeConfig(); // 无 lexicalScoring 键
  const byDefault = await hybridSearchOverIndex(QUERY, INDEX, { topK: 5 });
  const byExplicit = await hybridSearchOverIndex(QUERY, INDEX, { topK: 5, lexicalScoring: { mode: "existence" } });
  assert.deepEqual(byDefault, EXPECTED_HYBRID_EXISTENCE, "默认路 vs 硬编码");
  assert.deepEqual(byExplicit, EXPECTED_HYBRID_EXISTENCE, "显式 existence vs 硬编码");
});

test("接线 §7.3b:配置写入 idf → hybrid 默认路切档(真正的开关);显式入参仍压过配置(评测台解耦)", async () => {
  await writeFakeConfig({ lexicalScoring: "idf" });
  assert.deepEqual(await hybridSearchOverIndex(QUERY, INDEX, { topK: 5 }), EXPECTED_HYBRID_IDF, "配置档生效");
  assert.deepEqual(
    await hybridSearchOverIndex(QUERY, INDEX, { topK: 5, lexicalScoring: { mode: "existence" } }),
    EXPECTED_HYBRID_EXISTENCE,
    "显式 existence 压过配置里的 idf",
  );
  await writeFakeConfig(); // 复位
});

test("接线 §7.3c:配置写入非法档位名(constructor)→ hybrid 回落 existence 行为", async () => {
  await writeFakeConfig({ lexicalScoring: "constructor" });
  assert.deepEqual(await hybridSearchOverIndex(QUERY, INDEX, { topK: 5 }), EXPECTED_HYBRID_EXISTENCE);
  await writeFakeConfig(); // 复位
});
