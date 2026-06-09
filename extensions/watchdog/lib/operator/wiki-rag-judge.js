// lib/operator/wiki-rag-judge.js — 本地 LLM-as-judge(ollama chat,0 外部依赖)。
//
// 给 RAG 生成侧评测(wiki-rag-eval.js 的 evaluateFaithfulness / evaluateContextPrecision)提供
// 注入式 judge。judge 是纯函数边界:eval 引擎不关心 judge 怎么实现(测试注入 fake judge=确定式进
// gate;live 用本地 qwen)。默认 qwen3:8b(本地已有);format:json 强制结构化 + 防御式解析(<think>/
// 截断/噪声都兜住,遵守 CLAUDE.md 的 defensive_json_handling)。override 经 openclaw.json
// watchdog.wikiRag.{judgeModel,judgeBaseUrl}。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "../state.js";

const DEFAULT_JUDGE_MODEL = "qwen3:8b";
const DEFAULT_JUDGE_BASE_URL = "http://localhost:11434";
const JUDGE_TIMEOUT_MS = 120000;

// 复用 wiki-rag-embed.js 的 dispatcher 技巧:冷加载 qwen3:8b(5GB)可能超 undici 默认 300s,
// 从全局 dispatcher 构造一个长超时 Agent(0 依赖),wall-clock 仍由 AbortController 管。
let cachedJudgeDispatcher;
function resolveJudgeDispatcher() {
  if (cachedJudgeDispatcher !== undefined) return cachedJudgeDispatcher;
  cachedJudgeDispatcher = null;
  try {
    const sym = Object.getOwnPropertySymbols(globalThis).find((s) => s.description === "undici.globalDispatcher.1");
    const AgentCtor = sym ? globalThis[sym]?.constructor : null;
    if (typeof AgentCtor === "function") {
      cachedJudgeDispatcher = new AgentCtor({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 600000 });
    }
  } catch { cachedJudgeDispatcher = null; }
  return cachedJudgeDispatcher;
}

export async function resolveWikiRagJudgeConfig() {
  try {
    const cfg = JSON.parse(await readFile(join(OC, "openclaw.json"), "utf8"));
    const wikiRag = (cfg && cfg.watchdog && typeof cfg.watchdog === "object") ? cfg.watchdog.wikiRag : null;
    return {
      model: (wikiRag && typeof wikiRag.judgeModel === "string" && wikiRag.judgeModel.trim()) ? wikiRag.judgeModel.trim() : DEFAULT_JUDGE_MODEL,
      baseUrl: (wikiRag && typeof wikiRag.judgeBaseUrl === "string" && wikiRag.judgeBaseUrl.trim()) ? wikiRag.judgeBaseUrl.trim() : DEFAULT_JUDGE_BASE_URL,
    };
  } catch {
    return { model: DEFAULT_JUDGE_MODEL, baseUrl: DEFAULT_JUDGE_BASE_URL };
  }
}

// 防御式 JSON 解析:剥 <think>(qwen3 推理)/ 代码围栏,JSON.parse 失败则定位首尾花括号,
// 再失败则按截断补 } 兜底。解析不出返回 null(eval 引擎当该票弃)。
export function parseJudgeJson(raw) {
  let s = String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  if (a >= 0) { try { return JSON.parse(`${s.slice(a)}}`); } catch { /* 截断兜底失败 */ } }
  return null;
}

async function ollamaChatJson(prompt, { model, baseUrl, temperature = 0.4, signal } = {}) {
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS) : null;
  const dispatcher = resolveJudgeDispatcher();
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        messages: [{ role: "user", content: prompt }],
        options: { temperature },
      }),
      signal: signal || controller?.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      const error = new Error(`wiki-rag judge http ${response.status}`);
      error.code = "WIKI_RAG_JUDGE_UNAVAILABLE";
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    return parseJudgeJson(payload?.message?.content || "");
  } catch (err) {
    if (err?.code === "WIKI_RAG_JUDGE_UNAVAILABLE") throw err;
    const error = new Error(`wiki-rag judge unavailable: ${err?.message || err}`);
    error.code = "WIKI_RAG_JUDGE_UNAVAILABLE";
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// 构造注入到 evaluateFaithfulness / evaluateContextPrecision 的本地 judge。
// temperature 默认带轻微随机(0.4)→ 多票表决(votes>1)才有意义(降方差,见 122)。
export function buildLocalRagJudge({ model = DEFAULT_JUDGE_MODEL, baseUrl = DEFAULT_JUDGE_BASE_URL, temperature = 0.4 } = {}) {
  return {
    // faithfulness:答案的每个事实论断是否被检索到的上下文支撑(无编造)。
    faithfulness: async ({ query, context, answer }) => {
      const ctx = (Array.isArray(context) ? context : []).map((t, i) => `[${i + 1}] ${t}`).join("\n");
      const prompt = `你是严格的 RAG 评判。判断「答案」是否完全被「检索到的上下文」支撑——答案里每个事实论断都能在上下文中找到依据,没有编造/外部知识。\n\n问题: ${query}\n\n上下文:\n${ctx}\n\n答案: ${answer}\n\n只输出 JSON,不要别的: {"supported": true 或 false, "reason": "一句话理由"}`;
      const v = await ollamaChatJson(prompt, { model, baseUrl, temperature });
      return { supported: v?.supported === true, reason: v?.reason || null };
    },
    // relevance:单个 chunk 是否与 query 相关(context-precision 用)。
    relevance: async ({ query, chunk }) => {
      const prompt = `判断下面这段「片段」是否与「问题」相关(能帮助回答)。\n\n问题: ${query}\n\n片段: ${chunk}\n\n只输出 JSON: {"relevant": true 或 false}`;
      const v = await ollamaChatJson(prompt, { model, baseUrl, temperature });
      return { relevant: v?.relevant === true };
    },
  };
}
