// lib/operator/knowledge-base.js — 多知识库注册表 + ingestion(Phase 2)
//
// KB = 命名的语料 + 自己的索引。内置种子库 'wiki'(复用 wiki-rag 索引,零迁移);用户库经
// knowledge-base-registry.js 持久(control-plane/knowledge-bases.json),源是任意可读文件/文件夹。
// 切分/检索全复用 wiki-rag 核心(一条路径):buildChunkPlanForSources + embedChunkPlanToIndex(建库)、
// hybridSearchOverIndex(检索 = 向量+词法 RRF + 查询改写)。不为每库重造管线。

import {
  loadWikiRagIndex,
  buildWikiRagIndex,
  loadRagIndexFile,
  embedChunkPlanToIndex,
  buildChunkPlanForSources,
} from "./wiki-rag-store.js";
import { hybridSearchOverIndex } from "./wiki-rag-search.js";
import { knowledgeBaseIndexFile } from "../control-plane/control-plane-paths.js";
import { listPersistedKnowledgeBases } from "./knowledge-base-registry.js";

const SEED_KNOWLEDGE_BASES = Object.freeze([
  Object.freeze({
    id: "wiki",
    label: "系统 Wiki",
    kind: "builtin",
    scope: "global",
    sources: Object.freeze(["wiki"]), // wiki/ 目录(已排除 meta 页 index/log/schema/status)
  }),
]);

// 内置种子 ∪ 持久用户库。种子在前;normalizeKnowledgeBaseSpec 已拒绝 id="wiki" 的用户库 → 不会撞。
export async function listKnowledgeBaseSpecs() {
  const seed = SEED_KNOWLEDGE_BASES.map((kb) => ({ ...kb, sources: [...kb.sources] }));
  const persisted = await listPersistedKnowledgeBases().catch(() => []);
  return [...seed, ...persisted.filter((kb) => kb.id !== "wiki")];
}

export async function getKnowledgeBaseSpec(kbId) {
  const id = String(kbId || "");
  if (!id) return null;
  return (await listKnowledgeBaseSpecs()).find((kb) => kb.id === id) || null;
}

// 加载某 KB 的索引。'wiki' 复用现有 wiki-rag 索引;其它库各有 kb-<id>-index.json(缺失 → 空索引)。
export async function loadKnowledgeBaseIndex(kbId) {
  if (kbId === "wiki") return loadWikiRagIndex();
  return loadRagIndexFile(knowledgeBaseIndexFile(kbId));
}

// (重新)构建某 KB 的索引。wiki 走专用路径(meta 页排除);其它库 readSourceFiles → 通用 chunk →
// embed → kb-<id>-index.json。返回 embedChunkPlanToIndex 的结果(ok:true 永真,降级保护);未知库 → ok:false。
export async function buildKbIndex(kbId, { force = false, logger } = {}) {
  const spec = await getKnowledgeBaseSpec(kbId);
  if (!spec) return { ok: false, error: `unknown knowledge base: ${kbId}` };
  if (spec.id === "wiki") return buildWikiRagIndex({ force, logger });
  // Phase5:把 KB 声明的 metadataRules 透传给切分(提取 source/time/fields),temporal/conflict 写进 index 顶层。
  const plan = await buildChunkPlanForSources(spec.sources, { logger, metadataRules: spec.metadataRules });
  return embedChunkPlanToIndex({ plan, indexPath: knowledgeBaseIndexFile(spec.id), force, logger, temporal: spec.temporal === true, conflict: spec.conflict });
}

// 对某 KB 做 hybrid 检索(一条路径,复用 wiki 的检索核心)。
// Phase5 v151:asOf 点时过滤(防未来泄漏)透传;时态库返回会带 conflictHints(分歧派生)。
export async function searchKb(kbId, queryText, { topK = 5, asOf = null } = {}) {
  const spec = await getKnowledgeBaseSpec(kbId);
  if (!spec) return { ok: false, degraded: true, results: [], error: `unknown knowledge base: ${kbId}` };
  const index = await loadKnowledgeBaseIndex(kbId);
  if (!index) return { ok: false, degraded: true, results: [] };
  return hybridSearchOverIndex(queryText, index, { topK, asOf });
}

// v154 per-agent consumer:选出某 agent 该检索的库。纯数据过滤(scope/agentId,零 if(agentId==='xxx')):
// 绑定到该 agent 的库(scope:'agent' && agentId 匹配)+ (可选)scope:'global' 库。includeGlobal 默认
// false=没显式绑库的 agent 不平白吃 global wiki(保守默认,不给所有 agent 塞平台 WHY)。纯函数,可单测。
export function selectAgentKnowledgeBases(specs, agentId, { includeGlobal = false } = {}) {
  const id = String(agentId || "");
  return (Array.isArray(specs) ? specs : []).filter((s) =>
    (id && s.scope === "agent" && s.agentId === id) || (includeGlobal && s.scope === "global"));
}

// v154:名次交错合并多库结果(round-robin):库A#1→库B#1→库A#2…取前 topK。诚实取舍——各库可能
// 不同 embed 模型/量纲,score 跨库不可比,故**不做二次 score 排序**(那是伪精度),只公平交错 +
// 来源标注 {kbId,kbLabel,scope}。按 (kbId,sourcePath,heading) 去重。纯函数,可单测。
export function mergeAgentKbResults(perKb, { topK = 5 } = {}) {
  const lists = (Array.isArray(perKb) ? perKb : []).map((p) => ({
    kbId: p.kbId, kbLabel: p.kbLabel, scope: p.scope,
    results: Array.isArray(p.results) ? p.results : [],
  }));
  const maxLen = Math.max(0, ...lists.map((l) => l.results.length));
  const cap = Math.max(1, Number(topK) || 5);
  const merged = [];
  const seen = new Set();
  for (let i = 0; i < maxLen && merged.length < cap; i += 1) {
    for (const l of lists) {
      if (merged.length >= cap) break;
      const r = l.results[i];
      if (!r) continue;
      const key = `${l.kbId}::${r.sourcePath}::${r.heading || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...r, kbId: l.kbId, kbLabel: l.kbLabel, scope: l.scope });
    }
  }
  return merged;
}

// v154:跨「该 agent 绑定库 ∪(可选)global」做 hybrid 检索。复用 searchKb(一条路径,不另造检索);
// 各库独立检索 → 名次交错合并(score 跨库不可比,不强排);conflictHints 按库标注不跨库重算(各库
// source 体系不同,强合会造假分歧)。空绑定 → 空结果(默认关,行为零变化)。bases.length===0=没库,
// 与 degraded(有库但 embed 挂)区分。此函数是 per-agent 检索核心,agent 自动注入(v155)/operator
// 验证面(inspect.knowledge_agent_search)都调它。
export async function searchAgentKnowledge(agentId, queryText, { topK = 5, asOf = null, includeGlobal = false } = {}) {
  const specs = await listKnowledgeBaseSpecs();
  const bound = selectAgentKnowledgeBases(specs, agentId, { includeGlobal });
  if (bound.length === 0) return { ok: true, degraded: false, results: [], byKb: [], bases: [], conflictHints: [] };
  const perKb = await Promise.all(bound.map(async (s) => {
    const r = await searchKb(s.id, queryText, { topK, asOf }).catch(() => ({ ok: false, degraded: true, results: [] }));
    return {
      kbId: s.id, kbLabel: s.label, scope: s.scope,
      ok: r.ok !== false, degraded: !!r.degraded,
      results: Array.isArray(r.results) ? r.results : [],
      conflictHints: Array.isArray(r.conflictHints) ? r.conflictHints : [],
    };
  }));
  return {
    ok: true,
    degraded: perKb.some((p) => p.degraded || !p.ok),
    results: mergeAgentKbResults(perKb, { topK }),
    byKb: perKb.map((p) => ({ kbId: p.kbId, kbLabel: p.kbLabel, scope: p.scope, results: p.results })),
    bases: bound.map((s) => ({ id: s.id, label: s.label, scope: s.scope })),
    conflictHints: perKb.flatMap((p) => p.conflictHints.map((h) => ({ ...h, kbId: p.kbId }))),
  };
}

// KB 概览(供 inspect.knowledge_bases / 管理 UI):库 + chunk 数 + 源 + 模型。
export async function summarizeKnowledgeBases() {
  const specs = await listKnowledgeBaseSpecs();
  const knowledgeBases = [];
  for (const spec of specs) {
    const index = await loadKnowledgeBaseIndex(spec.id).catch(() => null);
    knowledgeBases.push({
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      scope: spec.scope,
      agentId: spec.agentId || null,
      sources: spec.sources,
      temporal: spec.temporal === true,                 // Phase5:时态库标记(UI/operator 可见)
      metadataRules: spec.metadataRules || null,         // Phase5:提取规则(管理页编辑用)
      conflict: spec.conflict || null,                   // Phase5 v151:分歧派生配置
      chunkCount: Array.isArray(index?.chunks) ? index.chunks.length : 0,
      model: index?.model || null,
      builtAt: index?.builtAt || null,
    });
  }
  return {
    counts: {
      total: specs.length,
      global: specs.filter((s) => s.scope === "global").length,
      user: specs.filter((s) => s.kind === "user").length,
    },
    knowledgeBases,
  };
}
