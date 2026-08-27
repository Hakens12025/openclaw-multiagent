/**
 * kb-index-path-override.test.js — buildKbIndex 影子索引(indexPath 覆盖)。rag-todo T3/T6 前置。
 *
 * 两条硬断言:
 *  1) 缺省行为与覆盖前逐字节等价 —— 索引落在硬编码期望路径
 *     ~/.openclaw/control-plane/kb-<id>-index.json(期望值手写路径段,独立于 knowledgeBaseIndexFile,
 *     排除自比自恒真);
 *  2) 覆盖 indexPath 时写到指定临时路径,正式落点保持零写入。
 *
 * 全程零 embed:KB source 指向空临时文件夹 → 空 chunk plan → embedChunkPlanToIndex 零次 embedText。
 * wiki 分支(buildKbIndex 短路 buildWikiRagIndex)的透传在 mock 层验证 —— 真跑会 embed 全部 wiki
 * chunk;需 --experimental-test-module-mocks(npm test 脚本已带),缺 flag 自动 skip。
 * 注册表写入沿用 knowledge-base-ingestion.test.js 约定:unique id + try/finally 清理。
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildKbIndex } from "../lib/knowledge/knowledge-base.js";
import { addKnowledgeBaseSource, removeKnowledgeBase } from "../lib/knowledge/knowledge-base-registry.js";

// 硬编码期望:kb 索引的正式落点。手写路径段(homedir/.openclaw/control-plane/kb-<id>-index.json),
// 独立于 knowledgeBaseIndexFile —— 默认落点若被改动,这里会红。
function hardcodedDefaultIndexPath(kbId) {
  return join(homedir(), ".openclaw", "control-plane", `kb-${kbId}-index.json`);
}

test("默认(无 indexPath):索引写到硬编码正式落点", async () => {
  const srcDir = await mkdtemp(join(tmpdir(), "kb-idx-default-"));
  const id = `kbidxdef-${Date.now()}`;
  const expectedPath = hardcodedDefaultIndexPath(id);
  try {
    await addKnowledgeBaseSource(id, srcDir, { label: "空源库" });
    assert.equal(existsSync(expectedPath), false, "前置:正式落点尚无索引(unique id 保证)");
    const built = await buildKbIndex(id);
    assert.equal(built.ok, true);
    assert.equal(built.chunkCount, 0, "空源 → 0 chunk(零 embed 调用)");
    assert.equal(existsSync(expectedPath), true, `索引应落在 ${expectedPath}`);
    const written = JSON.parse(await readFile(expectedPath, "utf8"));
    assert.deepEqual(written.chunks, []);
    assert.equal(typeof written.model, "string", "索引顶层带 model");
  } finally {
    await removeKnowledgeBase(id).catch(() => {});
    await rm(expectedPath, { force: true }).catch(() => {});
    await rm(srcDir, { recursive: true, force: true });
  }
});

test("覆盖 indexPath:索引写到指定临时路径,正式落点保持零写入", async () => {
  const srcDir = await mkdtemp(join(tmpdir(), "kb-idx-src-"));
  const outDir = await mkdtemp(join(tmpdir(), "kb-idx-out-"));
  const id = `kbidxovr-${Date.now()}`;
  const officialPath = hardcodedDefaultIndexPath(id);
  const shadowPath = join(outDir, "shadow-index.json");
  try {
    await addKnowledgeBaseSource(id, srcDir, { label: "影子库" });
    const built = await buildKbIndex(id, { indexPath: shadowPath });
    assert.equal(built.ok, true);
    assert.equal(built.chunkCount, 0);
    assert.equal(existsSync(shadowPath), true, "覆盖路径应有索引文件");
    const written = JSON.parse(await readFile(shadowPath, "utf8"));
    assert.deepEqual(written.chunks, []);
    assert.equal(existsSync(officialPath), false, "正式落点保持零写入");
  } finally {
    await removeKnowledgeBase(id).catch(() => {});
    await rm(srcDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ── wiki 分支透传(mock 层)──
const moduleMocksAvailable = typeof mock.module === "function";

test(
  "wiki 分支:indexPath 透传给 buildWikiRagIndex;缺省调用零透传该键(其自身默认 INDEX_FILE 生效)",
  { skip: moduleMocksAvailable ? false : "需 --experimental-test-module-mocks(npm test 已带)" },
  async (t) => {
    const calls = [];
    // mock 特定符从本测试文件自身定位(import.meta.url),与 knowledge-base.js 的相对
    // import 解析到同一份文件 —— 写死 /Users/<user> 在 CI/别机树下 mock 落空,真 build 被调。
    t.mock.module(fileURLToPath(new URL("../lib/knowledge/wiki-rag-store.js", import.meta.url)), {
      namedExports: {
        loadWikiRagIndex: async () => ({ model: null, builtAt: null, chunks: [] }),
        buildWikiRagIndex: async (opts = {}) => { calls.push(opts); return { ok: true, chunkCount: 0 }; },
        loadRagIndexFile: async () => ({ model: null, builtAt: null, chunks: [] }),
        embedChunkPlanToIndex: async () => ({ ok: true, chunkCount: 0 }),
        buildChunkPlanForSources: async () => [],
      },
    });
    // cache-bust query:knowledge-base.js 顶部已被本文件静态引入,带 query 强制在 mock 生效后重装配。
    const kb = await import("../lib/knowledge/knowledge-base.js?wiki-index-path-passthrough");
    const shadow = "/tmp/kb-wiki-shadow-index.json"; // 仅作参数值,mock 下零磁盘写入
    await kb.buildKbIndex("wiki", { indexPath: shadow });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].indexPath, shadow, "覆盖值应透传给 buildWikiRagIndex");
    await kb.buildKbIndex("wiki");
    assert.equal(calls.length, 2);
    assert.equal(Object.hasOwn(calls[1], "indexPath"), false, "缺省调用零透传 indexPath 键 → 默认 INDEX_FILE 生效");
  },
);
