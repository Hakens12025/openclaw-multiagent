/**
 * knowledge-conflict-derivation.test.js — Phase 5 v151:分歧派生(目标3 本体)+ asOf 点时过滤
 *
 * deriveConflictHints 纯函数 + hybridSearchOverIndex 的 asOf/conflict 接线。用合成 index(带 meta)
 * + 词法检索(不需 ollama)做确定式 e2e:多券商对同标的目标价不同 → 跨源分歧;同源取最新;asOf 防未来泄漏。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { deriveConflictHints, hybridSearchOverIndex } from "../lib/knowledge/wiki-rag-search.js";
import { normalizeConflictConfig } from "../lib/knowledge/knowledge-base-registry.js";
import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";

const CONFLICT = { groupBy: "fields.ticker", on: ["fields.target_price"] };

function res(source, time, target, score = 1) {
  return { sourcePath: `${source}.md`, heading: "AAA", text: `券商 ${source} 看 AAA 目标价 ${target}`, score, meta: { source, time, fields: { ticker: "AAA", target_price: String(target) } } };
}

// ── normalizeConflictConfig(纯)──
test("normalizeConflictConfig:合法→{groupBy,on};on 空→null", () => {
  assert.deepEqual(normalizeConflictConfig(CONFLICT), { groupBy: "fields.ticker", on: ["fields.target_price"] });
  assert.equal(normalizeConflictConfig({ groupBy: "x", on: [] }), null);
  assert.equal(normalizeConflictConfig({ on: ["a"] }).groupBy, null); // groupBy 省略 → null(全部一组)
  assert.equal(normalizeConflictConfig(null), null);
});

// ── deriveConflictHints(纯)──
test("deriveConflictHints:三券商同标的目标价不同 → 1 个跨源分歧 + 数值离散度", () => {
  const hints = deriveConflictHints([
    res("券商A", "2026-01-01T00:00:00.000Z", 200),
    res("券商B", "2026-01-05T00:00:00.000Z", 230),
    res("券商C", "2026-02-01T00:00:00.000Z", 180),
  ], CONFLICT);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].topic, "AAA");
  assert.equal(hints[0].sources.length, 3);
  const d = hints[0].dispersion["fields.target_price"];
  assert.equal(d.kind, "numeric");
  assert.equal(d.min, 180);
  assert.equal(d.max, 230);
  assert.ok(d.stdev > 0, "应有非零离散度");
  assert.ok(hints[0].timeSpan.from < hints[0].timeSpan.to);
});

test("deriveConflictHints:同源取最新(supersession)", () => {
  const hints = deriveConflictHints([
    res("券商A", "2026-01-01T00:00:00.000Z", 200),  // 旧
    res("券商A", "2026-03-01T00:00:00.000Z", 210),  // 新 → 取这条
    res("券商B", "2026-01-05T00:00:00.000Z", 230),
  ], CONFLICT);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].sources.length, 2, "券商A 两条只算一个源(取最新)");
  const a = hints[0].sources.find((s) => s.source === "券商A");
  assert.equal(a.values["fields.target_price"], "210", "同源取最新值");
});

test("deriveConflictHints:单源/取值一致/无 source → 无分歧", () => {
  assert.equal(deriveConflictHints([res("券商A", "2026-01-01T00:00:00.000Z", 200)], CONFLICT).length, 0); // 单源
  assert.equal(deriveConflictHints([
    res("券商A", "2026-01-01T00:00:00.000Z", 200),
    res("券商B", "2026-01-05T00:00:00.000Z", 200), // 同值
  ], CONFLICT).length, 0);
  assert.equal(deriveConflictHints([
    { sourcePath: "x.md", heading: "AAA", text: "无发布者", score: 1 }, // 无 meta.source
    { sourcePath: "y.md", heading: "AAA", text: "无发布者", score: 1 },
  ], CONFLICT).length, 0);
  assert.equal(deriveConflictHints([res("A", "t", 1)], null).length, 0); // 无 conflict 配置
});

// ── hybridSearchOverIndex 接线(合成 index + 词法,不需 ollama)──
function synthIndex(temporal = true) {
  return {
    model: "synthetic", builtAt: "2026-03-01T00:00:00.000Z",
    ...(temporal ? { temporal: true, conflict: CONFLICT } : {}),
    chunks: [
      { id: "a", hash: "ha", ...res("券商A", "2026-01-01T00:00:00.000Z", 200) },
      { id: "b", hash: "hb", ...res("券商B", "2026-01-05T00:00:00.000Z", 230) },
      { id: "c", hash: "hc", ...res("券商C", "2026-02-01T00:00:00.000Z", 180) },
    ].map((c) => ({ id: c.id, sourcePath: c.sourcePath, heading: c.heading, text: c.text, hash: c.hash, meta: c.meta })),
  };
}

test("hybridSearchOverIndex:时态+conflict 索引 → 结果带 meta + conflictHints(词法路径,确定式)", async () => {
  const r = await hybridSearchOverIndex("券商 AAA 目标价", synthIndex(true), { topK: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.results.length >= 2, "词法应召回多条");
  assert.ok(r.results.every((x) => x.meta), "结果应带 meta");
  assert.ok(r.conflictHints && r.conflictHints.length >= 1, "时态库应派生 conflictHints");
  assert.ok(r.conflictHints[0].dispersion["fields.target_price"], "应有目标价离散度");
});

test("hybridSearchOverIndex:非时态索引 → 无 conflictHints(默认关)", async () => {
  const r = await hybridSearchOverIndex("券商 AAA 目标价", synthIndex(false), { topK: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.conflictHints, undefined, "无 temporal/conflict → 不派生");
});

test("hybridSearchOverIndex:asOf 点时过滤(防未来泄漏)", async () => {
  // asOf 卡在 1-10:券商C(2-01)被滤掉 → 只剩 A/B → 仍跨源分歧(200 vs 230)
  const r1 = await hybridSearchOverIndex("券商 AAA 目标价", synthIndex(true), { topK: 5, asOf: "2026-01-10" });
  assert.ok(r1.results.every((x) => x.meta.time <= "2026-01-10"), "asOf 后不应有未来 chunk");
  assert.ok(!r1.results.some((x) => x.sourcePath === "券商C.md"), "券商C(未来)被滤");
  // asOf 卡在 1-02:只剩 A → 单源 → 无分歧
  const r2 = await hybridSearchOverIndex("券商 AAA 目标价", synthIndex(true), { topK: 5, asOf: "2026-01-02" });
  assert.equal(r2.conflictHints, undefined, "只剩单源 → 无分歧");
});

// ── surface 注册 ──
test("inspect.knowledge_kb_search 注册(检索任意 KB 的入口)", () => {
  const s = getCliSystemSurface("inspect.knowledge_kb_search");
  assert.ok(s, "应注册");
  assert.equal(s.family, "inspect");
});
