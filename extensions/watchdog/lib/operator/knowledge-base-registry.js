// lib/operator/knowledge-base-registry.js — 用户/operator 注册的知识库持久层(镜像 automation-registry)。
//
// 内置种子库(wiki)不可变,定义在 knowledge-base.js;本模块只管"用户加的库"
// (control-plane/knowledge-bases.json)。knowledge-base.listKnowledgeBaseSpecs() 把种子 ∪ 持久库合并。
// KB spec: { id, label, kind:'user', scope:'global'|'agent', agentId?, sources:[path], createdAt, updatedAt }。
// source 是路径字符串(相对 OC 或绝对);可读性在 build 时逐文件判定(isTextFile),不在 spec 里缓存。

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { atomicWriteFile, withLock } from "../state.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

export const KNOWLEDGE_BASES_STORE = CONTROL_PLANE_PATHS.knowledgeBasesFile;
const KNOWLEDGE_BASES_LOCK = "store:knowledge-bases";

const ID_CHARSET = /^[a-z0-9_-]+$/i; // 路径安全 + kb-<id>-index.json 文件名安全

// Phase5 元数据提取规则(声明式,金融 schema 唯一栖身处;核心代码不认 issuer/target_price)。
// 形状:{ source:{keys[],fallback?}, time:{keys[],fallback?}, fields:{passthrough[]} },非法子段剔除,整体空→null。
const META_FALLBACKS = new Set(["folder", "filename", "mtime"]);
function normalizeMetaSelector(value) {
  const src = normalizeRecord(value, null);
  if (!src) return null;
  const keys = (Array.isArray(src.keys) ? src.keys : []).map((k) => normalizeString(k)).filter(Boolean);
  const fallback = META_FALLBACKS.has(src.fallback) ? src.fallback : null;
  if (keys.length === 0 && !fallback) return null;
  return { keys, ...(fallback ? { fallback } : {}) };
}
export function normalizeMetadataRules(value) {
  const src = normalizeRecord(value, null);
  if (!src) return null;
  const source = normalizeMetaSelector(src.source);
  const time = normalizeMetaSelector(src.time);
  const passthrough = (Array.isArray(src.fields?.passthrough) ? src.fields.passthrough : [])
    .map((k) => normalizeString(k)).filter(Boolean);
  const fields = passthrough.length ? { passthrough } : null;
  if (!source && !time && !fields) return null;
  return { ...(source ? { source } : {}), ...(time ? { time } : {}), ...(fields ? { fields } : {}) };
}

// Phase5 v151:分歧派生配置(声明式,通用)。{ groupBy:路径|null(null=全部一组), on:[标量路径] }。
// on 为空 → null(无可比标量则无从算分歧)。groupBy/on 是路径串(heading|sourcePath|source|fields.<k>)。
export function normalizeConflictConfig(value) {
  const src = normalizeRecord(value, null);
  if (!src) return null;
  const on = (Array.isArray(src.on) ? src.on : []).map((s) => normalizeString(s)).filter(Boolean);
  if (on.length === 0) return null;
  return { groupBy: normalizeString(src.groupBy) || null, on };
}

// 规范化一个用户库 spec(非法 id / wiki 保留 id → null,由调用方过滤)。
export function normalizeKnowledgeBaseSpec(value) {
  const source = normalizeRecord(value, {});
  const id = normalizeString(source.id);
  if (!id || !ID_CHARSET.test(id) || id === "wiki") return null; // wiki = 内置保留 id
  const scope = source.scope === "agent" ? "agent" : "global";
  return {
    id,
    label: normalizeString(source.label) || id,
    kind: "user",
    scope,
    agentId: scope === "agent" ? (normalizeString(source.agentId) || null) : null,
    sources: uniqueStrings(
      (Array.isArray(source.sources) ? source.sources : [])
        .map((s) => normalizeString(s))
        .filter(Boolean),
    ),
    temporal: source.temporal === true,                          // Phase5:时态门控(默认关)
    metadataRules: normalizeMetadataRules(source.metadataRules), // Phase5:声明式提取规则(默认 null)
    conflict: normalizeConflictConfig(source.conflict),          // Phase5 v151:分歧派生配置(默认 null)
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}

async function readKnowledgeBasesStore() {
  try {
    return JSON.parse(await readFile(KNOWLEDGE_BASES_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortById(list) {
  return [...(Array.isArray(list) ? list : [])]
    .sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));
}

async function writeKnowledgeBasesStore(knowledgeBases) {
  const normalized = sortById(
    (Array.isArray(knowledgeBases) ? knowledgeBases : [])
      .map((kb) => normalizeKnowledgeBaseSpec(kb))
      .filter(Boolean),
  );
  await mkdir(dirname(KNOWLEDGE_BASES_STORE), { recursive: true });
  await atomicWriteFile(KNOWLEDGE_BASES_STORE, JSON.stringify({
    updatedAt: Date.now(),
    knowledgeBases: normalized,
  }, null, 2));
  return normalized;
}

// 仅持久(用户)库,不含种子。种子 ∪ 持久 的合并在 knowledge-base.js。
export async function listPersistedKnowledgeBases() {
  const parsed = await readKnowledgeBasesStore();
  const entries = Array.isArray(parsed?.knowledgeBases) ? parsed.knowledgeBases : [];
  return sortById(entries.map((e) => normalizeKnowledgeBaseSpec(e)).filter(Boolean));
}

// 给一个库追加一个 source(库不存在 → 按 createIfMissing 决定是否新建)。第一个 source 即建库。
export async function addKnowledgeBaseSource(kbId, sourcePath, { label, scope, agentId, createIfMissing = true } = {}) {
  const id = normalizeString(kbId);
  const src = normalizeString(sourcePath);
  if (!id) throw new Error("missing knowledge base id");
  if (!src) throw new Error("missing source path");
  if (!ID_CHARSET.test(id) || id === "wiki") throw new Error(`invalid knowledge base id: ${id}`);
  return withLock(KNOWLEDGE_BASES_LOCK, async () => {
    const now = Date.now();
    const all = await listPersistedKnowledgeBases();
    const existing = all.find((e) => e.id === id) || null;
    if (!existing && !createIfMissing) throw new Error(`unknown knowledge base: ${id}`);
    const base = existing || {
      id,
      label: normalizeString(label) || id,
      scope: scope === "agent" ? "agent" : "global",
      agentId: agentId || null,
      sources: [],
    };
    const merged = {
      ...base,
      label: normalizeString(label) || base.label || id,
      sources: uniqueStrings([...(base.sources || []), src]),
      createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
      updatedAt: now,
    };
    const saved = await writeKnowledgeBasesStore(all.filter((e) => e.id !== id).concat(merged));
    return saved.find((e) => e.id === id) || null;
  });
}

// 移除一个 source(库保留,空 sources);库不存在 → removed:false(幂等,不抛)。
export async function removeKnowledgeBaseSource(kbId, sourcePath) {
  const id = normalizeString(kbId);
  const src = normalizeString(sourcePath);
  if (!id || !src) throw new Error("missing knowledge base id or source path");
  return withLock(KNOWLEDGE_BASES_LOCK, async () => {
    const all = await listPersistedKnowledgeBases();
    const existing = all.find((e) => e.id === id) || null;
    if (!existing) return { ok: true, removed: false, knowledgeBase: null };
    const saved = await writeKnowledgeBasesStore(all.filter((e) => e.id !== id).concat({
      ...existing,
      sources: (existing.sources || []).filter((s) => s !== src),
      updatedAt: Date.now(),
    }));
    return { ok: true, removed: true, knowledgeBase: saved.find((e) => e.id === id) || null };
  });
}

// 删除整个用户库(内置 wiki 不可删 → 报错)。幂等:不存在 → removed:false。
export async function removeKnowledgeBase(kbId) {
  const id = normalizeString(kbId);
  if (!id) throw new Error("missing knowledge base id");
  if (id === "wiki") throw new Error("cannot remove builtin knowledge base: wiki");
  return withLock(KNOWLEDGE_BASES_LOCK, async () => {
    const all = await listPersistedKnowledgeBases();
    const existing = all.find((e) => e.id === id) || null;
    if (!existing) return { ok: true, removed: false, knowledgeBase: null };
    await writeKnowledgeBasesStore(all.filter((e) => e.id !== id));
    return { ok: true, removed: true, knowledgeBase: existing };
  });
}

// Phase5:配置一个用户库的时态/元数据规则(temporal 开关 + metadataRules)。这是把目标1/2 打开的
// 唯一入口;金融 schema 经此写进 knowledge-bases.json 的数据,核心代码零金融词。需重建索引生效。
export async function configureKnowledgeBase(kbId, { temporal, metadataRules, conflict } = {}) {
  const id = normalizeString(kbId);
  if (!id) throw new Error("missing knowledge base id");
  if (id === "wiki") throw new Error("cannot configure builtin knowledge base: wiki");
  if (!ID_CHARSET.test(id)) throw new Error(`invalid knowledge base id: ${id}`);
  return withLock(KNOWLEDGE_BASES_LOCK, async () => {
    const all = await listPersistedKnowledgeBases();
    const existing = all.find((e) => e.id === id) || null;
    if (!existing) throw new Error(`unknown knowledge base: ${id}`);
    const merged = {
      ...existing,
      ...(temporal !== undefined ? { temporal: temporal === true } : {}),
      ...(metadataRules !== undefined ? { metadataRules: normalizeMetadataRules(metadataRules) } : {}),
      ...(conflict !== undefined ? { conflict: normalizeConflictConfig(conflict) } : {}),
      updatedAt: Date.now(),
    };
    const saved = await writeKnowledgeBasesStore(all.filter((e) => e.id !== id).concat(merged));
    return saved.find((e) => e.id === id) || null;
  });
}
