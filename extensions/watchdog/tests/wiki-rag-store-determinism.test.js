/**
 * wiki-rag-store-determinism.test.js — 排序确定性 + headingPrefix 开关(全纯,零 ollama)
 *
 * 覆盖两条审计缺陷:
 * ① 两条检索路的 sort 此前只比 score,并列名次落回 chunk 插入序(= readdir 遍历序),
 *    重建索引就可能翻 rank-1(live 索引实测 12 条查询里 3 条洗牌后 top-1 换页)。
 * ② heading 不进被 embed 的文本(live 索引 444 chunk 里 383 块的 text 不含所属页 h1 标题),
 *    做成 headingPrefix 开关,**默认关 = 旧行为逐字节不变**,留给主会话 A/B。
 *
 * 全部用例只用合成索引 / 临时文件 + 纯函数,不 embed、不建索引、不碰 ollama。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  searchWikiRag,
  searchWikiRagLexical,
  buildChunkPlanForSources,
} from "../lib/knowledge/wiki-rag-store.js";

// 4 块同分 chunk。插入序刻意与字典序不同(decisions 先进、aaa 最后进),
// 用来暴露"并列 = 插入序"的旧行为。向量全同 → cosine 也全同分。
const VEC = [1, 0, 0];
const TIED_CHUNKS = [
  { id: "1", sourcePath: "wiki/decisions/zeta.md", heading: "B", text: "alpha 出现一次", vector: VEC },
  { id: "2", sourcePath: "wiki/concepts/mid.md", heading: "A", text: "alpha 出现一次", vector: VEC },
  { id: "3", sourcePath: "wiki/concepts/mid.md", heading: "Z", text: "alpha 出现一次", vector: VEC },
  { id: "4", sourcePath: "wiki/aaa/first.md", heading: "Q", text: "alpha 出现一次", vector: VEC },
];
const EXPECTED_TIE_ORDER = [
  "wiki/aaa/first.md#Q",
  "wiki/concepts/mid.md#A",
  "wiki/concepts/mid.md#Z",
  "wiki/decisions/zeta.md#B",
];
const keysOf = (results) => results.map((r) => `${r.sourcePath}#${r.heading}`);

test("词法路:同分并列按 sourcePath→heading 字典序,与插入序无关", async () => {
  const asIs = await searchWikiRagLexical("alpha", { topK: 10, index: { chunks: TIED_CHUNKS } });
  const reversed = await searchWikiRagLexical("alpha", { topK: 10, index: { chunks: [...TIED_CHUNKS].reverse() } });
  assert.deepEqual(keysOf(asIs), EXPECTED_TIE_ORDER);
  assert.deepEqual(keysOf(reversed), EXPECTED_TIE_ORDER, "插入序反转后名次必须不变");
  assert.ok(asIs.every((r) => r.score === asIs[0].score), "前提:这 4 块确实同分");
});

test("向量路:同分并列按 sourcePath→heading 字典序,与插入序无关", async () => {
  const asIs = await searchWikiRag(VEC, { topK: 10, index: { chunks: TIED_CHUNKS } });
  const reversed = await searchWikiRag(VEC, { topK: 10, index: { chunks: [...TIED_CHUNKS].reverse() } });
  assert.deepEqual(keysOf(asIs), EXPECTED_TIE_ORDER);
  assert.deepEqual(keysOf(reversed), EXPECTED_TIE_ORDER, "插入序反转后名次必须不变");
  assert.ok(asIs.every((r) => r.score === asIs[0].score), "前提:这 4 块确实同分");
});

test("重复调用同一索引 → 逐位同序(sort 不带随机性)", async () => {
  const index = { chunks: TIED_CHUNKS };
  const a = await searchWikiRagLexical("alpha", { topK: 10, index });
  const b = await searchWikiRagLexical("alpha", { topK: 10, index });
  assert.deepEqual(keysOf(a), keysOf(b));
});

test("score 仍是第一顺位:高分块排在字典序更靠前的低分块之前", async () => {
  // zeta 多命中一个词 → 分更高,尽管 sourcePath 字典序最靠后
  const chunks = [
    { id: "1", sourcePath: "wiki/aaa/first.md", heading: "Q", text: "alpha 出现", vector: [1, 0, 0] },
    { id: "2", sourcePath: "wiki/decisions/zeta.md", heading: "B", text: "alpha beta 都出现", vector: [1, 0, 0] },
  ];
  const out = await searchWikiRagLexical("alpha beta", { topK: 5, index: { chunks } });
  assert.equal(out[0].sourcePath, "wiki/decisions/zeta.md");
  assert.ok(out[0].score > out[1].score);

  // 向量路同理:cosine 更高者优先
  const vec = await searchWikiRag([1, 1, 0], {
    topK: 5,
    index: { chunks: [
      { id: "1", sourcePath: "wiki/aaa/first.md", heading: "Q", text: "x", vector: [1, 0, 0] },
      { id: "2", sourcePath: "zzz/last.md", heading: "B", text: "y", vector: [1, 1, 0] },
    ] },
  });
  assert.equal(vec[0].sourcePath, "zzz/last.md");
});

// ── headingPrefix 开关 ────────────────────────────────────────────────────────

const FIXTURE_MD = "# 页标题 Alpha\n\n> 摘要行\n\n## 小节一\n\n正文一 keyword-x\n\n### 深层\n\n正文二\n";
// 跳级:h1 之后直接 h3(面包屑中间有空洞)
const FIXTURE_SKIP_MD = "# 顶标题\n\n顶部正文\n\n### 三级\n\n三级正文\n";

async function planFixture(options) {
  const dir = await mkdtemp(join(tmpdir(), "rag-heading-"));
  try {
    await writeFile(join(dir, "page.md"), FIXTURE_MD, "utf8");
    return await buildChunkPlanForSources([join(dir, "page.md")], options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("headingPrefix 默认关:chunk.text 逐字节等于旧行为(正文,无任何标题前缀)", async () => {
  const plan = await planFixture(undefined);
  assert.deepEqual(plan.map((c) => c.text), ["摘要行", "正文一 keyword-x", "正文二"]);
  assert.deepEqual(plan.map((c) => c.heading), ["页标题 Alpha", "小节一", "深层"]);
  // hash 仍是 text 的 sha256 → 默认路径不会触发任何重嵌
  for (const c of plan) {
    assert.equal(c.hash, createHash("sha256").update(c.text).digest("hex"));
  }
  // 显式传 false 与不传等价
  const explicitOff = await planFixture({ headingPrefix: false });
  assert.deepEqual(explicitOff.map((c) => c.text), plan.map((c) => c.text));
  assert.deepEqual(explicitOff.map((c) => c.hash), plan.map((c) => c.hash));
});

test("headingPrefix 开:h1>h2>h3 面包屑拼进 chunk.text,hash 随之改变", async () => {
  const on = await planFixture({ headingPrefix: true });
  assert.deepEqual(on.map((c) => c.text), [
    "页标题 Alpha\n摘要行",
    "页标题 Alpha > 小节一\n正文一 keyword-x",
    "页标题 Alpha > 小节一 > 深层\n正文二",
  ]);
  // heading 字段本身不变(词法 head 加成与展示不受影响)
  assert.deepEqual(on.map((c) => c.heading), ["页标题 Alpha", "小节一", "深层"]);
  const off = await planFixture(undefined);
  // id 只比文件名之后的部分(两次 fixture 落在不同临时目录,前缀本就不同)
  const idTail = (c) => c.id.split("/").pop();
  assert.deepEqual(on.map(idTail), off.map(idTail), "id 不因变体改变");
  assert.ok(on.every((c, i) => c.hash !== off[i].hash), "text 变 → hash 必变 → 全量重嵌(A/B 时不会混用旧向量)");
});

test("headingPrefix 开:跳级 h1→h3 时面包屑跳过空洞", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rag-heading-skip-"));
  try {
    await writeFile(join(dir, "skip.md"), FIXTURE_SKIP_MD, "utf8");
    const plan = await buildChunkPlanForSources([join(dir, "skip.md")], { headingPrefix: true });
    assert.deepEqual(plan.map((c) => c.text), ["顶标题\n顶部正文", "顶标题 > 三级\n三级正文"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headingPrefix 开:非 markdown 文件前缀 = 文件名(不炸,单层面包屑)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rag-heading-txt-"));
  try {
    await writeFile(join(dir, "notes.txt"), "纯文本内容 banana\n", "utf8");
    const on = await buildChunkPlanForSources([join(dir, "notes.txt")], { headingPrefix: true });
    const off = await buildChunkPlanForSources([join(dir, "notes.txt")]);
    assert.equal(on.length, 1);
    assert.equal(on[0].text, "notes.txt\n纯文本内容 banana\n");
    assert.equal(off[0].text, "纯文本内容 banana\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
