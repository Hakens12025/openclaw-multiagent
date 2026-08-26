#!/usr/bin/env node
// KB 召回评测的复跑入口。
//
// 为什么需要它:评测集有两处存在 —— git 里的 fixture(真值)和 control-plane 的运行时注册表
// (runKnowledgeEval 只认后者)。两者之间没有任何自动同步,新克隆的仓库有 fixture 却跑不了评测。
// 本脚本就是那条同步:读 fixture → 注册 → 跑 → 打报告。fixture 始终是真值,注册表是它的投影。
//
//   node scripts/kb-eval.js memos            # 用 tests/fixtures/memos-rag-eval-set.json
//   node scripts/kb-eval.js wiki             # 同理
//   node scripts/kb-eval.js memos --no-run   # 只注册不跑(省 embed)
//
// 需要 ollama 在跑(每个 query 一次 embed)。**串行**,别并发跑多个 —— ollama 是单点,
// 并发只会互相饿死(实测教训)。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { saveKnowledgeEvalSet } from "../lib/knowledge/knowledge-eval-registry.js";
import { runKnowledgeEval, listKnowledgeEvalRuns } from "../lib/knowledge/knowledge-eval-runner.js";
import { diffRecallRanks } from "../lib/knowledge/wiki-rag-eval.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const kbId = process.argv[2];
if (!kbId) {
  console.error("用法: node scripts/kb-eval.js <kbId> [--no-run]\n  fixture 约定: tests/fixtures/<kbId>-rag-eval-set.json");
  process.exit(1);
}

const fixturePath = join(ROOT, "tests/fixtures", `${kbId}-rag-eval-set.json`);
const fx = JSON.parse(await readFile(fixturePath, "utf8"));
const evalSetId = `${kbId}-core`;

const saved = await saveKnowledgeEvalSet({ kbId, evalSetId, label: `${kbId} 主评测集`, topK: fx.topK, cases: fx.cases });
console.log(`注册 ${kbId}::${evalSetId} — ${saved.cases.length}/${fx.cases.length} 例`);
// normalizeCase 会静默丢弃畸形用例;数目对不上必须叫出来,否则评测悄悄少测几题。
if (saved.cases.length !== fx.cases.length) {
  console.error(`⚠ ${fx.cases.length - saved.cases.length} 例被 normalizeCase 丢弃 —— 检查 fixture 字段`);
  process.exit(1);
}
if (process.argv.includes("--no-run")) process.exit(0);

// 配对基线必须在本次 run 之前取,否则取到自己(runner 内部同理)。
const prev = (await listKnowledgeEvalRuns({ kbId, evalSetId, limit: 50 })).find((r) => r.kind === "recall" && Array.isArray(r.perCase));

const t = Date.now();
const out = await runKnowledgeEval(kbId, evalSetId, { logger: console });
if (!out.ok) { console.error("FAILED:", out.error); process.exit(1); }
const s = out.run;

console.log(`\n=== ${kbId} 召回 (${((Date.now() - t) / 1000).toFixed(0)}s) ===`);
console.log(`recall@1 ${(s.recallAt[1] * 100).toFixed(1)}  @3 ${(s.recallAt[3] * 100).toFixed(1)}  @5 ${(s.recallAt[5] * 100).toFixed(1)}  @10 ${(s.recallAt[10] * 100).toFixed(1)}  MRR ${s.mrr}`);
console.log(`ghostHitRate ${s.ghostHitRate ?? "n/a"} (${s.ghostEvaluated} 例, 越低越好) | keywordCoverage ${s.keywordCoverage ?? "n/a"}`);
console.log(`total ${s.total} | 计分 ${s.evaluated} | 弃权 ${s.abstained} | 未命中 ${s.missCount}${s.degraded ? " | ⚠ degraded" : ""}`);
console.log("byCategory:", JSON.stringify(s.byCategory));

if (prev) {
  const d = diffRecallRanks(prev.perCase, s.perCase);
  console.log(`\n--- 对比上轮 ${prev.runId}:配对 ${d.paired} 未配对 ${d.unpaired} | ↓${d.demotions.length} ↑${d.promotions.length} ---`);
  for (const p of d.demotions) console.log(`  ↓ rank ${p.rankBefore} → ${p.rankAfter}  ${p.query}`);
  for (const p of d.promotions) console.log(`  ↑ rank ${p.rankBefore} → ${p.rankAfter}  ${p.query}`);
} else {
  console.log("\n(无可配对基线 —— 这是本评测集的第一条 run)");
}

if (out.misses.length) {
  console.log("\n--- 未命中 ---");
  for (const m of out.misses) console.log(`  ✖ ${m.query}\n     期望 ${m.expected}\n     实得 ${(m.topPaths || []).slice(0, 3).join(" | ")}`);
}
