/**
 * knowledge-base-apply.test.js — Phase 2 apply 面:operator/UI 经 CLI-system 增删知识库条目
 *
 * apply.knowledge_add/reindex/remove 注册为 CLI-system apply 面(source:admin_surface,
 * operatorExecutable)。executeAdminSurfaceOperation 端到端:加源→重建→(命中)→删源→删库。
 * 注册/形状进 gate;搜索命中需 ollama 则 skip。unique kb id + try/finally 清理(沿用约定)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { getAdminSurfaceInputFields } from "../lib/admin/admin-surface-registry.js";
import { executeAdminSurfaceOperation } from "../lib/admin/operations/admin-surface-operations.js";
import { searchKb } from "../lib/knowledge/knowledge-base.js";
import { removeKnowledgeBase } from "../lib/knowledge/knowledge-base-registry.js";
import { knowledgeBaseIndexFile } from "../lib/control-plane/control-plane-paths.js";
import { embedText } from "../lib/knowledge/wiki-rag-embed.js";

let ollamaUp = false;
try { await embedText("probe", {}); ollamaUp = true; } catch { ollamaUp = false; }

const KB_SURFACES = ["apply.knowledge_add", "apply.knowledge_reindex", "apply.knowledge_remove"];

test("CLI-system:3 个 knowledge apply 面注册为 operator-executable(family=apply)", () => {
  for (const id of KB_SURFACES) {
    const s = getCliSystemSurface(id);
    assert.ok(s, `${id} 应注册`);
    assert.equal(s.family, "apply", `${id} family 应为 apply`);
    assert.equal(s.operatorExecutable, true, `${id} 应 operator 可执行`);
    assert.equal(s.source, "admin_surface", `${id} 应来自 admin_surface(有 executor)`);
  }
  // remove 是 destructive + explicit confirm(内置 wiki 误删保护 + UI 二次确认)
  assert.equal(getCliSystemSurface("apply.knowledge_remove").risk, "destructive");
});

test("input fields:knowledge_add 必填 kbId/sourcePath", () => {
  const fields = getAdminSurfaceInputFields("apply.knowledge_add");
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(byKey.kbId?.required, true);
  assert.equal(byKey.sourcePath?.required, true);
  assert.ok(byKey.label, "label 字段存在(可选)");
});

test("knowledge_remove('wiki') 经 executor → 抛(内置不可删)", async () => {
  await assert.rejects(
    () => executeAdminSurfaceOperation({ surfaceId: "apply.knowledge_remove", payload: { kbId: "wiki" } }),
    /cannot remove builtin/,
  );
});

test("e2e:add → reindex → (命中) → removeSource → removeKB(经 executeAdminSurfaceOperation)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-apply-"));
  const id = `kbapply-${Date.now()}`;
  try {
    await writeFile(join(dir, "guide.md"), "# 运维\n\n用 launchctl kickstart 重启 openclaw 网关,端口 18789。\n");

    // add(自动建索引)
    const added = await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_add",
      payload: { kbId: id, sourcePath: dir, label: "运维库" },
    });
    assert.equal(added.ok, true);
    assert.equal(added.knowledgeBase.id, id);
    assert.deepEqual(added.knowledgeBase.sources, [dir]);

    // reindex(force 全量)
    const reindexed = await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_reindex",
      payload: { kbId: id, force: true },
    });
    assert.equal(reindexed.ok, true);
    assert.equal(reindexed.reindexed, true);

    // 命中(需 ollama)
    if (ollamaUp) {
      const r = await searchKb(id, "重启网关 launchctl 端口", { topK: 3 });
      assert.equal(r.ok, true);
      assert.ok(r.results.some((x) => x.sourcePath.endsWith("guide.md")), "应命中 guide.md");
    }

    // removeSource(库保留,空 sources)
    const rmSrc = await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_remove",
      payload: { kbId: id, sourcePath: dir },
    });
    assert.equal(rmSrc.ok, true);
    assert.equal(rmSrc.removed, true);
    assert.deepEqual(rmSrc.knowledgeBase.sources, []);

    // removeKB(整库)
    const rmKb = await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_remove",
      payload: { kbId: id },
    });
    assert.equal(rmKb.ok, true);
    assert.equal(rmKb.removed, true);
  } finally {
    await removeKnowledgeBase(id).catch(() => {});
    await rm(knowledgeBaseIndexFile(id), { force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledge_reindex 未知库 → ok:true + reindexed:false(不触发 executor 回滚)", async () => {
  const r = await executeAdminSurfaceOperation({
    surfaceId: "apply.knowledge_reindex",
    payload: { kbId: "does-not-exist-kb" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.reindexed, false);
  assert.ok(r.error);
});
