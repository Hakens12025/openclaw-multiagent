/**
 * kb-chunkctx-grid.test.js — headingPrefix × capPerSource 网格驱动的纯函数锚点。
 *
 * 【钉什么】scripts/kb-chunkctx-ab.js 的网格展开、影子路径与报表格式:全部期望值手工写死成
 * 字面量(第三方锚点),实现漂移任何一位这里就红——「实现调实现」式互比在两边一起改坏时
 * 依然为真,冻结锚点才挡得住(与 wiki-rag-lexical-parity.test.js 同方法论)。
 *
 * 【零 ollama / 零 IO】build/grid 的 embed 与评测主流程属主控 live 步骤;import 驱动脚本
 * 只暴露纯函数(CLI 由 isMain 闸住,node --test 下 argv[1]=测试文件,主流程静默)。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GRID_VARIANTS,
  GRID_CAPS,
  expandChunkctxGrid,
  shadowIndexPath,
  formatGridRow,
  breadcrumbSideEffectLine,
  formatGridReport,
} from "../scripts/kb-chunkctx-ab.js";

// ── 网格真值常量 ─────────────────────────────────────────────────────────────

test("网格轴真值:variants=[off,on](基线在前)、caps=[0,1,2,3](关闭档在前)", () => {
  assert.deepEqual([...GRID_VARIANTS], ["off", "on"]);
  assert.deepEqual([...GRID_CAPS], [0, 1, 2, 3]);
});

// ── 网格展开 ─────────────────────────────────────────────────────────────────

test("expandChunkctxGrid:8 格全展开,variant 外层 × cap 内层,顺序逐格写死", () => {
  assert.deepEqual(expandChunkctxGrid(), [
    { variant: "off", cap: 0, label: "off N=0" },
    { variant: "off", cap: 1, label: "off N=1" },
    { variant: "off", cap: 2, label: "off N=2" },
    { variant: "off", cap: 3, label: "off N=3" },
    { variant: "on", cap: 0, label: "on N=0" },
    { variant: "on", cap: 1, label: "on N=1" },
    { variant: "on", cap: 2, label: "on N=2" },
    { variant: "on", cap: 3, label: "on N=3" },
  ]);
});

test("首格 = {off, N=0} 生产等价基线(headingPrefix 关 + cap=0 时 capPerSource 原样返回同一数组,result-diversity.js:30)", () => {
  const [first] = expandChunkctxGrid();
  assert.deepEqual(first, { variant: "off", cap: 0, label: "off N=0" });
});

// ── 影子索引路径 ─────────────────────────────────────────────────────────────

test("shadowIndexPath:固定落在缓存目录下的 chunkctx-<kb>-<臂>-index.json", () => {
  assert.equal(shadowIndexPath("/x/.replay-cache", "memos", "off"), "/x/.replay-cache/chunkctx-memos-off-index.json");
  assert.equal(shadowIndexPath("/x/.replay-cache", "memos", "on"), "/x/.replay-cache/chunkctx-memos-on-index.json");
  assert.equal(shadowIndexPath("/x/.replay-cache", "wiki", "on"), "/x/.replay-cache/chunkctx-wiki-on-index.json");
});

test("shadowIndexPath:kbId 白名单与 knowledgeBaseIndexFile(control-plane-paths.js:49-53)同规则;未知臂/空 id 抛错", () => {
  // 穿越字符(空格、斜杠、点)被剥除后仍生成同目录内的安全文件名
  assert.equal(shadowIndexPath("/c", "me mos/../x", "on"), "/c/chunkctx-memosx-on-index.json");
  assert.throws(() => shadowIndexPath("/c", "///", "on"), /invalid knowledge base id/);
  assert.throws(() => shadowIndexPath("/c", "", "off"), /invalid knowledge base id/);
  assert.throws(() => shadowIndexPath("/c", "memos", "ON"), /unknown variant/);
  assert.throws(() => shadowIndexPath("/c", "memos", "idf"), /unknown variant/);
});

// ── 单行格式 ─────────────────────────────────────────────────────────────────

const BASE_METRICS = Object.freeze({
  recallAt: Object.freeze({ 1: 0.5, 3: 0.625, 5: 0.75, 10: 0.875 }),
  mrr: 0.6123,
  keywordCoverage: 0.744,
  ghostHitRate: null,
  dupSlotRate: 0.125,
  sRecallAvg: 0.75,
});

test("formatGridRow:整行冻结(百分位一位小数、MRR 四位、sRec 三位、null → n/a)", () => {
  assert.equal(
    formatGridRow({ label: "off N=0", metrics: BASE_METRICS }),
    "off N=0   r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 12.5%  sRec 0.750",
  );
  // 满分 recall、ghost 有值、kwCov/sRec 缺席(null 语义 = 没人标,与 wiki-rag-eval 一致)
  assert.equal(
    formatGridRow({
      label: "on N=2",
      metrics: { recallAt: { 1: 1, 3: 1, 5: 1, 10: 1 }, mrr: 0.5, keywordCoverage: null, ghostHitRate: 0.25, dupSlotRate: 0, sRecallAvg: null },
    }),
    "on N=2    r@1 100.0  @3 100.0  @5 100.0  @10 100.0  MRR 0.5000  kwCov n/a  ghost 0.25  dup 0.0%  sRec n/a",
  );
});

// ── 面包屑词法副作用点名行 ───────────────────────────────────────────────────

test("breadcrumbSideEffectLine:正/负方向都按字面冻结;N=0 两格缺一 → null", () => {
  assert.equal(
    breadcrumbSideEffectLine([
      { variant: "off", cap: 0, metrics: { dupSlotRate: 0.125 } },
      { variant: "on", cap: 0, metrics: { dupSlotRate: 0.15 } },
    ]),
    "面包屑词法副作用(N=0): dup off 12.5% → on 15.0% (Δ+2.5pp;为正 = 祖先标题词让同页 chunk 一起加分、挤占加重)",
  );
  assert.equal(
    breadcrumbSideEffectLine([
      { variant: "off", cap: 0, metrics: { dupSlotRate: 0.2 } },
      { variant: "on", cap: 0, metrics: { dupSlotRate: 0.15 } },
    ]),
    "面包屑词法副作用(N=0): dup off 20.0% → on 15.0% (Δ-5.0pp;为正 = 祖先标题词让同页 chunk 一起加分、挤占加重)",
  );
  assert.equal(breadcrumbSideEffectLine([{ variant: "off", cap: 0, metrics: { dupSlotRate: 0.1 } }]), null);
  assert.equal(breadcrumbSideEffectLine([]), null);
  assert.equal(breadcrumbSideEffectLine(null), null);
});

// ── 整报表 ───────────────────────────────────────────────────────────────────

test("formatGridReport:整报表冻结 —— 表头、臂间空行、8 行网格、副作用尾行", () => {
  const rows = expandChunkctxGrid().map((cell) => ({
    ...cell,
    metrics: { ...BASE_METRICS, dupSlotRate: cell.variant === "on" ? 0.15 : 0.125 },
  }));
  const EXPECTED = [
    "# memos | 84 例 | topK=10 wide=40 | 每臂 3642 块 | qwen3-embedding:0.6b",
    "off N=0   r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 12.5%  sRec 0.750",
    "off N=1   r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 12.5%  sRec 0.750",
    "off N=2   r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 12.5%  sRec 0.750",
    "off N=3   r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 12.5%  sRec 0.750",
    "",
    "on N=0    r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 15.0%  sRec 0.750",
    "on N=1    r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 15.0%  sRec 0.750",
    "on N=2    r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 15.0%  sRec 0.750",
    "on N=3    r@1 50.0  @3 62.5  @5 75.0  @10 87.5  MRR 0.6123  kwCov 74.4  ghost n/a  dup 15.0%  sRec 0.750",
    "",
    "面包屑词法副作用(N=0): dup off 12.5% → on 15.0% (Δ+2.5pp;为正 = 祖先标题词让同页 chunk 一起加分、挤占加重)",
  ].join("\n");
  assert.equal(
    formatGridReport(rows, { kbId: "memos", caseCount: 84, topK: 10, wide: 40, chunkCount: 3642, model: "qwen3-embedding:0.6b" }),
    EXPECTED,
  );
});

test("formatGridReport:空 rows → 仅表头(副作用行随 N=0 两格缺席而缺席)", () => {
  assert.equal(
    formatGridReport([], { kbId: "wiki", caseCount: 24, topK: 10, wide: 40, chunkCount: 444, model: "m" }),
    "# wiki | 24 例 | topK=10 wide=40 | 每臂 444 块 | m",
  );
});
