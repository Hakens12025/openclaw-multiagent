/**
 * kb-longctx-probe.test.js — 把长上下文对照实验台的装配口径与判据口径钉死。
 *
 * 为什么用**硬编码期望值**:这份实验的每个结论都挂在「两条臂只差材料、其余逐字相同」上。
 * 若断言写成"拿一次调用比另一次调用",两条路一起改坏时它恒真、什么都挡不住。所以下面每个
 * 期望值都是手写出来的字面量:prompt 骨架、材料排版、引用名次、关键词覆盖、盲评洗牌结果。
 *
 * 另有一组**源码漂移守卫**:控制臂声称等于「今天的生产值」,这个声称由三处生产字面量支撑
 * (topK=4、摘录 500 字、宽集 max(topK*4,20))。生产改了而这里没跟,守卫直接红。
 *
 * 零网络、零 ollama、零 LLM:被测的全是纯函数与一次 --arms fullwiki 的本地装配。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ARMS,
  PROBE_SYSTEM_PROMPT,
  WIKI_PATH_RE,
  renderMaterial,
  toGroundingNotes,
  notesToBlocks,
  chunksToBlocks,
  buildUserPrompt,
  parseAnswer,
  scoreAnswer,
  blindOrder,
  tokenEstimate,
  cacheStalenessMessage,
  parseArgs,
} from "../scripts/kb-longctx-probe.js";
import { loadKnowledgeBaseIndex } from "../lib/knowledge/knowledge-base.js";
import { searchWikiRagLexical } from "../lib/knowledge/wiki-rag-store.js";
import { rrfFuse } from "../lib/knowledge/wiki-rag-search.js";
import { evaluateWikiRagRecall } from "../lib/knowledge/wiki-rag-eval.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "kb-longctx-probe.js");

// ── 材料装配 ────────────────────────────────────────────────────────────────

test("renderMaterial:页头 ### 路径、段头 ## 标题、块间 --- 分隔(两条臂共用这一套排版)", () => {
  const out = renderMaterial([
    { sourcePath: "wiki/concepts/a.md", sections: [{ heading: "标题一", text: "正文一" }, { heading: "", text: "无标题正文" }] },
    { sourcePath: "wiki/decisions/b.md", sections: [{ heading: "标题二", text: "正文二" }] },
  ]);
  assert.equal(out, [
    "### wiki/concepts/a.md",
    "## 标题一",
    "正文一",
    "",
    "无标题正文",
    "",
    "---",
    "",
    "### wiki/decisions/b.md",
    "## 标题二",
    "正文二",
  ].join("\n"));
});

test("renderMaterial:空段被丢弃,不产出空的 ## 头", () => {
  assert.equal(
    renderMaterial([{ sourcePath: "wiki/x.md", sections: [{ heading: "", text: "  " }, { heading: "有", text: "料" }] }]),
    "### wiki/x.md\n## 有\n料",
  );
});

test("toGroundingNotes:摘录截断上限 = 生产的 500 字;title 依次回退 heading → sourcePath → wiki", () => {
  const long = "字".repeat(700);
  const [a, b, c] = toGroundingNotes([
    { heading: "传送带", sourcePath: "wiki/concepts/conveyor-belt.md", text: long },
    { heading: "  ", sourcePath: "wiki/concepts/loop.md", text: "短文" },
    { heading: null, sourcePath: null, text: "无出处" },
  ]);
  assert.equal(a.excerpt.length, 500);
  assert.equal(a.excerpt, "字".repeat(500));
  assert.equal(a.title, "传送带");
  assert.equal(b.title, "wiki/concepts/loop.md");
  assert.equal(c.title, "wiki");
  assert.equal(c.sourcePath, null);
});

test("toGroundingNotes:excerptCap 可调(便宜臂 1200),缺 text 给空串而不是抛错", () => {
  const [note] = toGroundingNotes([{ heading: "h", sourcePath: "wiki/x.md", text: "字".repeat(1500) }], { excerptCap: 1200 });
  assert.equal(note.excerpt.length, 1200);
  const [empty] = toGroundingNotes([{ heading: "h", sourcePath: "wiki/x.md" }]);
  assert.equal(empty.excerpt, "");
});

test("notesToBlocks:同一页被召回两段 → 两个块(dupSlot 现象在材料里保持可见)", () => {
  const blocks = notesToBlocks([
    { sourcePath: "wiki/x.md", title: "段一", excerpt: "A" },
    { sourcePath: "wiki/x.md", title: "段二", excerpt: "B" },
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { sourcePath: "wiki/x.md", sections: [{ heading: "段一", text: "A" }] });
});

test("chunksToBlocks:按 sourcePath 首次出现顺序分组、页内保序、丢弃无 sourcePath 的块", () => {
  const blocks = chunksToBlocks([
    { sourcePath: "wiki/b.md", heading: "b1", text: "B1" },
    { sourcePath: "wiki/a.md", heading: "a1", text: "A1" },
    { sourcePath: "wiki/b.md", heading: "b2", text: "B2" },
    { heading: "孤儿", text: "无出处" },
  ]);
  assert.deepEqual(blocks, [
    { sourcePath: "wiki/b.md", sections: [{ heading: "b1", text: "B1" }, { heading: "b2", text: "B2" }] },
    { sourcePath: "wiki/a.md", sections: [{ heading: "a1", text: "A1" }] },
  ]);
});

// ── prompt ─────────────────────────────────────────────────────────────────

test("buildUserPrompt:材料在前、问题在后(稳定前缀靠前是 prompt caching 的前提)", () => {
  assert.equal(
    buildUserPrompt({ material: "M", question: "  Q?  " }),
    "<材料>\nM\n</材料>\n\n<问题>\nQ?\n</问题>",
  );
});

test("system prompt:正向文案 + 固定两段输出契约(判据全靠 SOURCES 段可解析)", () => {
  assert.ok(PROBE_SYSTEM_PROMPT.includes("ANSWER:"));
  assert.ok(PROBE_SYSTEM_PROMPT.includes("SOURCES:"));
  assert.ok(PROBE_SYSTEM_PROMPT.includes("最多 3 条"), "限 3 条是抗散弹的前提:多列来源无法提高引用名次");
  for (const banned of ["不要", "禁止", "Do not", "Never"]) {
    assert.ok(!PROBE_SYSTEM_PROMPT.includes(banned), `正向文案:出现了 ${banned}`);
  }
});

// ── 答案解析 ────────────────────────────────────────────────────────────────

test("parseAnswer:守格式的回答 → 正文剥掉 ANSWER:、SOURCES 按声明序去重", () => {
  const p = parseAnswer([
    "ANSWER: 传送带是唯一的 transport 原语。",
    "它只做 inbox/outbox。",
    "SOURCES: wiki/concepts/conveyor-belt.md, wiki/concepts/loop.md, wiki/concepts/conveyor-belt.md",
  ].join("\n"));
  assert.equal(p.body, "传送带是唯一的 transport 原语。\n它只做 inbox/outbox。");
  assert.deepEqual(p.citations, ["wiki/concepts/conveyor-belt.md", "wiki/concepts/loop.md"]);
  assert.deepEqual(p.declaredSources, p.citations);
  assert.equal(p.formatCompliant, true);
  assert.equal(p.insufficient, false);
});

test("parseAnswer:没守格式时回退到全文里的 wiki 路径,formatCompliant 单独记 false", () => {
  const p = parseAnswer("按 wiki/concepts/loop.md 的说法,loop 是重复派工。另见 wiki/concepts/conveyor-belt.md。");
  assert.deepEqual(p.citations, ["wiki/concepts/loop.md", "wiki/concepts/conveyor-belt.md"]);
  assert.deepEqual(p.declaredSources, []);
  assert.equal(p.formatCompliant, false);
});

test("parseAnswer:SOURCES 写 NONE + ANSWER 以 INSUFFICIENT 开头 → 零引用、insufficient=true", () => {
  const p = parseAnswer("ANSWER: INSUFFICIENT 材料里没有窗口大小。\nSOURCES: NONE");
  assert.deepEqual(p.citations, []);
  assert.equal(p.insufficient, true);
  assert.equal(p.formatCompliant, true);
  assert.equal(p.body, "INSUFFICIENT 材料里没有窗口大小。");
});

test("parseAnswer:空输入不抛错", () => {
  assert.deepEqual(parseAnswer("").citations, []);
  assert.deepEqual(parseAnswer(null).body, "");
});

test("WIKI_PATH_RE:全局正则被反复 match 不串 lastIndex", () => {
  const text = "wiki/a.md 与 wiki/b.md";
  assert.deepEqual(text.match(WIKI_PATH_RE), ["wiki/a.md", "wiki/b.md"]);
  assert.deepEqual(text.match(WIKI_PATH_RE), ["wiki/a.md", "wiki/b.md"]);
});

// ── 判据 ────────────────────────────────────────────────────────────────────

test("scoreAnswer:goldRank 是 0-indexed 的引用名次,-1=未引用(与 wiki-rag-eval 的 rank 口径同)", () => {
  const parsed = parseAnswer("ANSWER: 见下。\nSOURCES: wiki/a.md, wiki/gold.md");
  const hit = scoreAnswer({ parsed, expectedSourcePath: "wiki/gold.md", expectedKeywords: [] });
  assert.equal(hit.goldRank, 1);
  assert.equal(hit.goldCited, true);
  assert.equal(hit.citedCount, 2);
  const miss = scoreAnswer({ parsed, expectedSourcePath: "wiki/other.md", expectedKeywords: [] });
  assert.equal(miss.goldRank, -1);
  assert.equal(miss.goldCited, false);
});

test("scoreAnswer:散弹式多引用无法提高名次 —— 把 gold 排到第 3 就是 rank2", () => {
  const shotgun = parseAnswer("ANSWER: x\nSOURCES: wiki/p.md, wiki/q.md, wiki/gold.md");
  assert.equal(scoreAnswer({ parsed: shotgun, expectedSourcePath: "wiki/gold.md" }).goldRank, 2);
  const focused = parseAnswer("ANSWER: x\nSOURCES: wiki/gold.md");
  assert.equal(scoreAnswer({ parsed: focused, expectedSourcePath: "wiki/gold.md" }).goldRank, 0);
});

test("scoreAnswer:关键词覆盖按小写子串算,只看正文(与 wiki-rag-eval.js:42 同口径,haystack 不同)", () => {
  const parsed = parseAnswer("ANSWER: 平台用 INBOX 与 outbox 搬运。\nSOURCES: wiki/gold.md");
  const s = scoreAnswer({ parsed, expectedSourcePath: "wiki/gold.md", expectedKeywords: ["inbox", "outbox", "派工"] });
  assert.equal(s.keywordTotal, 3);
  assert.equal(s.keywordHits, 2);
  assert.equal(s.keywordCoverage, 2 / 3);
  // SOURCES 行里的词不算进正文覆盖率(否则「抄路径」也能刷分)
  const noKeywords = scoreAnswer({ parsed, expectedSourcePath: "wiki/gold.md", expectedKeywords: [] });
  assert.equal(noKeywords.keywordCoverage, null);
});

test("scoreAnswer:引用了索引外的路径 = 编造出处;不给 knownPaths 时不做该判定", () => {
  const parsed = parseAnswer("ANSWER: x\nSOURCES: wiki/real.md, wiki/made-up.md");
  const known = new Set(["wiki/real.md"]);
  assert.deepEqual(scoreAnswer({ parsed, expectedSourcePath: "wiki/real.md", knownPaths: known }).unknownCitations, ["wiki/made-up.md"]);
  assert.deepEqual(scoreAnswer({ parsed, expectedSourcePath: "wiki/real.md" }).unknownCitations, []);
});

// ── 盲评洗牌 ────────────────────────────────────────────────────────────────

test("blindOrder:同 seed 同结果、始终是一个置换、不同题会换序", () => {
  const arms = ["retrieval4", "retrieval12", "fullwiki"];
  assert.deepEqual(blindOrder(arms, 0, 20260811), blindOrder(arms, 0, 20260811));
  // 期望值由同一套 32 位整数算术在 Python 里独立复算得出(全程 Math.imul,不依赖浮点舍入)。
  assert.deepEqual(blindOrder(arms, 0, 20260811), ["retrieval4", "fullwiki", "retrieval12"]);
  assert.deepEqual(blindOrder(arms, 1, 20260811), ["retrieval12", "fullwiki", "retrieval4"]);
  assert.deepEqual(blindOrder(arms, 3, 20260811), ["retrieval12", "retrieval4", "fullwiki"]);
  assert.deepEqual(blindOrder(arms, 0, 7), ["fullwiki", "retrieval12", "retrieval4"]);
  for (let i = 0; i < 24; i += 1) {
    assert.deepEqual([...blindOrder(arms, i, 20260811)].sort(), [...arms].sort(), `第 ${i} 题不是置换`);
  }
  assert.notDeepEqual(blindOrder(arms, 0, 20260811), blindOrder(arms, 0, 7));
});

// ── token 估算 / 缓存守卫 / CLI ────────────────────────────────────────────

test("tokenEstimate:沿用 kb-token-budget 的口径(3 个汉字 → low 2 / mid 2 / high 3)", () => {
  assert.deepEqual(tokenEstimate("传送带"), { low: 2, mid: 2, high: 3 });
});

test("cacheStalenessMessage:块数一致=新鲜(null);不一致给出可执行的补救命令", () => {
  assert.equal(cacheStalenessMessage({ cacheChunkCount: 453, indexChunkCount: 453 }), null);
  const msg = cacheStalenessMessage({ cacheChunkCount: 452, indexChunkCount: 453, kbId: "wiki" });
  assert.match(msg, /缓存对应 452 块,当前索引 453 块/);
  assert.match(msg, /node scripts\/kb-replay\.js capture wiki/);
  assert.match(msg, /--allow-stale-cache/);
});

test("parseArgs:默认 dry、三臂、生产臂的 topK/cap 就是生产值", () => {
  const a = parseArgs([]);
  assert.equal(a.cmd, "dry");
  assert.deepEqual(a.arms, ["retrieval4", "retrieval12", "fullwiki"]);
  assert.equal(a.apiKeyEnv, "KB_PROBE_API_KEY");
  assert.equal(a.endpoint, null);
  assert.equal(a.seed, 20260811);
  assert.equal(ARMS.retrieval4.topK, 4);
  assert.equal(ARMS.retrieval4.excerptCap, 500);
  assert.equal(ARMS.retrieval12.topK, 12);
  assert.equal(ARMS.retrieval12.excerptCap, 1200);
  assert.equal(ARMS.fullwiki.kind, "full");
});

test("parseArgs:命令与参数解析,未知臂/未知命令/未知参数一律抛错(避免静默跑错实验)", () => {
  const a = parseArgs(["run", "--arms", "retrieval4,fullwiki", "--endpoint", "https://x/v1", "--model", "m", "--cases", "3"]);
  assert.equal(a.cmd, "run");
  assert.deepEqual(a.arms, ["retrieval4", "fullwiki"]);
  assert.equal(a.endpoint, "https://x/v1");
  assert.equal(a.cases, 3);
  assert.throws(() => parseArgs(["--arms", "topk99"]), /未知臂/);
  assert.throws(() => parseArgs(["fly"]), /未知命令/);
  assert.throws(() => parseArgs(["--nope"]), /未知参数/);
});

// ── 源码漂移守卫:控制臂 = 今天的生产值,这个声称必须有支撑 ─────────────────────

test("漂移守卫:生产的 grounding 常数仍是 topK=4 / 摘录 500 字 / 宽集 max(topK*4,20)", async () => {
  const knowledge = await readFile(join(ROOT, "lib", "operator", "operator-knowledge.js"), "utf8");
  assert.ok(knowledge.includes("retrieveGroundingNotes(requestText, 4"), "operator 预注入条数已不是 4,retrieval4 臂不再等于生产值");
  assert.ok(knowledge.includes("normalizeString(r.text).slice(0, 500)"), "grounding 摘录截断已不是 500 字");
  const search = await readFile(join(ROOT, "lib", "knowledge", "wiki-rag-search.js"), "utf8");
  assert.ok(search.includes("Math.max(topK * 4, 20)"), "hybrid 宽集口径已变,重放的 top-k 不再等于生产");
  assert.ok(search.includes("rrfFuse([vector, lexical]"), "融合顺序已变,重放次序不再等于生产");
});

// ── 控制臂 = 生产值:接上真索引 + 真评测器复算召回 ────────────────────────────
// 缓存缺失/陈旧时跳过(它是本地产物,且陈旧缓存重放的是旧世界)。断言用宽带而非死数字:
// wiki 每次 Ingest 都会动语料,把 0.8090 钉死等于给自己埋雷。逐位吻合的实测记录写在
// scripts/kb-longctx-probe.js 文件头(2026-08-11:r@1 70.8 / r@3 91.7 / r@5 95.8 / MRR 0.8090,
// 与 live 召回评测一致)—— 这里守的是「重放没崩」这条底线。
test("控制臂重放接上 evaluateWikiRagRecall 后召回落在生产量级(需新鲜的向量腿缓存)", async (t) => {
  const index = await loadKnowledgeBaseIndex("wiki");
  const cache = JSON.parse(await readFile(join(ROOT, ".replay-cache", "wiki.json"), "utf8").catch(() => "null"));
  if (!cache) return t.skip("无向量腿缓存:node scripts/kb-replay.js capture wiki(需 ollama)");
  const stale = cacheStalenessMessage({ cacheChunkCount: cache.chunkCount, indexChunkCount: index.chunks.length });
  if (stale) return t.skip(stale);

  const fixture = JSON.parse(await readFile(join(ROOT, "tests", "fixtures", "wiki-rag-eval-set.json"), "utf8"));
  const result = await evaluateWikiRagRecall(fixture.cases, async (query, { topK }) => {
    const entry = cache.entries.find((e) => e.query === query);
    const wide = Math.max(topK * 4, 20);
    const lexical = await searchWikiRagLexical(entry.rewritten, { topK: wide, index });
    return { ok: true, results: rrfFuse([entry.vector.slice(0, wide), lexical], { topK: wide }).slice(0, topK) };
  }, { topK: 10 });
  assert.ok(result.recallAt[3] >= 0.8, `r@3=${result.recallAt[3]} 掉出生产量级,重放多半坏了`);
  assert.ok(result.mrr >= 0.7, `MRR=${result.mrr} 掉出生产量级,重放多半坏了`);
});

// ── 端到端:fullwiki 臂本地装配(零网络、零 ollama、无需向量腿缓存)────────────

test("dry --arms fullwiki:真装配整库材料,token 表落盘且量级与那笔账吻合", async () => {
  const out = await mkdtemp(join(tmpdir(), "kb-longctx-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "dry", "--arms", "fullwiki", "--cases", "2", "--out", out], { maxBuffer: 64 * 1024 * 1024 });
    assert.match(stdout, /dry-run/);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.cases.length, 2);
    assert.deepEqual(manifest.arms.map((a) => a.id), ["fullwiki"]);
    // 全塞材料是跨题常量 —— 这正是它可做缓存前缀的原因(docs §3.3)。
    assert.equal(manifest.cases[0].perArm.fullwiki.materialChars, manifest.cases[1].perArm.fullwiki.materialChars);
    // 那笔账的量级:整库 chunk 文本约 10 万字、约 4 万 token 中位档。留宽区间只挡数量级错误。
    assert.ok(manifest.fullMaterialChars > 90000 && manifest.fullMaterialChars < 200000, `整库材料 ${manifest.fullMaterialChars} 字,越出量级`);
    const mid = manifest.cases[0].perArm.fullwiki.promptTokensEstimate.mid;
    assert.ok(mid > 30000 && mid < 90000, `全塞 prompt 中位档 ${mid} token,越出量级`);
    // 可引用路径数 = 材料里出现的 wiki 页数(今天 61 页,随 Ingest 增长,故只守量级)。
    // 与检索臂的 ≤4 条形成对照 —— 「引用命中」这个判据在两臂手里的候选面完全不同,读结论时须记住。
    assert.ok(manifest.cases[0].perArm.fullwiki.citablePaths >= 50, `可引用路径 ${manifest.cases[0].perArm.fullwiki.citablePaths} 条,少于量级下限`);
    const sample = await readFile(join(out, "sample-fullwiki.txt"), "utf8");
    assert.ok(sample.startsWith("[system]\n"));
    assert.ok(sample.includes("<材料>") && sample.includes("<问题>"));
    assert.ok(sample.indexOf("<材料>") < sample.indexOf("<问题>"), "材料必须在问题之前");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

// score 是产出结论的那一步。用**手工编造的答案**跑通它,期望值全部手算 —— 这样它的错会在
// 花掉任何 API 额度之前暴露,而不是在读结论时。
test("score:聚合与配对统计全部对得上手算值,且 compare.md 不泄露臂名", async () => {
  const out = await mkdtemp(join(tmpdir(), "kb-longctx-score-"));
  try {
    await mkdir(join(out, "answers"), { recursive: true });
    const write = async (caseId, arm, expected, keywords, text) => writeFile(
      join(out, "answers", `${caseId}.${arm}.json`),
      JSON.stringify({ caseId, arm, query: `${caseId} 问题`, expectedSourcePath: expected, expectedKeywords: keywords, text, usage: { prompt_tokens: 100 }, wallClockMs: 10, error: null }),
      "utf8",
    );
    const GOLD1 = "wiki/concepts/conveyor-belt.md";
    const GOLD2 = "wiki/concepts/loop.md";
    await write("case-01", "retrieval4", GOLD1, ["inbox", "outbox"], "ANSWER: 用 inbox 搬运。\nSOURCES: wiki/concepts/loop.md");
    await write("case-01", "fullwiki", GOLD1, ["inbox", "outbox"], `ANSWER: 用 inbox 与 outbox 搬运。\nSOURCES: ${GOLD1}`);
    await write("case-02", "retrieval4", GOLD2, ["LoopSpec"], `ANSWER: 见 LoopSpec。\nSOURCES: ${GOLD2}`);
    await write("case-02", "fullwiki", GOLD2, ["LoopSpec"], `ANSWER: 见 LoopSpec。\nSOURCES: wiki/does-not-exist.md, ${GOLD2}`);

    await execFileAsync(process.execPath, [SCRIPT, "score", "--arms", "retrieval4,fullwiki", "--out", out], { maxBuffer: 64 * 1024 * 1024 });
    const s = JSON.parse(await readFile(join(out, "scores.json"), "utf8"));

    assert.equal(s.base, "retrieval4");
    // 基线臂:case-01 未引对(rank -1)、case-02 引对且排第一(rank 0)
    assert.deepEqual(
      { cited: s.aggregate.retrieval4.goldCitedRate, at1: s.aggregate.retrieval4.goldCitedAt1Rate, mrr: s.aggregate.retrieval4.citationMrr },
      { cited: 0.5, at1: 0.5, mrr: 0.5 },
    );
    assert.equal(s.aggregate.retrieval4.keywordCoverage, 0.75); // (1/2 + 1/1) / 2
    assert.equal(s.aggregate.retrieval4.unknownCitationRate, 0);
    // 全塞臂:两题都引对,但 case-02 把 gold 排在第二 → MRR (1 + 0.5)/2
    assert.deepEqual(
      { cited: s.aggregate.fullwiki.goldCitedRate, at1: s.aggregate.fullwiki.goldCitedAt1Rate, mrr: s.aggregate.fullwiki.citationMrr },
      { cited: 1, at1: 0.5, mrr: 0.75 },
    );
    assert.equal(s.aggregate.fullwiki.keywordCoverage, 1);
    assert.equal(s.aggregate.fullwiki.meanCitedCount, 1.5);
    assert.equal(s.aggregate.fullwiki.unknownCitationRate, 0.5, "wiki/does-not-exist.md 不在索引里 = 编造出处");
    assert.equal(s.aggregate.fullwiki.formatCompliantRate, 1);
    assert.equal(s.aggregate.fullwiki.meanPromptTokens, 100);

    // 配对:ΔRR = [+1, -0.5] → ΔMRR = +0.25;n=2 时 Wilcoxon 精确双侧 p 恰为 1
    const p = s.paired.fullwiki;
    assert.equal(p.vs, "retrieval4");
    assert.equal(p.n, 2);
    assert.equal(p.citation.mrrBefore, 0.5);
    assert.equal(p.citation.mrrAfter, 0.75);
    assert.equal(p.citation.deltaMrr, 0.25);
    assert.equal(p.citation.wilcoxon.p, 1);
    assert.equal(p.keyword.mean, 0.25); // [0.5, 0]
    // 效应小于 MDE 时,报告必须把「测不出」和「没差别」分开说
    assert.ok(Math.abs(p.citation.deltaMrr) < p.citation.mde.mde);
    assert.match(await readFile(join(out, "scores.txt"), "utf8"), /测不出/);

    const compare = await readFile(join(out, "compare.md"), "utf8");
    for (const armId of ["retrieval4", "fullwiki"]) {
      assert.ok(!compare.includes(armId), `compare.md 泄露了臂名 ${armId},盲评就不盲了`);
    }
    assert.ok(compare.includes("### 甲") && compare.includes("### 乙"));
    const key = JSON.parse(await readFile(join(out, "key.json"), "utf8"));
    assert.deepEqual([...new Set(Object.values(key).flatMap((m) => Object.values(m)))].sort(), ["fullwiki", "retrieval4"]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("run 缺 endpoint/model 或缺 API key 时快速失败,不发任何请求", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT, "run", "--arms", "fullwiki", "--cases", "1"], { env: { ...process.env, KB_PROBE_API_KEY: "" } }),
    (err) => /run 需要 --endpoint 与 --model/.test(String(err.stderr)),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT, "run", "--arms", "fullwiki", "--cases", "1", "--endpoint", "https://example.invalid/v1", "--model", "m"], { env: { ...process.env, KB_PROBE_API_KEY: "" } }),
    (err) => /环境变量 KB_PROBE_API_KEY 为空/.test(String(err.stderr)),
  );
});
