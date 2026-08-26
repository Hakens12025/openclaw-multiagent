/**
 * rag-stats.test.js — 统计尺的硬期望验证(纯函数,零 ollama、零索引、零 IO)
 *
 * 【断言口径】全部对着**手算值**断言,而不是"两次调用互等"(自比自恒真、证明不了正确性)。
 * 每条手算过程写在用例注释里,便于第三方复核:
 *   · Wilcoxon 精确档 = 对观测秩向量枚举 2^n 种符号组合的条件置换 p 值;
 *   · 符号检验 = Bin(n, 0.5) 的双侧精确尾概率;
 *   · 效应量/MDE = 教科书闭式,分位数常数取 z_.975=1.959964、z_.80=0.841621。
 *
 * 【默认等价】本模块是新增件、被零个生产文件引用,默认路径的行为改变量为 0。等价性由两条守卫钉住:
 *   ① reciprocalRank 与今天 wiki-rag-eval.js:53 的 MRR 累加式同时对上同一个硬编码常数 0.425;
 *   ② 模块源码零 import(无副作用、无 IO、无第三方)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  reciprocalRank,
  pairedRankDeltas,
  wilcoxonSignedRank,
  signTest,
  pairedEffectSize,
  bootstrapMeanCI,
  minimumDetectableEffect,
  requiredPairCount,
  pairedRankReport,
} from "../lib/knowledge/rag-stats.js";
import { evaluateWikiRagRecall } from "../lib/knowledge/wiki-rag-eval.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: got ${actual}, want ${expected}±${tol}`);

// ── ① rank → RR 的换算(单独可测)────────────────────────────────────────────

test("reciprocalRank:0-indexed 名次逐位对上 1/(rank+1),-1 记 0", () => {
  assert.equal(reciprocalRank(0), 1);
  assert.equal(reciprocalRank(1), 0.5);
  assert.equal(reciprocalRank(2), 1 / 3);
  assert.equal(reciprocalRank(4), 0.2);
  assert.equal(reciprocalRank(9), 0.1);
  assert.equal(reciprocalRank(-1), 0);
});

test("reciprocalRank:null/undefined/字符串/小数一律按未命中记 0(Number(null)===0 的陷阱已封死)", () => {
  assert.equal(reciprocalRank(null), 0);
  assert.equal(reciprocalRank(undefined), 0);
  assert.equal(reciprocalRank("0"), 0);
  assert.equal(reciprocalRank(NaN), 0);
  assert.equal(reciprocalRank(1.5), 0);
  assert.equal(reciprocalRank(-2), 0);
});

// 等价守卫:同一批名次,本模块换算出的 MRR 与生产评测器算出的 MRR 同时等于硬编码的 0.425。
// (1 + 0.5 + 0 + 0.2) / 4 = 0.425 —— 手算值在先,两侧都对它负责。
test("默认等价:reciprocalRank 的 MRR 与 evaluateWikiRagRecall 同时命中硬编码 0.425", async () => {
  const ranks = [0, 1, -1, 4];
  const mine = ranks.reduce((s, r) => s + reciprocalRank(r), 0) / ranks.length;
  assert.equal(mine, 0.425);

  // fake searchFn:让 q1..q4 的期望文档正好落在 rank 0/1/miss/4。
  const cases = [
    { query: "q1", expectedSourcePath: "a.md" },
    { query: "q2", expectedSourcePath: "b.md" },
    { query: "q3", expectedSourcePath: "c.md" },
    { query: "q4", expectedSourcePath: "d.md" },
  ];
  const table = {
    q1: ["a.md", "x.md"],
    q2: ["x.md", "b.md"],
    q3: ["x.md", "y.md"],
    q4: ["x.md", "y.md", "z.md", "w.md", "d.md"],
  };
  const searchFn = async (query) => ({ ok: true, results: (table[query] || []).map((sourcePath) => ({ sourcePath })) });
  const result = await evaluateWikiRagRecall(cases, searchFn, { topK: 10 });
  assert.deepEqual(result.perCase.map((p) => p.rank), ranks);
  assert.equal(result.mrr, 0.425);
  assert.equal(result.mrr, mine);
});

test("默认等价:模块零 import(无副作用、无 IO、无第三方依赖)", async () => {
  const src = await readFile(join(HERE, "..", "lib", "knowledge", "rag-stats.js"), "utf8");
  const importLines = src.split("\n").filter((l) => /^\s*import[\s{("']/.test(l));
  assert.deepEqual(importLines, [], `统计尺应保持零依赖,实际出现: ${importLines.join(" | ")}`);
});

// ── ② 配对差值提取 ──────────────────────────────────────────────────────────

test("pairedRankDeltas:ΔRR = RR(rankB) - RR(rankA),miss→hit 为正、hit→miss 为负", () => {
  const deltas = pairedRankDeltas([
    { rankA: 1, rankB: 0 },   // 0.5 → 1
    { rankA: -1, rankB: 4 },  // 0   → 0.2
    { rankA: 0, rankB: -1 },  // 1   → 0
    { rankA: 2, rankB: 2 },   // 同名次
  ]);
  assert.equal(deltas.length, 4);
  assert.equal(deltas[0], 0.5);
  near(deltas[1], 0.2, 1e-12, "miss→rank4");
  assert.equal(deltas[2], -1);
  assert.equal(deltas[3], 0);
});

test("pairedRankDeltas:scored===false 的例子排除(与 evaluateWikiRagRecall 排除 undecided 同口径)", () => {
  const deltas = pairedRankDeltas([
    { rankA: 1, rankB: 0, scored: true },
    { rankA: 5, rankB: 0, scored: false },
  ]);
  assert.deepEqual(deltas, [0.5]);
  assert.deepEqual(pairedRankDeltas(null), []);
  assert.deepEqual(pairedRankDeltas([null, 7]), []);
});

// ── ③ Wilcoxon 符号秩 ───────────────────────────────────────────────────────

// 手算:d=[1,2,3,4,5] 全正,|d| 秩 = 1..5,W+ = 15、W- = 0。
// 精确条件分布下 W+ 取到 15 的只有"全部为正"这一种符号组合 → P(W+≥15) = 1/32;
// 双侧 p = 2 × 1/32 = 0.0625。
test("Wilcoxon 精确档:单边全正 d=[1..5] → W+=15,p 恰为 0.0625", () => {
  const w = wilcoxonSignedRank([1, 2, 3, 4, 5]);
  assert.equal(w.method, "exact");
  assert.equal(w.wPlus, 15);
  assert.equal(w.wMinus, 0);
  assert.equal(w.statistic, 0);
  assert.equal(w.hasTies, false);
  assert.equal(w.p, 0.0625);
});

// 手算(并列秩):d=[1,-1,2,3] → |d|=[1,1,2,3],前两个并列取平均秩 1.5,其余 3、4。
// W+ = 1.5 + 3 + 4 = 8.5,W- = 1.5,合计 10 = n(n+1)/2 ✓。
// 枚举秩向量 [1.5,1.5,3,4] 的 16 种符号组合:和 ≥ 8.5 的有 {1.5,3,4}(两种取法)与 {1.5,1.5,3,4},共 3 种
// → P(W+≥8.5)=3/16=0.1875;P(W+≤8.5)=15/16 → 双侧 p = 2×0.1875 = 0.375。
test("Wilcoxon 精确档:并列秩 d=[1,-1,2,3] → W+=8.5/W-=1.5,p 恰为 0.375", () => {
  const w = wilcoxonSignedRank([1, -1, 2, 3]);
  assert.equal(w.method, "exact");
  assert.equal(w.wPlus, 8.5);
  assert.equal(w.wMinus, 1.5);
  assert.equal(w.hasTies, true);
  assert.equal(w.p, 0.375);
});

// 手算(正态近似分支):同一批数据,μ = n(n+1)/4 = 5;
// 并列修正 Σ(t³-t)/48 = (2³-2)/48 = 0.125 → σ² = 4·5·9/24 - 0.125 = 7.375,σ = 2.715694;
// 连续性校正 z = (8.5 - 5 - 0.5)/σ = 3/2.715694 = 1.104690 → p = 2·Φ̄(1.104690) = 0.269294。
test("Wilcoxon 正态档:并列修正 + 连续性校正给出 z=1.10469、p=0.26929", () => {
  const w = wilcoxonSignedRank([1, -1, 2, 3], { method: "normal" });
  assert.equal(w.method, "normal");
  near(w.z, 1.104690, 1e-5, "z");
  near(w.p, 0.269294, 1e-5, "p");
});

// 零差值按 Wilcoxon 原法剔除:wiki 那种"24 例里只有 4 例动了、且 4 例全部向好"的形态,
// n 从 24 降到 4,p 与"只有这 4 例"完全一致(0.125),同时 n/zeros 如实保留供报告读者判断。
test("Wilcoxon:零差值剔除后定秩,4↑/0↓ + 20 个零 → p=0.125 且 n/zeros 如实保留", () => {
  const deltas = [0.5, 0.25, 0.1, 0.05, ...new Array(20).fill(0)];
  const w = wilcoxonSignedRank(deltas);
  assert.equal(w.n, 24);
  assert.equal(w.zeros, 20);
  assert.equal(w.nNonZero, 4);
  assert.equal(w.wPlus, 10);
  assert.equal(w.p, 0.125);
  assert.equal(w.p, wilcoxonSignedRank([0.5, 0.25, 0.1, 0.05]).p); // 零值对 p 无影响
});

test("Wilcoxon:全零差值 → p=1、method=degenerate,照常返回", () => {
  const w = wilcoxonSignedRank([0, 0, 0, 0]);
  assert.equal(w.p, 1);
  assert.equal(w.method, "degenerate");
  assert.equal(w.nNonZero, 0);
  assert.equal(w.z, null);
  assert.equal(wilcoxonSignedRank([]).p, 1);
  assert.equal(wilcoxonSignedRank(null).p, 1);
});

// ── ④ 符号检验(精确二项)────────────────────────────────────────────────────

// 手算:n=4、k=3 → P(X≥3) = (C(4,3)+C(4,4))/16 = 5/16 = 0.3125,双侧 p = 0.625。
test("符号检验:3↑/1↓ → p 恰为 0.625", () => {
  const s = signTest([1, 1, 1, -1]);
  assert.equal(s.method, "exact");
  assert.equal(s.positive, 3);
  assert.equal(s.negative, 1);
  assert.equal(s.p, 0.625);
});

// 手算:n=4、k=4 → P(X≥4) = 1/16,双侧 p = 0.125。wiki 的 4↑/0↓ 形态即此。
test("符号检验:单边全正 4↑/0↓ → p 恰为 0.125,与同批 Wilcoxon 一致", () => {
  const deltas = [0.5, 0.25, 0.1, 0.05, ...new Array(20).fill(0)];
  const s = signTest(deltas);
  assert.equal(s.nNonZero, 4);
  assert.equal(s.zeros, 20);
  assert.equal(s.p, 0.125);
  assert.equal(s.p, wilcoxonSignedRank(deltas).p);
});

// 复核实测数字:合并 Wilcoxon 那轮报的符号检验是 25↑/15↓ p=0.154,这把尺子给出 0.15386。
test("符号检验:25↑/15↓ 复现已报的 p=0.154", () => {
  const s = signTest([...new Array(25).fill(1), ...new Array(15).fill(-1)]);
  assert.equal(s.nNonZero, 40);
  near(s.p, 0.153860, 1e-6, "p");
  assert.equal(Number(s.p.toFixed(3)), 0.154);
});

test("符号检验:全零/空 → p=1、method=degenerate", () => {
  assert.equal(signTest([0, 0, 0]).p, 1);
  assert.equal(signTest([0, 0, 0]).method, "degenerate");
  assert.equal(signTest([]).p, 1);
});

// ── ⑤ 效应量 ────────────────────────────────────────────────────────────────

// 手算:d=[1,-1,2,3] → rankBiserial = (W+ - W-)/(W+ + W-) = (8.5-1.5)/10 = 0.7;
// mean = 1.25,sd = √(8.75/3) = 1.707825 → Cohen's d = 1.25/1.707825 = 0.731925。
test("效应量:rankBiserial=0.7 与 cohenD=0.73193 同时给出", () => {
  const e = pairedEffectSize([1, -1, 2, 3]);
  assert.equal(e.rankBiserial, 0.7);
  assert.equal(e.mean, 1.25);
  near(e.sd, 1.707825, 1e-6, "sd");
  near(e.cohenD, 0.731925, 1e-6, "cohenD");
});

test("效应量:单边全正 → rankBiserial=1;全零 → rankBiserial=0 且 cohenD=null(sd=0 时无定义)", () => {
  assert.equal(pairedEffectSize([0.5, 0.25, 0.1]).rankBiserial, 1);
  assert.equal(pairedEffectSize([-0.5, -0.25, -0.1]).rankBiserial, -1);
  const zero = pairedEffectSize([0, 0, 0]);
  assert.equal(zero.rankBiserial, 0);
  assert.equal(zero.cohenD, null);
});

// ── ⑥ 配对 bootstrap 置信区间(确定性)──────────────────────────────────────

test("bootstrap:同 seed 两次调用逐字段全等(自带 PRNG,与 Math.random 无关)", () => {
  const deltas = [0.5, 0.2, 0.1, 0.05, 0, 0, 0, -0.1];
  const a = bootstrapMeanCI(deltas, { seed: 42, samples: 2000 });
  const b = bootstrapMeanCI(deltas, { seed: 42, samples: 2000 });
  assert.deepEqual(a, b);
  assert.equal(a.seed, 42);
  assert.equal(a.samples, 2000);
  assert.equal(a.level, 0.95);
});

test("bootstrap:换 seed 给出不同区间(证明 seed 真的在驱动重采样)", () => {
  const deltas = [0.5, 0.2, 0.1, 0.05, 0, 0, 0, -0.1];
  const a = bootstrapMeanCI(deltas, { seed: 1, samples: 2000 });
  const b = bootstrapMeanCI(deltas, { seed: 2, samples: 2000 });
  assert.equal(a.mean, b.mean);                 // 点估计与 seed 无关
  assert.notDeepEqual([a.lower, a.upper], [b.lower, b.upper]);
});

// 常数差值:任何一次重采样的均值都等于同一个数 → 区间退化成一个点。这条把百分位取法钉死。
test("bootstrap:常数差值 → lower=upper=mean(区间退化成点)", () => {
  const ci = bootstrapMeanCI(new Array(10).fill(0.1), { samples: 500 });
  assert.equal(ci.lower, ci.upper);
  assert.equal(ci.lower, ci.mean);
  near(ci.mean, 0.1, 1e-15, "mean");
});

test("bootstrap:单边全正 → 区间下界为正;空输入 → 全 0 且照常返回", () => {
  const ci = bootstrapMeanCI([0.5, 0.4, 0.3, 0.2, 0.1], { seed: 7, samples: 2000 });
  assert.ok(ci.lower > 0, `下界应为正,实际 ${ci.lower}`);
  assert.ok(ci.lower <= ci.mean && ci.mean <= ci.upper);
  assert.deepEqual(bootstrapMeanCI([]), { mean: 0, lower: 0, upper: 0, level: 0.95, samples: 10000, seed: 20260811, n: 0 });
});

// ── ⑦ MDE(把"测不出来"变成一个数字)────────────────────────────────────────

// 手算:d=[1,-1,1,-1] → mean=0,sd=√(4/3)=1.154701;
// MDE = (z_.975 + z_.80)·sd/√n = (1.959964+0.841621)×1.154701/2 = 1.617496。
test("MDE:n=4、sd=1.154701 → MDE=1.617496,观测 0 判为测不出", () => {
  const m = minimumDetectableEffect([1, -1, 1, -1]);
  assert.equal(m.n, 4);
  near(m.sd, 1.154701, 1e-6, "sd");
  near(m.mde, 1.617496, 1e-6, "mde");
  assert.equal(m.observedDelta, 0);
  assert.equal(m.detectable, false);
  assert.equal(m.alpha, 0.05);
  assert.equal(m.power, 0.8);
});

test("MDE:观测效应超过 MDE 时判 detectable;样本不足 2 → mde=null", () => {
  const big = minimumDetectableEffect([0.9, 1.0, 1.1, 1.0]);
  assert.ok(big.mde < Math.abs(big.observedDelta));
  assert.equal(big.detectable, true);
  assert.equal(minimumDetectableEffect([0.5]).mde, null);
  assert.equal(minimumDetectableEffect([]).mde, null);
});

// 手算:sd=0.2、目标 ΔMRR=0.02 → n = ((1.959964+0.841621)×0.2/0.02)² = 28.015852² = 784.89 → 785。
test("requiredPairCount:sd=0.2 要检出 ΔMRR=0.02 需 785 对样本", () => {
  assert.equal(requiredPairCount(0.2, 0.02), 785);
  assert.equal(requiredPairCount(0.2, -0.02), 785);          // 方向无关
  assert.ok(requiredPairCount(0.2, 0.05) < 785);             // 目标放大 → 需求下降
  assert.equal(requiredPairCount(0, 0.02), null);
  assert.equal(requiredPairCount(0.2, 0), null);
});

// ── ⑧ 汇总口(两个检验同时出现)────────────────────────────────────────────

// 手算:四对名次 (1→0, 3→2, -1→4, 0→0)
//   MRR_before = (0.5+0.25+0+1)/4 = 0.4375;MRR_after = (1+1/3+0.2+1)/4 = 0.633333
//   ΔMRR = 0.195833;非零 ΔRR 三个且全正 → Wilcoxon 与符号检验双侧 p 均为 2×(1/8) = 0.25。
test("pairedRankReport:ΔMRR 与两个检验一次给全,数值对上手算", () => {
  const rep = pairedRankReport([
    { rankA: 1, rankB: 0 },
    { rankA: 3, rankB: 2 },
    { rankA: -1, rankB: 4 },
    { rankA: 0, rankB: 0 },
  ], { samples: 1000 });
  assert.equal(rep.n, 4);
  assert.equal(rep.mrrBefore, 0.4375);
  near(rep.mrrAfter, 0.633333, 1e-6, "mrrAfter");
  near(rep.deltaMrr, 0.195833, 1e-6, "deltaMrr");
  assert.equal(rep.wilcoxon.p, 0.25);
  assert.equal(rep.sign.p, 0.25);
  assert.equal(rep.effect.rankBiserial, 1);
  assert.ok(rep.mde.mde > 0);
  assert.equal(rep.ci.samples, 1000);
});

test("pairedRankReport:ΔMRR 与 mean(ΔRR) 恒等(同分母),且 scored=false 逐层排除", () => {
  const pairs = [
    { rankA: 2, rankB: 0 },
    { rankA: 0, rankB: 3 },
    { rankA: 9, rankB: 9 },
    { rankA: 0, rankB: -1, scored: false },
  ];
  const rep = pairedRankReport(pairs, { samples: 500 });
  assert.equal(rep.n, 3);                                   // 被排除的那对未计入分母
  assert.equal(rep.deltas.length, 3);
  const meanDelta = rep.deltas.reduce((s, d) => s + d, 0) / rep.deltas.length;
  near(rep.deltaMrr, meanDelta, 1e-15, "ΔMRR = mean(ΔRR)");
  near(rep.ci.mean, meanDelta, 1e-15, "bootstrap 点估计 = ΔMRR");
});

test("pairedRankReport:空输入照常返回全零结构", () => {
  const rep = pairedRankReport([]);
  assert.equal(rep.n, 0);
  assert.equal(rep.deltaMrr, 0);
  assert.equal(rep.wilcoxon.p, 1);
  assert.equal(rep.sign.p, 1);
  assert.equal(rep.mde.mde, null);
});

// 键名写错必须抛错而不是静默归零 —— 这是对抗审查抓到的缺陷:
// 传 diffRecallRanks 的 rankBefore/rankAfter(同仓真实存在的另一组键名)会得到
// 一份"无显著差异、ΔMRR=0、p=1"的漂亮报告,而不是任何报错。
test("别名键必须抛错,不许静默产出零差值报告", () => {
  const aliased = [{ rankBefore: 3, rankAfter: 0 }, { rankBefore: -1, rankAfter: 0 }];
  assert.throws(() => pairedRankDeltas(aliased), /rankA\/rankB/);
  assert.throws(() => pairedRankReport(aliased), /rankA\/rankB/);
  // 正确键名照常工作,且确实测出了非零差值(证明上面的抛错不是把功能测没了)
  const ok = [{ rankA: 3, rankB: 0 }, { rankA: -1, rankB: 0 }];
  assert.deepEqual(pairedRankDeltas(ok), [1 - 0.25, 1 - 0]);
});
