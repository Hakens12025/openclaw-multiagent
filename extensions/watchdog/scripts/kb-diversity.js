#!/usr/bin/env node
// 检索结果多样性度量。
//
// 为什么单独有它:同源挤占的收益**recall@k 测不出来** —— 挤占浪费的是名额,期望文档若已在 top-1,
// 清掉重复既不改它的 rank 也不改 recall/MRR。指标测不出的改动等于无法证明,所以先有尺再动刀(122 纪律)。
//
//   node scripts/kb-diversity.js memos      # 用 memos 评测集的查询跑一遍,报多样性
//   node scripts/kb-diversity.js wiki
//
// 报三个数:
//   dupSlotRate  — top-k 里被同源重复占用的名额占比(**主指标**,越低越好)
//   affectedRate — 有重复来源的查询占比
//   distinctAvg  — top-k 平均覆盖多少个不同来源(越高越好)
// 需要 ollama(每查询一次 embed)。**串行**,别与其它 embed 任务并发。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchKb } from "../lib/knowledge/knowledge-base.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const kbId = process.argv[2];
if (!kbId) {
  console.error("用法: node scripts/kb-diversity.js <kbId>   (读 tests/fixtures/<kbId>-rag-eval-set.json 的查询)");
  process.exit(1);
}
const label = process.argv[3] || "run";

const fx = JSON.parse(await readFile(join(ROOT, "tests/fixtures", `${kbId}-rag-eval-set.json`), "utf8"));
const topK = fx.topK || 10;

let dupSlots = 0, totalSlots = 0, affected = 0, distinctSum = 0, queries = 0;
const worst = [];

for (const c of fx.cases) {
  const r = await searchKb(kbId, c.query, { topK });
  const paths = (r?.results || []).map((x) => x.sourcePath).filter(Boolean);
  if (paths.length === 0) continue;
  queries += 1;
  totalSlots += paths.length;
  const distinct = new Set(paths).size;
  distinctSum += distinct;
  const dup = paths.length - distinct;
  if (dup > 0) { dupSlots += dup; affected += 1; }
  if (dup >= 2) worst.push({ dup, q: c.query.slice(0, 30) });
}

const pct = (n, d) => (d ? (n / d * 100).toFixed(1) : "0.0");
console.log(JSON.stringify({
  kbId, label, queries, topK,
  dupSlotRate: Number(pct(dupSlots, totalSlots)),
  affectedRate: Number(pct(affected, queries)),
  distinctAvg: Number((distinctSum / (queries || 1)).toFixed(2)),
  dupSlots, totalSlots,
}, null, 1));
if (worst.length) {
  console.log("--- 重复最重的查询 ---");
  for (const w of worst.sort((a, b) => b.dup - a.dup).slice(0, 6)) console.log(`  重复${w.dup}  ${w.q}`);
}
