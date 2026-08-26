// lib/knowledge/knowledge-eval-runner.js — 跑 per-KB 召回评测 + 持久运行记录。
//
// 一条路径:复用已泛化的 evaluateWikiRagRecall(cases, searchFn) + searchKb(kbId) 作 searchFn。
// 不重造评测引擎。运行摘要(recall@k/MRR/byCategory + 瘦身版 perCase)持久到
// control-plane/knowledge-eval-runs.json(capped)。perCase 只留 {query,rank,hit} —— 聚合数字
// 无法配对比较两次 run,per-case rank 才是配对检验和"降级清单"的唯一输入;topPaths 等大字段仍只
// 存在于本次 run 的返回值里,给调用方/UI 即时用。

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizeString } from "../core/normalize.js";
import { atomicWriteFile, withLock } from "../state.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { evaluateWikiRagRecall, evaluateFaithfulness, evaluateContextPrecision, diffRecallRanks } from "./wiki-rag-eval.js";
import { buildLocalRagJudge } from "./wiki-rag-judge.js";
import { searchKb } from "./knowledge-base.js";
import { getKnowledgeEvalSet } from "./knowledge-eval-registry.js";

const RUNS_STORE = CONTROL_PLANE_PATHS.knowledgeEvalRunsFile;
const RUNS_LOCK = "store:knowledge-eval-runs";
const MAX_RUNS = 100; // 全局保留最近 N 次(摘要),足够趋势对比又不让文件膨胀。
// perCase 落盘上限。24 例的评测集瘦身后约 3KB/run,100 run 上限 ≈ 300KB(落盘前实测 50KB),
// 可接受;但评测集是用户可自定义的,没有上限时一个几千例的集会把这个"每次全量重写"的文件撑爆。
// 截断可自检:run.perCase.length < run.total 即被截断(total 仍是全量案例数),不另加字段。
const PER_CASE_MAX = 500;

function newRunId() {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

async function readRuns() {
  try {
    const parsed = JSON.parse(await readFile(RUNS_STORE, "utf8"));
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

async function appendRun(summary) {
  return withLock(RUNS_LOCK, async () => {
    const runs = await readRuns();
    const next = [summary, ...runs].slice(0, MAX_RUNS); // newest-first, capped
    await mkdir(dirname(RUNS_STORE), { recursive: true });
    await atomicWriteFile(RUNS_STORE, JSON.stringify({ updatedAt: Date.now(), runs: next }, null, 2));
    return summary;
  });
}

// 跑一个评测集。未知评测集 → {ok:false,error}(调用方/handler 决定如何兜底)。
// 返回 {ok, run:{...摘要}, perCase, misses}。degraded=检索期 ollama 不可用(向量退化成词法),
// 结果仍有效但偏低,需在报告里区分"质量低"与"嵌入不可用"。
export async function runKnowledgeEval(kbId, evalSetId, { logger } = {}) {
  const k = normalizeString(kbId);
  const e = normalizeString(evalSetId);
  const set = await getKnowledgeEvalSet(k, e);
  if (!set) return { ok: false, error: `unknown eval set: ${k}::${e}` };
  if (set.cases.length === 0) return { ok: false, error: `eval set has no cases: ${k}::${e}` };

  const startedAt = new Date().toISOString();
  let degraded = false;
  const searchFn = async (query, { topK, asOf = null } = {}) => {
    const r = await searchKb(k, query, { topK, asOf }); // v153:透传 case 的 asOf=点时评测
    if (!r || r.degraded || r.ok === false) degraded = true;
    return r;
  };

  let result;
  try {
    result = await evaluateWikiRagRecall(set.cases, searchFn, { topK: set.topK });
  } catch (err) {
    logger?.warn?.(`[watchdog] kb eval failed (${k}::${e}): ${err.message}`);
    return { ok: false, error: err.message };
  }

  const misses = result.perCase.filter((p) => !p.hit).map((p) => ({ query: p.query, expected: p.expected, topPaths: p.topPaths }));

  // 与同 (kbId,evalSetId) 的上一次 recall run 配对。必须在 appendRun 之前取,否则取到自己。
  // 旧记录没有 perCase(落盘前的 100 条全是聚合数字)→ 基线为空 → demotions=[],不报错。
  const previous = (await listKnowledgeEvalRuns({ kbId: k, evalSetId: e, limit: MAX_RUNS }))
    .find((r) => r.kind === "recall" && Array.isArray(r.perCase)) || null;
  const diff = diffRecallRanks(previous?.perCase || [], result.perCase);

  // perCase 落盘,只留 {query,rank,hit}(丢掉 topPaths 这个大字段)。此前摘要不含 perCase,
  // 实测 control-plane/knowledge-eval-runs.json 的 100 条记录里 per-case rank 全部丢失,
  // 两次 run 只剩聚合百分比可比 → 配对检验(McNemar)物理上算不出来。
  const perCase = result.perCase.slice(0, PER_CASE_MAX).map((p) => ({ query: p.query, rank: p.rank, hit: p.hit }));
  const summary = {
    runId: newRunId(),
    kind: "recall",                                                               // v156:区分 recall vs faithfulness run
    kbId: k,
    evalSetId: e,
    label: set.label,
    total: result.total,
    evaluated: result.evaluated,                                                  // v153:计入 recall 的(排除 undecided)
    abstained: result.abstained,                                                  // v153:undecided 弃权数
    recallAt: result.recallAt,
    mrr: Number(result.mrr.toFixed(4)),
    byCategory: result.byCategory,
    ghostHitRate: result.ghostHitRate == null ? null : Number(result.ghostHitRate.toFixed(4)), // v153:幽灵命中率(越低越好)
    ghostEvaluated: result.ghostEvaluated,
    keywordCoverage: result.keywordCoverage == null ? null : Number(result.keywordCoverage.toFixed(4)), // expectedKeywords 接上后的正交指标
    keywordEvaluated: result.keywordEvaluated,
    missCount: misses.length,
    perCase,
    degraded,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  await appendRun(summary);
  // demotions/promotions 不落盘:perCase 已落,它们随时可由 diffRecallRanks 重算,存了就是第二真值。
  return { ok: true, run: summary, perCase: result.perCase, misses, baselineRunId: previous?.runId || null, demotions: diff.demotions, promotions: diff.promotions };
}

// v156:跑生成侧评测(faithfulness + context-precision)。复用 evaluateFaithfulness/evaluateContextPrecision
// (judgeFn 注入)。judge 默认本地 qwen(buildLocalRagJudge),测试可注入 fake judge=确定式。
// faithfulness 需 case 带 answer;context-precision 对所有 case 跑(逐 chunk 判相关,LLM 调用多=慢,offline 评测)。
// 持久 kind:"faithfulness" 摘要,与 recall run 同 store(listKnowledgeEvalRuns 一并返回,按 kind 区分)。
export async function runKnowledgeFaithfulness(kbId, evalSetId, { logger, judge = null, votes = 3 } = {}) {
  const k = normalizeString(kbId);
  const e = normalizeString(evalSetId);
  const set = await getKnowledgeEvalSet(k, e);
  if (!set) return { ok: false, error: `unknown eval set: ${k}::${e}` };
  if (set.cases.filter((c) => c.answer).length === 0) {
    return { ok: false, error: `eval set has no cases with 'answer' (faithfulness needs gold answers): ${k}::${e}` };
  }

  const startedAt = new Date().toISOString();
  let degraded = false;
  const searchFn = async (query, { topK, asOf = null } = {}) => {
    const r = await searchKb(k, query, { topK, asOf });
    if (!r || r.degraded || r.ok === false) degraded = true;
    return r;
  };
  const j = judge || buildLocalRagJudge();

  let faith;
  let prec;
  try {
    faith = await evaluateFaithfulness(set.cases, searchFn, j.faithfulness, { topK: set.topK, votes });
    prec = await evaluateContextPrecision(set.cases, searchFn, j.relevance, { topK: set.topK });
  } catch (err) {
    logger?.warn?.(`[watchdog] kb faithfulness failed (${k}::${e}): ${err.message}`);
    return { ok: false, error: err.message };
  }

  const summary = {
    runId: newRunId(),
    kind: "faithfulness",
    kbId: k,
    evalSetId: e,
    label: set.label,
    answered: faith.total,                                                        // 有 answer 的 case 数
    faithfulness: faith.faithfulness == null ? null : Number(faith.faithfulness.toFixed(4)),
    contextPrecision: prec.contextPrecision == null ? null : Number(prec.contextPrecision.toFixed(4)),
    precisionCases: prec.total,
    degraded,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  await appendRun(summary);
  return { ok: true, run: summary, faithfulnessPerCase: faith.perCase, precisionPerCase: prec.perCase };
}

// 查询历史运行摘要(可按 kbId / evalSetId 过滤,newest-first,limit 截断)。
export async function listKnowledgeEvalRuns({ kbId = null, evalSetId = null, limit = 20 } = {}) {
  const runs = await readRuns();
  const k = normalizeString(kbId);
  const e = normalizeString(evalSetId);
  const filtered = runs
    .filter((r) => (k ? r.kbId === k : true))
    .filter((r) => (e ? r.evalSetId === e : true));
  const n = Number(limit) > 0 ? Number(limit) : 20;
  return filtered.slice(0, n);
}
