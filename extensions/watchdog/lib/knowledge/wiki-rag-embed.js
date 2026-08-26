// lib/knowledge/wiki-rag-embed.js — ollama HTTP embed client (0 external deps).
//
// Calls a LOCAL ollama embeddings endpoint. The chat ollama provider (config
// models.providers.ollama, a nothink proxy on :11435) is deliberately NOT
// reused — embeddings need the raw model on :11434 + a separate embed-model
// key. Default model 'nomic-embed-text'; override via openclaw.json
// watchdog.wikiRag.{embedModel,embedBaseUrl}.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "../state.js";

// 122 P0-1:embed 升级 nomic→qwen3-embedding:0.6b。24 例 fixture A/B 实测(同 chunk 集、查询与索引同模型):
// recall@1 41.7%→79.2%(+37.5pp)、@5 79.2%→100%、MRR 0.612→0.862。需 `ollama pull qwen3-embedding:0.6b`
// (~600MB);未拉则 embedText 抛 → hybrid 优雅退化成词法-only(不 break,仅 recall 降)。换模触发
// existing.model!==model 全量重嵌(基础设施现成)。per-install 可经 openclaw.json watchdog.wikiRag.embedModel 覆盖。
const DEFAULT_EMBED_MODEL = "qwen3-embedding:0.6b";
const DEFAULT_EMBED_BASE_URL = "http://localhost:11434";
const EMBED_TIMEOUT_MS = 60000;

// Reuse llm-planner.js:11-24 dispatcher pattern: derive a long-timeout undici
// Agent from the global dispatcher's own constructor — 0 deps (no undici
// import). Local embeds are fast, but a cold model load can exceed undici's
// default 300s headersTimeout; wall-clock stays governed by the AbortController.
let cachedEmbedDispatcher;
function resolveEmbedDispatcher() {
  if (cachedEmbedDispatcher !== undefined) return cachedEmbedDispatcher;
  cachedEmbedDispatcher = null;
  try {
    const sym = Object.getOwnPropertySymbols(globalThis).find((s) => s.description === "undici.globalDispatcher.1");
    const AgentCtor = sym ? globalThis[sym]?.constructor : null;
    if (typeof AgentCtor === "function") {
      cachedEmbedDispatcher = new AgentCtor({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 600000 });
    }
  } catch {
    cachedEmbedDispatcher = null;
  }
  return cachedEmbedDispatcher;
}

// Resolve the separate embed-model config (best-effort raw read; this stays
// independent of loadConfig which validates/mutates agents.list on the hot path).
export async function resolveWikiRagEmbedConfig() {
  try {
    const raw = await readFile(join(OC, "openclaw.json"), "utf8");
    const cfg = JSON.parse(raw);
    const wikiRag = (cfg && typeof cfg === "object" && cfg.watchdog && typeof cfg.watchdog === "object")
      ? cfg.watchdog.wikiRag
      : null;
    return {
      model: (wikiRag && typeof wikiRag.embedModel === "string" && wikiRag.embedModel.trim())
        ? wikiRag.embedModel.trim()
        : DEFAULT_EMBED_MODEL,
      baseUrl: (wikiRag && typeof wikiRag.embedBaseUrl === "string" && wikiRag.embedBaseUrl.trim())
        ? wikiRag.embedBaseUrl.trim()
        : DEFAULT_EMBED_BASE_URL,
    };
  } catch {
    return { model: DEFAULT_EMBED_MODEL, baseUrl: DEFAULT_EMBED_BASE_URL };
  }
}

export async function embedText(text, { model = DEFAULT_EMBED_MODEL, baseUrl = DEFAULT_EMBED_BASE_URL, signal } = {}) {
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS) : null;
  const dispatcher = resolveEmbedDispatcher();
  try {
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: String(text || "") }),
      signal: signal || controller?.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      const error = new Error(`wiki-rag embed http ${response.status}`);
      error.code = "WIKI_RAG_EMBED_UNAVAILABLE";
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!Array.isArray(payload?.embedding)) {
      const error = new Error("wiki-rag embed returned no embedding vector");
      error.code = "WIKI_RAG_EMBED_UNAVAILABLE";
      throw error;
    }
    return payload.embedding;
  } catch (err) {
    if (err?.code === "WIKI_RAG_EMBED_UNAVAILABLE") throw err;
    // ECONNREFUSED / fetch failed / abort → normalize to the coded unavailable error.
    const error = new Error(`wiki-rag embed unavailable: ${err?.message || err}`);
    error.code = "WIKI_RAG_EMBED_UNAVAILABLE";
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
