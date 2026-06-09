/**
 * knowledge-base-ingestion.test.js — Phase 2:任意可读文件/文件夹 → RAG 库
 *
 * 纯路径(进 gate):isTextFile 可读判定、buildChunkPlanForSources 通用切分(二进制跳过)、
 * 注册表 CRUD(unique id + try/finally 清理,沿用 automation-store-locking 约定)。
 * live 路径(无 ollama 则 skip):buildKbIndex over 临时文件夹 → searchKb 命中。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isTextFile, buildChunkPlanForSources } from "../lib/operator/wiki-rag-store.js";
import {
  normalizeKnowledgeBaseSpec,
  addKnowledgeBaseSource,
  removeKnowledgeBaseSource,
  removeKnowledgeBase,
  listPersistedKnowledgeBases,
} from "../lib/operator/knowledge-base-registry.js";
import { buildKbIndex, searchKb, listKnowledgeBaseSpecs } from "../lib/operator/knowledge-base.js";
import { knowledgeBaseIndexFile } from "../lib/control-plane/control-plane-paths.js";
import { embedText } from "../lib/operator/wiki-rag-embed.js";

let ollamaUp = false;
try { await embedText("probe", {}); ollamaUp = true; } catch { ollamaUp = false; }

// ── isTextFile(纯)──
test("isTextFile:文本扩展+文本 buffer → true;二进制/未知扩展 → false", () => {
  const text = Buffer.from("hello world 你好\n", "utf8");
  assert.equal(isTextFile("a.md", text), true);
  assert.equal(isTextFile("a.txt", text), true);
  assert.equal(isTextFile("a.js", text), true);
  assert.equal(isTextFile("README", text), true); // 无扩展名 → 看内容
  assert.equal(isTextFile("a.png", text), false); // 已知非文本扩展 → 拒(即便内容像文本)
  assert.equal(isTextFile("a.bin", text), false); // 未知扩展 → 拒
  const binary = Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0xff]); // 含 NUL
  assert.equal(isTextFile("a.txt", binary), false); // NUL 字节 → 二进制
});

// ── 通用 chunk plan(纯,不需 embed)──
test("buildChunkPlanForSources:文件夹递归切分,二进制跳过,md/纯文本都进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-ingest-"));
  try {
    await writeFile(join(dir, "a.md"), "# 水果\n\n这段讲苹果和橙子 apples oranges。\n");
    await writeFile(join(dir, "b.txt"), "纯文本文件,讨论香蕉和葡萄 bananas grapes\n");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "d.js"), "const x = 1; // 代码注释 cherries\n");
    await writeFile(join(dir, "c.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])); // 二进制

    const plan = await buildChunkPlanForSources([dir]);
    assert.ok(plan.length >= 3, `应至少 3 个 chunk(a.md/b.txt/d.js),实得 ${plan.length}`);
    // 二进制 c.png 必须被跳过
    assert.ok(!plan.some((c) => c.sourcePath.endsWith("c.png")), "二进制文件不应进 chunk plan");
    // 内容正确进入
    assert.ok(plan.some((c) => c.text.includes("apples")), "md 内容应进 chunk");
    assert.ok(plan.some((c) => c.text.includes("bananas")), "纯文本内容应进 chunk");
    assert.ok(plan.some((c) => c.sourcePath.endsWith("sub/d.js")), "子文件夹应被递归");
    // 每个 chunk 有 id/hash/sourcePath/text
    for (const c of plan) {
      assert.ok(c.id && c.sourcePath && typeof c.text === "string" && c.hash, "chunk 形状完整");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── normalizeKnowledgeBaseSpec(纯)──
test("normalizeKnowledgeBaseSpec:拒 wiki/非法 id,去重 sources", () => {
  assert.equal(normalizeKnowledgeBaseSpec({ id: "wiki", sources: ["x"] }), null, "wiki 是保留 id");
  assert.equal(normalizeKnowledgeBaseSpec({ id: "bad id!", sources: [] }), null, "非法字符 id");
  assert.equal(normalizeKnowledgeBaseSpec({ sources: [] }), null, "缺 id");
  const ok = normalizeKnowledgeBaseSpec({ id: "my-kb", label: "My KB", sources: ["a", "a", "b"] });
  assert.equal(ok.id, "my-kb");
  assert.equal(ok.kind, "user");
  assert.equal(ok.scope, "global");
  assert.deepEqual(ok.sources, ["a", "b"]); // 去重
});

// ── 注册表 CRUD(写 live store,unique id + try/finally 清理)──
test("注册表 CRUD:add→list→removeSource→removeKB(unique id 隔离)", async () => {
  const id = `kbtest-${Date.now()}`;
  try {
    const added = await addKnowledgeBaseSource(id, "/tmp/some/source", { label: "测试库" });
    assert.equal(added.id, id);
    assert.deepEqual(added.sources, ["/tmp/some/source"]);
    assert.equal(added.kind, "user");

    // 经合并视图(种子 ∪ 持久)可见
    const merged = await listKnowledgeBaseSpecs();
    assert.ok(merged.some((k) => k.id === id), "合并列表应含新库");
    assert.ok(merged.some((k) => k.id === "wiki"), "种子 wiki 仍在");

    // 追加第二个 source
    const two = await addKnowledgeBaseSource(id, "/tmp/another");
    assert.deepEqual(two.sources, ["/tmp/some/source", "/tmp/another"]);

    // 移除一个 source(库保留)
    const afterRm = await removeKnowledgeBaseSource(id, "/tmp/some/source");
    assert.equal(afterRm.removed, true);
    assert.deepEqual(afterRm.knowledgeBase.sources, ["/tmp/another"]);
  } finally {
    await removeKnowledgeBase(id).catch(() => {});
  }
  const after = await listPersistedKnowledgeBases();
  assert.ok(!after.some((k) => k.id === id), "removeKnowledgeBase 后应彻底删除");
});

test("注册表:add(id='wiki') 抛,removeKnowledgeBase('wiki') 抛(内置不可改)", async () => {
  await assert.rejects(() => addKnowledgeBaseSource("wiki", "/x"), /invalid knowledge base id/);
  await assert.rejects(() => removeKnowledgeBase("wiki"), /cannot remove builtin/);
});

// ── live:建库 + 检索(无 ollama 则 skip)──
test("live: buildKbIndex over 临时文件夹 → searchKb 命中(skip if ollama down)", { skip: !ollamaUp }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-build-"));
  const id = `kbbuild-${Date.now()}`;
  try {
    await writeFile(join(dir, "notes.md"), "# 部署手册\n\n用 launchctl kickstart 重启网关。端口 18789。\n");
    await writeFile(join(dir, "faq.txt"), "常见问题:如何添加新的知识库条目,支持单文件和文件夹。\n");
    await addKnowledgeBaseSource(id, dir, { label: "临时库" });

    const built = await buildKbIndex(id, { force: true });
    assert.equal(built.ok, true);
    assert.ok(built.chunkCount >= 2, `应至少 2 chunk,实得 ${built.chunkCount}`);

    const r = await searchKb(id, "重启网关 launchctl 端口", { topK: 3 });
    assert.equal(r.ok, true);
    assert.ok(r.results.length > 0, "应有检索结果");
    assert.ok(r.results.some((x) => x.sourcePath.endsWith("notes.md")), "部署查询应命中 notes.md");
  } finally {
    await removeKnowledgeBase(id).catch(() => {});
    await rm(knowledgeBaseIndexFile(id), { force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
