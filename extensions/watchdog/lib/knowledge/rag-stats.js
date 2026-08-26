// lib/knowledge/rag-stats.js — 检索评测的统计尺(纯函数、零依赖、确定性)
//
// 【为什么需要它】今天判 A/B 用的是二值命中的符号检验:IDF 实测 25↑/15↓ → p=0.154,
// 而真正关心的估计量是 MRR(它对"名次前移但仍在 top-k"敏感,二值命中对此完全失明)。
// 符号检验丢弃幅度只留方向,在 1-3pp 效应量下功效天然不足 —— 于是"没测出来"和"没有效果"
// 长得一模一样。本模块把这两件事分开:
//   ① 对逐例 ΔRR(倒数名次差)做 Wilcoxon 符号秩 —— 它匹配 MRR 这个估计量,保留幅度;
//   ② 同时报符号检验 —— 两个都报,结论以事前约定的主检验为准;
//   ③ 报效应量与 ΔMRR 的置信区间 —— 让"多大"与"是否显著"分开说;
//   ④ 报 MDE(最小可检测效应)—— 把"这批样本本来就测不出这么小的差"从含糊变成一个数字。
//
// 【口径】rank 沿用 wiki-rag-eval.js 的 0-indexed 约定(-1=未命中 → RR=0),见该文件 :53。
// ΔRR = RR(after) - RR(before);ΔMRR = mean(ΔRR)(两臂同分母时逐字等价于 MRR 之差)。
//
// 【零依赖】本文件不 import 任何模块(含标准库),所有数值算法内联,便于在任何上下文里复用与自检。

// ── 数值基件 ────────────────────────────────────────────────────────────────

// mulberry32:32 位状态确定性 PRNG。bootstrap 需要"同 seed 同结果",用它取代 Math.random。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 标准正态上尾 P(Z >= z)。基于 Numerical Recipes 的 Chebyshev erfc(绝对误差 ~1e-10),
// 对报到 3-4 位有效数字的 p 值足够。
const ERFC_COF = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
  -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
  6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
  9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13,
  3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
];
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = ERFC_COF.length - 1; j > 0; j -= 1) {
    const tmp = d;
    d = ty * d - dd + ERFC_COF[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (ERFC_COF[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}
function normalSf(z) {
  return 0.5 * erfc(z / Math.SQRT2);
}

// 标准正态分位数(Acklam 有理逼近,相对误差 ~1.15e-9)。MDE 需要 z_{1-α/2} 与 z_{power}。
const AQ_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
const AQ_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const AQ_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const AQ_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
function normalQuantile(p) {
  const PLOW = 0.02425;
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  if (p < PLOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((AQ_C[0] * q + AQ_C[1]) * q + AQ_C[2]) * q + AQ_C[3]) * q + AQ_C[4]) * q + AQ_C[5])
      / ((((AQ_D[0] * q + AQ_D[1]) * q + AQ_D[2]) * q + AQ_D[3]) * q + 1);
  }
  if (p <= 1 - PLOW) {
    const q = p - 0.5;
    const r = q * q;
    return (((((AQ_A[0] * r + AQ_A[1]) * r + AQ_A[2]) * r + AQ_A[3]) * r + AQ_A[4]) * r + AQ_A[5]) * q
      / (((((AQ_B[0] * r + AQ_B[1]) * r + AQ_B[2]) * r + AQ_B[3]) * r + AQ_B[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((AQ_C[0] * q + AQ_C[1]) * q + AQ_C[2]) * q + AQ_C[3]) * q + AQ_C[4]) * q + AQ_C[5])
    / ((((AQ_D[0] * q + AQ_D[1]) * q + AQ_D[2]) * q + AQ_D[3]) * q + 1);
}

const finiteNumbers = (list) => (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(x));

// ── 名次 → 倒数名次 ─────────────────────────────────────────────────────────

// rank 是 0-indexed(rank0 = top-1),-1 = 未命中 → RR=0。
// 口径与 wiki-rag-eval.js:53 的 MRR 累加式逐字相同,评测集换算全部经过这里。
// 入参要求是真数值(evaluateWikiRagRecall 的 rank 由 indexOf 产出,天然是数值);
// null/undefined/字符串一律按未命中计 —— 保持 Number(null)===0 被当成 rank0 的可能性为零。
export function reciprocalRank(rank) {
  return Number.isInteger(rank) && rank >= 0 ? 1 / (rank + 1) : 0;
}

// 逐例配对名次 → ΔRR 数组。入参形状 = scripts/kb-replay.js `paired` 落盘的
// `.replay-cache/<kbId>-pairs.json`:[{ rankA, rankB, scored }],rankA=基线臂、rankB=变体臂。
// scored===false 的例子排除(与 evaluateWikiRagRecall 排除 undecided 同口径:悬而未决不可评)。
// 其他形状的调用方在自己那侧映射成这个形状,配对口径保持单一来源。
// 键名写错必须**抛错**,不能静默归零。缺 rankA/rankB 时 reciprocalRank(undefined) 返回 0,
// 该行会被当成"两臂都未命中"计入分母 —— 接线时把 diffRecallRanks 的 rankBefore/rankAfter
// 直接传进来(同目录 wiki-rag-eval.js:120-125 正是这组键名),会得到一份干净漂亮的
// "无显著差异、ΔMRR=0.000、p=1" 报告。统计工具给出静默的错误答案,比抛错危险得多。
export function pairedRankDeltas(pairs) {
  const out = [];
  for (const [i, p] of (Array.isArray(pairs) ? pairs : []).entries()) {
    if (!p || typeof p !== "object" || p.scored === false) continue;
    if (!("rankA" in p) || !("rankB" in p)) {
      throw new Error(`pairedRankDeltas: 第 ${i} 项缺 rankA/rankB(实得键 ${Object.keys(p).join(",")});调用方需自行映射成这组键名`);
    }
    out.push(reciprocalRank(p.rankB) - reciprocalRank(p.rankA));
  }
  return out;
}

// ── 符号翻转零分布(Wilcoxon 与符号检验共用同一条实现路径)────────────────────
// 两个检验的零假设是同一件事:每个配对的符号独立等概率翻转。差别只在"每次翻转携带多大权重"
// —— Wilcoxon 带秩,符号检验带 1。所以零分布由同一个 DP 产出,避免两套近似互相漂移。
// 概率空间 DP(而非计数)从根上回避 2^n 溢出;权重为整数时结果是二进制精确的二分有理数
// (n<=52 时逐位精确,例:n=4、k=3 的符号检验 p 恰为 0.625)。

function signFlipDistribution(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let dist = new Float64Array(total + 1);
  dist[0] = 1;
  for (const w of weights) {
    const next = new Float64Array(total + 1);
    for (let s = 0; s <= total; s += 1) {
      const p = dist[s];
      if (p === 0) continue;
      next[s] += 0.5 * p;
      next[s + w] += 0.5 * p;
    }
    dist = next;
  }
  return dist;
}

// 双侧 p = min(1, 2 * min(下尾, 上尾)),两尾都含观测值本身。零分布对称,该式即精确双侧值。
function twoSidedFromDistribution(dist, observed) {
  let lower = 0;
  let upper = 0;
  for (let s = 0; s < dist.length; s += 1) {
    const p = dist[s];
    if (p === 0) continue;
    if (s <= observed) lower += p;
    if (s >= observed) upper += p;
  }
  return Math.min(1, 2 * Math.min(lower, upper));
}

// 并列取平均秩(1-based)。返回与入参同序的秩数组 + 并列组大小(正态近似的方差修正要用)。
function averageRanks(values) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length);
  const tieGroups = [];
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j += 1;
    const mean = (i + j + 2) / 2; // 1-based 平均秩
    for (let k = i; k <= j; k += 1) ranks[idx[k]] = mean;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }
  return { ranks, tieGroups };
}

// 精确枚举的规模上限。Wilcoxon 的 DP 规模 ~ n^3(秩和上界 n(n+1));符号检验 ~ n^2。
// 超过上限走带并列修正 + 连续性校正的正态近似,并在结果里如实标 method。
const WILCOXON_EXACT_MAX_N = 200;
const SIGN_EXACT_MAX_N = 2000;

// ── 检验 ────────────────────────────────────────────────────────────────────

// Wilcoxon 符号秩(双侧)。主检验:它匹配我们真正关心的估计量 MRR(保留 ΔRR 的幅度),
// 对"名次前移但仍在 top-k"这种符号检验看不见的改进有功效。
// 零差值按 Wilcoxon 原法剔除后再定秩(Pratt 法保留零值,两者在零值占比高时结论可差,见文件末备注)。
// method:"auto"(默认,n<=200 走精确)| "exact" | "normal"。
// 精确档是**给定观测 |d| 的条件置换 p 值** —— 并列存在时依然精确,这点强于查表式精确检验。
export function wilcoxonSignedRank(deltas, { method = "auto" } = {}) {
  const all = finiteNumbers(deltas);
  const nonZero = all.filter((d) => d !== 0);
  const n = nonZero.length;
  const base = {
    n: all.length,
    nNonZero: n,
    zeros: all.length - n,
    wPlus: 0,
    wMinus: 0,
    statistic: 0,
    z: null,
    p: 1,
    method: "degenerate",
    hasTies: false,
  };
  if (n === 0) return base; // 全零差:两臂逐例同名次,证据量为零 → p=1

  const { ranks, tieGroups } = averageRanks(nonZero.map((d) => Math.abs(d)));
  let wPlus = 0;
  let wMinus = 0;
  for (let i = 0; i < n; i += 1) {
    if (nonZero[i] > 0) wPlus += ranks[i];
    else wMinus += ranks[i];
  }
  const hasTies = tieGroups.length > 0;
  const useExact = method === "exact" || (method === "auto" && n <= WILCOXON_EXACT_MAX_N);

  // 正态近似:μ=n(n+1)/4,σ² 带并列修正 Σ(t³-t)/48,连续性校正 0.5 朝均值方向。
  const mu = (n * (n + 1)) / 4;
  const tieCorrection = tieGroups.reduce((s, t) => s + (t ** 3 - t), 0) / 48;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection;
  const sigma = Math.sqrt(Math.max(variance, 0));
  const diff = wPlus - mu;
  const z = sigma > 0 ? (diff - Math.sign(diff) * 0.5) / sigma : 0;

  let p;
  if (useExact) {
    // 秩为 0.5 的整数倍 → 加倍后是整数,DP 才能按下标索引。
    const dist = signFlipDistribution(ranks.map((r) => Math.round(r * 2)));
    p = twoSidedFromDistribution(dist, Math.round(wPlus * 2));
  } else {
    p = Math.min(1, 2 * normalSf(Math.abs(z)));
  }

  return {
    n: all.length,
    nNonZero: n,
    zeros: all.length - n,
    wPlus,
    wMinus,
    statistic: Math.min(wPlus, wMinus), // 教科书常报的 W(两者较小值)
    z,
    p,
    method: useExact ? "exact" : "normal",
    hasTies,
  };
}

// 符号检验(精确二项,双侧,p0=0.5)。与 Wilcoxon 同时报:它只用方向、假设最弱,
// 是幅度分布怪异时的稳健对照。n 超上限时走带连续性校正的正态近似。
export function signTest(deltas) {
  const all = finiteNumbers(deltas);
  const positive = all.filter((d) => d > 0).length;
  const negative = all.filter((d) => d < 0).length;
  const n = positive + negative;
  if (n === 0) {
    return { n: all.length, nNonZero: 0, positive: 0, negative: 0, zeros: all.length, p: 1, method: "degenerate" };
  }
  let p;
  let method;
  if (n <= SIGN_EXACT_MAX_N) {
    p = twoSidedFromDistribution(signFlipDistribution(new Array(n).fill(1)), positive);
    method = "exact";
  } else {
    const mu = n / 2;
    const sigma = Math.sqrt(n / 4);
    const diff = positive - mu;
    p = Math.min(1, 2 * normalSf(Math.abs((diff - Math.sign(diff) * 0.5) / sigma)));
    method = "normal";
  }
  return { n: all.length, nNonZero: n, positive, negative, zeros: all.length - n, p, method };
}

// 效应量。主报 rankBiserial:它由 Wilcoxon 的统计量直接构成((W+ - W-)/(W+ + W-),Kerby 2014),
// 与主检验同一套秩、同一套零值口径,范围 [-1,1],对 ΔRR 这种零膨胀且有界的量稳健。
// cohenD 一并给出,因为 MDE/功效公式用的正是它的分母(ΔRR 的标准差),两者放一起可自洽核对。
export function pairedEffectSize(deltas) {
  const all = finiteNumbers(deltas);
  const n = all.length;
  const w = wilcoxonSignedRank(all, { method: "normal" }); // 只取 W+/W-,与 p 值算法无关
  const rankSum = w.wPlus + w.wMinus;
  const mean = n ? all.reduce((s, d) => s + d, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(all.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    nNonZero: w.nNonZero,
    rankBiserial: rankSum > 0 ? (w.wPlus - w.wMinus) / rankSum : 0,
    mean,
    sd,
    cohenD: sd > 0 ? mean / sd : null, // sd=0(全等差值)时 d 无定义,给 null 胜过给 Infinity
  };
}

// ΔMRR 的配对 bootstrap 百分位区间。重采样的是**配对差值**(同一例的两臂一起进出),
// 因此两臂的相关性天然被保留,方差比独立两样本法小得多。
// 确定性:自带 mulberry32,同 seed 同 samples 逐位可复现。
export function bootstrapMeanCI(deltas, { seed = 20260811, samples = 10000, level = 0.95 } = {}) {
  const all = finiteNumbers(deltas);
  const n = all.length;
  const mean = n ? all.reduce((s, d) => s + d, 0) / n : 0;
  const B = Math.max(1, Math.floor(samples));
  if (n === 0) return { mean: 0, lower: 0, upper: 0, level, samples: B, seed, n: 0 };

  const rand = mulberry32(seed);
  const means = new Float64Array(B);
  for (let b = 0; b < B; b += 1) {
    let acc = 0;
    for (let i = 0; i < n; i += 1) acc += all[Math.floor(rand() * n)];
    means[b] = acc / n;
  }
  means.sort();
  // 分位数用 type-7 线性插值(R 的 quantile 默认档),两端对称取 (1-level)/2。
  const q = (prob) => {
    const h = (B - 1) * prob;
    const lo = Math.floor(h);
    const hi = Math.min(lo + 1, B - 1);
    return means[lo] + (h - lo) * (means[hi] - means[lo]);
  };
  const tail = (1 - level) / 2;
  return { mean, lower: q(tail), upper: q(1 - tail), level, samples: B, seed, n };
}

// MDE:给定这批配对的方差与样本量,α/power 下**能被检出的最小 ΔMRR**。
// 公式 = (z_{1-α/2} + z_{power}) · sd / √n(配对 t 检验的正态近似)。
// 用途:当 p 值不显著时,MDE 回答"这批样本本来就只能看见 ≥X 的效应",把"测不出"量化成一个数字。
// sd 用全部配对(含零差值)的样本标准差 —— ΔMRR 的分母也是全部例数,两者同口径。
export function minimumDetectableEffect(deltas, { alpha = 0.05, power = 0.8 } = {}) {
  const all = finiteNumbers(deltas);
  const n = all.length;
  if (n < 2) return { n, sd: 0, mde: null, observedDelta: n ? all[0] : 0, detectable: false, alpha, power };
  const mean = all.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(all.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1));
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  const mde = (zAlpha + zPower) * sd / Math.sqrt(n);
  return { n, sd, mde, observedDelta: mean, detectable: Math.abs(mean) >= mde, alpha, power };
}

// MDE 的反解:要检出 targetDelta 这么大的 ΔMRR,需要多少配对样本。
// 评测集扩容决策直接读这个数(例:sd=0.20、targetDelta=0.02 → 约 785 例)。
export function requiredPairCount(sd, targetDelta, { alpha = 0.05, power = 0.8 } = {}) {
  const s = Number(sd);
  const d = Math.abs(Number(targetDelta));
  if (!Number.isFinite(s) || !Number.isFinite(d) || s <= 0 || d <= 0) return null;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  return Math.ceil(((zAlpha + zPower) * s / d) ** 2);
}

// 一次调用产出全套结论。Wilcoxon 与符号检验**一起**返回,报告侧照单全收即可,
// 从形状上就保证两个检验同时出现,择优挑选的机会不存在。
export function pairedRankReport(pairs, { alpha = 0.05, power = 0.8, seed = 20260811, samples = 10000, level = 0.95 } = {}) {
  const rows = (Array.isArray(pairs) ? pairs : []).filter((p) => p && typeof p === "object" && p.scored !== false);
  const deltas = pairedRankDeltas(rows);
  const n = rows.length;
  const mrrBefore = n ? rows.reduce((s, p) => s + reciprocalRank(p.rankA), 0) / n : 0;
  const mrrAfter = n ? rows.reduce((s, p) => s + reciprocalRank(p.rankB), 0) / n : 0;
  return {
    n,
    mrrBefore,
    mrrAfter,
    deltaMrr: mrrAfter - mrrBefore, // 与 mean(ΔRR) 恒等(同分母),bootstrap 区间即针对它
    wilcoxon: wilcoxonSignedRank(deltas),
    sign: signTest(deltas),
    effect: pairedEffectSize(deltas),
    ci: bootstrapMeanCI(deltas, { seed, samples, level }),
    mde: minimumDetectableEffect(deltas, { alpha, power }),
    deltas,
  };
}

// 备注(留给读结论的人):
// · 零差值处理沿用 Wilcoxon 原法(剔除后定秩)。零值占比很高时 Pratt 法(保留零值参与定秩)更保守,
//   两法可能给出不同结论 —— 检索评测里零差值即"两臂同名次",剔除法是通行做法,口径在此固定为一种。
// · 精确档是条件置换 p 值,前提是配对间独立;同一评测集内查询高度同源时该前提偏乐观。
// · bootstrap 百分位区间在 n 较小(如 24 例)且分布零膨胀时,实际覆盖率会略低于名义 95%。
