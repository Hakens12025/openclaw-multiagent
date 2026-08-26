/**
 * result-diversity.test.js — 同源上限裁剪(刀)与来源覆盖度量(尺),全纯函数、零 ollama、零索引。
 *
 * 三条主线:
 *  ① 默认等价:maxPerSource 缺省 / 0 / null / NaN / 负数 → 返回**同一个数组引用**,且逐项等于
 *     写死的输入顺序期望值(与"另一次调用相等"这种自比自恒真的假证明区分开)。
 *  ② 开的时候必须动:cap=2 的输出与关闭时**逐项不同**,且等于手算写死的名次表。只测"关的时候
 *     不动"会放过最经典的 bug —— Number(null)===0 让配置永远读不到、A/B delta 恒为 0 的假阴性。
 *  ③ 数学必然的机械化证明:输出是输入的置换 + 每个 sourcePath 的首现名次只前移不后移
 *     → 以 sourcePath 判定的 recall@k / MRR 单调不降。这正是"cap 的 recall 正向 delta 不是证据"
 *     的根据,所以收益改用覆盖度量(dupSlotRate / distinctAvg / S-Recall / Gini)来判。
 *
 * 覆盖度量的口径与 live 基线对表:合成一组 24 查询 × 10 位、117 个重复名额的结果集,
 * dupSlotRate 与 distinctAvg 经展示层格式化后逐字符等于已实测的 wiki 基线 48.8% / 5.13。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  capPerSource,
  distinctSourceCount,
  dupSlotRate,
  sRecallAtK,
  sourceFrequency,
  giniOfCounts,
  retrievalGini,
  coverageReport,
} from "../lib/knowledge/result-diversity.js";

// RRF 融合后的结果形状(wiki-rag-search.js:49):{sourcePath, heading, text, score}。
const FUSED = Object.freeze([
  { sourcePath: "a.md", heading: "a1", text: "t", score: 0.9 },
  { sourcePath: "a.md", heading: "a2", text: "t", score: 0.8 },
  { sourcePath: "b.md", heading: "b1", text: "t", score: 0.7 },
  { sourcePath: "a.md", heading: "a3", text: "t", score: 0.6 },
  { sourcePath: "c.md", heading: "c1", text: "t", score: 0.5 },
  { sourcePath: "b.md", heading: "b2", text: "t", score: 0.4 },
  { sourcePath: "a.md", heading: "a4", text: "t", score: 0.3 },
  { sourcePath: "d.md", heading: "d1", text: "t", score: 0.2 },
]);
const heads = (list) => list.map((r) => r.heading);

// ── ① 默认等价(与今天逐字节相同)──

test("capPerSource:缺省参数 → 同一个数组引用 + 逐项等于写死的输入顺序", () => {
  const out = capPerSource(FUSED);
  assert.equal(out, FUSED, "默认关时应原样返回,连新数组都无需分配");
  assert.deepEqual(heads(out), ["a1", "a2", "b1", "a3", "c1", "b2", "a4", "d1"]);
});

test("capPerSource:0 / null / undefined / NaN / 负数 / 空串 全部走默认关路径", () => {
  for (const off of [0, null, undefined, NaN, -1, -3, "", Number(null), Number(undefined)]) {
    assert.equal(capPerSource(FUSED, off), FUSED, `maxPerSource=${String(off)} 应当保持关闭`);
  }
});

test("capPerSource:非数组输入原样返回,不抛", () => {
  assert.equal(capPerSource(null, 2), null);
  assert.equal(capPerSource(undefined, 2), undefined);
});

// ── ② 开的时候必须动 ──

test("capPerSource:cap=2 → 名次表等于手算期望,且与关闭时逐项不同", () => {
  const on = capPerSource(FUSED, 2);
  // 手算:头部按序收每源前 2 条 [a1,a2,b1,c1,b2,d1],溢出的 a3/a4 保持相对序降到尾部。
  assert.deepEqual(heads(on), ["a1", "a2", "b1", "c1", "b2", "d1", "a3", "a4"]);
  assert.notDeepEqual(heads(on), heads(capPerSource(FUSED, 0)), "开启后必须真的改变名次");
});

test("capPerSource:cap=1 → 每源只留首块,其余按原相对序降尾", () => {
  assert.deepEqual(heads(capPerSource(FUSED, 1)), ["a1", "b1", "c1", "d1", "a2", "a3", "b2", "a4"]);
});

test("capPerSource:cap 大到无溢出 → 顺序与输入相同,但是一个新数组(裁剪路径已执行)", () => {
  const on = capPerSource(FUSED, 4);
  assert.deepEqual(heads(on), heads(FUSED));
  assert.notEqual(on, FUSED);
});

test("capPerSource:数字型字符串(配置常见形状)照常开启", () => {
  assert.deepEqual(heads(capPerSource(FUSED, "2")), ["a1", "a2", "b1", "c1", "b2", "d1", "a3", "a4"]);
});

test("capPerSource:条目对象原样透传,不复制不丢字段", () => {
  const on = capPerSource(FUSED, 2);
  assert.equal(on[0], FUSED[0], "元素应是同一个对象引用");
  assert.equal(on[6], FUSED[3], "降尾的 a3 也是同一个对象引用");
  assert.deepEqual(on[6], { sourcePath: "a.md", heading: "a3", text: "t", score: 0.6 });
});

test("capPerSource:sourcePath 缺失的条目归为同一组(与 kb-replay.js:133 口径一致)", () => {
  const list = [{ heading: "x" }, { heading: "y" }, { sourcePath: "a.md", heading: "a" }];
  assert.deepEqual(capPerSource(list, 1).map((r) => r.heading), ["x", "a", "y"]);
});

// ── ③ 置换 + 首现单调 = recall/MRR 单调不降的机械化证明 ──

const firstIndexBySource = (list) => {
  const first = new Map();
  list.forEach((r, i) => {
    const p = r.sourcePath || "";
    if (!first.has(p)) first.set(p, i);
  });
  return first;
};

test("capPerSource:输出是输入的置换(召回集合完整,只重排)", () => {
  for (const cap of [1, 2, 3]) {
    const on = capPerSource(FUSED, cap);
    assert.equal(on.length, FUSED.length);
    assert.deepEqual(heads(on).slice().sort(), heads(FUSED).slice().sort());
  }
});

test("capPerSource:每个 sourcePath 的首现名次只前移或不变(写死的名次表)", () => {
  // 关闭:a=0 b=2 c=4 d=7;cap=2:a=0 b=2 c=3 d=5;cap=1:a=0 b=1 c=2 d=3。
  assert.deepEqual([...firstIndexBySource(FUSED)], [["a.md", 0], ["b.md", 2], ["c.md", 4], ["d.md", 7]]);
  assert.deepEqual([...firstIndexBySource(capPerSource(FUSED, 2))], [["a.md", 0], ["b.md", 2], ["c.md", 3], ["d.md", 5]]);
  assert.deepEqual([...firstIndexBySource(capPerSource(FUSED, 1))], [["a.md", 0], ["b.md", 1], ["c.md", 2], ["d.md", 3]]);
});

test("以 sourcePath 判定的 recall@k / MRR 因此单调不降(k=4 与 k=6 上严格上升)", () => {
  const golds = ["a.md", "b.md", "c.md", "d.md"];
  const rankOf = (list, gold) => list.map((r) => r.sourcePath).indexOf(gold);
  const recallAt = (list, k) => golds.filter((g) => { const r = rankOf(list, g); return r !== -1 && r < k; }).length / golds.length;
  const mrr = (list) => golds.reduce((s, g) => { const r = rankOf(list, g); return s + (r === -1 ? 0 : 1 / (r + 1)); }, 0) / golds.length;

  const off = capPerSource(FUSED, 0);
  const on = capPerSource(FUSED, 2);
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(recallAt(on, k) >= recallAt(off, k), `recall@${k} 应单调不降`);
  }
  assert.equal(recallAt(off, 4), 0.5);
  assert.equal(recallAt(on, 4), 0.75);
  assert.equal(recallAt(off, 6), 0.75);
  assert.equal(recallAt(on, 6), 1);
  assert.equal(mrr(on), 0.4375); // (1/1 + 1/3 + 1/4 + 1/6)/4,手算自名次表 a=0 b=2 c=3 d=5
  assert.ok(mrr(on) > mrr(off));
});

test("性质:随机列表上仍是置换 + 首现单调(确定性 LCG,可复现)", () => {
  let seed = 20260811;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial = 0; trial < 200; trial += 1) {
    const list = [];
    for (let i = 0; i < 20; i += 1) list.push({ sourcePath: `s${Math.floor(rnd() * 5)}.md`, heading: `h${i}` });
    const cap = 1 + Math.floor(rnd() * 4);
    const on = capPerSource(list, cap);
    assert.deepEqual(heads(on).slice().sort(), heads(list).slice().sort(), `trial ${trial} 置换性`);
    const before = firstIndexBySource(list);
    const after = firstIndexBySource(on);
    for (const [p, i] of before) assert.ok(after.get(p) <= i, `trial ${trial} 来源 ${p} 首现名次应前移或不变`);
    // 头部长度 = Σ min(每源条数, cap);该前缀内每源至多 cap 条(裁剪真的生效了)
    const total = new Map();
    for (const r of list) total.set(r.sourcePath, (total.get(r.sourcePath) || 0) + 1);
    let headLen = 0;
    for (const [, n] of total) headLen += Math.min(n, cap);
    const headCount = new Map();
    for (const r of on.slice(0, headLen)) headCount.set(r.sourcePath, (headCount.get(r.sourcePath) || 0) + 1);
    for (const [, n] of headCount) assert.ok(n <= cap, `trial ${trial} 头部每源条数应 <= ${cap}`);
  }
});

// ── 尺:单条结果列表 ──

test("distinctSourceCount / dupSlotRate:写死的手算值", () => {
  const list = ["a.md", "a.md", "b.md", "c.md", "c.md", "c.md"];
  assert.equal(distinctSourceCount(list), 3);
  assert.equal(dupSlotRate(list), 0.5); // 6 个名额里 3 个被重复占用
  assert.equal(dupSlotRate(["a.md", "b.md"]), 0);
  assert.equal(dupSlotRate([]), 0);
  assert.equal(distinctSourceCount(null), 0);
});

test("度量忽略缺 sourcePath 的条目(与 kb-diversity.js:37 的 filter(Boolean) 同口径)", () => {
  const list = [{ sourcePath: "a.md" }, { heading: "无源" }, { sourcePath: "a.md" }, { sourcePath: "" }];
  assert.equal(distinctSourceCount(list), 1);
  assert.equal(dupSlotRate(list), 0.5); // 只有 2 个有效名额,其中 1 个重复
});

test("sRecallAtK:缺省分母 = min(k, 槽位数),恒等于 1 - dupSlotRate(同一事实的另一种归一化)", () => {
  const list = ["a.md", "a.md", "b.md", "c.md"];
  assert.equal(sRecallAtK(list, 4), 0.75);
  assert.equal(sRecallAtK(list, 4) + dupSlotRate(list), 1);
  assert.equal(sRecallAtK(list, 2), 0.5);  // 前 2 位都是 a.md
  assert.equal(sRecallAtK(list, 10), 0.75); // k 超出长度 → 分母收敛到槽位数
  assert.equal(sRecallAtK(list, 0), null);  // 无窗口 → 无分母
  assert.equal(sRecallAtK([], 5), null);
});

test("sRecallAtK:给了 universe 才是真正的子话题召回(分母 = 可得多样性)", () => {
  const topK = ["a.md", "a.md", "b.md", "c.md"];
  const pool = ["a.md", "b.md", "c.md", "e.md", "f.md"]; // 截断前的候选池:5 个互异来源
  assert.equal(sRecallAtK(topK, 4, { universe: pool }), 0.6); // 覆盖 3/5
  assert.equal(sRecallAtK(topK, 2, { universe: pool }), 0.2); // 前 2 位只覆盖 a.md
  // universe 外的命中不计入分子
  assert.equal(sRecallAtK(["x.md", "a.md"], 2, { universe: pool }), 0.2);
  assert.equal(sRecallAtK(topK, 4, { universe: [] }), null);
});

test("sRecallAtK:裁剪把候选池里的多样性抬进 top-k(cap 的收益在这把尺上现形)", () => {
  const pool = capPerSource(FUSED, 0);
  const k = 4;
  const before = sRecallAtK(pool, k, { universe: pool });
  const after = sRecallAtK(capPerSource(FUSED, 2), k, { universe: pool });
  assert.equal(before, 0.5);  // top-4 = a,a,b,a → 覆盖 {a,b} / 4 个互异来源
  assert.equal(after, 0.75);  // top-4 = a,a,b,c → 覆盖 {a,b,c} / 4
});

// ── 尺:整个评测集(频次 + Gini)──

test("sourceFrequency:跨查询累计召回次数", () => {
  const f = sourceFrequency([["a.md", "a.md", "b.md"], ["a.md", "c.md"], []]);
  assert.deepEqual([...f].sort(), [["a.md", 3], ["b.md", 1], ["c.md", 1]]);
  assert.equal(sourceFrequency(null).size, 0);
});

test("giniOfCounts:均匀 → 0;单点集中 → 上界 (n-1)/n;两点手算 → 0.25", () => {
  assert.equal(giniOfCounts([1, 1, 1, 1]), 0);
  assert.equal(giniOfCounts([7]), 0);
  assert.equal(giniOfCounts([0, 0, 0, 4]), 0.75); // n=4 时的上界 3/4
  assert.equal(giniOfCounts([1, 3]), 0.25);
  assert.equal(giniOfCounts([3, 1]), 0.25); // 输入序无关(内部升序)
  assert.equal(giniOfCounts(new Map([["a.md", 3], ["b.md", 1]])), 0.25);
});

test("giniOfCounts:无观测 → null(与'值为 0'语义分开)", () => {
  assert.equal(giniOfCounts([]), null);
  assert.equal(giniOfCounts([0, 0, 0]), null);
  assert.equal(giniOfCounts(null), null);
  assert.equal(giniOfCounts(new Map()), null);
});

test("giniOfCounts:universeSize 把总体扩到整库,数值随之抬高 —— 口径必须随数字一起报", () => {
  assert.equal(giniOfCounts([4, 4]), 0);                        // 露过面的两者完全均等
  assert.equal(giniOfCounts([4, 4], { universeSize: 4 }), 0.5); // 补 2 个 0 次文档后
  assert.equal(giniOfCounts([4, 4], { universeSize: 1 }), 0);   // universeSize 小于观测数 → 不补
});

test("retrievalGini:偏好集中的评测集 Gini 高于均匀的评测集", () => {
  const uniform = [["a.md", "b.md"], ["c.md", "d.md"]]; // 4 个来源各 1 次
  const skewed = [["hot.md", "hot.md"], ["hot.md", "x.md"]]; // hot=3 次,x=1 次
  assert.equal(retrievalGini(uniform), 0);
  assert.equal(retrievalGini(skewed), 0.25); // n=2 的上界是 0.5
  assert.ok(retrievalGini(skewed) > retrievalGini(uniform));
  assert.equal(retrievalGini([]), null);
});

// ── 尺:coverageReport 聚合口径 ──

test("coverageReport:dupSlotRate 是微平均(总重复名额/总名额),与逐查询取均值不同", () => {
  // 查询甲 10 位里 9 个重复;查询乙 2 位里 0 个重复。
  const long = new Array(10).fill("hot.md");
  const short = ["a.md", "b.md"];
  const r = coverageReport([long, short]);
  assert.equal(r.slots, 12);
  assert.equal(r.dupSlots, 9);
  assert.equal(r.dupSlotRate, 0.75);               // 9/12
  assert.notEqual(r.dupSlotRate, (0.9 + 0) / 2);   // 逐查询均值会给出 0.45
  assert.equal(r.affectedRate, 0.5);
  assert.equal(r.distinctAvg, 1.5);                // (1 + 2) / 2
});

test("coverageReport:空结果的查询计入 empty 并让开分母(与 kb-diversity.js:38 的 continue 一致)", () => {
  const r = coverageReport([["a.md", "b.md"], [], [{ heading: "无源" }]]);
  assert.equal(r.queries, 1);
  assert.equal(r.empty, 2);
  assert.equal(r.distinctAvg, 2); // 若把空查询算进分母会变成 2/3
  assert.equal(r.dupSlotRate, 0);
});

test("coverageReport:全空 / 非数组 → 零值而非抛错,gini 为 null", () => {
  const r = coverageReport(null);
  assert.deepEqual(r, { queries: 0, empty: 0, slots: 0, dupSlots: 0, dupSlotRate: 0, affectedRate: 0, distinctAvg: 0, sRecallAvg: 0, gini: null });
});

test("coverageReport:口径与已实测 wiki 基线对表(48.8% / 5.13,展示层格式化后逐字符相等)", () => {
  // 合成 24 查询 × 10 位:13 条整列同源(各 9 个重复名额 → 合计 117),11 条完全互异。
  const lists = [];
  for (let i = 0; i < 13; i += 1) lists.push(new Array(10).fill("hot.md"));
  for (let i = 0; i < 11; i += 1) lists.push(Array.from({ length: 10 }, (_, j) => `d${i}-${j}.md`));
  const r = coverageReport(lists, { k: 10 });

  assert.equal(r.queries, 24);
  assert.equal(r.slots, 240);
  assert.equal(r.dupSlots, 117);
  assert.equal(r.dupSlotRate, 117 / 240);
  assert.equal(r.distinctAvg, 123 / 24);
  // 展示层用的格式化(kb-diversity.js:51/53 的 toFixed 口径)必须落在已记录的 live 基线上。
  assert.equal((r.dupSlotRate * 100).toFixed(1), "48.8");
  assert.equal(r.distinctAvg.toFixed(2), "5.13");
  // 各列长度相同时,宏平均的 sRecallAvg 与 1 - 微平均 dupSlotRate 重合(逐项累加有浮点尾差)。
  assert.ok(Math.abs(r.sRecallAvg - (1 - r.dupSlotRate)) < 1e-12, String(r.sRecallAvg));
  assert.equal(r.affectedRate, 13 / 24);
});

test("coverageReport:裁剪后的 top-k 在覆盖度量上改善(recall 之外的独立读数)", () => {
  const topK = 4;
  const off = [capPerSource(FUSED, 0).slice(0, topK)];
  const on = [capPerSource(FUSED, 2).slice(0, topK)];
  const a = coverageReport(off, { k: topK });
  const b = coverageReport(on, { k: topK });
  assert.equal(a.distinctAvg, 2); // a,a,b,a
  assert.equal(b.distinctAvg, 3); // a,a,b,c
  assert.equal(a.dupSlotRate, 0.5);
  assert.equal(b.dupSlotRate, 0.25);
  assert.ok(b.sRecallAvg > a.sRecallAvg);
});
