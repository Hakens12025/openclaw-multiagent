/**
 * knowledge-temporal-metadata.test.js — Phase 5 v150:per-chunk source/time/fields 元数据
 *
 * 通用机:核心只认 {source,time,fields},金融 schema 只活在 KB 的 metadataRules 配置。
 * 纯路径进 gate:extractFrontMatter / extractChunkMeta / normalizeMetadataRules / 通用切分带 meta。
 * 向后兼容:无 rules → chunk 不挂 meta(逐字节同旧)。live(无 ollama 则 skip):配置时态 KB→建→检索带 meta。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFrontMatter } from "../lib/core/markdown-sections.js";
import { extractChunkMeta, buildChunkPlanForSources } from "../lib/operator/wiki-rag-store.js";
import {
  normalizeMetadataRules,
  configureKnowledgeBase,
  addKnowledgeBaseSource,
  removeKnowledgeBase,
} from "../lib/operator/knowledge-base-registry.js";
import { buildKbIndex, searchKb } from "../lib/operator/knowledge-base.js";
import { knowledgeBaseIndexFile } from "../lib/control-plane/control-plane-paths.js";
import { embedText } from "../lib/operator/wiki-rag-embed.js";

let ollamaUp = false;
try { await embedText("probe", {}); ollamaUp = true; } catch { ollamaUp = false; }

const RULES = {
  source: { keys: ["issuer", "author"], fallback: "folder" },
  time: { keys: ["date", "published"], fallback: "mtime" },
  fields: { passthrough: ["target_price", "rating"] },
};

// ── extractFrontMatter(纯)──
test("extractFrontMatter:标准块→kv;无块→{};畸形 fail-soft", () => {
  const fm = extractFrontMatter('---\nissuer: 中信证券\ndate: 2026-01-15\ntarget_price: "200"\nrating: buy\n---\n# 正文\n内容');
  assert.equal(fm.issuer, "中信证券");
  assert.equal(fm.date, "2026-01-15");
  assert.equal(fm.target_price, "200"); // 去引号
  assert.equal(fm.rating, "buy");
  assert.deepEqual(extractFrontMatter("# 没有 front-matter\n正文"), {});
  // 畸形:嵌套缩进 + 列表项 + 无冒号行 → 跳过坏行不崩
  const messy = extractFrontMatter("---\nok: yes\n  nested: skip\n- listitem\nnocolon\n---\n");
  assert.equal(messy.ok, "yes");
  assert.equal(messy.nested, undefined);
  assert.equal(messy.listitem, undefined);
});

// ── extractChunkMeta(纯)──
test("extractChunkMeta:有规则提 source/time/fields;无规则全空;fallback 链", () => {
  const raw = {
    frontMatter: { issuer: "中信证券", date: "2026-01-15", target_price: "200", rating: "buy" },
    fileFacts: { folder: "reports", filename: "rpt1", mtime: "2026-02-01T00:00:00.000Z" },
  };
  const m = extractChunkMeta(raw, RULES);
  assert.equal(m.source, "中信证券");
  assert.equal(m.time, new Date("2026-01-15").toISOString());
  assert.deepEqual(m.fields, { target_price: "200", rating: "buy" });

  // 无规则 → 全空
  assert.deepEqual(extractChunkMeta(raw, null), { source: null, time: null, fields: {} });

  // fallback 链:front-matter 无 issuer/date → 退 folder / mtime
  const m2 = extractChunkMeta({ frontMatter: {}, fileFacts: raw.fileFacts }, RULES);
  assert.equal(m2.source, "reports");                                   // fallback folder
  assert.equal(m2.time, "2026-02-01T00:00:00.000Z");                    // fallback mtime
  assert.deepEqual(m2.fields, {});                                      // 无 passthrough 命中
});

// ── normalizeMetadataRules(纯)──
test("normalizeMetadataRules:合法保留;非法子段剔除;整体空→null", () => {
  const r = normalizeMetadataRules(RULES);
  assert.deepEqual(r.source, { keys: ["issuer", "author"], fallback: "folder" });
  assert.deepEqual(r.fields, { passthrough: ["target_price", "rating"] });
  // 非法 fallback 剔除,但有 keys 仍保留
  assert.deepEqual(normalizeMetadataRules({ source: { keys: ["x"], fallback: "BOGUS" } }).source, { keys: ["x"] });
  // 全空/垃圾 → null
  assert.equal(normalizeMetadataRules({}), null);
  assert.equal(normalizeMetadataRules(null), null);
  assert.equal(normalizeMetadataRules({ source: { keys: [], fallback: "nope" } }), null);
});

// ── 通用切分带 meta(纯,不需 embed)+ 向后兼容 ──
test("buildChunkPlanForSources:有 rules→chunk 带 meta;无 rules→无 meta 字段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-temporal-"));
  try {
    await writeFile(join(dir, "rpt.md"), "---\nissuer: 中信证券\ndate: 2026-01-15\ntarget_price: 200\nrating: buy\n---\n# 目标价上调\n\n我们预测目标价 200。\n");

    const withRules = await buildChunkPlanForSources([dir], { metadataRules: RULES });
    assert.ok(withRules.length >= 1);
    const c = withRules.find((x) => x.sourcePath.endsWith("rpt.md"));
    assert.ok(c.meta, "时态规则下 chunk 应带 meta");
    assert.equal(c.meta.source, "中信证券");
    assert.equal(c.meta.time, new Date("2026-01-15").toISOString());
    assert.equal(c.meta.fields.target_price, "200");
    assert.ok(!c.text.includes("issuer:"), "正文不应含 front-matter(stripMarkdownNoise 已剥)");

    const noRules = await buildChunkPlanForSources([dir]); // 无 rules
    const c2 = noRules.find((x) => x.sourcePath.endsWith("rpt.md"));
    assert.equal(c2.meta, undefined, "无规则 → chunk 不挂 meta 字段(向后兼容)");
    assert.equal(c2.hash, c.hash, "meta 不进 hash → 同文同 hash(改 rules 不触发 re-embed)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── live:配置时态 KB → 建 → 检索结果带 meta(无 ollama 则 skip)──
test("live: configure temporal KB → buildKbIndex → searchKb 结果带 meta(skip if ollama down)", { skip: !ollamaUp }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-temporal-live-"));
  const kbId = `tmpkb-${Date.now()}`;
  try {
    await writeFile(join(dir, "citic.md"), "---\nissuer: 中信证券\ndate: 2026-01-01\ntarget_price: 200\n---\n# A 标的\n\n中信预测 A 标的目标价 200,上调评级。\n");
    await addKnowledgeBaseSource(kbId, dir, { label: "研报库" });
    const cfg = await configureKnowledgeBase(kbId, { temporal: true, metadataRules: RULES });
    assert.equal(cfg.temporal, true);
    assert.deepEqual(cfg.metadataRules.source, { keys: ["issuer", "author"], fallback: "folder" });

    await buildKbIndex(kbId, { force: true });
    const r = await searchKb(kbId, "中信 A 标的 目标价", { topK: 3 });
    assert.equal(r.ok, true);
    const hit = r.results.find((x) => x.sourcePath.endsWith("citic.md"));
    assert.ok(hit, "应命中 citic.md");
    assert.ok(hit.meta, "时态 KB 检索结果应带 meta(端到端透传)");
    assert.equal(hit.meta.source, "中信证券");
    assert.equal(hit.meta.fields.target_price, "200");
  } finally {
    await removeKnowledgeBase(kbId).catch(() => {});
    await rm(knowledgeBaseIndexFile(kbId), { force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
