#!/usr/bin/env node
// scripts/kb-rerank-ab.js — 离线 rerank A/B 测量台(串行 LLM + 断点续跑 + 池内救回兑现率)
//
// 【测什么】memos 实测:gold 在 wide-40 融合池内 85.2%,而 r@10 只有 66.7 —— 中间 18.5pp 是
// 「池里有、top-10 没有」的题,恰是 listwise rerank 唯一能兑现的空间(池外的题再好的重排也是零收益)。
// 本脚本把这件事变成直接测量:同一 fused wide-40,基线臂按 RRF 原序切 10,rerank 臂全量喂给
// 生产 rerankResults 重排后切 10,逐例配对(pairedRankReport)+ 单独报「池内救回率」。
//
// 【与生产的对齐】基线臂 = 向量腿(.replay-cache/<kbId>.json 缓存截回生产宽集)+ 词法腿
// (生产 searchWikiRagLexical)+ rrfFuse —— 与 scripts/kb-replay.js verify 同一条复现路径
// (该路径已与 live 逐位对齐)。rerank 臂调的是生产 rerankResults(wiki-rag-rerank.js:51),
// query 用改写后 rewritten(与 hybridSearchOverIndex 的 rerank 挂点同口径)。
//
// 【关键点①:吃满宽集】rerankResults 内部有 MAX_RERANK_CANDIDATES(24)截候选、4 处
// .slice(0,topN) 截返回。这里注入 maxCandidates=fused.length + topN=fused.length,让 40 候选
// 全部进入重排,返回后由本脚本再切 top-10。maxCandidates 是为本测量台新增的注入项,默认值 =
// 原常量,生产默认路径逐字节等价(tests/kb-rerank-ab-units.test.js 冻结锚点证明)。
//
// 【关键点②:串行 + 断点续跑】LLM 是本地 ollama 单点:一次一调,每题完成立即落盘
// .replay-cache/<kbId>-rerank-ab.json;重跑跳过已完成题。ollama 不可达 → 立即停批保进度;
// 解析失败(模型答非所问)→ 记入 failures,下次重跑重试。索引/宽集/topK/模型指纹不匹配 →
// 拒跑并提示删状态文件重来(混两个世界的数据比重跑更贵)。
//
// 【关键点③:池内救回单独报】rescued = gold 在池内、基线 top-10 之外、rerank 后进 top-10 ——
// 这是 18.5pp 空间的直接兑现率,聚合 recall 会把它和「本来就在 top-10」混在一起看不清。
//
// 【rank 口径】rank 0-based、-1 = 不在 top-10,与 wiki-rag-eval.js 一致;判定单位 sourcePath。
//
//   node scripts/kb-rerank-ab.js memos                  # 默认 dry-run(零 LLM):打印将调用次数
//   node scripts/kb-rerank-ab.js memos --run            # 串行真跑(断点续跑)
//   node scripts/kb-rerank-ab.js memos --run --limit 10 # 分批:只跑前 10 道待跑题
//
// 前置:node scripts/kb-replay.js capture <kbId> 已抓宽集缓存(≥ 生产宽集)。

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { loadKnowledgeBaseIndex } from "../lib/knowledge/knowledge-base.js";
import { searchWikiRagLexical } from "../lib/knowledge/wiki-rag-store.js";
import { rrfFuse } from "../lib/knowledge/wiki-rag-search.js";
import { rerankResults, resolveWikiRagRerankConfig } from "../lib/knowledge/wiki-rag-rerank.js";
import { ollamaChatJson } from "../lib/knowledge/wiki-rag-judge.js";
import { pairedRankReport, reciprocalRank } from "../lib/knowledge/rag-stats.js";

// ── 纯函数(tests/kb-rerank-ab-units.test.js 覆盖,硬编码期望)──────────────────

const inTopK = (rank) => Number.isInteger(rank) && rank >= 0;

// 池内救回判定。goldInPool = gold 在 fused wide 池内;baseRank/rerankRank = top-K 内名次(-1 = 未进)。
// out-of-pool 优先级最高:池外的题两臂必然同 miss,归因于召回深度而非重排。
export function classifyRerankOutcome({ goldInPool, baseRank, rerankRank } = {}) {
  if (goldInPool !== true) return "out-of-pool";
  const baseHit = inTopK(baseRank);
  const rerankHit = inTopK(rerankRank);
  if (!baseHit && rerankHit) return "rescued"; // 18.5pp 空间的直接兑现
  if (baseHit && !rerankHit) return "lost"; // rerank 造成的伤害
  if (!baseHit && !rerankHit) return "unrescued"; // 池里有,但重排也没救回
  return "held"; // 两臂都在 top-K(名次仍可挪,配对检验看得见)
}

// 断点续跑清单:保持 fixture 序,completed 里已有的题跳过。completed 里 fixture 已删的孤儿键
// 与清单无关(报表侧同样按 fixture 序过滤)。
export function pendingQueries(cases, completed) {
  const done = completed && typeof completed === "object" ? completed : {};
  return (Array.isArray(cases) ? cases : []).filter(
    (c) => c && typeof c.query === "string" && c.query && !Object.hasOwn(done, c.query),
  );
}

// 状态指纹:索引/宽集/topK/模型任一变了,旧进度就属于另一个世界,拒绝混用。
const FINGERPRINT_KEYS = ["kbId", "chunkCount", "wide", "topK", "model"];
export function fingerprintMatches(a, b) {
  if (!a || typeof a !== "object" || !b || typeof b !== "object") return false;
  return FINGERPRINT_KEYS.every((k) => a[k] === b[k]);
}

// 池内救回聚合:只算 scored(undecided 悬而未决,与 evaluateWikiRagRecall 同口径)。
// poolOnly = rescued + unrescued(gold 在池内且基线 top-K 之外)= rerank 空间的人口;
// rescueRate = rescued / poolOnly = 该空间的直接兑现率。
export function rescueSummary(records) {
  const scored = (Array.isArray(records) ? records : []).filter((r) => r && r.scored !== false);
  const counts = { rescued: 0, unrescued: 0, lost: 0, held: 0, outOfPool: 0 };
  const keyOf = { rescued: "rescued", unrescued: "unrescued", lost: "lost", held: "held", "out-of-pool": "outOfPool" };
  for (const r of scored) counts[keyOf[classifyRerankOutcome(r)]] += 1;
  const poolOnly = counts.rescued + counts.unrescued;
  return { scored: scored.length, ...counts, poolOnly, rescueRate: poolOnly ? counts.rescued / poolOnly : null };
}

// ── 报告(dry-run 与 --run 共用一条打印路径)──────────────────────────────────

function printReport(fx, state, topK) {
  const records = fx.cases.filter((c) => Object.hasOwn(state.completed, c.query)).map((c) => state.completed[c.query]);
  if (!records.length) return;
  const scoredRecs = records.filter((r) => r.scored !== false);
  const denom = scoredRecs.length || 1;
  const rAt = (key, k) => ((scoredRecs.filter((r) => inTopK(r[key]) && r[key] < k).length / denom) * 100).toFixed(1);
  const mrrOf = (key) => scoredRecs.reduce((s, r) => s + reciprocalRank(r[key]), 0) / denom;
  const partial = records.length < fx.cases.length ? `(部分 ${records.length}/${fx.cases.length},结论以全量完成为准)` : "";
  console.log(`# ${state.kbId} | rerank A/B 报告${partial} | 完成 ${records.length} 题(计分 ${scoredRecs.length})| wide ${state.fingerprint.wide} → top-${topK} | 模型 ${state.fingerprint.model}`);
  console.log(`基线   r@1 ${rAt("baseRank", 1)}  @3 ${rAt("baseRank", 3)}  @5 ${rAt("baseRank", 5)}  @${topK} ${rAt("baseRank", topK)}  MRR ${mrrOf("baseRank").toFixed(4)}`);
  console.log(`rerank r@1 ${rAt("rerankRank", 1)}  @3 ${rAt("rerankRank", 3)}  @5 ${rAt("rerankRank", 5)}  @${topK} ${rAt("rerankRank", topK)}  MRR ${mrrOf("rerankRank").toFixed(4)}`);
  const rep = pairedRankReport(records.map((r) => ({ rankA: r.baseRank, rankB: r.rerankRank, scored: r.scored })));
  console.log(`MRR ${rep.mrrBefore.toFixed(4)} → ${rep.mrrAfter.toFixed(4)} (Δ${rep.deltaMrr >= 0 ? "+" : ""}${rep.deltaMrr.toFixed(4)})  n=${rep.n}`);
  console.log(`  Wilcoxon(ΔRR) p=${rep.wilcoxon.p.toFixed(4)} [${rep.wilcoxon.method}]  |  符号检验 p=${rep.sign.p.toFixed(4)}  |  rank-biserial=${rep.effect.rankBiserial.toFixed(3)}`);
  console.log(`  ΔMRR 95%CI [${rep.ci.lower.toFixed(4)}, ${rep.ci.upper.toFixed(4)}]  |  MDE=${rep.mde.mde == null ? "n/a" : rep.mde.mde.toFixed(4)}`);
  const rs = rescueSummary(records);
  console.log(`池内救回(rerank 空间的直接兑现):人口 ${rs.poolOnly} 题(gold 在池内、基线 top-${topK} 之外)`);
  console.log(`  rescued ${rs.rescued}${rs.rescueRate == null ? "" : `(兑现率 ${(rs.rescueRate * 100).toFixed(1)}%)`} | unrescued ${rs.unrescued} | lost ${rs.lost}(基线在、rerank 后掉出)| held ${rs.held} | out-of-pool ${rs.outOfPool}`);
  const failN = Object.keys(state.failures || {}).length;
  const pendN = pendingQueries(fx.cases, state.completed).length;
  if (failN || pendN) console.log(`待重试(解析失败)${failN} 题 | 未跑 ${pendN} 题`);
}

// ── CLI 主流程(测试 import 本文件时经 main-guard 跳过)───────────────────────

async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const CACHE_DIR = join(ROOT, ".replay-cache");

  const args = process.argv.slice(2);
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--limit") { i += 1; continue; }
    if (args[i].startsWith("--")) continue;
    positional.push(args[i]);
  }
  const kbId = positional[0];
  const doRun = args.includes("--run");
  const limitAt = args.indexOf("--limit");
  const limit = limitAt !== -1 ? Math.max(1, Number(args[limitAt + 1]) || 0) : Infinity;
  if (!kbId) {
    console.error("用法: node scripts/kb-rerank-ab.js <kbId> [--run] [--limit N]");
    process.exit(1);
  }

  const fx = JSON.parse(await readFile(join(ROOT, "tests/fixtures", `${kbId}-rag-eval-set.json`), "utf8"));
  const TOP_K = fx.topK || 10;
  const PROD_WIDE = Math.max(TOP_K * 4, 20); // 与 wiki-rag-search.js 的 wide 一致(生产宽集)
  if (fx.cases.some((c) => c.asOf)) {
    console.error("✖ fixture 含 asOf,本测量台未处理点时过滤(会给出错误结论)。先扩展脚本。");
    process.exit(1);
  }

  const cachePath = join(CACHE_DIR, `${kbId}.json`);
  const cache = JSON.parse(await readFile(cachePath, "utf8").catch(() => "null"));
  if (!cache) {
    console.error(`✖ 无宽集缓存,先跑: node scripts/kb-replay.js capture ${kbId}`);
    process.exit(1);
  }
  if (Number(cache.wide) < PROD_WIDE) {
    console.error(`✖ 缓存宽度 ${cache.wide} < 生产宽集 ${PROD_WIDE},请重新 capture`);
    process.exit(1);
  }
  const index = await loadKnowledgeBaseIndex(kbId);
  if (!index?.chunks?.length) { console.error(`✖ kb '${kbId}' 索引为空`); process.exit(1); }
  if (index.chunks.length !== cache.chunkCount) {
    console.error(`✖ 索引已变(缓存 ${cache.chunkCount} 块,当前 ${index.chunks.length}),请重新 capture`);
    process.exit(1);
  }

  // enabled 开关与测量无关(测的就是「开了会怎样」),只取 model/baseUrl(一条配置真值)。
  const rcfg = await resolveWikiRagRerankConfig();
  const fingerprint = { kbId, chunkCount: index.chunks.length, wide: PROD_WIDE, topK: TOP_K, model: rcfg.model };

  const statePath = join(CACHE_DIR, `${kbId}-rerank-ab.json`);
  let state = JSON.parse(await readFile(statePath, "utf8").catch(() => "null"));
  if (state && !fingerprintMatches(state.fingerprint, fingerprint)) {
    console.error(`✖ 状态指纹不匹配(索引/宽集/topK/模型变了),旧进度属于另一个世界。确认后删除重来:\n  rm '${statePath}'`);
    process.exit(1);
  }
  if (!state) state = { kbId, fingerprint, completed: {}, failures: {} };
  if (!state.failures) state.failures = {};

  async function saveState() {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, statePath); // 先写临时再原子换名,断电也只丢当前题
  }

  // 基线臂(零 LLM):缓存向量腿截回生产宽集 + 生产词法腿 + rrfFuse。与 kb-replay verify 同路。
  async function fusedPoolFor(c) {
    const entry = cache.entries.find((e) => e.query === c.query);
    if (!entry) throw new Error(`缓存缺查询: ${c.query}(fixture 变了?重新 capture)`);
    const vector = entry.vector.slice(0, PROD_WIDE);
    const lexical = await searchWikiRagLexical(entry.rewritten, { topK: PROD_WIDE, index });
    const fused = rrfFuse([vector, lexical], { topK: PROD_WIDE });
    const poolRank = fused.findIndex((r) => r.sourcePath === c.expectedSourcePath);
    const baseRank = fused.slice(0, TOP_K).findIndex((r) => r.sourcePath === c.expectedSourcePath);
    return { entry, fused, poolRank, baseRank };
  }

  // 失败题挪队尾(稳定分区):它们每次重试 ~3.5min 且大概率再败,排前面会把每个批次的
  // 预算烧在已知啃不动的题上,新题永远轮不到 —— 实测因此活锁过。新题跑完再碰它们。
  const pendingRaw = pendingQueries(fx.cases, state.completed);
  const pending = [...pendingRaw.filter((c) => !state.failures?.[c.query]), ...pendingRaw.filter((c) => state.failures?.[c.query])];

  if (!doRun) {
    // dry-run:零 LLM。打印将调用次数、池内可救人口、prompt 尺寸上界,再给出已完成部分的报告。
    const pendingSet = new Set(pending.map((c) => c.query));
    let goldInPool = 0;
    let poolOnly = 0;
    let scoredN = 0;
    let llmCalls = 0;
    let maxPrompt = 0;
    for (const c of fx.cases) {
      const { fused, poolRank, baseRank } = await fusedPoolFor(c);
      const promptChars = fused.reduce(
        (s, r) => s + Math.min(String(r.text || "").length, 240) + String(r.heading || "").length + 8,
        140 + String(c.query).length,
      );
      if (promptChars > maxPrompt) maxPrompt = promptChars;
      if (pendingSet.has(c.query) && fused.length > 1) llmCalls += 1;
      if (c.verdictStatus === "undecided") continue;
      scoredN += 1;
      if (poolRank !== -1) goldInPool += 1;
      if (poolRank !== -1 && baseRank === -1) poolOnly += 1;
    }
    console.log(`# ${kbId} | rerank A/B dry-run(零 LLM)`);
    console.log(`fixture ${fx.cases.length} 例(计分 ${scoredN})| wide ${PROD_WIDE} → top-${TOP_K} | 模型 ${rcfg.model} @ ${rcfg.baseUrl}`);
    console.log(`gold 在池内 ${goldInPool}/${scoredN}(${((goldInPool / (scoredN || 1)) * 100).toFixed(1)}%)| 池内可救(基线 top-${TOP_K} 之外)${poolOnly} 题 ← rerank 空间人口`);
    console.log(`已完成 ${Object.keys(state.completed).length} | 待跑 ${pending.length} | 将调用 LLM ${llmCalls} 次(串行,一题一调)`);
    console.log(`最大 prompt ≈ ${maxPrompt} 字符(留意模型 num_ctx 是否吃得下 ${PROD_WIDE} 候选)`);
    if (Object.keys(state.failures).length) console.log(`待重试(上轮解析失败)${Object.keys(state.failures).length} 题`);
    printReport(fx, state, TOP_K);
    console.log(`真跑: node scripts/kb-rerank-ab.js ${kbId} --run`);
    process.exit(0);
  }

  // --run:串行真跑,逐题落盘。进度符号:R=rescued L=lost .=其余 x=解析失败待重试。
  const batch = pending.slice(0, limit === Infinity ? pending.length : limit);
  console.log(`# ${kbId} | rerank A/B --run | 待跑 ${pending.length} 题,本批 ${batch.length} 题 | 模型 ${rcfg.model} @ ${rcfg.baseUrl}`);
  let transportDown = false;
  for (const c of batch) {
    const { entry, fused, poolRank, baseRank } = await fusedPoolFor(c);
    const base = {
      expected: c.expectedSourcePath,
      scored: c.verdictStatus !== "undecided",
      goldInPool: poolRank !== -1,
      poolRank,
      baseRank,
    };
    if (fused.length <= 1) { // 单候选池无从重排,零 LLM 直接记录
      state.completed[c.query] = { ...base, rerankRank: baseRank, outcome: classifyRerankOutcome({ ...base, rerankRank: baseRank }), llmOk: null, ranking: null, at: new Date().toISOString() };
      delete state.failures[c.query];
      await saveState();
      process.stderr.write(".");
      continue;
    }
    const probe = { ok: false, ranking: null, error: null };
    const recordingChatJson = async (prompt, opts) => {
      // rerankResults 对 LLM 失败会静默退回原序 —— 测量里那会伪装成「重排无变化」,
      // 所以用探针记录真实成败,失败题保留待重试而非计入结果。
      const parsed = await ollamaChatJson(prompt, opts).catch((err) => {
        probe.error = String(err?.message || err);
        throw err;
      });
      probe.ranking = parsed && Array.isArray(parsed.ranking) ? parsed.ranking : null;
      probe.ok = Boolean(probe.ranking && probe.ranking.length);
      return parsed;
    };
    // numCtx 16384:max prompt ≈万字中文 ≈ 6-7k token + 输出,4096 默认会静默截尾偏压高序号候选
    const reranked = await rerankResults(entry.rewritten, fused, {
      numCtx: 16384,
      numPredict: 3072, // 毒题保险:超限=坏输出=解析失败(~2min)按题跳过;8192 试过=生成期超时又变停批,勿再调大
      model: rcfg.model,
      baseUrl: rcfg.baseUrl,
      topN: fused.length, // 内部 4 处 slice(0,topN) 全部放行(关键点①)
      maxCandidates: fused.length, // MAX_RERANK_CANDIDATES 上限放行,40 候选全数进入重排
      chatJson: recordingChatJson,
    });
    if (!probe.ok) {
      state.failures[c.query] = { error: probe.error || "ranking 缺失/为空", at: new Date().toISOString() };
      await saveState();
      if (probe.error) { // 传输层失败(ollama 不可达/超时)→ 停批保进度;纯解析失败 → 下一题
        console.error(`\n✖ LLM 不可达,停批保进度(已完成 ${Object.keys(state.completed).length} 题):${probe.error}`);
        transportDown = true;
        break;
      }
      process.stderr.write("x");
      continue;
    }
    const rerankRank = reranked.slice(0, TOP_K).findIndex((r) => r.sourcePath === c.expectedSourcePath);
    const record = { ...base, rerankRank, outcome: classifyRerankOutcome({ ...base, rerankRank }), llmOk: true, ranking: probe.ranking, at: new Date().toISOString() };
    state.completed[c.query] = record;
    delete state.failures[c.query];
    await saveState();
    process.stderr.write(record.outcome === "rescued" ? "R" : record.outcome === "lost" ? "L" : ".");
  }
  process.stderr.write("\n");

  printReport(fx, state, TOP_K);

  const allDone = fx.cases.every((c) => Object.hasOwn(state.completed, c.query));
  if (allDone) { // 全量完成才落逐例名次对(下游统计吃这份,形状同 kb-replay 的 <kbId>-pairs.json)
    const pairs = fx.cases.map((c) => {
      const r = state.completed[c.query];
      return { rankA: r.baseRank, rankB: r.rerankRank, scored: r.scored };
    });
    const pairsPath = join(CACHE_DIR, `${kbId}-rerank-pairs.json`);
    await writeFile(pairsPath, JSON.stringify(pairs), "utf8");
    console.log(`逐例名次对 → ${pairsPath}`);
  }
  process.exit(transportDown ? 2 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
