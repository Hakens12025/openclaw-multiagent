/**
 * rag-graded-eval.test.js — 分级相关性评测的硬期望验证(纯函数,零 ollama、零索引、零 IO)
 *
 * 【断言口径】全部对着**手算值**断言,而非「两次调用互等」(自比自恒真,两条路一起改坏也照样绿)。
 * 增益 w(g)=2^g-1 → primary 7 / secondary 3 / marginal 1;每条手算过程写在用例注释里可复核。
 *
 * 【本模块存在的唯一理由】把「名次小幅变化」从二值 RR 的盲区里救出来,从而降低 ΔMRR 的方差。
 * 证不出这一条,模块就没有价值 —— 对应下方 ③ 组的三个用例:
 *   · 二值 ΔRR 在「主 gold 名次不动、次相关文档前移」与「主 gold 两臂都未命中、B 臂捞回次相关」
 *     两种场景下**恒为 0**(悬崖之外的变化看不见),而分级指标的 Δ 非零;
 *   · 聚合后 sd 与 requiredN 同时下降,且两个数字都是硬编码手算值;
 *   · 反向对照:全部退化例时两种口径逐位相同、requiredN 比值恰为 1 —— 收益来自标注,而非换把尺子。
 *
 * 【默认等价】本模块是新增件,被零个生产文件引用,默认路径的行为改变量为 0。等价性由三条守卫钉住:
 *   ① evaluateGraded 的二值腿(rank/hit/recallAt/mrr)与 evaluateWikiRagRecall 在同一 fake searchFn 上
 *      逐位相同,且双方同时命中硬编码常数 0.425;
 *   ② 单 gold 时 gradedReciprocalRank 与 rag-stats.js 的 reciprocalRank **精确相等**(assert.equal,非容差);
 *   ③ wiki-rag-eval.js 未引用本模块 —— 二值路的源码没被碰过。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  gradedGain,
  hasGradedAnnotation,
  ndcgAtK,
  gradedReciprocalRank,
  evaluateGraded,
  varianceComparison,
  formatGradedReport,
  GRADE_PRIMARY,
  GRADE_SECONDARY,
  GRADE_MARGINAL,
} from "../lib/knowledge/rag-graded-eval.js";
import { evaluateWikiRagRecall } from "../lib/knowledge/wiki-rag-eval.js";
import { reciprocalRank } from "../lib/knowledge/rag-stats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: got ${actual}, want ${expected}±${tol}`);

// 贯穿全文件的标注:P=主 gold(7)、S=次相关(3)。理想 gRR 分母 = 7/1 + 3/2 = 8.5。
const PS = { query: "q", expectedSourcePath: "P.md", secondarySourcePaths: ["S.md"] };

// ── ① 标注读取:gradedGain ───────────────────────────────────────────────────

test("gradedGain:expectedSourcePath/secondary/marginal 分别读出 3/2/1,其余 0", () => {
  const c = { expectedSourcePath: "P.md", secondarySourcePaths: ["S.md"], marginalSourcePaths: ["M.md"] };
  assert.equal(gradedGain(c, "P.md"), GRADE_PRIMARY);
  assert.equal(gradedGain(c, "S.md"), GRADE_SECONDARY);
  assert.equal(gradedGain(c, "M.md"), GRADE_MARGINAL);
  assert.equal(gradedGain(c, "other.md"), 0);
  assert.equal(gradedGain(c, ""), 0);
  assert.equal(gradedGain(null, "P.md"), 0);
});

test("gradedGain:同一路径被多桶声明时高等级覆盖低等级(标注矛盾从宽判)", () => {
  const c = { expectedSourcePath: "P.md", secondarySourcePaths: ["A.md"], marginalSourcePaths: ["A.md"] };
  assert.equal(gradedGain(c, "A.md"), GRADE_SECONDARY, "同一路径同时进 secondary 与 marginal 时取高等级(标注矛盾从宽判)");
  const d = { expectedSourcePath: "P.md", secondarySourcePaths: ["B.md"], marginalSourcePaths: ["B.md"] };
  assert.equal(gradedGain(d, "B.md"), GRADE_SECONDARY, "secondary 覆盖 marginal");
});

test("gradedGain:expectedSourcePath 缺席分级桶时补成 primary,被显式降格时尊重降格", () => {
  // 补:二值 gold 必定也是分级 gold,两条腿对「什么算对」的定义保持一致。
  assert.equal(gradedGain({ expectedSourcePath: "P.md" }, "P.md"), GRADE_PRIMARY);
  assert.equal(gradedGain({ expectedSourcePath: "P.md", secondarySourcePaths: ["S.md"] }, "P.md"), GRADE_PRIMARY);
  // 降格:标注者把 expectedSourcePath 明确写进 marginal,该意图生效而不是被静默抬回 3。
  const demoted = { expectedSourcePath: "P.md", marginalSourcePaths: ["P.md"] };
  assert.equal(gradedGain(demoted, "P.md"), GRADE_MARGINAL);
});

test("gradedGain:ghostSourcePaths 记 0 而非负值(nDCG 的 [0,1] 边界由此得以保持)", () => {
  const c = { expectedSourcePath: "P.md", ghostSourcePaths: ["ghost.md"] };
  assert.equal(gradedGain(c, "ghost.md"), 0);
  // 幽灵命中仍由 wiki-rag-eval.js:65 的 ghostHitRate 单独度量,两把尺各司其职。
});

test("hasGradedAnnotation:三桶皆空 = 退化例", () => {
  assert.equal(hasGradedAnnotation({ expectedSourcePath: "P.md" }), false);
  assert.equal(hasGradedAnnotation({ expectedSourcePath: "P.md", secondarySourcePaths: [] }), false);
  assert.equal(hasGradedAnnotation(PS), true);
  assert.equal(hasGradedAnnotation({ expectedSourcePath: "P.md", marginalSourcePaths: ["M.md"] }), true);
});

// ── ② 指标本体:ndcgAtK / gradedReciprocalRank ───────────────────────────────

test("ndcgAtK:对上手算的 DCG/IDCG 比值", () => {
  // A = [P, x, x, x, x, S] → P 在 1-based 名次 1、S 在名次 6
  //   DCG  = 7/log2(2) + 3/log2(7) = 7 + 1.0685655 = 8.0685655
  //   IDCG = 7/log2(2) + 3/log2(3) = 7 + 1.8927893 = 8.8927893
  //   nDCG = 0.9073218
  const A = ["P.md", "x1", "x2", "x3", "x4", "S.md"];
  near(ndcgAtK(A, PS, 10), 0.9073218, 1e-7, "nDCG@10(P@1,S@6)");
  // B = [P, S, ...] 即理想排序本身 → 恰为 1
  assert.equal(ndcgAtK(["P.md", "S.md", "x1"], PS, 10), 1);
  // 全未命中 → 0
  assert.equal(ndcgAtK(["x1", "x2"], PS, 10), 0);
});

test("ndcgAtK:k 截断同时作用于实际排名与理想排名", () => {
  // k=1 时理想只剩 P(7/1=7);A 的第 1 位就是 P → nDCG@1 = 1
  assert.equal(ndcgAtK(["P.md", "S.md"], PS, 1), 1);
  // 第 1 位是 S(3/1=3),理想 @1 仍是 7 → 3/7
  near(ndcgAtK(["S.md", "P.md"], PS, 1), 3 / 7, 1e-12, "nDCG@1(S 占首位)");
  // k=5 时 S@6 被截断在外:DCG = 7,IDCG = 8.8927893 → 0.7871
  near(ndcgAtK(["P.md", "x1", "x2", "x3", "x4", "S.md"], PS, 5), 7 / 8.8927893, 1e-7, "nDCG@5 截断 S");
});

test("ndcgAtK:同一 sourcePath 占多个结果位时只记首次,nDCG 保持在 1 以内", () => {
  // wiki-rag-search.js:44 的 RRF 去重键是 `sourcePath + heading`,同篇文档的多个 section 各占一位。
  // 若重复累加增益,下面这条会算出 >1 的 nDCG。
  // [P, P, S, S] → P 记名次 1(7/1),S 记名次 3(3/log2(4)=1.5) → DCG=8.5,/8.8927893 = 0.9558306
  const dup = ["P.md", "P.md", "S.md", "S.md"];
  const v = ndcgAtK(dup, PS, 10);
  near(v, 0.9558306, 1e-7, "nDCG(重复 sourcePath)");
  assert.ok(v <= 1, "nDCG 必须落在 [0,1]");
});

test("ndcgAtK / gradedReciprocalRank:毫无 gold 的 case 返回 null 而不是 0", () => {
  // 0 会被均值当成「检索很差」,把不可测悄悄算成失败;null 表示「此题不可测」,由驱动器显式排除。
  assert.equal(ndcgAtK(["a.md"], { query: "q" }, 10), null);
  assert.equal(gradedReciprocalRank(["a.md"], { query: "q" }), null);
});

test("gradedReciprocalRank:单 gold 时与 reciprocalRank 精确相等(逐位,非容差)", () => {
  const single = { query: "q", expectedSourcePath: "P.md" };
  for (const rank of [0, 1, 2, 3, 9]) {
    const paths = [...Array(rank).fill("z.md"), "P.md"];
    assert.equal(gradedReciprocalRank(paths, single), reciprocalRank(rank), `rank${rank} 逐位相等`);
  }
  assert.equal(gradedReciprocalRank(["z.md"], single), 0, "未命中 → 0");
  assert.equal(gradedReciprocalRank(["z.md"], single), reciprocalRank(-1));
  // 只声明 primary(仍是单 gold)也走同一条恒等
  assert.equal(gradedReciprocalRank(["z.md", "P.md"], { expectedSourcePath: "P.md" }), 0.5);
});

test("gradedReciprocalRank:单 gold 快捷支与通式在 1 ULP 内吻合(通式漂移会被立刻发现)", () => {
  // 通式的规格在此独立写出:gRR = Σ w(g_i)/rank_i ÷ Σ w(g_j^sorted)/j。单 gold 时权重对消。
  const single = { query: "q", expectedSourcePath: "P.md" };
  for (const rank of [0, 1, 2, 3, 9]) {
    const paths = [...Array(rank).fill("z.md"), "P.md"];
    const w = 2 ** GRADE_PRIMARY - 1; // = 7
    const byFormula = w / (rank + 1) / w;
    near(gradedReciprocalRank(paths, single), byFormula, Number.EPSILON, `rank${rank} 通式一致`);
  }
});

test("gradedReciprocalRank:多 gold 对上手算(理想分母 = 7/1 + 3/2 = 8.5)", () => {
  // [P, x,x,x,x, S] → 7/1 + 3/6 = 7.5 → 7.5/8.5 = 0.8823529
  near(gradedReciprocalRank(["P.md", "x1", "x2", "x3", "x4", "S.md"], PS), 7.5 / 8.5, 1e-12, "P@1,S@6");
  // [P, S, ...] = 理想排序 → 1
  assert.equal(gradedReciprocalRank(["P.md", "S.md", "x1"], PS), 1);
  // 仅捞回 S 且在名次 3 → (3/3)/8.5 = 1/8.5
  near(gradedReciprocalRank(["x1", "x2", "S.md"], PS), 1 / 8.5, 1e-12, "只命中次相关");
  // [P, x, S] → (7/1 + 3/3)/8.5 = 8/8.5
  near(gradedReciprocalRank(["P.md", "x1", "S.md"], PS), 8 / 8.5, 1e-12, "P@1,S@3");
});

// ── ③ 核心论证:分级指标看得见二值 RR 的盲区,且方差随之下降 ──────────────────

// 三类会动的场景 + 五例两臂全同的静态场景。构造贴合 memos 的现实分布:
// 绝大多数题完全不动,少数题发生悬崖式跳变 —— 这正是 sd=0.2308 的成因。
const SHIFT_CASES = ["shuffle", "pooling", "cliff", "n1", "n2", "n3", "n4", "n5"].map((q) => ({ ...PS, query: q }));
const ARM_A = [
  ["P.md", "x1", "x2", "x3", "x4", "S.md"], // shuffle:P@1、S@6
  ["x1", "x2", "x3", "x4", "x5"],           // pooling:两臂主 gold 都未命中
  ["x1", "x2", "x3"],                       // cliff  :未命中
  ["P.md", "x1"], ["P.md", "x1"], ["x1", "x2"], ["x1", "x2"], ["P.md", "x1"],
];
const ARM_B = [
  ["P.md", "S.md", "x1", "x2", "x3", "x4"], // shuffle:P 名次不动,S 由 6 升到 2
  ["x1", "x2", "S.md", "x3", "x4"],         // pooling:主 gold 仍未命中,捞回 S@3
  ["P.md", "x1", "S.md"],                   // cliff  :未命中 → P@1
  ["P.md", "x1"], ["P.md", "x1"], ["x1", "x2"], ["x1", "x2"], ["P.md", "x1"],
];

test("盲区证明:名次小幅变化时二值 ΔRR 恒为 0,分级指标的 Δ 非零", () => {
  const r = varianceComparison(SHIFT_CASES, ARM_A, ARM_B, { k: 10 });

  // ── shuffle:主 gold 名次不动(两臂都 @1),次相关由名次 6 升到 2 ──
  assert.equal(r.deltas.binary[0], 0, "二值 RR 只盯单个 gold → 完全看不见这次前移");
  near(r.deltas.gradedRR[0], 1 - 7.5 / 8.5, 1e-12, "分级 RR:8.5/8.5 - 7.5/8.5 = 0.1176471");
  near(r.deltas.ndcg[0], 1 - 0.9073218, 1e-7, "nDCG:1 - 0.9073218 = 0.0926782");

  // ── pooling:主 gold 两臂都未命中,B 臂捞回一篇次相关(pooling bias 的典型症状)──
  assert.equal(r.deltas.binary[1], 0, "二值 RR:0 → 0,改进被完全吞掉");
  near(r.deltas.gradedRR[1], 1 / 8.5, 1e-12, "分级 RR:(3/3)/8.5 = 0.1176471");
  near(r.deltas.ndcg[1], 1.5 / 8.8927893, 1e-7, "nDCG:(3/log2(4))/IDCG = 0.1686763");

  // ── cliff:未命中 → rank1,二值跳满 1.0;分级把跳幅摊薄(其余 gold 仍未命中,拿不满分)──
  assert.equal(r.deltas.binary[2], 1, "二值 RR 的悬崖:0 → 1.0");
  near(r.deltas.gradedRR[2], 8 / 8.5, 1e-12, "分级 RR 仅到 0.9411765,悬崖被削掉 6%");
  assert.ok(r.deltas.gradedRR[2] < r.deltas.binary[2], "巨幅跳变被摊薄 = 方差下降的另一半机制");

  // ── 五例静态:两种口径都记 0,不制造假信号 ──
  assert.deepEqual(r.deltas.binary.slice(3), [0, 0, 0, 0, 0]);
  assert.deepEqual(r.deltas.gradedRR.slice(3), [0, 0, 0, 0, 0]);
  assert.deepEqual(r.deltas.ndcg.slice(3), [0, 0, 0, 0, 0]);
});

test("方差证明:同一批检索下 sd 与 requiredN 同时下降(全部硬编码手算值)", () => {
  const r = varianceComparison(SHIFT_CASES, ARM_A, ARM_B, { k: 10 });
  assert.equal(r.n, 8);
  assert.equal(r.gradedAnnotated, 8);
  assert.equal(r.skipped, 0);

  // 二值 ΔRR = [0,0,1,0,0,0,0,0] → mean = 1/8 = 0.125
  //   离差平方和 = (1-0.125)² + 7×0.125² = 0.765625 + 0.109375 = 0.875;/(8-1) = 0.125;sd = 0.3535534
  near(r.binary.delta, 0.125, 1e-12, "二值 ΔMRR");
  near(r.binary.sd, 0.3535534, 1e-7, "二值 ΔRR 的 sd(手算 √0.125)");
  // requiredN = ((1.959964+0.841621)·sd/Δ)² = (2.801585×0.3535534/0.125)² = 7.924427² = 62.80 → 63
  assert.equal(r.binary.requiredN, 63, "二值口径要 63 例才测得动这个效应");

  // 分级 ΔgRR = [0.1176471, 0.1176471, 0.9411765, 0×5] → mean = 1.1764706/8 = 0.1470588
  //   离差平方和 = 2×0.0294118² + 0.7941176² + 5×0.1470588² = 0.0017301+0.6306228+0.1081315 = 0.7404844
  //   /(8-1) = 0.1057835;sd = 0.3252437
  near(r.gradedRR.delta, 0.1470588, 1e-7, "分级 ΔMRR");
  near(r.gradedRR.sd, 0.3252437, 1e-7, "分级 ΔgRR 的 sd");
  // requiredN = (2.801585×0.3252437/0.1470588)² = 6.196061² = 38.39 → 39
  assert.equal(r.gradedRR.requiredN, 39, "分级口径 39 例即可 —— 少 24 例");

  // nDCG@10 口径同向
  near(r.ndcg.sd, 0.3306834, 1e-7, "nDCG Δ 的 sd");
  assert.equal(r.ndcg.requiredN, 38);

  // 两个比值:sd 降 8%,requiredN 降 38%。
  near(r.sdRatio.gradedRR, 0.3252437 / 0.3535534, 1e-6, "sdRatio = 0.9199");
  near(r.requiredNRatio.gradedRR, 39 / 63, 1e-12, "requiredNRatio = 0.6190");
  assert.equal(r.gradedMoreSensitive.gradedRR, true);
  assert.equal(r.gradedMoreSensitive.ndcg, true);

  // requiredN 才是结论所在:sd 单独看会骗人 —— 任何整体缩放都能压低 sd,同时把效应一起压低。
  // requiredN = ((z_α+z_β)·sd/Δ)² 对缩放免疫,下一条用例把这件事直接证出来。
});

test("方差口径自证:指标整体缩放会压低 sd,但 requiredN 纹丝不动", () => {
  // 把二值 ΔRR 全部乘以 0.1 —— sd 掉到十分之一,看起来「方差大幅下降」,实则毫无信息增益。
  // 这条用例存在的意义:防止有人拿 sdRatio 单独宣布胜利。
  const scaled = SHIFT_CASES.map((c) => ({ ...c }));
  const r = varianceComparison(scaled, ARM_A, ARM_B, { k: 10 });
  const shrunk = r.deltas.binary.map((d) => d * 0.1);
  const mean = shrunk.reduce((s, d) => s + d, 0) / shrunk.length;
  const sd = Math.sqrt(shrunk.reduce((s, d) => s + (d - mean) ** 2, 0) / (shrunk.length - 1));
  near(sd, r.binary.sd * 0.1, 1e-12, "缩放后 sd 恰好是原来的十分之一");
  const requiredN = Math.ceil(((1.959963985 + 0.841621234) * sd / Math.abs(mean)) ** 2);
  assert.equal(requiredN, r.binary.requiredN, "requiredN 对缩放免疫 —— 结论必须读它");
});

test("反向对照:全部退化例时两种口径逐位相同,requiredN 比值恰为 1(收益来自标注)", () => {
  // 去掉 primary/secondary,只留 expectedSourcePath —— 84 例里目前的大多数就是这个样子。
  const bare = SHIFT_CASES.map((c) => ({ query: c.query, expectedSourcePath: c.expectedSourcePath }));
  const r = varianceComparison(bare, ARM_A, ARM_B, { k: 10 });
  assert.equal(r.gradedAnnotated, 0);
  assert.equal(r.degraded, 8);
  assert.deepEqual(r.deltas.gradedRR, r.deltas.binary, "退化例的分级 RR 与二值 RR 逐位相同");
  assert.equal(r.gradedRR.sd, r.binary.sd);
  assert.equal(r.gradedRR.requiredN, r.binary.requiredN);
  assert.equal(r.requiredNRatio.gradedRR, 1, "没有标注就没有增益 —— 换尺子本身不产生功效");
  assert.equal(r.gradedMoreSensitive.gradedRR, false);
});

test("varianceComparison:两臂长度与 cases 对不上时抛错(静默错位会产出格式漂亮的错数字)", () => {
  assert.throws(() => varianceComparison(SHIFT_CASES, ARM_A.slice(0, 3), ARM_B), /等长且同序/);
  assert.throws(() => varianceComparison(SHIFT_CASES, ARM_A, []), /等长且同序/);
});

test("varianceComparison:undecided 与无 gold 的 case 被排除并计入 skipped", () => {
  const cases = [
    { ...PS, query: "keep" },
    { ...PS, query: "drop", verdictStatus: "undecided" },
    { query: "nogold" },
  ];
  const A = [["P.md"], ["x1"], ["x1"]];
  const B = [["P.md", "S.md"], ["P.md"], ["P.md"]];
  const r = varianceComparison(cases, A, B, { k: 10 });
  assert.equal(r.n, 1, "只剩 keep 一例进入统计");
  assert.equal(r.skipped, 2);
});

// ── ④ 驱动器 evaluateGraded ─────────────────────────────────────────────────

// 与 wiki-rag-recall.test.js:41-47 同款 fake:名次 0 / 1 / 未命中 / 4。
const FAKE_PATHS = {
  qA: ["a.md", "z.md"],
  qB: ["z.md", "b.md"],
  qC: ["z.md", "y.md"],
  qD: ["z.md", "y.md", "w.md", "v.md", "d.md"],
};
const fakeSearch = async (q) => ({ ok: true, results: (FAKE_PATHS[q] || []).map((sp) => ({ sourcePath: sp })) });
const BINARY_CASES = [
  { query: "qA", expectedSourcePath: "a.md", category: "x" },
  { query: "qB", expectedSourcePath: "b.md", category: "x" },
  { query: "qC", expectedSourcePath: "c.md", category: "y" },
  { query: "qD", expectedSourcePath: "d.md", category: "y" },
];

test("默认等价:evaluateGraded 的二值腿与 evaluateWikiRagRecall 逐位相同,双方同时命中硬编码 0.425", async () => {
  const graded = await evaluateGraded(BINARY_CASES, fakeSearch, { ks: [1, 3, 5, 10], topK: 10 });
  const binary = await evaluateWikiRagRecall(BINARY_CASES, fakeSearch, { ks: [1, 3, 5, 10], topK: 10 });

  // 手算值在先:名次 0、1、未命中、4 → MRR = (1 + 0.5 + 0 + 0.2)/4 = 0.425
  assert.equal(graded.mrr, 0.425, "分级驱动器的二值 MRR = 手算 0.425");
  assert.equal(binary.mrr, 0.425, "生产评测器的 MRR = 同一个 0.425");
  assert.equal(graded.mrr, binary.mrr);
  assert.deepEqual(graded.recallAt, binary.recallAt, "recall@k 逐位相同");
  assert.equal(graded.total, binary.total);
  assert.equal(graded.evaluated, binary.evaluated);
  assert.equal(graded.abstained, binary.abstained);
  assert.deepEqual(
    graded.perCase.map((p) => [p.query, p.rank, p.hit]),
    binary.perCase.map((p) => [p.query, p.rank, p.hit]),
    "逐例 rank/hit 相同",
  );
  // 退化例的 gradedMRR 与二值 MRR 也相同(单 gold 恒等)
  assert.equal(graded.gradedMrr, 0.425, "全退化时 gradedMRR 与二值 MRR 同值");
  assert.equal(graded.degradedCases, 4);
  assert.equal(graded.gradedCases, 0);
  assert.equal(graded.degradedRatio, 1);
});

test("evaluateGraded:分级例与退化例混跑时,三组数字分开摆(混口径的均值会骗人)", async () => {
  const cases = [
    { query: "qA", expectedSourcePath: "a.md", secondarySourcePaths: ["z.md"] }, // 分级
    { query: "qB", expectedSourcePath: "b.md" },                                          // 退化
  ];
  const r = await evaluateGraded(cases, fakeSearch, { ks: [1, 10], topK: 10 });
  assert.equal(r.measurable, 2);
  assert.equal(r.gradedCases, 1);
  assert.equal(r.degradedCases, 1);
  assert.equal(r.degradedRatio, 0.5, "一半例子是退化的 —— 读数的人必须看得到这个比例");
  assert.equal(r.annotatedOnly.n, 1, "annotatedOnly 用独立分母,仅覆盖真正带分级标注的例子");

  // qA:a.md@1(7/1) + z.md@2(3/2) = 8.5,理想 8.5 → gradedRR = 1
  assert.equal(r.perCase[0].gradedRR, 1);
  assert.equal(r.perCase[0].graded, true);
  assert.equal(r.perCase[0].goldCount, 2);
  // qB:退化例,b.md 在名次 2 → 0.5(与二值 RR 相同)
  assert.equal(r.perCase[1].gradedRR, 0.5);
  assert.equal(r.perCase[1].graded, false);
  assert.equal(r.perCase[1].goldCount, 1);
  // 全体均值 = (1 + 0.5)/2 = 0.75;仅分级例均值 = 1。两个数字都在,读者自己选口径。
  assert.equal(r.gradedMrr, 0.75);
  assert.equal(r.annotatedOnly.gradedMrr, 1);
});

test("evaluateGraded:undecided 不计分,口径与 wiki-rag-eval.js:47 一致", async () => {
  const cases = [
    { query: "qA", expectedSourcePath: "a.md" },
    { query: "qC", expectedSourcePath: "c.md", verdictStatus: "undecided" },
  ];
  const r = await evaluateGraded(cases, fakeSearch, { ks: [1, 10], topK: 10 });
  assert.equal(r.total, 2);
  assert.equal(r.evaluated, 1);
  assert.equal(r.abstained, 1);
  assert.equal(r.mrr, 1, "只有 qA 计分(名次 0)→ MRR = 1,未命中的 qC 未拉低分母");
  assert.equal(r.gradedMrr, 1);
});

test("evaluateGraded:searchFn 降级返回 ok:false → 该例记 0,不抛", async () => {
  const r = await evaluateGraded([{ query: "q", expectedSourcePath: "a.md", secondarySourcePaths: ["s.md"] }],
    async () => ({ ok: false, degraded: true, results: [] }), { ks: [1, 10], topK: 10 });
  assert.equal(r.perCase[0].hit, false);
  assert.equal(r.perCase[0].gradedRR, 0);
  assert.equal(r.perCase[0].ndcg[10], 0);
  assert.equal(r.recallAt[10], 0);
});

test("evaluateGraded:perCase 带全量 paths,varianceComparison 可复用同一次检索(免第二轮 ollama)", async () => {
  const r = await evaluateGraded(BINARY_CASES, fakeSearch, { ks: [1, 10], topK: 10 });
  assert.deepEqual(r.perCase[3].paths, FAKE_PATHS.qD, "全量名次表原样保留");
  // 直接把 perCase 行喂回对比器(toPathList 认得 {paths} 形状)
  const cmp = varianceComparison(BINARY_CASES, r.perCase, r.perCase, { k: 10 });
  assert.equal(cmp.n, 4);
  assert.deepEqual(cmp.deltas.binary, [0, 0, 0, 0], "同一臂自比 → Δ 全 0");
  assert.equal(cmp.binary.sd, 0);
  assert.equal(cmp.binary.requiredN, null, "sd=0 且 Δ=0 时反解无定义,返回 null 胜过返回 0");
});

test("formatGradedReport:分级与退化的条数出现在报告正文里", async () => {
  const r = await evaluateGraded(
    [{ query: "qA", expectedSourcePath: "a.md", secondarySourcePaths: ["z.md"] }, { query: "qB", expectedSourcePath: "b.md" }],
    fakeSearch, { ks: [1, 10], topK: 10 });
  const text = formatGradedReport(r);
  assert.match(text, /nDCG@10/);
  assert.match(text, /gradedMRR/);
  assert.match(text, /graded-annotated: 1/);
  assert.match(text, /degraded\(binary-equivalent\): 1/);
});

// ── ⑤ 默认等价的第三条守卫:二值路的源码没被碰过 ─────────────────────────────

test("默认等价:wiki-rag-eval.js 未引用本模块,二值路保持独立可用", async () => {
  const source = await readFile(join(HERE, "../lib/knowledge/wiki-rag-eval.js"), "utf8");
  assert.doesNotMatch(source, /rag-graded-eval/, "生产二值评测器对本模块零依赖");
});

// 真语料等价:拿现役的 84 例 memos 与 24 例 wiki 评测集直接过一遍。fake searchFn 是确定式的
// (按 query 长度决定期望路径落在第几位),因此零 ollama、零索引,却走完了真标注的全部分支
// —— 含 verdictStatus:"undecided"、ghostSourcePaths、expectedKeywords 这些现存字段。
for (const fixture of ["memos-rag-eval-set", "wiki-rag-eval-set"]) {
  test(`真语料等价:${fixture} 上分级驱动器与 evaluateWikiRagRecall 的二值腿逐位相同`, async () => {
    const parsed = JSON.parse(await readFile(join(HERE, `fixtures/${fixture}.json`), "utf8"));
    const cases = parsed.cases;
    const search = async (query, { topK }) => {
      const c = cases.find((x) => x.query === query);
      const slot = query.length % 7; // 确定式:制造混合的命中/未命中/深位命中
      const results = Array.from({ length: Math.min(topK, 10) }, (_, i) => ({ sourcePath: `noise${i}.md` }));
      if (slot < results.length && slot !== 5) results[slot] = { sourcePath: c.expectedSourcePath };
      return { ok: true, results };
    };
    const graded = await evaluateGraded(cases, search, { ks: [1, 3, 5, 10], topK: 10 });
    const binary = await evaluateWikiRagRecall(cases, search, { ks: [1, 3, 5, 10], topK: 10 });

    assert.equal(graded.mrr, binary.mrr, "二值 MRR 逐位相同");
    assert.deepEqual(graded.recallAt, binary.recallAt, "recall@k 逐位相同");
    assert.equal(graded.evaluated, binary.evaluated, "计分例数相同(undecided 排除口径一致)");
    assert.equal(graded.abstained, binary.abstained);
    assert.deepEqual(graded.perCase.map((p) => p.rank), binary.perCase.map((p) => p.rank), "逐例名次相同");
    // v193 起 memos 有 65 例带分级标注,所以 gradedMrr 与二值 MRR **应当**不同 —— 那正是分级的意义。
    // 真正要守的不变量比原来那条更强:**未标注的退化例必须与二值腿逐位相同**,
    // 即接入分级模块对没标注的题零影响。这条在标注推进过程中始终成立,不会随覆盖率变化而失效。
    assert.equal(graded.degradedCases + graded.gradedCases, graded.measurable, "每例非退化即分级,无第三态");
    // 这条测试对两个 fixture 共用,而 wiki 目前 0 例分级、memos 65 例 —— 断言必须跟着 fixture 的实际标注量走,
    // 写死"必须>0"会在 wiki 上假红,写死"必须=0"会在 memos 上假红。两种写死都是把测试绑在某一时刻的快照上。
    // 口径要与 gradedCases 一致:它只在**计分例**里数(undecided 不计分),
    // 而 fixture 里确实存在带分级标注的 undecided 例。按全部 84 例数会差 1。
    const annotatedInFixture = cases.filter((c) => c.verdictStatus !== "undecided" && hasGradedAnnotation(c)).length;
    assert.equal(graded.gradedCases, annotatedInFixture, "分级例数必须与 fixture 里实际带标注的例数一致");
    assert.equal(graded.unmeasurable, 0, "现存标注每例都有 gold");
    for (const p of graded.perCase) {
      if (p.graded) continue;
      assert.equal(p.gradedRR, binary.perCase.find((b) => b.query === p.query).rank === -1 ? 0 : 1 / (binary.perCase.find((b) => b.query === p.query).rank + 1),
        `退化例 ${p.query.slice(0, 24)} 的分级 RR 必须等于二值 RR`);
    }
  });
}

test("真语料规模守卫:memos 84 例计分 82、wiki 24 例全计分", async () => {
  // 数字来自评测集现状;标注量变动时这条会红,提醒同步样本量反解结论。
  // v193:计分数 81→82 —— 修掉一例 undecided 误判(USR1 那题当初判「全库仅[过时]篇有答案」,
  // 实测 7 篇含 USR1 且 135/136/36/38 四篇现行,原 grep 跑在 135/136 加入之前且未复查)。
  const memos = JSON.parse(await readFile(join(HERE, "fixtures/memos-rag-eval-set.json"), "utf8"));
  const wiki = JSON.parse(await readFile(join(HERE, "fixtures/wiki-rag-eval-set.json"), "utf8"));
  assert.equal(memos.cases.length, 84);
  assert.equal(memos.cases.filter((c) => c.verdictStatus !== "undecided").length, 82);
  assert.equal(wiki.cases.length, 24);
  assert.equal(wiki.cases.filter((c) => c.verdictStatus !== "undecided").length, 24);
  // 分级标注进度。v193 首批落地:memos 65/84 有分级(46 例带次相关),wiki 仍为 0。
  // 这个数字必须与 sd 下降幅度一起读 —— 覆盖率低时分级指标的降方差效果也小。
  const memosAnnotated = memos.cases.filter(hasGradedAnnotation).length;
  const wikiAnnotated = wiki.cases.filter(hasGradedAnnotation).length;
  assert.equal(memosAnnotated, 65);
  assert.equal(wikiAnnotated, 0, "wiki 尚未分级标注 —— 它走退化路(二值),与 memos 的聚合数字不可混读");
});

test("本模块只依赖 rag-stats.js:统计实现单一来源,且无 IO/无副作用", async () => {
  const source = await readFile(join(HERE, "../lib/knowledge/rag-graded-eval.js"), "utf8");
  const imports = [...source.matchAll(/^import .*? from "(.*?)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./rag-stats.js"], "sd/MDE/反解样本量全部复用 rag-stats,不另起第二套统计");
});
