// lib/knowledge/wiki-rag-search.js — operator-facing wiki-RAG query entry.
//
// 默认 HYBRID:词法(BM25-lite,不需 ollama)+ 向量(cosine,需 ollama)经 RRF 融合。
// NEVER throws:索引缺失/空 → { ok:false, degraded:true, results:[] }；embed 不可用 → 退化成
// 词法-only（degraded:true 但仍返结果,优于此前的空降级）。结果形状 {sourcePath,heading,text,score}
// 与纯向量一致(score 改为 RRF 融合分),下游 mapper 不受影响。

import { embedText, resolveWikiRagEmbedConfig } from "./wiki-rag-embed.js";
import { loadWikiRagIndex, searchWikiRag, searchWikiRagLexical } from "./wiki-rag-store.js";
import { rerankResults, resolveWikiRagRerankConfig } from "./wiki-rag-rerank.js";
import { resolveWikiRagLexicalConfig } from "./wiki-rag-lexical.js";

const RRF_K = 60; // 标准 Reciprocal Rank Fusion 常数。

// 查询改写:剥离中文疑问/礼貌脚手架 + 结构虚词,让真术语主导检索(embedding 不被泛词拖偏 + 词法聚焦)。
// 0 依赖确定式,不用 LLM。实测:'我想知道 harness 的四种模块是什么' miss → 改写成 'harness 四种模块' 救回 top-3,
// 且 24 例评测集零回归。空化(全是填充词)则回退原文。
const QUERY_FILLER = [
  "我想知道", "我想了解", "我想问问", "我想问", "我想", "请问一下", "请问", "请告诉我", "告诉我", "麻烦", "帮我看看", "帮我",
  "能不能", "可不可以", "可以吗",
  "是什么意思", "是什么", "什么是", "是啥", "究竟是什么", "到底是什么", "究竟是", "到底是", "究竟", "到底", "指的是",
  "怎么回事", "怎么样", "怎么", "怎样", "如何",
];

export function rewriteQuery(text) {
  let q = String(text || "");
  // 保护 WHY 意图:为什么/为何 对 WHY 语料(wiki=WHY 层)携带"决策/依据"语义,
  // 不能被 什么是/是什么 误伤('为什么是 X' 不该被剥成 '为 X')。
  q = q.replace(/为什么|为何/gu, "WHY");
  for (const f of QUERY_FILLER) q = q.split(f).join(" ");
  q = q.replace(/[的了吗呢啊呀吧？?。!！,，、]/gu, " "); // 结构虚词/标点 → 空
  q = q.replace(/(^|\s)是(\s|$)/gu, " ");                // 剥离孤立的"是"(filler 剥离后常残留)
  q = q.replace(/WHY/gu, "为什么");
  q = q.replace(/\s+/gu, " ").trim();
  return q.length >= 2 ? q : String(text || "").trim();
}

// RRF 融合多个排名表:每个文档(按 sourcePath#heading 去重)累加各表的 1/(K+rank)。
// 不依赖各表分数量纲(向量 cosine vs 词法 BM25-lite 不可比)——只用名次,稳健。
export function rrfFuse(lists, { topK = 5, k = RRF_K } = {}) {
  const byKey = new Map();
  for (const list of lists) {
    (Array.isArray(list) ? list : []).forEach((r, rank) => {
      if (!r || !r.sourcePath) return;
      const key = `${r.sourcePath} ${r.heading || ""}`;
      const contrib = 1 / (k + rank);
      const prev = byKey.get(key);
      if (prev) prev.score += contrib;
      // Phase5:meta 首次出现即写入(同 key=同 page,meta 一致,后续不覆盖避免融合漂移);旧索引无 meta → 不加字段。
      else byKey.set(key, { sourcePath: r.sourcePath, heading: r.heading, text: r.text || "", score: contrib, ...(r.meta ? { meta: r.meta } : {}) });
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, Number(topK) || 5));
}

// Phase5 v151:从结果取声明式路径(heading | sourcePath | source | fields.<k>),给分歧派生用。
function resolveResultPath(result, path) {
  if (!path || !result) return null;
  if (path === "heading") return result.heading || null;
  if (path === "sourcePath") return result.sourcePath || null;
  if (path === "source") return result.meta?.source || null;
  if (path.startsWith("fields.")) return result.meta?.fields?.[path.slice(7)] ?? null;
  return null;
}
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// Phase5 v151:分歧派生(目标3 本体)。对已融合结果按 groupBy 分组,组内同源用 time 取最新
// (supersession),跨源(≥2 distinct source)且 on 标量有差异 → 产 conflictHint。纯函数、通用
// (groupBy/on 是声明式路径,无领域硬编码)、query-time(分歧是召回集涌现属性,非 index 预存)。
export function deriveConflictHints(results, conflictConfig) {
  const list = Array.isArray(results) ? results : [];
  const cfg = conflictConfig && typeof conflictConfig === "object" ? conflictConfig : null;
  const onPaths = cfg && Array.isArray(cfg.on) ? cfg.on : [];
  if (!cfg || onPaths.length === 0) return [];
  const groupByPath = cfg.groupBy || null;

  const groups = new Map();
  for (const r of list) {
    if (!r.meta?.source) continue; // 无发布者 → 不参与分歧
    const key = groupByPath ? resolveResultPath(r, groupByPath) : "__all__";
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const hints = [];
  for (const [topic, members] of groups) {
    // 同源取最新(supersession):每个 source 留 time 最大的代表
    const latestBySource = new Map();
    for (const r of members) {
      const prev = latestBySource.get(r.meta.source);
      if (!prev || String(r.meta.time || "") > String(prev.meta.time || "")) latestBySource.set(r.meta.source, r);
    }
    if (latestBySource.size < 2) continue; // 单源 → 无分歧
    const reps = [...latestBySource.values()];

    const dispersion = {};
    let anyDiff = false;
    for (const path of onPaths) {
      const vals = reps.map((r) => resolveResultPath(r, path)).filter((v) => v != null);
      if (vals.length < 2) continue;
      const nums = vals.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      if (nums.length === vals.length) {
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        const stdev = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
        const min = Math.min(...nums); const max = Math.max(...nums);
        dispersion[path] = { kind: "numeric", mean: round4(mean), stdev: round4(stdev), cv: mean ? round4(stdev / Math.abs(mean)) : null, min, max, n: nums.length };
        if (max !== min) anyDiff = true;
      } else {
        const distinct = [...new Set(vals.map((v) => String(v)))];
        dispersion[path] = { kind: "categorical", distinctValues: distinct, n: vals.length };
        if (distinct.length > 1) anyDiff = true;
      }
    }
    if (!anyDiff) continue; // 跨源但取值一致 → 不算分歧

    const times = reps.map((r) => r.meta.time).filter(Boolean).sort();
    hints.push({
      topic: String(topic),
      sources: reps.map((r) => ({
        source: r.meta.source, time: r.meta.time || null, sourcePath: r.sourcePath,
        values: Object.fromEntries(onPaths.map((p) => [p, resolveResultPath(r, p)])),
      })),
      dispersion,
      timeSpan: times.length ? { from: times[0], to: times[times.length - 1] } : null,
    });
  }
  return hints;
}

// hybrid 检索的「无库绑定」核心:对一个**已加载的索引**做 查询改写 → 词法 + 向量 → RRF。
// searchWiki(wiki 索引)与 knowledge-base.searchKb(任意 KB 索引)共用此函数(一条路径,不重造)。
// Phase5 v151:asOf=点时过滤(丢 meta.time>asOf,防未来泄漏;无 time 保留);index.temporal+index.conflict
// → 在 wide 融合集上派生 conflictHints(不挤占 topK)。非时态库/无 asOf → 行为同旧。
export async function hybridSearchOverIndex(queryText, index, { topK = 5, asOf = null, embedModel = null, rerank = null, lexicalScoring = null } = {}) {
  const text = String(queryText || "").trim();
  if (!text || !index || !Array.isArray(index.chunks) || index.chunks.length === 0) {
    return { ok: false, degraded: true, results: [] };
  }
  // asOf 点时过滤:仅对带 meta.time 的 chunk 生效;无 time 的保留(不是"未来",只是无时间标注)。
  const scopedIndex = asOf
    ? { ...index, chunks: index.chunks.filter((c) => !c?.meta?.time || String(c.meta.time) <= String(asOf)) }
    : index;
  if (!scopedIndex.chunks.length) return { ok: false, degraded: true, results: [] };

  const q = rewriteQuery(text); // 剥离填充词,让真术语主导(向量+词法都用改写后查询)

  const wide = Math.max(topK * 4, 20); // 宽召回供融合 + 分歧派生
  // 词法档位:显式入参优先(评测台/A-B 与本机配置解耦),否则读 openclaw.json。实测读盘+解析
  // 66 µs/次(15 KB 配置,500 次热态均值),与同一函数里的 embed 配置读同量级,远低于一次 embed 往返。
  const scoring = await resolveWikiRagLexicalConfig(lexicalScoring);
  const lexical = await searchWikiRagLexical(q, { topK: wide, index: scopedIndex, scoring }); // 词法不需 ollama,总能算

  let vector = [];
  let degraded = false;
  try {
    const cfg = await resolveWikiRagEmbedConfig();
    // embedModel override(A/B 评测:查询须与索引同模型,否则向量不可比);默认走配置。
    const queryEmbedding = await embedText(q, { model: embedModel || cfg.model, baseUrl: cfg.baseUrl });
    vector = await searchWikiRag(queryEmbedding, { topK: wide, index: scopedIndex });
  } catch {
    degraded = true; // embed 不可用 → 退化成词法-only(仍有结果)
  }

  if (vector.length === 0 && lexical.length === 0) {
    return { ok: false, degraded: true, results: [] };
  }
  const fused = rrfFuse([vector, lexical], { topK: wide }); // wide 供分歧 + rerank;results 仍切 topK
  const cap = Math.max(1, Number(topK) || 5);

  // P0-2:可选 LLM rerank(默认关)。rerank===false 直接跳(默认路径零 config 读);否则读配置,
  // rerank===true 强开 / null 看 watchdog.wikiRag.rerank。LLM 不可用/解析失败 → rerankResults 内部
  // 优雅退化保持 RRF 序(同 degraded 语义)。conflictHints 仍用 fused 宽集(rerank 只影响 results 序)。
  let results = fused.slice(0, cap);
  let reranked = false;
  if (rerank !== false && fused.length > 1) {
    const rcfg = await resolveWikiRagRerankConfig();
    if (rerank === true || rcfg.enabled) {
      results = await rerankResults(q, fused, { model: rcfg.model, baseUrl: rcfg.baseUrl, topN: cap });
      reranked = true;
    }
  }

  const out = { ok: true, degraded, results };
  if (reranked) out.reranked = true;
  if (index.temporal && index.conflict) {
    const conflictHints = deriveConflictHints(fused, index.conflict);
    if (conflictHints.length) out.conflictHints = conflictHints;
  }
  return out;
}

export async function searchWiki(queryText, { topK = 5 } = {}) {
  let index;
  try {
    index = await loadWikiRagIndex();
  } catch {
    return { ok: false, degraded: true, results: [] };
  }
  return hybridSearchOverIndex(queryText, index, { topK });
}

// 纯向量检索(对比/回退用;recall 评测对比 hybrid vs vector 的 delta)。
export async function searchWikiVector(queryText, { topK = 5 } = {}) {
  const text = String(queryText || "").trim();
  if (!text) return { ok: false, degraded: true, results: [] };
  let index;
  try {
    index = await loadWikiRagIndex();
  } catch {
    return { ok: false, degraded: true, results: [] };
  }
  if (!index || !Array.isArray(index.chunks) || index.chunks.length === 0) {
    return { ok: false, degraded: true, results: [] };
  }
  try {
    const { model, baseUrl } = await resolveWikiRagEmbedConfig();
    const queryEmbedding = await embedText(text, { model, baseUrl });
    return { ok: true, results: await searchWikiRag(queryEmbedding, { topK, index }) };
  } catch {
    return { ok: false, degraded: true, results: [] };
  }
}
