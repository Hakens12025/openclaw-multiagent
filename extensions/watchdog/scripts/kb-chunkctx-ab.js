#!/usr/bin/env node
// kb-chunkctx-ab.js — headingPrefix(面包屑进 chunk 文本)× capPerSource(同源上限)合并网格 A/B。
//
// 【测什么】两个已建好但默认关闭的旋钮,一次网格出裁决数据:
//   ① headingPrefix(wiki-rag-store.js:153 buildChunkPlanFromPages,默认 false):把 h1>h2>h3
//      面包屑拼进 chunk.text。它同时改向量腿(embed 的正是 chunk.text,store.js:378)与词法腿
//      (hay = text + heading,store.js:503)——祖先标题词会给该页**全部** chunk 加分,预期把
//      同页 chunk 一起推高。这个副作用由网格的 dupSlotRate 列直接可见(on/off 在 N=0 的差),
//      报表尾行专门点名方向。
//   ② capPerSource(result-diversity.js:28,生产零调用):RRF 融合后的同源上限稳定分区。
//      本网格是该模块的 wire-or-delete 裁决实验:N∈{1,2,3} 若拿不出多样性收益(sRec/dup),模块应删。
//
// 【证据等级纪律】网格数字只说明「方向为正 / 机制成立」;统计认证需另跑配对检验
// (rag-stats.pairedRankReport,与 kb-replay.js paired 同口径)。结论表述保持「统计未认证」措辞。
//
// 【怎么跑 —— embed 一律由主控独占串行执行,ollama 是单点】
//   node scripts/kb-chunkctx-ab.js build memos    # 需 ollama:建 off/on 两个影子索引
//   node scripts/kb-chunkctx-ab.js grid  memos    # 需 ollama:每查询嵌一次,8 格网格评测
//   node scripts/kb-chunkctx-ab.js --clean memos  # 零 ollama:拆除影子索引
//
// 【影子索引】.replay-cache/chunkctx-<kbId>-{off,on}-index.json,生产索引全程只读。
//   off 臂与生产同文本 → 先把生产索引拷来当增量底座,hash 复用让 off 臂接近零嵌入;
//   build 打印 off reembedded=0 时,grid 的 off N=0 行可与 live `node scripts/kb-eval.js <kbId>`
//   逐位对表(该格 = 生产管线等价:rewriteQuery → 词法/向量 wide=max(topK*4,20) → rrfFuse →
//   slice(topK),与 hybridSearchOverIndex(wiki-rag-search.js:145-170)同序同参;rerank 默认关;
//   cap=0 时 capPerSource 原样返回同一数组,见 result-diversity.js:30)。
//   on 臂前缀让每块 text→hash 全变 → 全量重嵌(约 = 语料块数次 embed,主控预算内)。

import { resolveWikiRagLexicalConfig } from "../lib/knowledge/wiki-rag-lexical.js";
import { readFile, writeFile, mkdir, rm, copyFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  loadRagIndexFile,
  buildChunkPlanForSources,
  embedChunkPlanToIndex,
  buildWikiRagIndex,
  searchWikiRag,
  searchWikiRagLexical,
} from "../lib/knowledge/wiki-rag-store.js";
import { getKnowledgeBaseSpec, loadKnowledgeBaseIndex } from "../lib/knowledge/knowledge-base.js";
import { knowledgeBaseIndexFile } from "../lib/control-plane/control-plane-paths.js";
import { rewriteQuery, rrfFuse } from "../lib/knowledge/wiki-rag-search.js";
import { embedText, resolveWikiRagEmbedConfig } from "../lib/knowledge/wiki-rag-embed.js";
import { resolveWikiRagRerankConfig } from "../lib/knowledge/wiki-rag-rerank.js";
import { evaluateWikiRagRecall } from "../lib/knowledge/wiki-rag-eval.js";
import { capPerSource, coverageReport, sRecallAtK } from "../lib/knowledge/result-diversity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, ".replay-cache");

// ── 纯函数(tests/kb-chunkctx-grid.test.js 用硬编码期望钉住) ──────────────────

export const GRID_VARIANTS = Object.freeze(["off", "on"]); // off 在前 = 基线先行
export const GRID_CAPS = Object.freeze([0, 1, 2, 3]);      // N=0 = capPerSource 关闭档

// 网格展开:variant 外层 × cap 内层,顺序固定(首格 = 生产等价基线 off/N=0)。
export function expandChunkctxGrid() {
  const cells = [];
  for (const variant of GRID_VARIANTS) {
    for (const cap of GRID_CAPS) cells.push({ variant, cap, label: `${variant} N=${cap}` });
  }
  return cells;
}

// 影子索引路径。kbId 白名单与 knowledgeBaseIndexFile(control-plane-paths.js:49-53)同规则,
// 保持一致口径(sources 由用户/operator 提供,路径构造必须过 charset 闸)。
export function shadowIndexPath(cacheDir, kbId, variant) {
  const safe = String(kbId || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) throw new Error("invalid knowledge base id");
  if (!GRID_VARIANTS.includes(variant)) throw new Error(`unknown variant: ${variant}`);
  return join(cacheDir, `chunkctx-${safe}-${variant}-index.json`);
}

// 比例 [0,1] → 百分数一位小数;null → n/a(与 wiki-rag-eval 的 null 语义一致:没人标 = 无读数)。
const pct = (v) => (v == null ? "n/a" : (v * 100).toFixed(1));

// 单元格一行:recall/MRR/kwCov/ghost 沿用 kb-replay.js:174 的列风格,追加 dup / sRec 两列。
export function formatGridRow({ label, metrics } = {}) {
  const m = metrics || {};
  const r = m.recallAt || {};
  return `${String(label || "").padEnd(9)} r@1 ${pct(r[1])}  @3 ${pct(r[3])}  @5 ${pct(r[5])}  @10 ${pct(r[10])}` +
    `  MRR ${m.mrr == null ? "n/a" : Number(m.mrr).toFixed(4)}` +
    `  kwCov ${pct(m.keywordCoverage)}` +
    `  ghost ${m.ghostHitRate == null ? "n/a" : Number(m.ghostHitRate).toFixed(2)}` +
    `  dup ${pct(m.dupSlotRate)}%` +
    `  sRec ${m.sRecallAvg == null ? "n/a" : Number(m.sRecallAvg).toFixed(3)}`;
}

// 面包屑词法副作用点名行:on/off 在 N=0(裁剪关闭)的 dupSlotRate 差就是「祖先标题词给同页
// 全部 chunk 加分」的直接读数——Δ 为正即副作用坐实。两格缺一 → null(报表里整行缺席)。
export function breadcrumbSideEffectLine(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const off0 = list.find((r) => r && r.variant === "off" && r.cap === 0);
  const on0 = list.find((r) => r && r.variant === "on" && r.cap === 0);
  if (!off0 || !on0) return null;
  const offDup = Number(off0.metrics?.dupSlotRate) || 0;
  const onDup = Number(on0.metrics?.dupSlotRate) || 0;
  const delta = (onDup - offDup) * 100;
  return `面包屑词法副作用(N=0): dup off ${(offDup * 100).toFixed(1)}% → on ${(onDup * 100).toFixed(1)}%` +
    ` (Δ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp;为正 = 祖先标题词让同页 chunk 一起加分、挤占加重)`;
}

// 整报表:表头 → off 臂 4 行 → 空行 → on 臂 4 行 → 空行 → 副作用点名行。
export function formatGridReport(rows, { kbId, caseCount, topK, wide, chunkCount, model } = {}) {
  const lines = [`# ${kbId} | ${caseCount} 例 | topK=${topK} wide=${wide} | 每臂 ${chunkCount} 块 | ${model}`];
  let prevVariant = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (prevVariant !== null && row.variant !== prevVariant) lines.push("");
    prevVariant = row.variant;
    lines.push(formatGridRow(row));
  }
  const sideEffect = breadcrumbSideEffectLine(rows);
  if (sideEffect) lines.push("", sideEffect);
  return lines.join("\n");
}

// ── CLI(仅直接执行时运行;被测试 import 时只暴露上面的纯函数) ────────────────

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function runBuild(kbId) {
  const spec = await getKnowledgeBaseSpec(kbId);
  if (!spec) fail(`未知知识库: ${kbId}`);
  await mkdir(CACHE_DIR, { recursive: true });

  // off 臂播种:off 与生产同文本,把生产索引拷来当增量底座 → hash 复用,off 臂接近零嵌入。
  const offPath = shadowIndexPath(CACHE_DIR, kbId, "off");
  const offExists = await stat(offPath).then(() => true, () => false);
  if (!offExists) {
    if (spec.id === "wiki") {
      const prod = await loadKnowledgeBaseIndex("wiki");
      if (Array.isArray(prod?.chunks) && prod.chunks.length) await writeFile(offPath, JSON.stringify(prod), "utf8");
    } else {
      await copyFile(knowledgeBaseIndexFile(spec.id), offPath).catch(() => { /* 生产索引缺席 → off 臂全量嵌 */ });
    }
  }

  const results = {};
  if (spec.id === "wiki") {
    // wiki 走专用建库路(meta 页排除),与 buildKbIndex(knowledge-base.js:53)同口径,多两个实验旋钮。
    for (const variant of GRID_VARIANTS) {
      results[variant] = await buildWikiRagIndex({
        logger: console,
        indexPath: shadowIndexPath(CACHE_DIR, kbId, variant),
        headingPrefix: variant === "on",
      });
    }
  } else {
    // 与 buildKbIndex(knowledge-base.js:55-56)同口径:sources → chunk plan → embed 到索引文件,
    // 多 headingPrefix / indexPath 两个实验旋钮。快照守卫:chunk id 与前缀无关(id=relPath#slug#ord,
    // 前缀只改 text/hash,store.js:169-186),两臂 id 序列一致 = 两次读源读到同一份语料快照。
    const plans = {};
    for (const variant of GRID_VARIANTS) {
      plans[variant] = await buildChunkPlanForSources(spec.sources, {
        logger: console,
        metadataRules: spec.metadataRules,
        headingPrefix: variant === "on",
      });
    }
    const idSeq = (plan) => plan.map((c) => c.id).join("\n");
    if (idSeq(plans.off) !== idSeq(plans.on)) fail("两臂 chunk id 序列不一致(两次读源之间语料变了)— 重跑 build");
    for (const variant of GRID_VARIANTS) {
      results[variant] = await embedChunkPlanToIndex({
        plan: plans[variant],
        indexPath: shadowIndexPath(CACHE_DIR, kbId, variant),
        logger: console,
        temporal: spec.temporal === true,
        conflict: spec.conflict,
      });
    }
  }

  let degraded = false;
  for (const variant of GRID_VARIANTS) {
    const r = results[variant];
    console.log(`${variant.padEnd(4)} 块 ${r.chunkCount}  新嵌 ${r.reembedded}  复用 ${r.reused}${r.degraded ? "  ⚠ degraded" : ""}  → ${shadowIndexPath(CACHE_DIR, kbId, variant)}`);
    if (r.degraded) degraded = true;
  }
  if (degraded) fail("有臂降级(embed 掉线期间缺向量)— A/B 数据没有裁决力,修好 ollama 后重跑 build");
  if (results.off.chunkCount !== results.on.chunkCount) fail("两臂块数不一致 — 重跑 build");
  console.log(`off reembedded=${results.off.reembedded}(=0 时 off 臂与生产索引同文本,grid 的 off N=0 行可与 live kb-eval 逐位对表)`);
}

async function runGrid(kbId) {
  const fixturePath = join(ROOT, "tests/fixtures", `${kbId}-rag-eval-set.json`);
  let fx;
  try {
    fx = JSON.parse(await readFile(fixturePath, "utf8"));
  } catch {
    fail(`评测集缺失/损坏: ${fixturePath}`);
  }
  if (fx.cases.some((c) => c.asOf)) fail("fixture 含 asOf,本网格未实现点时过滤(结论会失真)— 先扩展脚本");
  const topK = fx.topK || 10;
  const wide = Math.max(topK * 4, 20); // 与生产宽集一致(wiki-rag-search.js:147)

  const indexes = {};
  for (const variant of GRID_VARIANTS) {
    const p = shadowIndexPath(CACHE_DIR, kbId, variant);
    const idx = await loadRagIndexFile(p);
    if (!idx.chunks.length) fail(`影子索引缺失/为空: ${p} — 先跑 build ${kbId}`);
    const missing = idx.chunks.filter((c) => !Array.isArray(c.vector) || c.vector.length === 0).length;
    if (missing > 0) fail(`${p} 缺 ${missing} 块向量(降级建库残留)— 重跑 build`);
    indexes[variant] = idx;
  }
  if (indexes.off.chunks.length !== indexes.on.chunks.length) {
    fail(`两臂块数不一致(off ${indexes.off.chunks.length} / on ${indexes.on.chunks.length})— 语料漂移,重跑 build`);
  }
  const cfg = await resolveWikiRagEmbedConfig();
  for (const variant of GRID_VARIANTS) {
    if (indexes[variant].model !== cfg.model) {
      fail(`${variant} 臂索引模型 ${indexes[variant].model} 与当前配置 ${cfg.model} 不同 — 查询向量须与索引同空间,重跑 build`);
    }
  }
  const rcfg = await resolveWikiRagRerankConfig();
  if (rcfg.enabled) console.error("⚠ live 配置开了 rerank:本网格恒走 RRF 序,与 live kb-eval 对表前先关 rerank 再跑 live。");

  // 每查询 embed 一次(串行,ollama 单点),两臂共用同一 query 向量(同模型同空间)。
  // 每臂各自组装生产管线:rewriteQuery → 词法/向量 wide → rrfFuse(内部 k=RRF_K=60)——
  // 与 hybridSearchOverIndex(wiki-rag-search.js:145-164)同序同参,rerank 默认关。
  const fusedBy = { off: new Map(), on: new Map() };
  for (const c of fx.cases) {
    const rewritten = rewriteQuery(c.query);
    let queryEmbedding;
    try {
      queryEmbedding = await embedText(rewritten, { model: cfg.model, baseUrl: cfg.baseUrl });
    } catch (error) {
      fail(`query embed 失败(${error.message})— 降级数据没有裁决力,修好 ollama 再跑`);
    }
    // 词法档位与生产同源解析(wiki-rag-lexical.js 的 resolveWikiRagLexicalConfig):
    // 网格测的是 headingPrefix × cap,词法档必须跟生产一致,否则测的是三变量混合体。
    const scoring = await resolveWikiRagLexicalConfig(null);
    for (const variant of GRID_VARIANTS) {
      const index = indexes[variant];
      const vectorLeg = await searchWikiRag(queryEmbedding, { topK: wide, index });
      const lexicalLeg = await searchWikiRagLexical(rewritten, { topK: wide, index, scoring });
      fusedBy[variant].set(c.query, rrfFuse([vectorLeg, lexicalLeg], { topK: wide }));
    }
    process.stderr.write(".");
  }
  process.stderr.write("\n");

  const rows = [];
  for (const cell of expandChunkctxGrid()) {
    const wideOf = (q) => fusedBy[cell.variant].get(q) || [];
    const resultsOf = (q) => capPerSource(wideOf(q), cell.cap).slice(0, topK);
    const recall = await evaluateWikiRagRecall(fx.cases, async (q) => ({ ok: true, degraded: false, results: resultsOf(q) }), { topK });
    const cov = coverageReport(fx.cases.map((c) => resultsOf(c.query)), { k: topK });
    // sRec 口径:universe = 该臂自己的 wide 融合集(截断前候选池,result-diversity.js:58-63 口径①)。
    // 同臂内跨 N 直接可比(池子固定,量的正是裁剪把多少候选多样性带进 topK);跨臂比较时池子随
    // 面包屑一起变,读数要连同 dup/recall 一起看。
    let sSum = 0;
    let sCount = 0;
    for (const c of fx.cases) {
      const s = sRecallAtK(resultsOf(c.query), topK, { universe: wideOf(c.query) });
      if (s != null) {
        sSum += s;
        sCount += 1;
      }
    }
    rows.push({
      ...cell,
      metrics: {
        recallAt: recall.recallAt,
        mrr: recall.mrr,
        keywordCoverage: recall.keywordCoverage,
        ghostHitRate: recall.ghostHitRate,
        dupSlotRate: cov.dupSlotRate,
        sRecallAvg: sCount ? sSum / sCount : null,
      },
    });
  }

  console.log(formatGridReport(rows, {
    kbId,
    caseCount: fx.cases.length,
    topK,
    wide,
    chunkCount: indexes.off.chunks.length,
    model: cfg.model,
  }));
  console.log("");
  console.log(`off N=0 = 生产等价格(cap 关 → capPerSource 原样返回,rerank 关);build 报 off reembedded=0 时可与 live kb-eval ${kbId} 逐位对表。`);
  console.log("读数纪律:网格给的是方向/机制;统计认证另跑配对检验(rag-stats.pairedRankReport 口径)。");
}

async function runClean(kbId) {
  for (const variant of GRID_VARIANTS) {
    const p = shadowIndexPath(CACHE_DIR, kbId, variant);
    await rm(p, { force: true });
    console.log(`已移除 ${p}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--clean")) {
    if (!positional[0]) usage();
    await runClean(positional[0]);
    return;
  }
  const [cmd, kbId] = positional;
  if (cmd === "build" && kbId) return runBuild(kbId);
  if (cmd === "grid" && kbId) return runGrid(kbId);
  usage();
}

function usage() {
  console.error("用法: node scripts/kb-chunkctx-ab.js <build|grid> <kbId> | --clean <kbId>");
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) await main();
