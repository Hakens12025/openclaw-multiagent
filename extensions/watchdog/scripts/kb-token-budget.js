#!/usr/bin/env node
// scripts/kb-token-budget.js — 语料体量 × 上下文预算的计数器(零依赖、只读)。
//
// 它回答一个问题:「把整库直接塞进 prompt」这条路,数字上成不成立。
// 判据是三段:① 语料有多大(字节/字符/汉字占比)② 折成多少 token ③ 与目标模型的窗口和
// 当前 prompt 基线相比占多大。三段都打印中间量,便于第三方复算。
//
// 【token 是估算,不是真值】本机没有目标模型的分词器,所以按字符分类加权估:
//   汉字(U+4E00–U+9FFF,与 wiki-rag-store.js:495 的 CJK 判定同一区间)按 0.6/0.75/1.0 token/字,
//   其余字符(ASCII 词、路径、标点、空白、换行)按 4.5/4.0/3.0 字符/token,
//   分别给出 low/mid/high 三档。真实分词器落在这个带里的哪一处,由 §校准 那一步定:
//   Moonshot 提供 /v1/tokenizers/estimate-token-count(纯计数、不做推理),
//   或直接读任意一次真实调用回包里的 usage.prompt_tokens —— 两者都能把估算换成实测。
//   结论层面对这个带并不敏感:全塞与检索差着两个数量级,带宽 ±30% 不改变方向。
//
// 用法:
//   node scripts/kb-token-budget.js                     # 两库体量 + 预算判断
//   node scripts/kb-token-budget.js --window 204800     # 换一个上下文窗口(默认 262144)
//   node scripts/kb-token-budget.js --baseline-tokens 20000   # 换 prompt 基线假设
//   node scripts/kb-token-budget.js --force-index       # 连大索引文件一起读(memos 索引 115MB)
//   node scripts/kb-token-budget.js --json              # 机器可读

import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OC = join(ROOT, "..", "..");

// wiki 索引侧排除的 meta 页,与 wiki-rag-store.js:71 的 WIKI_META_PAGES 保持一致 ——
// 讨论「wiki 能不能全塞」时,口径要对齐真正进检索的那 61 页。
const WIKI_META_PAGES = new Set(["index.md", "log.md", "schema.md", "status.md"]);
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
const LARGE_INDEX_BYTES = 64 * 1024 * 1024; // 超过此体积的索引默认跳过(--force-index 可读)

// 单条 grounding 摘录的截断上限,与 operator-knowledge.js:316 的 slice(0, 500) 一致。
const GROUNDING_EXCERPT_CAP = 500;
const GROUNDING_TOP_K = 4; // operator/viz-master 预注入条数(operator-knowledge.js:298)

// 「今天 / 抬高一档 / 全塞」三种 grounding 规格,用于把成本差摆在同一张表里。
const GROUNDING_SCENARIOS = Object.freeze([
  Object.freeze({ label: "今天(生产值)", topK: 4, cap: 500 }),
  Object.freeze({ label: "抬高一档", topK: 12, cap: 1200 }),
  Object.freeze({ label: "再抬一档", topK: 24, cap: 1200 }),
]);

export const CJK_TOKENS_PER_CHAR = Object.freeze({ low: 0.6, mid: 0.75, high: 1.0 });
export const OTHER_CHARS_PER_TOKEN = Object.freeze({ low: 4.5, mid: 4.0, high: 3.0 });

// ── 纯函数(可单测,估算口径的唯一真值) ──────────────────────────────────────

// 字符分类:汉字 vs 其余。bytes 按 UTF-8 计(汉字 3 字节,ASCII 1 字节 → 字节数会高估中文体量,
// 所以体量判断以 chars/token 为准,bytes 只用来和 `du` 对账。)
export function countCharClasses(text) {
  const s = String(text || "");
  let cjk = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk += 1;
  }
  return { chars: s.length, bytes: Buffer.byteLength(s, "utf8"), cjk, other: s.length - cjk };
}

export function addCounts(a, b) {
  return { chars: a.chars + b.chars, bytes: a.bytes + b.bytes, cjk: a.cjk + b.cjk, other: a.other + b.other };
}

export const emptyCounts = () => ({ chars: 0, bytes: 0, cjk: 0, other: 0 });

// 字符分类 → token 三档估算。四舍五入到整 token。
export function estimateTokenRange(counts) {
  const c = counts || emptyCounts();
  const at = (band) => Math.round(c.cjk * CJK_TOKENS_PER_CHAR[band] + c.other / OTHER_CHARS_PER_TOKEN[band]);
  return { low: at("low"), mid: at("mid"), high: at("high") };
}

// 预算判读:某个 token 量 + prompt 基线,在给定窗口里占多少、剩多少。
// fits 用 high 档(最保守的一档)判定,这样「说放得下」是有余量的说法。
export function budgetVerdict({ tokens, window, baselineTokens = 0 }) {
  const win = Math.max(1, Number(window) || 1);
  const totalHigh = tokens.high + baselineTokens;
  const totalMid = tokens.mid + baselineTokens;
  return {
    window: win,
    baselineTokens,
    totalMid,
    totalHigh,
    utilizationMid: round1((totalMid / win) * 100),
    utilizationHigh: round1((totalHigh / win) * 100),
    fits: totalHigh <= win,
    headroomHigh: win - totalHigh,
  };
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function formatInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── IO ────────────────────────────────────────────────────────────────────

function extensionOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

async function scanCorpus({ label, dir, skipRelPaths = new Set() }) {
  let entries = [];
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return { label, dir, available: false, fileCount: 0, byExtension: {}, counts: emptyCounts(), largest: [] };
  }
  let counts = emptyCounts();
  const byExtension = {};
  const perFile = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extensionOf(entry.name);
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const abs = join(entry.parentPath || entry.path || dir, entry.name);
    const rel = relative(dir, abs).split(sep).join("/");
    if (skipRelPaths.has(rel)) continue;
    const text = await readFile(abs, "utf8").catch(() => "");
    if (!text) continue;
    const c = countCharClasses(text);
    counts = addCounts(counts, c);
    byExtension[ext] = (byExtension[ext] || 0) + 1;
    perFile.push({ rel, chars: c.chars });
  }
  perFile.sort((a, b) => b.chars - a.chars);
  return {
    label,
    dir,
    available: true,
    fileCount: perFile.length,
    byExtension,
    counts,
    largest: perFile.slice(0, 3),
  };
}

// 索引侧:chunk 数 + chunk 文本总量 + 当前 grounding 每次实际注入多少字符。
// 大索引(向量占体积)默认跳过,给出提示而非静默。
async function scanIndex({ label, path, force }) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { label, path, available: false, reason: "索引文件尚未生成" };
  }
  if (info.size > LARGE_INDEX_BYTES && !force) {
    return { label, path, available: false, fileBytes: info.size, reason: `索引 ${formatInt(info.size / 1048576)}MB 超过默认读取上限,加 --force-index 读它` };
  }
  let index;
  try {
    index = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { label, path, available: false, reason: "索引解析失败" };
  }
  const chunks = Array.isArray(index?.chunks) ? index.chunks : [];
  if (chunks.length === 0) return { label, path, available: false, reason: "索引为空" };
  const lengths = chunks.map((c) => String(c?.text || "").length).sort((a, b) => a - b);
  let counts = emptyCounts();
  let cappedSum = 0;
  for (const c of chunks) {
    counts = addCounts(counts, countCharClasses(c?.text || ""));
    cappedSum += Math.min(String(c?.text || "").length, GROUNDING_EXCERPT_CAP);
  }
  const pages = new Set(chunks.map((c) => c?.sourcePath).filter(Boolean));
  return {
    label,
    path,
    available: true,
    model: index.model || null,
    chunkCount: chunks.length,
    pageCount: pages.size,
    counts,
    chunkLengths: lengths,
    medianChunkChars: lengths[Math.floor(lengths.length / 2)],
    p90ChunkChars: lengths[Math.floor(lengths.length * 0.9)],
    meanCappedExcerptChars: Math.round(cappedSum / chunks.length),
    groundingPayloadChars: groundingPayloadChars(lengths, { topK: GROUNDING_TOP_K, cap: GROUNDING_EXCERPT_CAP }),
  };
}

// 一份摘录字符数 → token(按该库的汉字占比等比推算)。
function excerptTokens(indexCounts, chars) {
  return estimateTokenRange(scaleCounts(indexCounts, chars / Math.max(1, indexCounts.chars))).mid;
}

// ── main ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { window: 262144, baselineTokens: 20000, json: false, forceIndex: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--force-index") args.forceIndex = true;
    else if (a === "--window") args.window = Number(argv[++i]) || args.window;
    else if (a === "--baseline-tokens") args.baselineTokens = Number(argv[++i]) || args.baselineTokens;
    else if (a.startsWith("--window=")) args.window = Number(a.slice(9)) || args.window;
    else if (a.startsWith("--baseline-tokens=")) args.baselineTokens = Number(a.slice(18)) || args.baselineTokens;
  }
  return args;
}

function printCorpus(corpus) {
  if (!corpus.available) {
    console.log(`  ${corpus.label}: 目录不可读 (${corpus.dir})`);
    return;
  }
  const c = corpus.counts;
  const t = estimateTokenRange(c);
  const exts = Object.entries(corpus.byExtension).map(([e, n]) => `${e}×${n}`).join(" ");
  console.log(`  ${corpus.label}  ${corpus.dir}`);
  console.log(`    文件      ${corpus.fileCount} (${exts})`);
  console.log(`    字节      ${formatInt(c.bytes)} B  (${round1(c.bytes / 1024)} KB)`);
  console.log(`    字符      ${formatInt(c.chars)}   其中汉字 ${formatInt(c.cjk)} (${round1((c.cjk / c.chars) * 100)}%)`);
  console.log(`    token估算 ${formatInt(t.low)} ~ ${formatInt(t.high)}  (中位档 ${formatInt(t.mid)})`);
  console.log(`    最大文件  ${corpus.largest.map((f) => `${f.rel} ${formatInt(f.chars)}字`).join(" | ")}`);
}

function printIndex(idx) {
  if (!idx.available) {
    console.log(`  ${idx.label}: ${idx.reason}`);
    return;
  }
  const t = estimateTokenRange(idx.counts);
  console.log(`  ${idx.label}  model=${idx.model}`);
  console.log(`    chunk     ${formatInt(idx.chunkCount)} 块 / ${formatInt(idx.pageCount)} 页  (中位 ${idx.medianChunkChars} 字, p90 ${idx.p90ChunkChars} 字)`);
  console.log(`    文本总量  ${formatInt(idx.counts.chars)} 字 → token 估算 ${formatInt(t.low)} ~ ${formatInt(t.high)} (中位档 ${formatInt(t.mid)})`);
  console.log(`    单次注入  topK=${GROUNDING_TOP_K} × 平均 ${idx.meanCappedExcerptChars} 字(截断上限 ${GROUNDING_EXCERPT_CAP}) = ${formatInt(idx.groundingPayloadChars)} 字 ≈ ${formatInt(excerptTokens(idx.counts, idx.groundingPayloadChars))} token`);
}

function printGroundingScenarios(idx, baselineTokens) {
  if (!idx.available) return;
  const fullTokens = estimateTokenRange(idx.counts).mid;
  const rows = GROUNDING_SCENARIOS.map((s) => {
    const chars = groundingPayloadChars(idx.chunkLengths, s);
    return { ...s, chars, tokens: excerptTokens(idx.counts, chars) };
  });
  rows.push({ label: "全塞(整库 chunk 文本)", topK: idx.chunkCount, cap: null, chars: idx.counts.chars, tokens: fullTokens });
  console.log("  规格                 每次注入        占 prompt   相对今天");
  const todayTokens = rows[0].tokens;
  for (const r of rows) {
    const share = round1((r.tokens / (baselineTokens - todayTokens + r.tokens)) * 100);
    const times = round1(r.tokens / Math.max(1, todayTokens));
    const spec = r.cap === null ? `全部 ${formatInt(r.topK)} 块` : `topK=${r.topK} cap=${r.cap}`;
    console.log(`  ${r.label.padEnd(18)} ${String(formatInt(r.tokens) + " token").padEnd(14)} ${String(share + "%").padEnd(10)} ${times}×   (${spec})`);
  }
}

// 按比例缩放字符分类(用整库的汉字占比去推一份摘录的 token 量,汉字比例视作均匀)。
export function scaleCounts(counts, factor) {
  const f = Number.isFinite(factor) ? factor : 0;
  return { chars: counts.chars * f, bytes: counts.bytes * f, cjk: counts.cjk * f, other: counts.other * f };
}

// 某个 grounding 规格每次注入多少字符 = topK × 平均(min(块长, cap))。
// 用平均块长而非"最相关的 topK 块"的真实长度:检索结果的长度分布与全库分布无系统性差异,
// 这里要的是量级而非某一次查询的精确值。纯函数。
export function groundingPayloadChars(chunkLengths, { topK, cap }) {
  const lens = Array.isArray(chunkLengths) ? chunkLengths : [];
  if (lens.length === 0) return 0;
  const capped = lens.reduce((sum, len) => sum + Math.min(len, cap), 0) / lens.length;
  return Math.round(capped * topK);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const wiki = await scanCorpus({ label: "wiki(检索口径,已排除 meta 页)", dir: join(OC, "wiki"), skipRelPaths: WIKI_META_PAGES });
  const wikiAll = await scanCorpus({ label: "wiki(全目录,含 meta 页)", dir: join(OC, "wiki") });
  const memos = await scanCorpus({ label: "memos(备忘录库)", dir: join(OC, "use guide") });

  const wikiIndex = await scanIndex({ label: "wiki-rag-index", path: join(OC, "control-plane", "wiki-rag-index.json"), force: args.forceIndex });
  const memosIndex = await scanIndex({ label: "kb-memos-index", path: join(OC, "control-plane", "kb-memos-index.json"), force: args.forceIndex });

  const budgets = [wiki, memos].filter((c) => c.available).map((c) => ({
    label: c.label,
    tokens: estimateTokenRange(c.counts),
    verdict: budgetVerdict({ tokens: estimateTokenRange(c.counts), window: args.window, baselineTokens: args.baselineTokens }),
  }));

  if (args.json) {
    console.log(JSON.stringify({ corpora: { wiki, wikiAll, memos }, indexes: { wikiIndex, memosIndex }, budgets, args }, null, 2));
    return;
  }

  console.log("== 语料体量 ==");
  printCorpus(wiki);
  printCorpus(wikiAll);
  printCorpus(memos);

  console.log("\n== 索引侧(切分后的实际可注入文本) ==");
  printIndex(wikiIndex);
  printIndex(memosIndex);

  console.log(`\n== 预算判断 (窗口 ${formatInt(args.window)} token,prompt 基线假设 ${formatInt(args.baselineTokens)} token) ==`);
  for (const b of budgets) {
    const v = b.verdict;
    const flag = v.fits ? "放得下" : "放不下";
    console.log(`  ${b.label}`);
    console.log(`    整库 ${formatInt(b.tokens.mid)} token(中位档) + 基线 ${formatInt(v.baselineTokens)} = ${formatInt(v.totalMid)}`);
    console.log(`    占窗口 ${v.utilizationMid}%(中位档)/ ${v.utilizationHigh}%(保守档)→ ${flag},保守档余量 ${formatInt(v.headroomHigh)} token`);
  }

  if (wikiIndex.available) {
    console.log(`\n== 每次调用的差账(wiki,中位档,prompt 基线 ${formatInt(args.baselineTokens)} token) ==`);
    printGroundingScenarios(wikiIndex, args.baselineTokens);
  }

  console.log("\n提示:token 为字符分类加权估算(见文件头)。把估算换成实测的两条路 ——");
  console.log("  ① Moonshot /v1/tokenizers/estimate-token-count(只计数,不推理);");
  console.log("  ② 读任意一次真实调用回包的 usage.prompt_tokens。");
  console.log("详细账与结论见 docs/rag-longcontext-vs-retrieval.md");
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
