// lib/knowledge/wiki-rag-eval.js — wiki-RAG 召回率评测(recall@k + MRR)
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
    // expectedKeywords 此前 24/24 的 fixture 都声明、registry 也归一化,但没有任何评测器读它 ——
    // 制造了"还额外校验了关键词"的假象。接上而不是删掉,因为它与 recall@k 真正正交:recall 判
    // sourcePath(文档级),关键词判「交给 LLM 的 context 文本里是否真含答案术语」。切分器改动导致
    // "文件对了但捞回的是错的段落"时 recall@k 完全失明,keywordCoverage 能抓到。零 LLM/零 ollama
    // (纯子串匹配,text 已在检索结果里),且不参与 recall/MRR/byCategory 任何计算。
    const keywords = Array.isArray(c.expectedKeywords) ? c.expectedKeywords.filter(Boolean) : [];
    // 只看 r.text:与 evaluateFaithfulness 对 context 的定义保持一致(那里也只取 r.text)。
    const haystack = keywords.length ? results.map((r) => r.text || "").join("\n").toLowerCase() : "";
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
      keywordTotal: keywords.length,
      keywordHits: keywords.filter((kw) => haystack.includes(String(kw).toLowerCase())).length,
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

  // keywordCoverage:逐 case 覆盖率再取均值(不是关键词总数的微平均——那样关键词多的 case 会
  // 悄悄主导指标)。只算 scored,理由同 recall:undecided 悬而未决不可评。null=没人标关键词。
  const keywordCases = scored.filter((p) => p.keywordTotal > 0);
  const keywordCoverage = keywordCases.length
    ? keywordCases.reduce((s, p) => s + p.keywordHits / p.keywordTotal, 0) / keywordCases.length
    : null;

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
    keywordCoverage,
    keywordEvaluated: keywordCases.length,
  };
}

// 排名的可比序:rank=-1 是"未命中",语义上比任何真实名次都差,必须映射到 Infinity。
// 直接比原始数值会同时犯两个方向的错——把 rank2 → 未命中(2 < -1 为假)这个最严重的回归漏报,
// 又把 未命中 → rank3(-1 < 3 为真)误报成降级。
function rankOrder(rank) {
  return Number.isInteger(rank) && rank >= 0 ? rank : Infinity;
}

function formatRank(rank) {
  return rankOrder(rank) === Infinity ? "miss" : `rank${rank}`;
}

// 按 query 配对两次 run 的 perCase,列出降级/升级。纯函数,零 IO。
// 动机(审计实测):落盘只有聚合数字时,两次 run 的差异只能拿 recall@1 的百分比互猜——本会话就因此
// 在 2 例之差上折腾了三轮。配对后不仅能直接点名谁退化,discordant pair(demotions/promotions 的计数)
// 也正是 McNemar 检验的输入。只比较两边都出现的 query;缺失的记入 unpaired(无从判断,不猜)。
export function diffRecallRanks(baselinePerCase, currentPerCase) {
  const base = new Map();
  for (const p of Array.isArray(baselinePerCase) ? baselinePerCase : []) {
    if (p && p.query) base.set(p.query, p);
  }
  const current = Array.isArray(currentPerCase) ? currentPerCase : [];
  const demotions = [];
  const promotions = [];
  let paired = 0;
  for (const cur of current) {
    const prev = cur && cur.query ? base.get(cur.query) : null;
    if (!prev) continue;
    paired += 1;
    const before = rankOrder(prev.rank);
    const after = rankOrder(cur.rank);
    if (before === after) continue;
    const row = {
      query: cur.query,
      rankBefore: prev.rank,
      rankAfter: cur.rank,
      expected: cur.expected || prev.expected || null,
    };
    (after > before ? demotions : promotions).push(row);
  }
  return { paired, unpaired: current.length - paired, demotions, promotions };
}

// 格式化为可读报告（live runner / 测试日志用）。
// baselinePerCase 可选:给了就把「相对基线的降级」也打出来(见下方 misses 段的说明)。
export function formatRecallReport(result, { baselinePerCase = null } = {}) {
  const lines = [];
  lines.push(`wiki-RAG recall (n=${result.total}):`);
  for (const [k, v] of Object.entries(result.recallAt)) {
    lines.push(`  recall@${k}: ${(v * 100).toFixed(1)}%`);
  }
  lines.push(`  MRR: ${result.mrr.toFixed(3)}`);
  if (result.abstained) lines.push(`  abstained (undecided): ${result.abstained} (recall over ${result.evaluated})`);
  if (result.ghostHitRate != null) lines.push(`  ghostHitRate: ${(result.ghostHitRate * 100).toFixed(1)}% (over ${result.ghostEvaluated} ghost-annotated)`);
  if (result.keywordCoverage != null) lines.push(`  keywordCoverage: ${(result.keywordCoverage * 100).toFixed(1)}% (over ${result.keywordEvaluated} keyword-annotated)`);
  lines.push("  by category:");
  for (const [cat, s] of Object.entries(result.byCategory)) {
    lines.push(`    ${cat}: ${s.hit}/${s.total}`);
  }
  const misses = result.perCase.filter((p) => !p.hit);
  if (misses.length) {
    lines.push(`  misses (${misses.length}):`);
    for (const m of misses) lines.push(`    "${m.query}" → expected ${m.expected}, got [${m.topPaths.join(", ")}]`);
  }
  // 只列 !hit 等价于只列 rank===-1 ——「掉出 rank1 但仍在 top-5」的降级在报告里根本不打印,
  // 而这恰是切分/融合改动最常见的退化形态(本次评测争议正是这一种)。给了基线就把它列出来。
  if (baselinePerCase) {
    const diff = diffRecallRanks(baselinePerCase, result.perCase);
    lines.push(`  vs baseline (paired ${diff.paired}, unpaired ${diff.unpaired}): ${diff.demotions.length} demoted, ${diff.promotions.length} promoted`);
    for (const d of diff.demotions) lines.push(`    ↓ "${d.query}" ${formatRank(d.rankBefore)} → ${formatRank(d.rankAfter)}`);
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
