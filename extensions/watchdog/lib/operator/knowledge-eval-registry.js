// lib/operator/knowledge-eval-registry.js — per-KB 召回评测集持久层(镜像 knowledge-base-registry)。
//
// 评测集 = 一组 {query → expectedSourcePath} 标注,绑定到某个 KB,用于跑 recall@k/MRR。
// 一个 KB 可有多个评测集(evalSetId 区分)。复合主键 = (kbId, evalSetId)。
// case 形状与 wiki-rag-eval 一致:{query, expectedSourcePath, category?, expectedKeywords?},
// evaluateWikiRagRecall 直接吃。存 control-plane/knowledge-eval-sets.json。

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizeRecord, normalizeString, normalizePositiveInteger } from "../core/normalize.js";
import { atomicWriteFile, withLock } from "../state.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

export const KNOWLEDGE_EVAL_SETS_STORE = CONTROL_PLANE_PATHS.knowledgeEvalSetsFile;
const STORE_LOCK = "store:knowledge-eval-sets";
const ID_CHARSET = /^[a-z0-9_-]+$/i;

function normalizeCase(value) {
  const source = normalizeRecord(value, {});
  const query = normalizeString(source.query);
  const expectedSourcePath = normalizeString(source.expectedSourcePath || source.expected || source.path);
  if (!query || !expectedSourcePath) return null;
  const verdict = normalizeString(source.verdictStatus);
  return {
    query,
    expectedSourcePath,
    category: normalizeString(source.category) || null,
    expectedKeywords: Array.isArray(source.expectedKeywords)
      ? source.expectedKeywords.map((k) => normalizeString(k)).filter(Boolean)
      : [],
    // Phase5 v153(皆可选):asOf 点时评测;verdictStatus 三态(undecided 不计入 recall);
    // ghostSourcePaths 已知过时/被推翻的路径(进 top-k=幽灵命中,recall@k 对它失明)。
    asOf: normalizeString(source.asOf) || null,
    verdictStatus: ["resolved_correct", "resolved_wrong", "undecided"].includes(verdict) ? verdict : null,
    ghostSourcePaths: Array.isArray(source.ghostSourcePaths)
      ? source.ghostSourcePaths.map((p) => normalizeString(p)).filter(Boolean)
      : [],
    // v156:gold answer(生成侧 faithfulness 评测用——判检索 context 是否真支撑该答案;无则该 case
    // 不参与 faithfulness,recall 仍照常算)。
    answer: normalizeString(source.answer) || null,
  };
}

export function normalizeKnowledgeEvalSet(value) {
  const source = normalizeRecord(value, {});
  const kbId = normalizeString(source.kbId);
  const evalSetId = normalizeString(source.evalSetId || source.id);
  if (!kbId || !evalSetId || !ID_CHARSET.test(kbId) || !ID_CHARSET.test(evalSetId)) return null;
  const cases = (Array.isArray(source.cases) ? source.cases : []).map(normalizeCase).filter(Boolean);
  return {
    kbId,
    evalSetId,
    label: normalizeString(source.label) || evalSetId,
    topK: normalizePositiveInteger(source.topK, 10) || 10,
    cases,
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}

async function readStore() {
  try {
    return JSON.parse(await readFile(KNOWLEDGE_EVAL_SETS_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortSets(list) {
  return [...(Array.isArray(list) ? list : [])]
    .sort((a, b) => `${a?.kbId}::${a?.evalSetId}`.localeCompare(`${b?.kbId}::${b?.evalSetId}`));
}

async function writeStore(evalSets) {
  const normalized = sortSets((Array.isArray(evalSets) ? evalSets : []).map(normalizeKnowledgeEvalSet).filter(Boolean));
  await mkdir(dirname(KNOWLEDGE_EVAL_SETS_STORE), { recursive: true });
  await atomicWriteFile(KNOWLEDGE_EVAL_SETS_STORE, JSON.stringify({ updatedAt: Date.now(), evalSets: normalized }, null, 2));
  return normalized;
}

// 列出评测集(可按 kbId 过滤)。
export async function listKnowledgeEvalSets(kbId = null) {
  const parsed = await readStore();
  const all = sortSets((Array.isArray(parsed?.evalSets) ? parsed.evalSets : []).map(normalizeKnowledgeEvalSet).filter(Boolean));
  const id = normalizeString(kbId);
  return id ? all.filter((s) => s.kbId === id) : all;
}

export async function getKnowledgeEvalSet(kbId, evalSetId) {
  const k = normalizeString(kbId);
  const e = normalizeString(evalSetId);
  if (!k || !e) return null;
  return (await listKnowledgeEvalSets(k)).find((s) => s.evalSetId === e) || null;
}

// 新建/整体覆盖一个评测集(覆盖 cases)。
export async function saveKnowledgeEvalSet(spec) {
  const normalized = normalizeKnowledgeEvalSet(spec);
  if (!normalized) throw new Error("invalid knowledge eval set (need kbId + evalSetId)");
  return withLock(STORE_LOCK, async () => {
    const now = Date.now();
    const all = await listKnowledgeEvalSets();
    const existing = all.find((s) => s.kbId === normalized.kbId && s.evalSetId === normalized.evalSetId) || null;
    const merged = {
      ...normalized,
      createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
      updatedAt: now,
    };
    const next = all.filter((s) => !(s.kbId === normalized.kbId && s.evalSetId === normalized.evalSetId)).concat(merged);
    const saved = await writeStore(next);
    return saved.find((s) => s.kbId === normalized.kbId && s.evalSetId === normalized.evalSetId) || null;
  });
}

// 删除一个评测集(幂等)。
export async function deleteKnowledgeEvalSet(kbId, evalSetId) {
  const k = normalizeString(kbId);
  const e = normalizeString(evalSetId);
  if (!k || !e) throw new Error("missing kbId or evalSetId");
  return withLock(STORE_LOCK, async () => {
    const all = await listKnowledgeEvalSets();
    const existing = all.find((s) => s.kbId === k && s.evalSetId === e) || null;
    if (!existing) return { ok: true, deleted: false, evalSet: null };
    await writeStore(all.filter((s) => !(s.kbId === k && s.evalSetId === e)));
    return { ok: true, deleted: true, evalSet: existing };
  });
}
