// lib/knowledge/result-diversity.js — 检索结果的来源多样性:同源上限裁剪 + 覆盖度量尺。
//
// 【为什么这两件事必须同一个模块】per-source cap 在 recall@k / MRR 上的正向 delta 是**数学必然,
// 而非证据**:稳定分区只把某来源第二次及以后的条目降到尾部,于是任一 sourcePath 的首次出现名次
// 只会前移或保持 → 以 sourcePath 判定的 recall@k / MRR 单调不降(tests 里以「置换 + 首现单调」
// 两条性质断言把这个证明机械化)。所以裁剪的收益要用**独立的来源覆盖类指标**来量,尺与刀同处一室,
// 读代码的人一眼看见「这把刀的收益得用那把尺量」。
//
// 全部纯函数、零依赖、零 IO。输入形状 = 检索结果数组 [{sourcePath, ...}],与 wiki-rag-store.js:477
// (向量腿)/ :522(词法腿)/ wiki-rag-search.js:52(RRF 融合)的输出同形;其余字段原样透传。
// 度量类函数也接受纯路径字符串数组,便于评测侧直接喂 paths。

// 结果项 → sourcePath。字符串直接当路径用(评测侧常已 map 成 paths)。
const pathOf = (item) => (typeof item === "string" ? item : (item && item.sourcePath) || "");

// 度量口径:缺 sourcePath 的条目既不进分子也不进分母(与 scripts/kb-diversity.js:37 的
// .filter(Boolean) 一致,基线数字就是这么算出来的)。
function sourcePaths(results) {
  return (Array.isArray(results) ? results : []).map(pathOf).filter(Boolean);
}

// ── 刀:同源上限裁剪 ──────────────────────────────────────────────────────

// 稳定分区式同源上限:每个来源的前 maxPerSource 条留在头部,溢出条**降到尾部而非删除**
// → 输出是输入的置换,召回集合本身保持完整,只有名次重排。
// maxPerSource 缺省 / 0 / 负数 / 非有限值 → 原样返回**同一个数组引用**(默认关 = 与今天逐字节等价)。
// sourcePath 缺失的条目按空串归为同一组,与 scripts/kb-replay.js:133 的既有实现口径一致。
export function capPerSource(list, maxPerSource) {
  const cap = Number(maxPerSource);
  if (!Array.isArray(list) || !Number.isFinite(cap) || cap <= 0) return list;
  const seen = new Map();
  const head = [];
  const tail = [];
  for (const item of list) {
    const key = pathOf(item);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    (n <= cap ? head : tail).push(item);
  }
  return head.concat(tail);
}

// ── 尺:单条结果列表 ──────────────────────────────────────────────────────

// 这一条列表覆盖了多少个互异来源。
export function distinctSourceCount(results) {
  return new Set(sourcePaths(results)).size;
}

// 被同源重复占用的名额占比,值域 [0,1)。空列表 → 0(0 个名额里 0 个被重复占用)。
export function dupSlotRate(results) {
  const paths = sourcePaths(results);
  if (paths.length === 0) return 0;
  return (paths.length - new Set(paths).size) / paths.length;
}

// S-Recall@k(subtopic recall,Zhai 2003;此处以 sourcePath 近似"子话题")。
// 分子 = top-k 里落在 universe 内的互异来源数。分母两种口径,按需索取:
//   ① universe 给了(gold 子话题集,或**截断前的候选池**)→ 真正的子话题召回:
//      「这 k 个名额把可得的多样性覆盖了多少」。A/B 裁剪时把宽集当 universe,量的正是裁剪的收益。
//   ② universe 缺省 → 分母 = min(k, 槽位数) = 这 k 个名额**最多**能装下的互异来源数,
//      得到"槽位多样性达成率";此口径下它恒等于 1 - dupSlotRate(同一事实的另一种归一化),
//      真正独立的信息量来自口径 ①。
// 分母为 0(universe 为空 / k<=0 / 无有效槽位)→ null,与 keywordCoverage 的 null 语义一致。
export function sRecallAtK(results, k, { universe = null } = {}) {
  const kNum = Number(k);
  const window = Number.isFinite(kNum) && kNum > 0 ? Math.floor(kNum) : 0;
  const paths = sourcePaths(results);
  const covered = new Set(paths.slice(0, window));
  if (universe) {
    const universeSet = new Set(sourcePaths(universe));
    if (universeSet.size === 0) return null;
    let hit = 0;
    for (const p of covered) if (universeSet.has(p)) hit += 1;
    return hit / universeSet.size;
  }
  const denom = Math.min(window, paths.length);
  return denom > 0 ? covered.size / denom : null;
}

// ── 尺:整个评测集 ────────────────────────────────────────────────────────

// 每个来源在整个评测集里被召回的次数。Gini 的输入,也可单独看谁被系统性偏好。
export function sourceFrequency(resultLists) {
  const counts = new Map();
  for (const list of Array.isArray(resultLists) ? resultLists : []) {
    for (const p of sourcePaths(list)) counts.set(p, (counts.get(p) || 0) + 1);
  }
  return counts;
}

// 计数分布的 Gini 系数,值域 [0, (n-1)/n]:0 = 完全均匀,越大越集中。
// G = 2·Σ i·x_i / (n·Σ x_i) − (n+1)/n,x 升序,i 从 1 计。
//
// 【口径边界 —— 结论完全取决于这里,故显式声明】
//   默认总体 = **被召回过至少一次的来源**(observed support),量的是"露过面的文档之间是否厚此薄彼"。
//   传 universeSize 则把总体扩到整库(缺席文档按 0 次补齐),量的是"整库有多少文档从未露面"。
//   后者在 语料规模 >> 查询数×位数 时会趋近 1 —— 那是名额算术的结果(24 例 × 10 位 = 240 个名额
//   面对 452 块语料,大多数块必然 0 次),把它当"系统偏好"的发现会重犯"数学必然当证据"的错。
//   因此默认取前者,后者显式索取。
// n=0 或总召回次数为 0 → null(无观测,与"值为 0"不同);n=1 → 0。
export function giniOfCounts(counts, { universeSize = null } = {}) {
  const raw = counts instanceof Map ? [...counts.values()] : Array.isArray(counts) ? counts : [];
  const observed = raw.map(Number).filter((v) => Number.isFinite(v) && v >= 0);
  const size = Number(universeSize);
  const pad = Number.isFinite(size) ? Math.max(0, Math.floor(size) - observed.length) : 0;
  const values = observed.concat(new Array(pad).fill(0)).sort((a, b) => a - b);
  const n = values.length;
  const total = values.reduce((s, v) => s + v, 0);
  if (n === 0 || total === 0) return null;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) weighted += (i + 1) * values[i];
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export function retrievalGini(resultLists, { universeSize = null } = {}) {
  return giniOfCounts(sourceFrequency(resultLists), { universeSize });
}

// 评测集级聚合 = 检索侧 A/B 的读数面。resultLists 的每一项 = 一条查询**已截断到展示位数**的结果。
//
// dupSlotRate 沿用 scripts/kb-diversity.js:51 的既有口径:**微平均**(总重复名额 / 总名额),
// 而非逐查询比率再取均值 —— 后者会让只召回 2 条的查询与召回 10 条的查询等权。
// 空结果的查询计入 empty,并从 distinctAvg / affectedRate / sRecallAvg 的分母里让开
// (与 kb-diversity.js:38 的 continue 一致;基线 distinctAvg 5.13 / 7.59 就是这么算的)。
// sRecallAvg 取宏平均(逐查询再平均),与微平均的 dupSlotRate 互为参照。
// 返回值一律是**比例 [0,1] 的原始数**,百分号与小数位交给展示层(与 wiki-rag-eval.js 的
// recallAt / keywordCoverage 同约定,保持一处真值)。
export function coverageReport(resultLists, { k = null, universeSize = null } = {}) {
  const lists = (Array.isArray(resultLists) ? resultLists : []).map(sourcePaths);
  const scored = lists.filter((paths) => paths.length > 0);
  let slots = 0;
  let dupSlots = 0;
  let affected = 0;
  let distinctSum = 0;
  let sRecallSum = 0;
  for (const paths of scored) {
    const distinct = new Set(paths).size;
    const dup = paths.length - distinct;
    slots += paths.length;
    distinctSum += distinct;
    if (dup > 0) {
      dupSlots += dup;
      affected += 1;
    }
    sRecallSum += sRecallAtK(paths, k == null ? paths.length : k) ?? 0;
  }
  const queries = scored.length;
  return {
    queries,
    empty: lists.length - queries,
    slots,
    dupSlots,
    dupSlotRate: slots ? dupSlots / slots : 0,
    affectedRate: queries ? affected / queries : 0,
    distinctAvg: queries ? distinctSum / queries : 0,
    sRecallAvg: queries ? sRecallSum / queries : 0,
    gini: giniOfCounts(sourceFrequency(resultLists), { universeSize }),
  };
}
