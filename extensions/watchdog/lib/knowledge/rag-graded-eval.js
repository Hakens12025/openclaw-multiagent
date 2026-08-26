// lib/knowledge/rag-graded-eval.js — 分级相关性检索评测(nDCG + 分级 RR)
//
// 【它解决什么】同目录 wiki-rag-eval.js:18 用 `paths.indexOf(c.expectedSourcePath)` 做二值判定:
// 每题一个 gold、命中与否是 0/1 悬崖。由此得到两个病:
//   ① 高方差 —— 一题从未命中跳到 rank-1,ΔRR 就是 1.0;绝大多数题完全不动,ΔRR=0。零膨胀 + 少数
//      巨幅 → sd 大 → MDE 大(memos 实测 sd=0.2308、MDE=0.0719,而真实效应只有 0.0402,量不出来)。
//   ② pooling bias —— 某篇同样贴题却从未被检回过,它就进不了 gold 名单,检索系统被系统性低估。
// 分级标注同时治这两条:一题可有 primary(3) / secondary(2) / marginal(1),名次的小幅变化也能反映
// 成分数的小幅变化 → 分布填满 0 与 1 之间 → 方差下降。
//
// 【与二值评测并存,而非替换】现有 84+24 例大部分尚无分级标注,二值路继续是默认。本模块对
// 未标注的 case 优雅退化,且退化口径是**可证的恒等**(见下方 gradedReciprocalRank 的说明)。
//
// 【判定单位 = sourcePath】与 wiki-rag-eval.js:5 一致。注意 wiki-rag-search.js:44 的 RRF 去重键是
// `sourcePath + heading`,同一篇文档的多个 section 会各占一个结果位。因此累加增益时每个 gold 路径
// 只记一次(取首次出现),这样 nDCG 保持在 [0,1] 内;名次仍用**原始下标**,与 indexOf 逐位对齐。
//
// 【统计尺复用】sd / MDE / 反解样本量一律调 rag-stats.js,本文件不自建第二套统计实现。

import { reciprocalRank, minimumDetectableEffect, requiredPairCount } from "./rag-stats.js";

// ── 标注读取 ────────────────────────────────────────────────────────────────

export const GRADE_PRIMARY = 3;
export const GRADE_SECONDARY = 2;
export const GRADE_MARGINAL = 1;

const asList = (value) =>
  (Array.isArray(value) ? value : value ? [value] : []).filter((x) => typeof x === "string" && x.length > 0);

// case → Map(sourcePath → 等级)。
// 写入顺序 marginal → secondary → primary,于是同一路径被多个桶声明时**高等级覆盖低等级**。
// expectedSourcePath 仅在三个分级桶都没提到它时才补成 primary:
//   · 补 —— 保证二值腿的 gold 必定也是分级腿的 gold,两条腿对「什么算对」的定义保持一致;
//   · 仅在缺席时补 —— 标注者若刻意把 expectedSourcePath 降格进 secondary/marginal,该意图被尊重。
function goldMap(evalCase) {
  const c = evalCase && typeof evalCase === "object" ? evalCase : {};
  const map = new Map();
  // 字段名跟随 fixture 既有约定(expectedSourcePath / ghostSourcePaths),而不是另起一套 —— 
  // 同一个 fixture 文件里两种命名风格会让下一个人不知道该写哪个,那就是第二真值的雏形。
  for (const p of asList(c.marginalSourcePaths)) map.set(p, GRADE_MARGINAL);
  for (const p of asList(c.secondarySourcePaths)) map.set(p, GRADE_SECONDARY);
  for (const p of asList(c.expectedSourcePath)) if (!map.has(p)) map.set(p, GRADE_PRIMARY);
  return map;
}

// 该 case 是否带真正的分级标注(三个桶里有任意一个非空)。仅靠 expectedSourcePath 的 case = 退化例。
export function hasGradedAnnotation(evalCase) {
  const c = evalCase && typeof evalCase === "object" ? evalCase : {};
  return asList(c.secondarySourcePaths).length > 0 || asList(c.marginalSourcePaths).length > 0;
}

// 某路径在该题下的相关性等级:primary=3 / secondary=2 / marginal=1 / 其余=0。
// ghostSourcePaths(已知过时或被推翻的路径)在这里记 0 而非负值 —— 负增益会让 nDCG 的归一化失去
// [0,1] 边界。幽灵仍由 wiki-rag-eval.js:65 的 ghostHitRate 单独度量,两把尺各司其职。
export function gradedGain(evalCase, sourcePath) {
  if (typeof sourcePath !== "string" || !sourcePath) return 0;
  return goldMap(evalCase).get(sourcePath) || 0;
}

// ── 结果规整 ────────────────────────────────────────────────────────────────

// 接受三种形状,归一成「按名次排列的 sourcePath 数组」:
//   · 字符串数组 · 检索结果数组 [{sourcePath,...}] · searchFn 原始返回 {ok,results} · perCase 的 {paths}
// 缺 sourcePath 的条目保留为 ""(占位),使下标与 wiki-rag-eval.js:17-18 的 `results.map(...)` 逐位一致。
function toPathList(results) {
  const list = Array.isArray(results)
    ? results
    : results && Array.isArray(results.results)
      ? results.results
      : results && Array.isArray(results.paths)
        ? results.paths
        : [];
  return list.map((r) => (typeof r === "string" ? r : r && typeof r.sourcePath === "string" ? r.sourcePath : ""));
}

// 指数增益 2^g - 1(Burges 2005,现代 IR 与 ML 文献里 nDCG 的主流口径):3→7、2→3、1→1、0→0。
const gainWeight = (grade) => 2 ** grade - 1;

// 遍历名次表,对每个 gold 路径的**首次**出现累加 weight/discount(discount 由调用方给)。
// 首次出现即止,对应「同一篇文档的多个 section 各占一位」的现实(wiki-rag-search.js:44)。
function accumulate(paths, golds, discount, cut) {
  const limit = Number.isInteger(cut) && cut > 0 ? Math.min(cut, paths.length) : paths.length;
  const counted = new Set();
  let acc = 0;
  for (let i = 0; i < limit; i += 1) {
    const path = paths[i];
    const grade = golds.get(path) || 0;
    if (grade > 0 && !counted.has(path)) {
      counted.add(path);
      acc += gainWeight(grade) / discount(i);
    }
  }
  return acc;
}

// 理想排序 = 该题全部已标注 gold 按等级降序,依次坐第 1、2、3… 位。
function idealScore(golds, discount, cut) {
  const grades = [...golds.values()].sort((a, b) => b - a);
  const limit = Number.isInteger(cut) && cut > 0 ? Math.min(cut, grades.length) : grades.length;
  let acc = 0;
  for (let i = 0; i < limit; i += 1) acc += gainWeight(grades[i]) / discount(i);
  return acc;
}

// ── 指标 ────────────────────────────────────────────────────────────────────

const LOG_DISCOUNT = (i) => Math.log2(i + 2); // 0-based 下标 i → 1-based 名次 i+1 → log2(名次+1)
const RANK_DISCOUNT = (i) => i + 1;           // 0-based 下标 i → 1-based 名次

// 标准 nDCG@k:DCG@k = Σ (2^g - 1)/log2(名次+1),理想 DCG 取该题全部 gold 按等级降序的前 k 位。
// 无任何标注(golds 为空)时返回 null 而非 0 —— 0 会被均值当成「检索很差」,null 表示「此题不可测」。
export function ndcgAtK(results, evalCase, k = 10) {
  const golds = goldMap(evalCase);
  if (golds.size === 0) return null;
  const cut = Number.isInteger(k) && k > 0 ? k : 10;
  const idcg = idealScore(golds, LOG_DISCOUNT, cut);
  return idcg > 0 ? accumulate(toPathList(results), golds, LOG_DISCOUNT, cut) / idcg : null;
}

// 分级倒数名次(gradedRR)。
//
// 【定义】把 nDCG 的对数折扣换成 1/名次,再对同一题的理想排序归一:
//     gRR = Σ_i w(g_i)/rank_i  ÷  Σ_j w(g_j^sorted)/j        (w(g) = 2^g - 1,rank 与 j 均 1-based)
//
// 【为什么这么定义】它在「该题只有一个 gold」时**逐字退化成二值 RR**:唯一 gold 的权重 w 在分子分母
// 里对消,gRR = (w/rank)/(w/1) = 1/rank,未命中则 0/w = 0。于是未标注分级的 case 走这条路,数值与
// wiki-rag-eval.js:53 的 RR 完全相同,而不是「近似」——退化口径因此是可证的恒等,不是约定。
//
// 【为什么方差比二值 RR 低】二值 RR 只盯一个 gold,分数的全部信息来自那一个名次。两种常见变化它看不见:
//   · 主 gold 名次不动、次相关文档从 rank6 升到 rank2 → 二值 ΔRR = 0;
//   · 主 gold 在两臂都落在 top-k 之外、但 B 臂捞回了一篇次相关 → 二值 ΔRR = 0(正是 pooling bias 的症状)。
// 这两类变化在分级口径下都产生小幅正 Δ,原本堆在 0 上的质量被摊开;同时「未命中 → rank1」这种
// 悬崖跳变的幅度从 1.0 被摊薄(其余 gold 仍未命中,拿不满分),两头一起收窄 → Δ 的 sd 下降。
// 【口径提醒】sd 变小本身不足以证明尺子更好(整体缩放同样能让 sd 变小)。真正的判据是与量纲无关的
// requiredN = ((z_α+z_β)·sd/Δ)²,它对缩放免疫。varianceComparison 因此把两者一起报。
export function gradedReciprocalRank(results, evalCase) {
  const golds = goldMap(evalCase);
  if (golds.size === 0) return null;
  const paths = toPathList(results);
  // 单 gold 直接走 reciprocalRank。数学上与下方通式同值,分出这一支是为了**逐位**相同:
  // 通式算 (7/3)/7 = 0.33333333333333337,而 1/3 = 0.3333333333333333,差 1 ULP。退化例的
  // 「等于二值 RR」是本模块的承诺而非巧合,让它精确到浮点位,断言就能用 assert.equal 钉死。
  // 通式与这一支的一致性由测试守着(两者在 1 ULP 内必须吻合),通式改动会立刻暴露。
  if (golds.size === 1) return reciprocalRank(paths.indexOf([...golds.keys()][0]));
  // 不设 k 截断:调用方交来多少名次就算多少(驱动器已按 topK 截过)。
  const best = idealScore(golds, RANK_DISCOUNT, 0);
  return best > 0 ? accumulate(paths, golds, RANK_DISCOUNT, 0) / best : null;
}

// ── 驱动器 ──────────────────────────────────────────────────────────────────

// 对一组 perCase 行做分级聚合。抽出来是因为要用两次:全体 measurable 一次、仅分级标注例一次。
function summarizeGraded(rows, ks) {
  const denom = rows.length || 1;
  const ndcgAt = {};
  for (const k of ks) ndcgAt[k] = rows.reduce((s, r) => s + (r.ndcg[k] || 0), 0) / denom;
  return {
    n: rows.length,
    ndcgAt,
    gradedMrr: rows.reduce((s, r) => s + (r.gradedRR || 0), 0) / denom,
  };
}

// 与 evaluateWikiRagRecall(wiki-rag-eval.js:10)同形状的驱动器:同样的入参、同样的 searchFn 契约、
// 同样把 verdictStatus==="undecided" 排除出计分集。区别是每例额外产出 ndcg 与 gradedRR。
//
// 二值腿(rank/hit/recallAt/mrr)照旧计算并一并返回 —— 它既是交叉校验(测试里与 evaluateWikiRagRecall
// 逐位对齐),也让 varianceComparison 能在**同一次检索**上比较两种口径,省掉第二轮 ollama 调用。
//
// 混着两种口径的聚合数字会骗人,因此返回里把三件事分开摆:全体 measurable 的分级均值、仅分级标注例的
// 分级均值(annotatedOnly)、以及退化例的条数与占比(degradedCases / degradedRatio)。
export async function evaluateGraded(cases, searchFn, { ks = [1, 3, 5, 10], topK = 10 } = {}) {
  const list = Array.isArray(cases) ? cases : [];
  const kMax = Math.max(...ks);
  const perCase = [];
  for (const c of list) {
    const res = await searchFn(c.query, { topK, asOf: c.asOf || null });
    const results = res && res.ok && Array.isArray(res.results) ? res.results : [];
    const paths = results.map((r) => r.sourcePath);
    const rank = paths.indexOf(c.expectedSourcePath); // 0-based;-1=未命中(与二值评测同一行算式)
    const ndcg = {};
    for (const k of ks) ndcg[k] = ndcgAtK(paths, c, k);
    perCase.push({
      query: c.query,
      category: c.category || null,
      expected: c.expectedSourcePath,
      rank,
      hit: rank !== -1,
      binaryRR: reciprocalRank(rank),
      gradedRR: gradedReciprocalRank(paths, c),
      ndcg,
      graded: hasGradedAnnotation(c),
      goldCount: goldMap(c).size,
      topPaths: paths.slice(0, 5),
      paths, // 全量名次表:让 varianceComparison 复用同一次检索重算,免于再跑一遍 searchFn
      verdictStatus: c.verdictStatus || null,
    });
  }

  const scored = perCase.filter((p) => p.verdictStatus !== "undecided");
  const measurable = scored.filter((p) => p.goldCount > 0); // 无任何 gold 的题不可测,排除而非记 0
  const denom = scored.length || 1;

  const recallAt = {};
  for (const k of ks) recallAt[k] = scored.filter((p) => p.rank !== -1 && p.rank < k).length / denom;
  const mrr = scored.reduce((s, p) => s + p.binaryRR, 0) / denom;

  const byCategory = {};
  for (const p of measurable) {
    const cat = p.category || "uncategorized";
    if (!byCategory[cat]) byCategory[cat] = { total: 0, hit: 0, ndcg: 0 };
    byCategory[cat].total += 1;
    if (p.rank !== -1 && p.rank < kMax) byCategory[cat].hit += 1;
    byCategory[cat].ndcg += (p.ndcg[kMax] || 0) / 1;
  }
  for (const stat of Object.values(byCategory)) stat.ndcg /= stat.total || 1;

  const graded = summarizeGraded(measurable, ks);
  const annotatedRows = measurable.filter((p) => p.graded);

  return {
    total: perCase.length,
    evaluated: scored.length,
    abstained: perCase.length - scored.length,
    unmeasurable: scored.length - measurable.length,
    // 二值腿(口径 = evaluateWikiRagRecall,分母 = scored)
    recallAt,
    mrr,
    // 分级腿(分母 = measurable)
    ndcgAt: graded.ndcgAt,
    gradedMrr: graded.gradedMrr,
    measurable: measurable.length,
    // 退化透明度:degradedCases 例仅有 expectedSourcePath,它们的 gradedRR 等同二值 RR
    gradedCases: annotatedRows.length,
    degradedCases: measurable.length - annotatedRows.length,
    degradedRatio: measurable.length ? (measurable.length - annotatedRows.length) / measurable.length : null,
    annotatedOnly: summarizeGraded(annotatedRows, ks),
    byCategory,
    perCase,
  };
}

// ── 口径对比(给主控验证「sd 真的降了」)──────────────────────────────────────

const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null);

// 一个指标的可检出性画像。sd/MDE/反解样本量全部走 rag-stats.js,不在此处另起统计实现。
function detectability(deltas, meanA, meanB, { alpha, power }) {
  const mde = minimumDetectableEffect(deltas, { alpha, power });
  return {
    meanA,
    meanB,
    delta: mde.observedDelta, // 与 meanB-meanA 恒等(同分母),留两份便于核对
    sd: mde.sd,
    mde: mde.mde,
    detectable: mde.detectable,
    // 要把当前这个量级的效应测显著,需要多少配对样本。对指标整体缩放免疫 → 跨口径可比。
    requiredN: requiredPairCount(mde.sd, mde.observedDelta, { alpha, power }),
  };
}

// 在**同一批 case、同一对检索结果**上,并排给出二值 RR / 分级 RR / nDCG@k 三种口径的
// ΔMRR、sd、MDE 与反解样本量。
//
// 入参:cases 与 resultsA/resultsB 等长同序,resultsA[i] 是 cases[i] 在 A 臂的检索结果
// (接受 [{sourcePath}] / ["path"] / {ok,results} / evaluateGraded 的 perCase 行)。
// 长度对不上直接抛错 —— 静默错位会产出一份格式漂亮、数字全错的报告,比报错危险得多
// (同样的理由见 rag-stats.js:99-108)。
//
// 【读法】sd 变小是必要条件而非充分条件:任何指标整体缩小都能让 sd 变小,同时效应也一起缩小。
// 结论看 requiredNRatio —— 它是 (sd/Δ)² 的比值,对缩放免疫。小于 1 才说明这把新尺子确实更灵敏。
export function varianceComparison(cases, resultsA, resultsB, { k = 10, alpha = 0.05, power = 0.8 } = {}) {
  const list = Array.isArray(cases) ? cases : [];
  const armA = Array.isArray(resultsA) ? resultsA : [];
  const armB = Array.isArray(resultsB) ? resultsB : [];
  if (armA.length !== list.length || armB.length !== list.length) {
    throw new Error(
      `varianceComparison: 需要与 cases(${list.length} 例)等长且同序的两臂检索结果(实得 A=${armA.length}, B=${armB.length})`,
    );
  }

  const binary = [];
  const gradedRR = [];
  const ndcg = [];
  let annotated = 0;
  let skipped = 0;
  const rowsA = { binary: [], gradedRR: [], ndcg: [] };
  const rowsB = { binary: [], gradedRR: [], ndcg: [] };

  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (!c || c.verdictStatus === "undecided" || goldMap(c).size === 0) {
      skipped += 1;
      continue;
    }
    if (hasGradedAnnotation(c)) annotated += 1;
    const pathsA = toPathList(armA[i]);
    const pathsB = toPathList(armB[i]);
    const pair = (a, b, bucket) => {
      rowsA[bucket].push(a);
      rowsB[bucket].push(b);
      return b - a;
    };
    binary.push(pair(reciprocalRank(pathsA.indexOf(c.expectedSourcePath)), reciprocalRank(pathsB.indexOf(c.expectedSourcePath)), "binary"));
    gradedRR.push(pair(gradedReciprocalRank(pathsA, c) || 0, gradedReciprocalRank(pathsB, c) || 0, "gradedRR"));
    ndcg.push(pair(ndcgAtK(pathsA, c, k) || 0, ndcgAtK(pathsB, c, k) || 0, "ndcg"));
  }

  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const opts = { alpha, power };
  const out = {
    n: binary.length,
    skipped,
    gradedAnnotated: annotated,
    degraded: binary.length - annotated,
    k,
    binary: detectability(binary, mean(rowsA.binary), mean(rowsB.binary), opts),
    gradedRR: detectability(gradedRR, mean(rowsA.gradedRR), mean(rowsB.gradedRR), opts),
    ndcg: detectability(ndcg, mean(rowsA.ndcg), mean(rowsB.ndcg), opts),
    deltas: { binary, gradedRR, ndcg }, // 可直接喂 rag-stats.js 的 wilcoxonSignedRank / bootstrapMeanCI
  };
  out.sdRatio = { gradedRR: ratio(out.gradedRR.sd, out.binary.sd), ndcg: ratio(out.ndcg.sd, out.binary.sd) };
  out.requiredNRatio = {
    gradedRR: ratio(out.gradedRR.requiredN, out.binary.requiredN),
    ndcg: ratio(out.ndcg.requiredN, out.binary.requiredN),
  };
  out.gradedMoreSensitive = {
    gradedRR: Number.isFinite(out.requiredNRatio.gradedRR) && out.requiredNRatio.gradedRR < 1,
    ndcg: Number.isFinite(out.requiredNRatio.ndcg) && out.requiredNRatio.ndcg < 1,
  };
  return out;
}

// 格式化为可读报告(镜像 wiki-rag-eval.js:133 的 formatRecallReport 风格)。
export function formatGradedReport(result) {
  const lines = [`graded RAG eval (n=${result.total}, measurable=${result.measurable}):`];
  for (const [k, v] of Object.entries(result.ndcgAt)) lines.push(`  nDCG@${k}: ${v.toFixed(4)}`);
  lines.push(`  gradedMRR: ${result.gradedMrr.toFixed(4)}   binaryMRR: ${result.mrr.toFixed(4)}`);
  lines.push(`  graded-annotated: ${result.gradedCases}   degraded(binary-equivalent): ${result.degradedCases}`);
  if (result.abstained) lines.push(`  abstained (undecided): ${result.abstained}`);
  if (result.unmeasurable) lines.push(`  unmeasurable (no gold): ${result.unmeasurable}`);
  if (result.annotatedOnly.n) {
    lines.push(`  annotated-only subset (n=${result.annotatedOnly.n}): gradedMRR ${result.annotatedOnly.gradedMrr.toFixed(4)}`);
  }
  return lines.join("\n");
}
