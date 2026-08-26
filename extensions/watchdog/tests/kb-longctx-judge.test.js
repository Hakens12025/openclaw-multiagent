/**
 * kb-longctx-judge.test.js — 长上下文探针的**判据链**单测:parseAnswer → scoreAnswer →
 * aggregateArm → pairArms → renderScoreReport,期望值全部手算硬编码。
 *
 * 与 kb-longctx-probe.test.js 的分工:那边钉装配口径(材料/prompt/盲评/CLI/e2e),
 * 这边钉判据本身 —— 尤其是畸形输出的解析行为、失败请求在聚合与配对里的记账方式、
 * 以及判据的诚实边界(子串匹配的已知误差、报告必须指向"测不到什么"的说明)。
 * 零网络、零 ollama、零索引读取:全部纯函数。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseAnswer,
  scoreAnswer,
  aggregateArm,
  pairArms,
  renderScoreReport,
  parseArgs,
} from "../scripts/kb-longctx-probe.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "kb-longctx-probe.js");

// ── parseAnswer:畸形但常见的模型输出 ────────────────────────────────────────

test("parseAnswer:CRLF 换行与全角冒号都按守格式解析(kimi 系模型两种都出现过)", () => {
  const crlf = parseAnswer("ANSWER: 甲\r\nSOURCES: wiki/a.md");
  assert.equal(crlf.body, "甲");
  assert.deepEqual(crlf.citations, ["wiki/a.md"]);
  assert.equal(crlf.formatCompliant, true);

  const fullwidth = parseAnswer("ANSWER: 乙\nSOURCES: wiki/b.md");
  assert.equal(fullwidth.body, "乙");
  assert.deepEqual(fullwidth.citations, ["wiki/b.md"]);
  assert.equal(fullwidth.formatCompliant, true);
});

test("parseAnswer:标签大小写不敏感;只有 SOURCES 没有 ANSWER 记不守格式但引用照常取", () => {
  const lower = parseAnswer("answer: 丙\nsources: wiki/c.md");
  assert.equal(lower.formatCompliant, true);
  assert.deepEqual(lower.citations, ["wiki/c.md"]);

  const sourcesOnly = parseAnswer("正文没有标签。\nSOURCES: wiki/d.md");
  assert.equal(sourcesOnly.formatCompliant, false);
  assert.equal(sourcesOnly.body, "正文没有标签。");
  assert.deepEqual(sourcesOnly.declaredSources, ["wiki/d.md"]);
});

test("parseAnswer:INSUFFICIENT 判定大小写不敏感且只认开头(正文中途提到不算)", () => {
  assert.equal(parseAnswer("ANSWER: insufficient 缺窗口大小。\nSOURCES: NONE").insufficient, true);
  assert.equal(parseAnswer("ANSWER: 材料并非 INSUFFICIENT。\nSOURCES: NONE").insufficient, false);
});

test("parseAnswer:路径正则吃连字符/下划线/多级目录,SOURCES 行之后的行归不进正文", () => {
  const p = parseAnswer("ANSWER: 丁\nSOURCES: wiki/concepts/agent-group_v2.md\n附言:这行在 SOURCES 之后。");
  assert.deepEqual(p.citations, ["wiki/concepts/agent-group_v2.md"]);
  assert.equal(p.body, "丁");
});

// ── scoreAnswer:整对象硬编码(经真实 parseAnswer 链,非手捏 parsed)────────────

test("scoreAnswer:全字段手算对照(gold 排第二、2/4 关键词、一条编造出处)", () => {
  const parsed = parseAnswer("ANSWER: inbox outbox\nSOURCES: wiki/b.md, wiki/gold.md");
  const s = scoreAnswer({
    parsed,
    expectedSourcePath: "wiki/gold.md",
    expectedKeywords: ["inbox", "outbox", "graph", "派工"],
    knownPaths: new Set(["wiki/gold.md"]),
  });
  assert.deepEqual(s, {
    goldRank: 1,
    goldCited: true,
    citedCount: 2,
    unknownCitations: ["wiki/b.md"],
    keywordTotal: 4,
    keywordHits: 2,
    keywordCoverage: 0.5,
    insufficient: false,
    formatCompliant: true,
    answerChars: 12, // "inbox outbox"
  });
});

test("scoreAnswer:关键词是小写子串匹配 —— 'box' 会命中 'inbox',这是判据的已知边界", () => {
  const parsed = parseAnswer("ANSWER: 只提了 inbox。\nSOURCES: wiki/gold.md");
  const s = scoreAnswer({ parsed, expectedSourcePath: "wiki/gold.md", expectedKeywords: ["box"] });
  assert.equal(s.keywordHits, 1, "子串口径与 wiki-rag-eval.js 一致;读覆盖率时须记住它偏宽");
});

// ── aggregateArm:失败请求单独计 errors,各率的分母只含成功例 ──────────────────

const wrap = (text, { expected, keywords, usage = null, wallClockMs = null }) => {
  const parsed = parseAnswer(text);
  return {
    error: null,
    usage,
    wallClockMs,
    score: scoreAnswer({ parsed, expectedSourcePath: expected, expectedKeywords: keywords, knownPaths: new Set(["wiki/gold.md"]) }),
  };
};

test("aggregateArm:三行(两成功一失败)的聚合全字段手算对照", () => {
  const rows = [
    wrap("ANSWER: 传送带用 inbox 与 outbox。\nSOURCES: wiki/gold.md", {
      expected: "wiki/gold.md", keywords: ["inbox", "outbox"], usage: { prompt_tokens: 21000 }, wallClockMs: 1000,
    }),
    wrap("见 wiki/gold.md 与 wiki/fake.md。", {
      expected: "wiki/other.md", keywords: ["派工"], wallClockMs: 3000,
    }),
    { error: "http 429" }, // 请求没成功 ≠ 模型答错:只进 errors,进不了任何率的分母
  ];
  assert.deepEqual(aggregateArm(rows), {
    n: 3,
    errors: 1,
    goldCitedRate: 0.5,
    goldCitedAt1Rate: 0.5,
    citationMrr: 0.5,
    meanCitedCount: 1.5,
    unknownCitationRate: 0.5, // wiki/fake.md 不在索引
    keywordCoverage: 0.5, // (1 + 0) / 2
    insufficientRate: 0,
    formatCompliantRate: 0.5, // 第二行没守标签,但引用回退照常计分
    meanAnswerChars: 25, // (20 + 30) / 2
    meanPromptTokens: 21000, // usage 缺失的行不稀释均值
    meanWallClockMs: 2000,
  });
});

// ── pairArms:一边失败的例子配不成对,统计只吃两边都成功的 ───────────────────────

test("pairArms:n 只算双成功例;MRR/关键词差值手算对照;n=2 时 Wilcoxon 精确 p=1", () => {
  const armRow = (goldRank, keywordCoverage, error = null) => ({ error, score: { goldRank, keywordCoverage } });
  const cases = [
    { arms: { base: armRow(0, 1), variant: armRow(-1, 0.5) } },
    { arms: { base: armRow(1, 0.5), variant: armRow(0, 1) } },
    { arms: { base: armRow(0, 1), variant: armRow(0, 1, "timeout") } }, // 变体臂失败 → 整例出局
  ];
  const p = pairArms(cases, "base", "variant");
  assert.equal(p.vs, "base");
  assert.equal(p.n, 2, "第三例一边失败,强行计入等于拿空答案当答错");
  assert.equal(p.citation.mrrBefore, 0.75); // (1 + 1/2) / 2
  assert.equal(p.citation.mrrAfter, 0.5); // (0 + 1) / 2
  assert.equal(p.citation.deltaMrr, -0.25);
  assert.equal(p.citation.wilcoxon.p, 1);
  assert.equal(p.keyword.n, 2);
  assert.equal(p.keyword.mean, 0); // [-0.5, +0.5]
});

// ── renderScoreReport + 诚实边界 ────────────────────────────────────────────

test("renderScoreReport:标题行硬编码;|Δ|<MDE 时必须把「测不出」和「没差别」分开说", () => {
  const armRow = (goldRank, keywordCoverage) => ({
    error: null,
    usage: null,
    wallClockMs: null,
    score: {
      goldRank, goldCited: goldRank >= 0, citedCount: 1, unknownCitations: [],
      keywordCoverage, insufficient: false, formatCompliant: true, answerChars: 50,
    },
  });
  const cases = [
    { arms: { base: armRow(0, 1), variant: armRow(-1, 0.5) } },
    { arms: { base: armRow(1, 0.5), variant: armRow(0, 1) } },
  ];
  const aggregate = {
    base: aggregateArm(cases.map((c) => c.arms.base)),
    variant: aggregateArm(cases.map((c) => c.arms.variant)),
  };
  const paired = { variant: pairArms(cases, "base", "variant") };
  const text = renderScoreReport({ caseCount: 2, base: "base", armIds: ["base", "variant"], aggregate, paired });
  assert.equal(text.split("\n")[0], "# wiki 长上下文对照 | 2 题 | 基线臂 base");
  assert.ok(Math.abs(paired.variant.citation.deltaMrr) < paired.variant.citation.mde.mde, "前提:这批样本的效应确实小于 MDE");
  assert.match(text, /测不出/);
  assert.match(text, /测不到什么/, "报告尾部必须把读者指向判据边界说明");
});

test("诚实边界:脚本文件头逐条写明两个判据测不到什么(正确性/跨页综合/单 gold/覆盖率偏长)", async () => {
  const src = await readFile(SCRIPT, "utf8");
  for (const marker of ["测不到", "正确性", "跨页综合", "单 gold", "偏向长材料"]) {
    assert.ok(src.includes(marker), `文件头缺判据边界说明:${marker}`);
  }
});

// ── parseArgs:默认值整对象快照 = 「默认行为与既有版本等价」的硬编码证明 ─────────

test("parseArgs:默认值快照(既有键逐字节不变;新增 sleepMs 只作用于 run 限速)", () => {
  const { out, ...rest } = parseArgs([]);
  assert.deepEqual(rest, {
    cmd: "dry",
    arms: ["retrieval4", "retrieval12", "fullwiki"],
    endpoint: null,
    model: null,
    apiKeyEnv: "KB_PROBE_API_KEY",
    cases: 0,
    seed: 20260811,
    maxTokens: 1024,
    timeoutMs: 180000,
    sleepMs: 1000,
    allowStaleCache: false,
    force: false,
  });
  assert.ok(out.endsWith(join("research-lab", "kb-longctx-probe")));
});

test("parseArgs:--sleep-ms 接受 0(关限速),非法值保持默认而非静默变成 0", () => {
  assert.equal(parseArgs(["--sleep-ms", "0"]).sleepMs, 0);
  assert.equal(parseArgs(["--sleep-ms", "2500"]).sleepMs, 2500);
  assert.equal(parseArgs(["--sleep-ms", "abc"]).sleepMs, 1000);
  assert.equal(parseArgs(["--sleep-ms", "-5"]).sleepMs, 1000);
});
