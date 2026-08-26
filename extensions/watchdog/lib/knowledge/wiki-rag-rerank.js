// lib/knowledge/wiki-rag-rerank.js — LLM-as-reranker(122 P0-2 第二级,默认关)。
//
// ollama 0.21 无 /api/rerank 端点、无可 serve 的专用 cross-encoder reranker → 改用 LLM listwise rerank:
// 给宽召回集 + query 一次 LLM 调用(非逐条 N 次),让模型按相关度排序,取前 topK。复用 wiki-rag-judge 的
// ollama chat 原语(一条路径)。默认关;LLM 不可用/解析失败 → 优雅退化保持 RRF 原序(同现有 degraded 语义)。
// override 经 openclaw.json watchdog.wikiRag.{rerank,rerankModel,rerankBaseUrl}。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "../state.js";
import { ollamaChatJson } from "./wiki-rag-judge.js";

const DEFAULT_RERANK_MODEL = "qwen3:8b";
const DEFAULT_RERANK_BASE_URL = "http://localhost:11434";
const MAX_RERANK_CANDIDATES = 24; // 喂给 LLM 的上限(prompt 可控 + 一次调用)

export async function resolveWikiRagRerankConfig() {
  try {
    const cfg = JSON.parse(await readFile(join(OC, "openclaw.json"), "utf8"));
    const wikiRag = (cfg && cfg.watchdog && typeof cfg.watchdog === "object") ? cfg.watchdog.wikiRag : null;
    return {
      enabled: wikiRag?.rerank === true,
      model: (wikiRag && typeof wikiRag.rerankModel === "string" && wikiRag.rerankModel.trim()) ? wikiRag.rerankModel.trim() : DEFAULT_RERANK_MODEL,
      baseUrl: (wikiRag && typeof wikiRag.rerankBaseUrl === "string" && wikiRag.rerankBaseUrl.trim()) ? wikiRag.rerankBaseUrl.trim() : DEFAULT_RERANK_BASE_URL,
    };
  } catch {
    return { enabled: false, model: DEFAULT_RERANK_MODEL, baseUrl: DEFAULT_RERANK_BASE_URL };
  }
}

// 把 LLM 返回的 ranking(1-based 候选序号,相关度降序)应用到结果:按序取,LLM 漏掉的按原序补在后面
// (绝不丢结果),去重,取 topN。纯函数,可单测。
export function applyRanking(results, ranking, topN = 5) {
  const list = Array.isArray(results) ? results : [];
  const out = [];
  const seen = new Set();
  for (const idx of (Array.isArray(ranking) ? ranking : [])) {
    const i = Number(idx) - 1;
    if (Number.isInteger(i) && i >= 0 && i < list.length && !seen.has(i)) {
      seen.add(i);
      out.push(list[i]);
    }
  }
  for (let i = 0; i < list.length; i += 1) if (!seen.has(i)) out.push(list[i]); // LLM 漏的补回(不丢)
  return out.slice(0, Math.max(1, Number(topN) || 5));
}

// listwise LLM rerank:一次调用,返回重排后的结果(取 topN)。失败/解析不出 → 原序前 topN(优雅退化)。
// chatJson 可注入(测试用 fake);默认 wiki-rag-judge 的 ollamaChatJson。
// maxCandidates 可注入(scripts/kb-rerank-ab.js 离线测量用它把 wide 融合池全量喂进重排);
// 默认沿用 MAX_RERANK_CANDIDATES,生产调用点(wiki-rag-search.js)零改动 → 默认路径行为与既往
// 逐字节一致,由 tests/kb-rerank-ab-units.test.js 的冻结锚点钉住。
export async function rerankResults(query, results, { model = DEFAULT_RERANK_MODEL, baseUrl = DEFAULT_RERANK_BASE_URL, topN = 5, numCtx = null, numPredict = null, chatJson = ollamaChatJson, maxCandidates = MAX_RERANK_CANDIDATES } = {}) {
  const list = (Array.isArray(results) ? results : []).slice(0, Math.max(1, Number(maxCandidates) || MAX_RERANK_CANDIDATES));
  if (list.length <= 1) return list.slice(0, topN);
  const cands = list.map((r, i) => `[${i + 1}] ${String(r.heading ? `${r.heading}: ` : "")}${String(r.text || "").slice(0, 240)}`).join("\n");
  const prompt = `给定「问题」,把下面「候选片段」按与问题的相关度从高到低排序(最能回答问题的在前)。\n只输出 JSON,不要别的: {"ranking": [序号, ...]}(序号是候选前的 [n],降序,可只列相关的)。\n\n问题: ${String(query || "")}\n\n候选:\n${cands}`;
  let parsed = null;
  try {
    parsed = await chatJson(prompt, { model, baseUrl, temperature: 0, numCtx, numPredict });
  } catch {
    return list.slice(0, topN); // LLM 不可用 → 保持 RRF 原序
  }
  const ranking = parsed && Array.isArray(parsed.ranking) ? parsed.ranking : null;
  if (!ranking || ranking.length === 0) return list.slice(0, topN); // 解析失败 → 原序
  return applyRanking(list, ranking, topN);
}
