// lib/operator/wiki-rag-store.js — flat-JSON vector store over the wiki (0 deps).
//
// corpus = wiki ONLY (the WHY truth). NO memos, NO test-reports. Chunks each
// page with the SHARED markdown chunker (lib/core/markdown-sections.js, Phase 2)
// so RAG and the lexical path chunk identically. Per-chunk sha256 drives
// incremental reuse: unchanged chunks keep their old vector, only changed/new
// chunks re-embed. Cosine search is hand-rolled (no math lib).

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

import { splitMarkdownSections, stripMarkdownNoise, extractFrontMatter } from "../core/markdown-sections.js";
import { atomicWriteFile, readJsonFile } from "../state-file-utils.js";
import { OC } from "../state.js";
import { embedText, resolveWikiRagEmbedConfig } from "./wiki-rag-embed.js";

const WIKI_DIR = join(OC, "wiki");
const INDEX_FILE = join(OC, "control-plane", "wiki-rag-index.json");
const MAX_CHUNK_CHARS = 1200;

// sha256 of chunk text — same content-addressed pattern as
// structure-snapshot.js:40-41 (createHash("sha256")...digest("hex")).
function hashText(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function slugifyHeading(heading) {
  const normalized = String(heading || "section")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "section";
}

// Oversize section → split on blank line, packing paragraphs up to the cap.
function splitOversize(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const paras = text.split(/\n\s*\n/).map((p) => stripMarkdownNoise(p)).filter(Boolean);
  const pieces = [];
  let buf = "";
  for (const para of paras) {
    if (!buf) {
      buf = para;
    } else if ((buf.length + 1 + para.length) <= MAX_CHUNK_CHARS) {
      buf = `${buf} ${para}`;
    } else {
      pieces.push(buf);
      buf = para;
    }
  }
  if (buf) pieces.push(buf);
  // A single paragraph still over the cap → hard-slice it.
  const out = [];
  for (const piece of pieces) {
    if (piece.length <= MAX_CHUNK_CHARS) {
      out.push(piece);
      continue;
    }
    for (let i = 0; i < piece.length; i += MAX_CHUNK_CHARS) {
      out.push(piece.slice(i, i + MAX_CHUNK_CHARS));
    }
  }
  return out.length ? out : [text.slice(0, MAX_CHUNK_CHARS)];
}

// Walk wiki/ recursively → array of { relPath, markdown }. relPath uses '/'.
// 顶层 meta 页：维护规则 / 全局导航 / 变更日志 / 状态——不是概念知识，进索引只会污染检索
// （recall 评测实测：schema.md 对多条查询霸占 top 结果）。仅排除 wiki 根的这几个，子目录概念/决策页照常索引。
const WIKI_META_PAGES = new Set(["index.md", "log.md", "schema.md", "status.md"]);

async function readWikiPages() {
  let entries = [];
  try {
    entries = await readdir(WIKI_DIR, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const pages = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const dir = entry.parentPath || entry.path || WIKI_DIR;
    const abs = join(dir, entry.name);
    const relPath = relative(WIKI_DIR, abs).split(sep).join("/");
    if (WIKI_META_PAGES.has(relPath)) continue; // 跳过 meta 页（非知识,污染检索）
    const markdown = await readFile(abs, "utf8").catch(() => "");
    if (markdown) pages.push({ relPath, markdown });
  }
  return pages;
}

// Phase5:把 page 级 rawMeta(front-matter + fileFacts)按 KB 声明的 metadataRules 投影成
// 通用三槽 {source,time,fields}。rules=null(wiki/旧库)→ 全空 → chunk 不挂 meta(向后兼容)。
// 通用机红线:核心从不读 issuer/target_price/fiscal_period——它们只是 rules.fields.passthrough
// 里的不透明键名,金融 schema 只活在某个 KB 的 metadataRules 配置里。纯函数,可单测。
function normalizeTimeValue(raw) {
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function extractChunkMeta(rawMeta, metadataRules) {
  const empty = { source: null, time: null, fields: {} };
  if (!metadataRules || typeof metadataRules !== "object") return empty;
  const fm = (rawMeta && rawMeta.frontMatter) || {};
  const facts = (rawMeta && rawMeta.fileFacts) || {};
  const firstKey = (keys) => {
    for (const k of (Array.isArray(keys) ? keys : [])) {
      if (fm[k] != null && String(fm[k]).trim()) return String(fm[k]).trim();
    }
    return null;
  };
  const applyFallback = (fb) => (fb === "folder" || fb === "filename" || fb === "mtime") ? (facts[fb] || null) : null;

  const source = metadataRules.source
    ? (firstKey(metadataRules.source.keys) || applyFallback(metadataRules.source.fallback))
    : null;
  const time = metadataRules.time
    ? normalizeTimeValue(firstKey(metadataRules.time.keys) || applyFallback(metadataRules.time.fallback))
    : null;
  const fields = {};
  const passthrough = metadataRules.fields && Array.isArray(metadataRules.fields.passthrough) ? metadataRules.fields.passthrough : [];
  for (const k of passthrough) {
    if (fm[k] != null && String(fm[k]).trim()) fields[k] = String(fm[k]).trim();
  }
  return { source, time, fields };
}

// 通用 chunk planner(无 embedding):pages=[{ relPath, content, isMarkdown, rawMeta? }] → chunk[]。
// md 页按 markdown sections 切;非 md 按整文一段(splitOversize 再按段落/硬切打包到 cap)。
// wiki(全 md)与任意 KB(混合文件)共用此函数 = 一条切分路径。
// Phase5:有 metadataRules 时按 page 级 rawMeta 投影出 meta,挂到该页所有 chunk(文档级元数据)。
// hash 仍只 hash text(改 rules 不触发 re-embed);无 meta 不加字段(向后兼容)。
function buildChunkPlanFromPages(pages, { metadataRules = null } = {}) {
  const chunks = [];
  for (const page of (Array.isArray(pages) ? pages : [])) {
    const { relPath, content, isMarkdown } = page;
    const meta = extractChunkMeta(page.rawMeta, metadataRules);
    const hasMeta = !!(meta.source || meta.time || Object.keys(meta.fields).length > 0);
    const sections = isMarkdown
      ? splitMarkdownSections(content)
      : [{ heading: relPath.split("/").pop() || "Section", text: String(content || "") }];
    let ord = 0;
    for (const section of sections) {
      const heading = section.heading || "Section";
      for (const text of splitOversize(section.text)) {
        if (!text) continue;
        chunks.push({
          id: `${relPath}#${slugifyHeading(heading)}#${ord}`,
          sourcePath: relPath,
          heading,
          text,
          hash: hashText(text),
          ...(hasMeta ? { meta } : {}),
        });
        ord += 1;
      }
    }
  }
  return chunks;
}

// wiki chunk plan = wiki/ 全 md 页过通用 planner(行为与旧 buildChunkPlan 等价)。
async function buildChunkPlan() {
  const pages = (await readWikiPages()).map((p) => ({
    relPath: p.relPath,
    content: p.markdown,
    isMarkdown: true,
  }));
  return buildChunkPlanFromPages(pages);
}

// ── 任意可读文件/文件夹 → RAG 页(generic ingestion,供 knowledge-base.buildKbIndex) ──

// 可读文本判定:扩展名白名单 + buffer 启发(无 NUL 字节 + 高可打印比例)。
// 已知文本/代码/配置扩展 → 过内容确认;无扩展名 → 仅看内容;其它(图片/压缩/二进制扩展)→ 直接拒。
// UI 用此判定给非文本文件打叉,build 跳过它们。
const TEXT_FILE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".org",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".jsonc",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".html", ".htm", ".css", ".scss", ".xml", ".csv", ".tsv", ".sql", ".log",
]);

function fileExtension(name) {
  const i = String(name || "").lastIndexOf(".");
  return i > 0 ? String(name).slice(i).toLowerCase() : "";
}

// buffer 启发:NUL 字节 → 二进制;否则取前 4KB 统计可打印比例(允许 \t\n\r + UTF-8 高位)。
function looksLikeText(buffer) {
  if (!buffer || buffer.length === 0) return false; // 空文件无内容可索引
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false; // NUL = 二进制
    if (byte >= 0x20 || byte === 9 || byte === 10 || byte === 13 || byte >= 0x80) printable += 1;
  }
  return printable / sample.length >= 0.95;
}

export function isTextFile(name, buffer) {
  const ext = fileExtension(name);
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) return false; // 已知非文本/未知扩展 → 拒
  return looksLikeText(buffer);
}

// fileAbs → 用于 chunk id / 展示的稳定 relPath。OC 内 → 相对路径;OC 外 → 绝对路径(去前导 /)。
function toRelPath(fileAbs) {
  const rel = relative(OC, fileAbs);
  if (rel && !rel.startsWith("..")) return rel.split(sep).join("/");
  return fileAbs.split(sep).join("/").replace(/^\/+/, "");
}

async function readPageIfText(fileAbs) {
  let buffer;
  try { buffer = await readFile(fileAbs); } catch { return null; }
  const name = fileAbs.split(sep).pop() || fileAbs;
  if (!isTextFile(name, buffer)) return null;
  const content = buffer.toString("utf8");
  if (!content.trim()) return null;
  const relPath = toRelPath(fileAbs);
  const isMarkdown = /\.(md|markdown)$/i.test(name);
  // Phase5 raw 元数据源(只在 page 级抓一次,供 extractChunkMeta 投影;有无 rules 都附,无 rules 时被丢弃)。
  // mtime:reindex 非热路径,一次 stat 相对 readFile+embed 可忽略;失败 → null(fail-soft)。
  let mtime = null;
  try { mtime = (await stat(fileAbs)).mtime.toISOString(); } catch { /* mtime 兜底不可用 */ }
  const rawMeta = {
    frontMatter: isMarkdown ? extractFrontMatter(content) : {},
    fileFacts: { folder: relPath.split("/").at(-2) || null, filename: name.replace(/\.[^.]+$/, "") || name, mtime },
  };
  return { relPath, content, isMarkdown, rawMeta };
}

// 把 KB 的 sources(相对 OC 或绝对,文件或文件夹)展开成可读文本页 [{ relPath, content, isMarkdown }]。
// 文件夹递归展开,逐文件过 isTextFile;缺失/不可读跳过(不抛)。
export async function readSourceFiles(sources, { logger } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const pages = [];
  for (const source of list) {
    const src = String(source || "").trim();
    if (!src) continue;
    const abs = src.startsWith("/") ? src : join(OC, src);
    let info;
    try { info = await stat(abs); } catch { logger?.warn?.(`[watchdog] kb source missing: ${src}`); continue; }
    if (info.isDirectory()) {
      let entries = [];
      try { entries = await readdir(abs, { recursive: true, withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const dir = entry.parentPath || entry.path || abs;
        const page = await readPageIfText(join(dir, entry.name));
        if (page) pages.push(page);
      }
    } else if (info.isFile()) {
      const page = await readPageIfText(abs);
      if (page) pages.push(page);
    }
  }
  return pages;
}

// 任意源 chunk plan = readSourceFiles → 通用 planner(供 buildKbIndex)。
// Phase5:metadataRules 透传给 planner,使时态 KB 的 chunk 带 source/time/fields(无规则=旧行为)。
export async function buildChunkPlanForSources(sources, { logger, metadataRules = null } = {}) {
  return buildChunkPlanFromPages(await readSourceFiles(sources, { logger }), { metadataRules });
}

// 加载任意 RAG 索引文件(wiki 与各 KB 共用)。缺失/损坏 → 空索引(优雅降级)。
export async function loadRagIndexFile(indexPath) {
  const data = await readJsonFile(indexPath);
  if (!data || !Array.isArray(data.chunks)) {
    return { model: null, builtAt: null, chunks: [] };
  }
  return data;
}

export async function loadWikiRagIndex() {
  return loadRagIndexFile(INDEX_FILE);
}

// 把 chunk plan 嵌入并写到指定索引文件:embed + 按 hash 增量复用 + 0-chunk 降级保护(不覆盖旧索引)。
// wiki 与任意 KB 共用此核心(buildWikiRagIndex / knowledge-base.buildKbIndex 都调它)= 一条路径。
// Returns ok:true ALWAYS — degraded:true when ollama is down (per-chunk embed caught),
// never {ok:false} (the executor treats {ok:false} as a failure → rollback).
export async function embedChunkPlanToIndex({ plan, indexPath, force = false, logger, temporal = false, conflict = null, embedModel = null } = {}) {
  const cfg = await resolveWikiRagEmbedConfig();
  // embedModel override(122 P0-1 的 A/B 纪律:换模前先建 alt 索引测 recall delta);默认走配置。
  const model = embedModel || cfg.model;
  const baseUrl = cfg.baseUrl;
  const chunks = Array.isArray(plan) ? plan : [];

  const existing = force ? { chunks: [] } : await loadRagIndexFile(indexPath);
  const reuseByHash = new Map();
  // Only reuse vectors that match the current embed model (model switch invalidates).
  if (!force && existing.model === model) {
    for (const rec of existing.chunks) {
      if (rec && typeof rec.hash === "string" && Array.isArray(rec.vector)) {
        reuseByHash.set(rec.hash, rec);
      }
    }
  }

  const records = [];
  let reembedded = 0;
  let reused = 0;
  let degraded = false;

  // text is persisted alongside the vector so search returns excerpts without
  // re-reading source. Record shape: { id, sourcePath, heading, hash, dim, vector, text, meta? }.
  // Phase5:meta(若有)随 base 透传——reuse 分支也从当前 chunk 取 meta(非 prior 向量),
  // 故改 metadataRules 重 build 时 meta 刷新而 vector 仍按 hash 复用。
  for (const chunk of chunks) {
    const base = {
      id: chunk.id,
      sourcePath: chunk.sourcePath,
      heading: chunk.heading,
      hash: chunk.hash,
      text: chunk.text,
      ...(chunk.meta ? { meta: chunk.meta } : {}),
    };
    const prior = reuseByHash.get(chunk.hash);
    if (prior && Array.isArray(prior.vector) && prior.vector.length > 0) {
      records.push({ ...base, dim: prior.dim || prior.vector.length, vector: prior.vector });
      reused += 1;
      continue;
    }
    try {
      const vector = await embedText(chunk.text, { model, baseUrl });
      records.push({ ...base, dim: vector.length, vector });
      reembedded += 1;
    } catch (error) {
      // ollama unavailable → degrade gracefully. Skip this chunk's vector; the
      // index simply lacks it until the next reindex. ok:true is preserved.
      degraded = true;
      logger?.warn?.(`[watchdog] rag embed skipped (${chunk.id}): ${error.message}`);
    }
  }

  // ⑨ A forced rebuild that embedded ZERO chunks (transient ollama outage during force:true) must NOT
  // clobber a non-empty working index — that would silently destroy the grounding corpus. Preserve
  // the prior index instead of writing an empty one. (force resets `existing` to empty, so re-load it.)
  if (degraded && records.length === 0) {
    const prior = force ? await loadRagIndexFile(indexPath) : existing;
    if (Array.isArray(prior?.chunks) && prior.chunks.length > 0) {
      logger?.warn?.("[watchdog] rag reindex degraded (0 chunks embedded); preserving prior index");
      return {
        ok: true,
        model,
        builtAt: prior.builtAt,
        chunkCount: prior.chunks.length,
        reembedded: 0,
        reused: 0,
        removed: 0,
        degraded: true,
        preserved: true,
      };
    }
  }

  const removed = Math.max(0, (existing.chunks?.length || 0) - reused);
  const builtAt = new Date().toISOString();
  // Phase5:temporal/conflict 标记写进 index 顶层(而非只在 KB spec)——检索期 hybridSearchOverIndex
  // 只拿到 index 不拿 spec,真值随 index 走,避免 spec/index 不一致。默认空,wiki 顶层无此字段差异。
  const index = { model, builtAt, ...(temporal ? { temporal: true } : {}), ...(conflict ? { conflict } : {}), chunks: records };

  await atomicWriteFile(indexPath, JSON.stringify(index, null, 2));

  return {
    ok: true,
    model,
    builtAt,
    chunkCount: records.length,
    reembedded,
    reused,
    removed,
    ...(degraded ? { degraded: true } : {}),
  };
}

// wiki 索引 = wiki/ 目录 chunk plan → embedChunkPlanToIndex(INDEX_FILE)。
// Incremental build (unless force): reuse vectors for unchanged hashes, re-embed changed/new, drop dead.
export async function buildWikiRagIndex({ force = false, logger, indexPath = INDEX_FILE, embedModel = null } = {}) {
  return embedChunkPlanToIndex({ plan: await buildChunkPlan(), indexPath, force, logger, embedModel });
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Hand-rolled cosine top-K against a query embedding. Ranks over the supplied
// index (default: load fresh). Caller (wiki-rag-search.js) loads once and passes
// it in so embed + load + rank stay a single pass with no hidden module state.
export async function searchWikiRag(queryEmbedding, { topK = 5, index = null } = {}) {
  const resolved = index || await loadWikiRagIndex();
  const chunks = Array.isArray(resolved?.chunks) ? resolved.chunks : [];
  return chunks
    .map((rec) => ({
      sourcePath: rec.sourcePath,
      heading: rec.heading,
      text: rec.text || "",
      score: cosine(queryEmbedding, rec.vector),
      ...(rec.meta ? { meta: rec.meta } : {}), // Phase5:旧索引无 meta → 不加字段(向后兼容)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(topK) || 5));
}

// 词法检索词项:ASCII 词(token) + CJK 字符 bigram。中文无空格分词,整句会成单 token →
// 用 CJK 字符 2-gram 才能匹配「传送带」这类短语重叠;ASCII 用整词匹配(harness/conveyor/inbox)。
export function lexicalTermsForQuery(text) {
  const lower = String(text || "").toLowerCase();
  const asciiTokens = [...new Set(lower.split(/[^a-z0-9_-]+/u).filter((t) => t.length >= 2))];
  const cjkBigrams = [];
  for (const run of (lower.match(/[一-鿿]+/gu) || [])) {
    if (run.length === 1) cjkBigrams.push(run);
    else for (let i = 0; i < run.length - 1; i += 1) cjkBigrams.push(run.slice(i, i + 2));
  }
  return { asciiTokens, cjkBigrams: [...new Set(cjkBigrams)] };
}

function lexicalScoreChunk(terms, chunkText, chunkHeading) {
  const hay = `${chunkText || ""} ${chunkHeading || ""}`.toLowerCase();
  const head = String(chunkHeading || "").toLowerCase();
  let score = 0;
  for (const t of terms.asciiTokens) {
    if (hay.includes(t)) score += (t.length >= 4 ? 3 : 1) + (head.includes(t) ? 2 : 0);
  }
  for (const bg of terms.cjkBigrams) {
    if (hay.includes(bg)) score += 1 + (head.includes(bg) ? 1 : 0);
  }
  return score;
}

// 词法 top-K(纯函数,不需 ollama)。与 searchWikiRag 同输出形状 {sourcePath,heading,text,score}。
// 用于 hybrid 融合 + ollama 不可用时的降级检索(此前降级=空,现在降级仍有词法结果)。
export async function searchWikiRagLexical(queryText, { topK = 5, index = null } = {}) {
  const resolved = index || await loadWikiRagIndex();
  const chunks = Array.isArray(resolved?.chunks) ? resolved.chunks : [];
  const terms = lexicalTermsForQuery(queryText);
  if (terms.asciiTokens.length === 0 && terms.cjkBigrams.length === 0) return [];
  return chunks
    .map((rec) => ({
      sourcePath: rec.sourcePath,
      heading: rec.heading,
      text: rec.text || "",
      score: lexicalScoreChunk(terms, rec.text, rec.heading),
      ...(rec.meta ? { meta: rec.meta } : {}), // Phase5:meta 透传(旧索引无→不加)
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(topK) || 5));
}
