/**
 * kb-token-budget.test.js — 把「wiki 全塞上下文」那份账里的估算口径钉死。
 *
 * 为什么需要这个测试:docs/rag-longcontext-vs-retrieval.md 的每一个结论都挂在几个具体数字上
 * (wiki ≈ 4.96 万 token、memos ≈ 48.4 万 token、单次 grounding ≈ 326 token)。这些数字由
 * scripts/kb-token-budget.js 的纯函数算出。断言用**手算的硬编码期望值**,而不是拿一次调用去比
 * 另一次调用(自比自恒真)—— 常数一旦被改动,文档里的结论会立刻红。
 *
 * 全部零依赖、零网络、零 ollama:被测的是字符分类与加权算术。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CJK_TOKENS_PER_CHAR,
  OTHER_CHARS_PER_TOKEN,
  countCharClasses,
  addCounts,
  emptyCounts,
  estimateTokenRange,
  budgetVerdict,
  groundingPayloadChars,
  scaleCounts,
  round1,
  formatInt,
} from "../scripts/kb-token-budget.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 2026-08-11 实测口径(node scripts/kb-token-budget.js 的输出),文档 §1 引用的就是它们。
const WIKI_COUNTS = { chars: 130223, bytes: 207852, cjk: 34063, other: 96160 };
const MEMOS_COUNTS = { chars: 1364146, bytes: 2016594, cjk: 286758, other: 1077388 };

test("估算常数就是文档写的那三档(改了常数=改了结论,必须显式)", () => {
  assert.deepEqual({ ...CJK_TOKENS_PER_CHAR }, { low: 0.6, mid: 0.75, high: 1.0 });
  assert.deepEqual({ ...OTHER_CHARS_PER_TOKEN }, { low: 4.5, mid: 4.0, high: 3.0 });
});

test("countCharClasses:汉字与其余字符分开计,字节按 UTF-8", () => {
  // "传送带原则"=5 个汉字(各 3 字节) + " conveyor-belt"=14 个 ASCII 字符
  const c = countCharClasses("传送带原则 conveyor-belt");
  assert.equal(c.chars, 19);
  assert.equal(c.cjk, 5);
  assert.equal(c.other, 14);
  assert.equal(c.bytes, 5 * 3 + 14);
  assert.equal(c.cjk + c.other, c.chars); // 分类是完备划分
});

test("countCharClasses:CJK 区间与 wiki-rag-store 的词法分词器同界(U+4E00–U+9FFF)", () => {
  assert.equal(countCharClasses("一").cjk, 1);   // U+4E00 下界
  assert.equal(countCharClasses("鿿").cjk, 1);   // U+9FFF 上界
  assert.equal(countCharClasses("、。").cjk, 0); // 中文标点在区间外,计入 other
  assert.equal(countCharClasses("").chars, 0);
});

test("estimateTokenRange:手算期望值(5 汉字 + 14 其余)", () => {
  // low  = 5×0.6 + 14/4.5 = 3 + 3.111 = 6.111 → 6
  // mid  = 5×0.75 + 14/4  = 3.75 + 3.5 = 7.25 → 7
  // high = 5×1.0 + 14/3   = 5 + 4.667 = 9.667 → 10
  assert.deepEqual(estimateTokenRange({ chars: 19, bytes: 29, cjk: 5, other: 14 }), { low: 6, mid: 7, high: 10 });
});

test("estimateTokenRange:wiki 实测体量 → 文档 §1 引用的 41,807 / 49,587 / 66,116", () => {
  assert.deepEqual(estimateTokenRange(WIKI_COUNTS), { low: 41807, mid: 49587, high: 66116 });
});

test("estimateTokenRange:memos 实测体量 → 文档 §1 引用的 411,474 / 484,416 / 645,887", () => {
  assert.deepEqual(estimateTokenRange(MEMOS_COUNTS), { low: 411474, mid: 484416, high: 645887 });
});

test("estimateTokenRange:三档单调(low ≤ mid ≤ high),空语料为 0", () => {
  const t = estimateTokenRange(WIKI_COUNTS);
  assert.ok(t.low <= t.mid && t.mid <= t.high);
  assert.deepEqual(estimateTokenRange(emptyCounts()), { low: 0, mid: 0, high: 0 });
  assert.deepEqual(estimateTokenRange(null), { low: 0, mid: 0, high: 0 });
});

test("budgetVerdict:wiki 进 256K 窗口 → 放得下,占比与余量为文档 §3 的数", () => {
  const v = budgetVerdict({ tokens: estimateTokenRange(WIKI_COUNTS), window: 262144, baselineTokens: 20000 });
  assert.equal(v.totalMid, 69587);
  assert.equal(v.totalHigh, 86116);
  assert.equal(v.utilizationMid, 26.5);
  assert.equal(v.utilizationHigh, 32.9);
  assert.equal(v.fits, true);
  assert.equal(v.headroomHigh, 176028);
});

test("budgetVerdict:memos 进 256K 窗口 → 放不下(保守档 254%)", () => {
  const v = budgetVerdict({ tokens: estimateTokenRange(MEMOS_COUNTS), window: 262144, baselineTokens: 20000 });
  assert.equal(v.utilizationMid, 192.4);
  assert.equal(v.utilizationHigh, 254);
  assert.equal(v.fits, false);
  assert.ok(v.headroomHigh < 0);
});

test("budgetVerdict:GLM 的 200K 窗口下 wiki 仍放得下,memos 仍放不下", () => {
  const win = 204800;
  assert.equal(budgetVerdict({ tokens: estimateTokenRange(WIKI_COUNTS), window: win, baselineTokens: 20000 }).fits, true);
  assert.equal(budgetVerdict({ tokens: estimateTokenRange(MEMOS_COUNTS), window: win, baselineTokens: 20000 }).fits, false);
});

test("budgetVerdict:fits 用最保守档判定(卡边时按 high 说话)", () => {
  const tokens = { low: 10, mid: 20, high: 100 };
  assert.equal(budgetVerdict({ tokens, window: 100, baselineTokens: 0 }).fits, true);  // 100 ≤ 100
  assert.equal(budgetVerdict({ tokens, window: 99, baselineTokens: 0 }).fits, false);  // high 超一格即判超
});

test("groundingPayloadChars:topK × 平均(min(块长, cap)),截断上限真的生效", () => {
  const lens = [100, 200, 900];
  assert.equal(groundingPayloadChars(lens, { topK: 4, cap: 1200 }), 1600); // cap 不咬合:(100+200+900)/3=400 → ×4
  assert.equal(groundingPayloadChars(lens, { topK: 4, cap: 500 }), 1067);  // 900 被截到 500:266.67 → ×4
  assert.equal(groundingPayloadChars(lens, { topK: 4, cap: 150 }), 533);   // 200/900 都被截:133.33 → ×4
  assert.equal(groundingPayloadChars(lens, { topK: 12, cap: 500 }), 3200); // topK 线性:266.67×12
  assert.equal(groundingPayloadChars([], { topK: 4, cap: 500 }), 0);
  assert.equal(groundingPayloadChars(null, { topK: 4, cap: 500 }), 0);
});

test("addCounts / scaleCounts:聚合与按比例缩放", () => {
  const a = countCharClasses("传送带");
  const b = countCharClasses("belt");
  const sum = addCounts(a, b);
  assert.deepEqual({ chars: sum.chars, cjk: sum.cjk, other: sum.other }, { chars: 7, cjk: 3, other: 4 });
  const half = scaleCounts({ chars: 100, bytes: 200, cjk: 40, other: 60 }, 0.5);
  assert.deepEqual(half, { chars: 50, bytes: 100, cjk: 20, other: 30 });
  assert.deepEqual(scaleCounts({ chars: 100, bytes: 200, cjk: 40, other: 60 }, NaN), { chars: 0, bytes: 0, cjk: 0, other: 0 });
});

test("round1 / formatInt:展示层", () => {
  assert.equal(round1(26.546), 26.5);
  assert.equal(formatInt(1364146), "1,364,146");
  assert.equal(formatInt(326), "326");
});

test("脚本可复跑:--json 退出码 0,语料分类完备", async () => {
  const { stdout } = await execFileAsync(process.execPath, [join(ROOT, "scripts", "kb-token-budget.js"), "--json"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = JSON.parse(stdout);
  assert.equal(out.corpora.wiki.available, true);
  // memos = use guide/ 私有备忘录语料,公开树(CI fresh checkout)天然缺席=无物可数,
  // 相关断言剔除;wiki 语料随仓同步,两态都全力断言。
  const memosAvailable = out.corpora.memos.available === true;
  for (const key of ["wiki", "wikiAll", ...(memosAvailable ? ["memos"] : [])]) {
    const c = out.corpora[key].counts;
    assert.equal(c.cjk + c.other, c.chars, `${key} 的字符分类应为完备划分`);
    assert.ok(c.chars > 0);
  }
  // wiki 检索口径 = 全目录减去 4 个 meta 页(wiki-rag-store.js:71 的 WIKI_META_PAGES)
  assert.equal(out.corpora.wikiAll.fileCount - out.corpora.wiki.fileCount, 4);
  if (memosAvailable) {
    assert.ok(out.corpora.memos.counts.chars > out.corpora.wiki.counts.chars * 5, "memos 体量应远大于 wiki");
  }
});
