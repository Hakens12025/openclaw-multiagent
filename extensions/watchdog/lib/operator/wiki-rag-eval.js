// wiki-rag-eval.js — wiki-RAG 召回率评测(recall@k + MRR)
//
// 纯函数:接收 searchFn(query,{topK})→{ok,results:[{sourcePath,...}]}，对评测集逐条算
// 期望 sourcePath 出现在 top-k 的命中。可单测(fake searchFn,无 ollama)+ live(真 searchWiki)。
// 判定单位=sourcePath（section 级 heading 太细,见 wiki-rag-store 搜索结果形状）。

// Phase5 v153:case 可选声明 asOf(点时评测,防未来泄漏)、verdictStatus(undecided 不计入 recall)、
// ghostSourcePaths(已知被现实推翻/过时的路径,进 top-k=幽灵命中)。三者皆可选,旧评测集(无这些字段)
// 行为逐字节不变(scored=全部、ghostHitRate=null、abstained=0)。recall@k 对幽灵结论失明 → ghostHitRate 补它。
export async function evaluateWikiRagRecall(cases, searchFn, { ks = [1, 3, 5, 10], topK = 10 } = {}) {
  const list = Array.isArray(cases) ? cases : [];
  const kMax = Math.max(...ks);
  const perCase = [];
  for (const c of list) {
    const res = await searchFn(c.query, { topK, asOf: c.asOf || null });
    const results = res && res.ok && Array.isArray(res.results) ? res.results : [];
    const paths = results.map((r) => r.sourcePath);
    const rank = paths.indexOf(c.expectedSourcePath); // 0-based;-1=未命中
    const ghostPaths = Array.isArray(c.ghostSourcePaths) ? c.ghostSourcePaths : [];
    const ghostRank = ghostPaths.length
      ? Math.min(...ghostPaths.map((g) => { const i = paths.indexOf(g); return i === -1 ? Infinity : i; }))
      : Infinity;
    perCase.push({
      query: c.query,
      category: c.category || null,
      expected: c.expectedSourcePath,
      rank,
      hit: rank !== -1,
      topPaths: paths.slice(0, 5),
      verdictStatus: c.verdictStatus || null,
      hasGhost: ghostPaths.length > 0,
      ghostHit: ghostRank < kMax, // 幽灵进 top-kMax
    });
  }

  // recall/MRR/byCategory 只算 scored(排除 undecided——悬而未决不可评,计入分子分母都污染)。
  const scored = perCase.filter((p) => p.verdictStatus !== "undecided");
  const denom = scored.length || 1;
  const recallAt = {};
  for (const k of ks) {
    recallAt[k] = scored.filter((p) => p.rank !== -1 && p.rank < k).length / denom;
  }
  const mrr = scored.reduce((s, p) => s + (p.rank === -1 ? 0 : 1 / (p.rank + 1)), 0) / denom;

  const byCategory = {};
  for (const p of scored) {
    const cat = p.category || "uncategorized";
    if (!byCategory[cat]) byCategory[cat] = { total: 0, hit: 0 };
    byCategory[cat].total += 1;
    if (p.rank !== -1 && p.rank < kMax) byCategory[cat].hit += 1;
  }

  // ghostHitRate:有 ghost 标注的 case 里,top-kMax 命中幽灵的比例(越低越好;null=无标注)。
  const ghostCases = perCase.filter((p) => p.hasGhost);
  const ghostHitRate = ghostCases.length ? ghostCases.filter((p) => p.ghostHit).length / ghostCases.length : null;

  return {
    total: perCase.length,
    evaluated: scored.length,
    abstained: perCase.length - scored.length,
    recallAt,
    mrr,
    byCategory,
    perCase,
    ghostHitRate,
    ghostEvaluated: ghostCases.length,
  };
}

// 格式化为可读报告（live runner / 测试日志用）。
export function formatRecallReport(result) {
  const lines = [];
  lines.push(`wiki-RAG recall (n=${result.total}):`);
  for (const [k, v] of Object.entries(result.recallAt)) {
    lines.push(`  recall@${k}: ${(v * 100).toFixed(1)}%`);
  }
  lines.push(`  MRR: ${result.mrr.toFixed(3)}`);
  if (result.abstained) lines.push(`  abstained (undecided): ${result.abstained} (recall over ${result.evaluated})`);
  if (result.ghostHitRate != null) lines.push(`  ghostHitRate: ${(result.ghostHitRate * 100).toFixed(1)}% (over ${result.ghostEvaluated} ghost-annotated)`);
  lines.push("  by category:");
  for (const [cat, s] of Object.entries(result.byCategory)) {
    lines.push(`    ${cat}: ${s.hit}/${s.total}`);
  }
  const misses = result.perCase.filter((p) => !p.hit);
  if (misses.length) {
    lines.push(`  misses (${misses.length}):`);
    for (const m of misses) lines.push(`    "${m.query}" → expected ${m.expected}, got [${m.topPaths.join(", ")}]`);
  }
  return lines.join("\n");
}

// ── 生成侧评测(122 P1-3,faithfulness/context-precision)──
// recall@k 只证「检索对了」(对的 chunk 进 top-k);生成侧度量证「用对了」。judgeFn 注入(同 searchFn
// 模式)= LLM-as-judge,纯函数边界 → 可单测(fake judge,确定式)+ live(本地 qwen 见 wiki-rag-judge.js)。

// faithfulness:检索到的 context 是否真支撑答案(RAGAS faithfulness)。case 需带 answer(gold)。
// judgeFn({query,context[],answer}) → {supported:bool}。votes 次多数表决降方差(judge 需带温度才有意义)。
export async function evaluateFaithfulness(cases, searchFn, judgeFn, { topK = 5, votes = 3 } = {}) {
  const list = (Array.isArray(cases) ? cases : []).filter((c) => c.query && c.answer);
  const perCase = [];
  for (const c of list) {
    const res = await searchFn(c.query, { topK, asOf: c.asOf || null });
    const context = (res && res.ok && Array.isArray(res.results) ? res.results : []).map((r) => r.text || "");
    const verdicts = [];
    for (let i = 0; i < Math.max(1, votes); i += 1) {
      const v = await judgeFn({ query: c.query, context, answer: c.answer }).catch(() => null);
      if (v) verdicts.push(v.supported === true);
    }
    const supportedCount = verdicts.filter(Boolean).length;
    const faithful = verdicts.length > 0 && supportedCount * 2 > verdicts.length; // 严格多数
    perCase.push({ query: c.query, faithful, votes: verdicts.length, supportedCount, contextSize: context.length });
  }
  const evaluated = perCase.length;
  return {
    total: perCase.length,
    faithfulness: evaluated ? perCase.filter((p) => p.faithful).length / evaluated : null,
    perCase,
  };
}

// context-precision:召回 context 的信噪比——召回的 chunk 里多少真与 query 相关(逐 chunk LLM 判)。
// judgeFn({query,chunk}) → {relevant:bool}。precision = 相关 chunk / 召回总数,跨 case 取均值。
export async function evaluateContextPrecision(cases, searchFn, judgeFn, { topK = 5 } = {}) {
  const list = (Array.isArray(cases) ? cases : []).filter((c) => c.query);
  const perCase = [];
  for (const c of list) {
    const res = await searchFn(c.query, { topK, asOf: c.asOf || null });
    const chunks = res && res.ok && Array.isArray(res.results) ? res.results : [];
    let relevant = 0;
    for (const ch of chunks) {
      const v = await judgeFn({ query: c.query, chunk: ch.text || "" }).catch(() => null);
      if (v && v.relevant === true) relevant += 1;
    }
    perCase.push({ query: c.query, retrieved: chunks.length, relevant, precision: chunks.length ? relevant / chunks.length : 0 });
  }
  const evaluated = perCase.length;
  return {
    total: perCase.length,
    contextPrecision: evaluated ? perCase.reduce((s, p) => s + p.precision, 0) / evaluated : null,
    perCase,
  };
}
