// lib/knowledge/wiki-rag-store.js — flat-JSON vector store over the wiki (0 deps).
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
import { atomicWriteFile, readJsonFile } from "../state/state-file-utils.js";
import { OC } from "../state.js";
import { redactSecrets } from "../security/secret-redactor.js";
import { embedText, resolveWikiRagEmbedConfig } from "./wiki-rag-embed.js";
import { buildLexicalScorer } from "./wiki-rag-lexical.js";

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
    // meta 页判定按 **wiki 内相对**(集合里就是 "index.md" 这种),对外的 sourcePath 按 **OC 根相对**。
    // 两者必须分开算:v186 之前 relPath 一个值兼两用,统一基准后若继续拿它查集合,
    // "wiki/index.md" ∉ {"index.md",…} → 四个 meta 页会全部混进索引(评测实测 schema.md 会霸榜)。
    const wikiRel = relative(WIKI_DIR, abs).split(sep).join("/");
    if (WIKI_META_PAGES.has(wikiRel)) continue; // 跳过 meta 页（非知识,污染检索）
    // v186:与 buildChunkPlanForSources 用同一个 toRelPath —— 此前 wiki 走 relative(WIKI_DIR),
    // 用户库走 toRelPath(相对 OC 根),同名字段 sourcePath 有两种含义,谁也无法只凭它定位文件。
    // 实测代价:worker 拿到 "concepts/conveyor-belt.md" 后无从知道要补 "wiki/",猜了个
    // workspaces/worker/.kb/wiki/... 去 read,连废三次调用(答案靠摘录才对)。一条路径原则。
    const relPath = toRelPath(abs);
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
//
// headingPrefix(**默认 false = 旧行为逐字节不变**):把 h1>h2>h3 面包屑拼进 chunk.text。
// 为什么做成开关而不是直接改:被 embed 的正是 chunk.text(:330),而 splitMarkdownSections 只维护
// 单个平面 heading,h2/h3 chunk 的正文里没有页标题——页标题恰恰是真正的概念名。
// 实测 live 索引 444 chunk:**383 块(86%)的 text 不含所属页 h1 标题**。拼进去很可能提升召回,
// 但这是**改变检索行为**:全部 chunk hash 变化 → 全量重嵌,且必须 A/B 裁决,不能默认开。
// 注意两个诚实的副作用:(1) 面包屑同时进了词法 hay(:434),祖先标题的词会给该页所有 chunk 加分,
// 所以 A/B 测的是「面包屑进 chunk 文本」整体效果,不是纯向量效果;(2) 面包屑不占 MAX_CHUNK_CHARS
// 预算(切完再前缀)。另:h1 后若无正文就不产 section,该 h1 也不进面包屑——这是不改共享切分器
// (markdown-sections.js 是词法路共用的)的代价;实测当前 wiki 64 页全部 h1 下都有摘要行,不受影响。
function buildChunkPlanFromPages(pages, { metadataRules = null, headingPrefix = false, extraSecrets = [] } = {}) {
  const chunks = [];
  for (const page of (Array.isArray(pages) ? pages : [])) {
    const { relPath, content, isMarkdown } = page;
    const meta = extractChunkMeta(page.rawMeta, metadataRules);
    const hasMeta = !!(meta.source || meta.time || Object.keys(meta.fields).length > 0);
    const sections = isMarkdown
      ? splitMarkdownSections(content)
      : [{ heading: relPath.split("/").pop() || "Section", text: String(content || "") }];
    let ord = 0;
    const crumbs = []; // 按 section.level 维护的祖先标题栈(splitMarkdownSections 只给平面 heading)
    for (const section of sections) {
      const heading = section.heading || "Section";
      const level = Number(section.level) || 1;
      crumbs.length = level - 1;   // 截断到父级(h1 出现时清空 h2/h3)
      crumbs[level - 1] = heading; // 跳级(h1→h3)留下的空洞由 filter(Boolean) 吃掉
      const prefix = headingPrefix ? `${crumbs.filter(Boolean).join(" > ")}\n` : "";
      for (const rawText of splitOversize(section.text)) {
        if (!rawText) continue;
        const prefixed = prefix ? `${prefix}${rawText}` : rawText;
        // 摄入侧脱敏:**必须在 hashText 之前** —— hash 基于脱敏后文本,索引里永不出现明文。
        // 起因(实测):活着的网关 token 明文进了 memos 索引(10 文件 22 处),而 memos 是 global KB,
        // 任何 agent 检索到就把密钥带进上下文。规则全部要求上下文锚点(厂商前缀/Bearer/token= 等),
        // 宁可漏也不误伤正文;extraSecrets 补锚点管不了的裸值(如中文标签后直接跟 token)。
        // ⚠ 这只挡**未来**的 chunk:存量索引需重建、语料原文与 git 历史仍是明文 → 轮换密钥才是根治。
        const text = redactSecrets(prefixed, { extraSecrets });
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
// 从 openclaw.json 取当前活着的密钥,交给 redactSecrets 的 extraSecrets 做字面量兜底 ——
// 锚点规则管不了「- 当前值: <token>」这种中文标签后直接跟裸值的形态(实测残留 1 处,加这个后 0)。
// best-effort:读不到就返回空数组,绝不阻断建库(锚点规则仍在)。不缓存:配置轮换后下次建库即生效。
async function resolveExtraSecrets() {
  try {
    const cfg = JSON.parse(await readFile(join(OC, "openclaw.json"), "utf8"));
    return [cfg?.gateway?.auth?.token, cfg?.hooks?.token]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length >= 12);
  } catch {
    return [];
  }
}

async function buildChunkPlan({ headingPrefix = false } = {}) {
  const pages = (await readWikiPages()).map((p) => ({
    relPath: p.relPath,
    content: p.markdown,
    isMarkdown: true,
  }));
  return buildChunkPlanFromPages(pages, { headingPrefix, extraSecrets: await resolveExtraSecrets() });
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
// headingPrefix 同样只透传(默认 false),给 A/B 用。
export async function buildChunkPlanForSources(sources, { logger, metadataRules = null, headingPrefix = false } = {}) {
  return buildChunkPlanFromPages(await readSourceFiles(sources, { logger }), {
    metadataRules, headingPrefix, extraSecrets: await resolveExtraSecrets(),
  });
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
// headingPrefix:见 buildChunkPlanFromPages。A/B 时配合 indexPath 建 alt 索引(别覆盖主索引);
// 变体切换会让全部 chunk hash 变化 → 自动全量重嵌,不会与旧向量混用(无需在索引里记变体标记)。
export async function buildWikiRagIndex({ force = false, logger, indexPath = INDEX_FILE, embedModel = null, headingPrefix = false } = {}) {
  return embedChunkPlanToIndex({ plan: await buildChunkPlan({ headingPrefix }), indexPath, force, logger, embedModel });
}

// 同分并列的确定性二级键。为什么必须有:两条检索路的 sort 此前只比 score,并列名次就落回
// chunk 插入序 = readdir 目录遍历序 —— 新增/删除一个 wiki 页就能把 rank-1 换掉。
// 实测(444 chunk 的 live 索引 + 12 条查询,纯词法路,不需 ollama):5/12 条查询 top-1 是并列
// (最多一次 8 块同分),把 chunk 数组洗牌后重排,3/12 条的 rank-1 直接换了另一个页面。
// 后果:任何切分器/模型 A/B 测到的 delta 里混着 tie-break 抖动,不是质量差异。
// 这里只做"可复现",不做"公平":并列仍按 sourcePath 字典序偏好(wiki/concepts/ < wiki/decisions/)。
// 并列本身的根因是词法默认档纯存在性计分(existence:无 IDF、无长度归一,"提到 X"和"定义 X"同分),
// 那是行为改变 —— 可切换档位已建于 wiki-rag-lexical.js,默认档保持 existence(证据等级见该文件)。
function compareByScoreThenPath(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ap = a.sourcePath || "";
  const bp = b.sourcePath || "";
  if (ap !== bp) return ap < bp ? -1 : 1;
  const ah = a.heading || "";
  const bh = b.heading || "";
  if (ah !== bh) return ah < bh ? -1 : 1;
  return 0; // 同页同标题 → 保持插入序(Array#sort 规范稳定),该序由页内容决定,与遍历序无关
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
    .sort(compareByScoreThenPath)
    .slice(0, Math.max(1, Number(topK) || 5));
}

// 词法检索词项:ASCII 词(token) + CJK 字符 bigram。中文无空格分词,整句会成单 token →
// 用 CJK 字符 2-gram 才能匹配「传送带」这类短语重叠;ASCII 用整词匹配(conveyor/inbox/gateway)。
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

// 词法 top-K(纯函数,不需 ollama)。与 searchWikiRag 同输出形状 {sourcePath,heading,text,score}。
// 用于 hybrid 融合 + ollama 不可用时的降级检索(此前降级=空,现在降级仍有词法结果)。
// scoring:打分档位与参数({mode,k1,b}),由调用方解析后传入 —— 本函数自身与配置文件解耦,
// 于是 kb-replay / 单测的结果与本机 openclaw.json 无关。缺省 = existence = 历史行为。
export async function searchWikiRagLexical(queryText, { topK = 5, index = null, scoring = null } = {}) {
  const resolved = index || await loadWikiRagIndex();
  const chunks = Array.isArray(resolved?.chunks) ? resolved.chunks : [];
  const terms = lexicalTermsForQuery(queryText);
  if (terms.asciiTokens.length === 0 && terms.cjkBigrams.length === 0) return [];
  // 每查询构造一次 scorer:df/avgLen 的统计遍(仅 idf/bm25 系档需要)在构造时发生一次,
  // 之后逐块打分是同步纯函数。传 chunks 本身(而非全库)—— asOf 过滤后的候选集与被打分的
  // 集合必须是同一份,df 才对得上。
  const scoreOf = buildLexicalScorer(terms, chunks, scoring || {});
  return chunks
    .map((rec) => ({
      sourcePath: rec.sourcePath,
      heading: rec.heading,
      text: rec.text || "",
      score: scoreOf(rec),
      ...(rec.meta ? { meta: rec.meta } : {}), // Phase5:meta 透传(旧索引无→不加)
    }))
    .filter((r) => r.score > 0)
    .sort(compareByScoreThenPath)
    .slice(0, Math.max(1, Number(topK) || 5));
}
