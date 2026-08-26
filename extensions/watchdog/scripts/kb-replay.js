#!/usr/bin/env node
// 离线 RRF 重放台 —— 检索侧 A/B 的杠杆点。
//
// 【为什么能离线】两项待测改动都不碰向量腿:
//   ① 词法打分(IDF)只改 searchWikiRagLexical 的排序;
//   ② 多样性裁剪完全发生在 rrfFuse 之后。
// 所以把每条 fixture 查询的**向量腿 top-wide 结果**用一次 ollama 跑缓存下来,之后所有词法变体、
// 所有 N 值都能本地重放完整的 rrfFuse + 裁剪 + slice,得到**逐字节精确**的
// recall@k / MRR / keywordCoverage / ghostHitRate / dupSlotRate —— 不是代理指标,是精确值。
//
// 【为什么必须有它】
// (a) 修掉预筛的方法论洞:只跟踪期望文档自己的分值变化是错的 —— rrfFuse 决定名次的是期望文档
//     与**其余所有候选**的相对关系,竞争者名次同样在动;
// (b) 把"每个变体一轮串行 ollama"变成"零 ollama、秒级",参数扫描才可能穷尽;
// (c) 能在**写任何生产代码之前**判 ship/kill,不把永远为 0 的开关合进主干(「不留遗留代码」)。
//
// 【正确性门 —— 最重要】基线臂(existence, N=0)直接调**生产函数** searchWikiRagLexical,
// 只有变体臂才是本文件的复刻。所以 verify 若不能复现 live 数字,错的一定是重放框架本身
// (向量腿缓存/RRF/切片),而不是"两份实现漂移"。复现不了 → 下游结论全部作废。
//
//   node scripts/kb-replay.js capture <kbId>   # 唯一需要 ollama 的步骤
//   node scripts/kb-replay.js verify  <kbId>   # 零 ollama:自检
//   node scripts/kb-replay.js scan    <kbId>   # 零 ollama:变体 × N 扫描
//
// 前置已核实:两 fixture 的 asOf 出现 0 次、全库无 meta.time、rerank 默认关 → 无需处理点时与 rerank 分支。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadKnowledgeBaseIndex } from "../lib/knowledge/knowledge-base.js";
import { searchWikiRag, searchWikiRagLexical, lexicalTermsForQuery } from "../lib/knowledge/wiki-rag-store.js";
import { embedText, resolveWikiRagEmbedConfig } from "../lib/knowledge/wiki-rag-embed.js";
import { rewriteQuery, rrfFuse } from "../lib/knowledge/wiki-rag-search.js";
import { evaluateWikiRagRecall } from "../lib/knowledge/wiki-rag-eval.js";
import { pairedRankReport } from "../lib/knowledge/rag-stats.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, ".replay-cache");
const RRF_K = 60; // 必须与 wiki-rag-search.js:12 一致

const [, , cmd, kbId] = process.argv;
if (!cmd || !kbId) {
  console.error("用法: node scripts/kb-replay.js <capture|verify|scan> <kbId>");
  process.exit(1);
}

const fx = JSON.parse(await readFile(join(ROOT, "tests/fixtures", `${kbId}-rag-eval-set.json`), "utf8"));
const TOP_K = fx.topK || 10;
// 生产宽集(wiki-rag-search.js:147 是 Math.max(topK*4,20)=40)。
// 做成 env 可覆盖,才能离线测「扩宽集」这一项 —— 天花板探测实测 memos 融合召回
// 深度40=85.2% / 深度200=100.0%,即有 14.8pp 纯粹因池子太窄而丢失,零模型零重嵌可拿。
const WIDE = Number(process.env.KB_PROD_WIDE || Math.max(TOP_K * 4, 20));
// A3:候选宽度天花板探测。生产宽集只有 40,但要回答「gold 到底在不在候选里」必须抓更宽。
// 抓宽不改变生产行为 —— 重放时按需截断到 WIDE 即可复现基线(verify 会证明这一点)。
const WIDE_CAPTURE = Number(process.env.KB_WIDE || 200);
const cachePath = join(CACHE_DIR, `${kbId}.json`);

if (fx.cases.some((c) => c.asOf)) {
  console.error("✖ fixture 含 asOf,本重放台不支持点时过滤(会给出错误结论)。先扩展脚本。");
  process.exit(1);
}

// KB_INDEX_FILE:影子索引覆盖(T6 A/B 用 —— buildKbIndex({indexPath}) 建出的对照索引经此注入,
// 生产索引保持只读)。缺省走正式索引,行为与今天一致。
const index = process.env.KB_INDEX_FILE
  ? await (await import("../lib/knowledge/wiki-rag-store.js")).loadRagIndexFile(process.env.KB_INDEX_FILE)
  : await loadKnowledgeBaseIndex(kbId);
if (!index?.chunks?.length) { console.error(`✖ kb '${kbId}' 索引为空`); process.exit(1); }

// ── capture:唯一需要 ollama 的步骤 ────────────────────────────────────────
if (cmd === "capture") {
  const cfg = await resolveWikiRagEmbedConfig();
  const entries = [];
  for (const c of fx.cases) {
    const q = rewriteQuery(c.query);
    const emb = await embedText(q, { model: cfg.model, baseUrl: cfg.baseUrl });
    const vector = await searchWikiRag(emb, { topK: WIDE_CAPTURE, index });
    if (!vector.length) { console.error(`\n✖ 向量腿空:${c.query}`); process.exit(1); }
    entries.push({
      query: c.query,
      rewritten: q,
      vector: vector.map((r) => ({ sourcePath: r.sourcePath, heading: r.heading, text: r.text, ...(r.meta ? { meta: r.meta } : {}) })),
    });
    process.stderr.write(".");
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify({ kbId, topK: TOP_K, wide: WIDE_CAPTURE, chunkCount: index.chunks.length, model: cfg.model, entries }), "utf8");
  console.error(`\n已缓存 ${entries.length} 条查询的向量腿 top-${WIDE_CAPTURE} → ${cachePath}`);
  process.exit(0);
}

const cache = JSON.parse(await readFile(cachePath, "utf8").catch(() => "null"));
if (!cache) { console.error(`✖ 无缓存,先跑: node scripts/kb-replay.js capture ${kbId}`); process.exit(1); }
// 缓存对应的是**当时的索引**;索引重建过就必须重新 capture,否则重放的是旧世界。
if (index.chunks.length !== cache.chunkCount) {
  console.error(`✖ 索引已变(缓存 ${cache.chunkCount} 块,当前 ${index.chunks.length}),请重新 capture`);
  process.exit(1);
}

// ── 词法变体 ────────────────────────────────────────────────────────────
// 基线臂 existence **直接调生产函数**,不复刻。
// idf 变体 = 逐字保留旧版 lexicalScoreChunk(v193 前位于 wiki-rag-store.js:502,现已并入 wiki-rag-lexical.js)的结构权重
//   ASCII: (词长≥4 ? 3 : 1) + (命中 heading ? 2 : 0)
//   CJK  : 1 + (命中 heading ? 1 : 0)
// 只把每个词项的贡献**乘以 IDF**。若顺手改掉词长权重或标题加成,测的就是混合体,不是 IDF。
// IDF 取 log(1+N/df):df=N 时仍有 log2≈0.693 地板,永不归零 → 过得了 :530 的 score>0 召回闸。
// (经典 log((N-df+0.5)/(df+0.5)) 在 df=N 时 ≈0.000137,形式上活着实质等于删词,本语料 CJK bigram
//  高频不等于无信息,故否掉。)
function idfLexicalLeg(rewritten) {
  const terms = lexicalTermsForQuery(rewritten);
  if (terms.asciiTokens.length === 0 && terms.cjkBigrams.length === 0) return [];
  const chunks = index.chunks;
  const N = chunks.length;
  const hays = chunks.map((c) => `${c.text || ""} ${c.heading || ""}`.toLowerCase());
  const heads = chunks.map((c) => String(c.heading || "").toLowerCase());
  const dfOf = (t) => { let n = 0; for (const h of hays) if (h.includes(t)) n += 1; return n; };
  const idf = new Map();
  for (const t of terms.asciiTokens) idf.set(t, Math.log(1 + N / Math.max(1, dfOf(t))));
  for (const b of terms.cjkBigrams) idf.set(b, Math.log(1 + N / Math.max(1, dfOf(b))));

  const out = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const hay = hays[i], head = heads[i];
    let score = 0;
    for (const t of terms.asciiTokens) {
      if (hay.includes(t)) score += ((t.length >= 4 ? 3 : 1) + (head.includes(t) ? 2 : 0)) * idf.get(t);
    }
    for (const b of terms.cjkBigrams) {
      if (hay.includes(b)) score += (1 + (head.includes(b) ? 1 : 0)) * idf.get(b);
    }
    if (score > 0) out.push({ sourcePath: chunks[i].sourcePath, heading: chunks[i].heading, text: chunks[i].text || "", score, ...(chunks[i].meta ? { meta: chunks[i].meta } : {}) });
  }
  // 与 compareByScoreThenPath 同序(score → sourcePath → heading),确定性一致。
  out.sort((a, b) => (b.score - a.score)
    || ((a.sourcePath || "") < (b.sourcePath || "") ? -1 : (a.sourcePath || "") > (b.sourcePath || "") ? 1 : 0)
    || ((a.heading || "") < (b.heading || "") ? -1 : (a.heading || "") > (b.heading || "") ? 1 : 0));
  return out.slice(0, WIDE);
}

// ── 稳定分区式同源上限 ──────────────────────────────────────────────────
// 溢出**降尾而非删除** → 输出是输入的置换 → 每个 sourcePath 的首块名次只前移不后移
// → 以 sourcePath 判定的 recall@k / MRR 单调不降(可证)。N=0 = 不裁。
function capPerSource(list, maxPerSource) {
  if (!maxPerSource || maxPerSource <= 0) return list;
  const seen = new Map();
  const head = [], tail = [];
  for (const r of list) {
    const k = r.sourcePath || "";
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    (n <= maxPerSource ? head : tail).push(r);
  }
  return head.concat(tail);
}

async function replaySearch(caseQuery, { variant, maxPerSource }) {
  const entry = cache.entries.find((e) => e.query === caseQuery);
  if (!entry) throw new Error(`缓存缺查询: ${caseQuery}`);
  const vector = entry.vector.slice(0, WIDE); // 截回生产宽集,保证 verify 仍能复现 live
  const lexical = variant === "existence"
    ? await searchWikiRagLexical(entry.rewritten, { topK: WIDE, index })
    : idfLexicalLeg(entry.rewritten);
  const fused = rrfFuse([vector, lexical], { topK: WIDE });
  return { ok: true, degraded: false, results: capPerSource(fused, maxPerSource).slice(0, TOP_K) };
}

async function measure({ variant, maxPerSource }) {
  const r = await evaluateWikiRagRecall(fx.cases, (q) => replaySearch(q, { variant, maxPerSource }), { topK: TOP_K });
  let dup = 0, slots = 0;
  for (const c of fx.cases) {
    const paths = (await replaySearch(c.query, { variant, maxPerSource })).results.map((x) => x.sourcePath);
    slots += paths.length; dup += paths.length - new Set(paths).size;
  }
  return { ...r, dupSlotRate: slots ? Number((dup / slots * 100).toFixed(1)) : 0 };
}

const fmt = (r) => `r@1 ${(r.recallAt[1] * 100).toFixed(1)}  @3 ${(r.recallAt[3] * 100).toFixed(1)}  @5 ${(r.recallAt[5] * 100).toFixed(1)}  @10 ${(r.recallAt[10] * 100).toFixed(1)}  MRR ${r.mrr.toFixed(4)}  kwCov ${(r.keywordCoverage * 100).toFixed(1)}  ghost ${r.ghostHitRate == null ? "n/a" : r.ghostHitRate.toFixed(2)}  dup ${r.dupSlotRate}%`;

if (cmd === "verify") {
  const base = await measure({ variant: "existence", maxPerSource: 0 });
  console.log(`重放(existence, N=0): ${fmt(base)}`);
  console.log("→ 与 live `node scripts/kb-eval.js " + kbId + "` 的 recall/MRR/kwCov 逐位比对;不一致则重放台有错,下游结论作废。");
  process.exit(0);
}

// 逐例配对:existence(N=0) vs idf(N=0)。符号检验要的是**不一致对**的数量,
// 聚合百分比看不出它 —— 两个方向各动一例、净变化为 0 的情况在聚合上完全隐形。
if (cmd === "paired") {
  const a = await evaluateWikiRagRecall(fx.cases, (q) => replaySearch(q, { variant: "existence", maxPerSource: 0 }), { topK: TOP_K });
  const b = await evaluateWikiRagRecall(fx.cases, (q) => replaySearch(q, { variant: "idf", maxPerSource: 0 }), { topK: TOP_K });
  const ord = (r) => (r === -1 ? 999 : r); // 未命中排在所有名次之后
  let up = 0, down = 0, same = 0;
  for (let i = 0; i < a.perCase.length; i += 1) {
    const x = ord(a.perCase[i].rank), y = ord(b.perCase[i].rank);
    const q = String(a.perCase[i].query || "").slice(0, 42);
    if (y < x) { up += 1; console.log(`  UP   ${a.perCase[i].rank} -> ${b.perCase[i].rank}  ${q}`); }
    else if (y > x) { down += 1; console.log(`  DOWN ${a.perCase[i].rank} -> ${b.perCase[i].rank}  ${q}`); }
    else same += 1;
  }
  console.log(JSON.stringify({ kbId, up, down, same, discordant: up + down, total: a.perCase.length }));
  // 逐例名次对也一并落盘:符号检验丢弃幅度,而 MRR 是我们真正关心的估计量,
  // 匹配它的检验是对 ΔRR 做 Wilcoxon 符号秩。两个检验都要报,不挑对结论有利的那个。
  const pairs = a.perCase.map((p, i) => ({ rankA: p.rank, rankB: b.perCase[i].rank, scored: b.perCase[i].verdictStatus !== "undecided" }));
  await writeFile(join(CACHE_DIR, `${kbId}-pairs.json`), JSON.stringify(pairs), "utf8");
  console.log(`逐例名次对 → ${join(CACHE_DIR, `${kbId}-pairs.json`)}`);
  // A1:符号检验丢弃幅度,而 MRR 才是我们关心的估计量;两个检验一起报,不挑对结论有利的。
  const rep = pairedRankReport(pairs);
  console.log(`MRR ${rep.mrrBefore.toFixed(4)} → ${rep.mrrAfter.toFixed(4)} (Δ${rep.deltaMrr >= 0 ? "+" : ""}${rep.deltaMrr.toFixed(4)})  n=${rep.n}`);
  console.log(`  Wilcoxon(ΔRR) p=${rep.wilcoxon.p.toFixed(4)} [${rep.wilcoxon.method}]  |  符号检验 p=${rep.sign.p.toFixed(4)}  |  效应量 rank-biserial=${rep.effect.rankBiserial.toFixed(3)}`);
  console.log(`  ΔMRR 95%CI [${rep.ci.lower.toFixed(4)}, ${rep.ci.upper.toFixed(4)}]  |  MDE(这把尺当前能检出的最小 ΔMRR)=${rep.mde.mde == null ? "n/a" : rep.mde.mde.toFixed(4)}`);
  process.exit(0);
}

// A3:候选天花板探测。回答的是「gold 到底在不在候选池里」——
// 这决定 rerank 值不值得做:救不回没进候选的东西,再好的重排也是零收益。
// 分别看 ①向量腿单独 ②词法腿单独 ③融合 在各深度的召回上界。
if (cmd === "ceiling") {
  const depths = [10, 20, 40, 80, 150, cache.wide].filter((d, i, a) => d <= cache.wide && a.indexOf(d) === i);
  const rows = [];
  for (const d of depths) {
    let vHit = 0, lHit = 0, fHit = 0, scored = 0;
    for (const c of fx.cases) {
      if (c.verdictStatus === "undecided") continue;
      scored += 1;
      const e = cache.entries.find((x) => x.query === c.query);
      const vec = e.vector.slice(0, d);
      const lex = await searchWikiRagLexical(e.rewritten, { topK: d, index });
      const fus = rrfFuse([vec, lex], { topK: d });
      const has = (list) => list.some((r) => r.sourcePath === c.expectedSourcePath);
      if (has(vec)) vHit += 1;
      if (has(lex)) lHit += 1;
      if (has(fus)) fHit += 1;
    }
    rows.push({ d, v: (vHit / scored * 100).toFixed(1), l: (lHit / scored * 100).toFixed(1), f: (fHit / scored * 100).toFixed(1), scored });
  }
  console.log(`# ${kbId} | 计分 ${rows[0]?.scored} 例 | 候选召回上界(gold 在不在池子里)`);
  console.log("深度   向量腿   词法腿   融合");
  for (const r of rows) console.log(`${String(r.d).padStart(4)}   ${r.v.padStart(6)}   ${r.l.padStart(6)}   ${r.f.padStart(6)}`);
  console.log(`\n生产宽集 = ${WIDE};最终返回 top-${TOP_K}。融合列与深度 ${WIDE} 那行的差距 = rerank 的理论天花板。`);
  process.exit(0);
}

if (cmd === "scan") {
  console.log(`# ${kbId} | ${fx.cases.length} 例 | topK=${TOP_K} wide=${WIDE} | 索引 ${cache.chunkCount} 块`);
  for (const variant of ["existence", "idf"]) {
    console.log("");
    for (const N of [0, 1, 2, 3, 4]) {
      console.log(`${variant.padEnd(9)} N=${N}  ${fmt(await measure({ variant, maxPerSource: N }))}`);
    }
  }
  process.exit(0);
}

console.error(`未知命令: ${cmd}`);
process.exit(1);
