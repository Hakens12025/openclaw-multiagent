/**
 * knowledge-base-eval.test.js — Phase 4:per-KB 召回评测(eval-set 注册表 + runner + CLI 面)
 *
 * 复用已泛化的 evaluateWikiRagRecall(searchFn) + searchKb 作 searchFn(一条路径,不重造引擎)。
 * 纯路径进 gate:normalize / 注册表 CRUD / surface 注册 / 未知集不回滚。
 * live(无 ollama 则 skip):temp KB + eval-set → runKnowledgeEval → recall 命中。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeKnowledgeEvalSet,
  saveKnowledgeEvalSet,
  getKnowledgeEvalSet,
  listKnowledgeEvalSets,
  deleteKnowledgeEvalSet,
} from "../lib/knowledge/knowledge-eval-registry.js";
import { runKnowledgeEval, listKnowledgeEvalRuns } from "../lib/knowledge/knowledge-eval-runner.js";
import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-inspector.js";
import { executeAdminSurfaceOperation } from "../lib/admin/operations/admin-surface-operations.js";
import { addKnowledgeBaseSource, removeKnowledgeBase } from "../lib/knowledge/knowledge-base-registry.js";
import { buildKbIndex, searchKb } from "../lib/knowledge/knowledge-base.js";
import { knowledgeBaseIndexFile } from "../lib/control-plane/control-plane-paths.js";
import { embedText } from "../lib/knowledge/wiki-rag-embed.js";

let ollamaUp = false;
try { await embedText("probe", {}); ollamaUp = true; } catch { ollamaUp = false; }

// ── normalize(纯)──
test("normalizeKnowledgeEvalSet:缺 kbId/evalSetId → null;丢弃无效 case", () => {
  assert.equal(normalizeKnowledgeEvalSet({ evalSetId: "x", cases: [] }), null);
  assert.equal(normalizeKnowledgeEvalSet({ kbId: "k", cases: [] }), null);
  const ok = normalizeKnowledgeEvalSet({
    kbId: "k", evalSetId: "base", topK: 7,
    cases: [
      { query: "q1", expectedSourcePath: "a.md", category: "x" },
      { query: "", expectedSourcePath: "b.md" },        // 无 query → 丢
      { query: "q3", expectedSourcePath: "" },           // 无 expected → 丢
    ],
  });
  assert.equal(ok.topK, 7);
  assert.equal(ok.cases.length, 1);
  assert.equal(ok.cases[0].expectedSourcePath, "a.md");
});

// ── 注册表 CRUD(写 live store,unique id + try/finally)──
test("eval-set 注册表:save→get→list→delete", async () => {
  const kbId = `evkb-${Date.now()}`;
  const evalSetId = "base";
  try {
    const saved = await saveKnowledgeEvalSet({
      kbId, evalSetId, label: "基线",
      cases: [{ query: "如何重启", expectedSourcePath: "deploy.md", category: "ops" }],
    });
    assert.equal(saved.kbId, kbId);
    assert.equal(saved.cases.length, 1);

    const got = await getKnowledgeEvalSet(kbId, evalSetId);
    assert.equal(got.evalSetId, evalSetId);
    assert.equal(got.label, "基线");

    const list = await listKnowledgeEvalSets(kbId);
    assert.equal(list.length, 1);

    const del = await deleteKnowledgeEvalSet(kbId, evalSetId);
    assert.equal(del.deleted, true);
    assert.equal((await listKnowledgeEvalSets(kbId)).length, 0);
  } finally {
    await deleteKnowledgeEvalSet(kbId, evalSetId).catch(() => {});
  }
});

// ── surface 注册 ──
test("CLI-system:2 inspect 面 + 2 apply 面注册", () => {
  for (const id of ["inspect.knowledge_eval_sets", "inspect.knowledge_eval_runs"]) {
    const s = getCliSystemSurface(id);
    assert.ok(s, `${id} 应注册`);
    assert.equal(s.family, "inspect");
  }
  for (const id of ["apply.knowledge_eval_set_save", "apply.knowledge_eval_run", "apply.knowledge_eval_set_remove"]) {
    const s = getCliSystemSurface(id);
    assert.ok(s, `${id} 应注册`);
    assert.equal(s.family, "apply");
    assert.equal(s.operatorExecutable, true);
  }
});

test("apply.knowledge_eval_set_save + remove 经 executor:存→删→消失", async () => {
  const kbId = `evkb3-${Date.now()}`;
  const evalSetId = "base";
  try {
    await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_eval_set_save",
      payload: { kbId, evalSetId, cases: [{ query: "q", expectedSourcePath: "a.md" }] },
    });
    assert.equal((await inspectCliSystemSurface({ surfaceId: "inspect.knowledge_eval_sets", params: { kbId } })).evalSets.length, 1);
    const rm = await executeAdminSurfaceOperation({ surfaceId: "apply.knowledge_eval_set_remove", payload: { kbId, evalSetId } });
    assert.equal(rm.ok, true);
    assert.equal(rm.deleted, true);
    assert.equal((await inspectCliSystemSurface({ surfaceId: "inspect.knowledge_eval_sets", params: { kbId } })).evalSets.length, 0);
  } finally {
    await deleteKnowledgeEvalSet(kbId, evalSetId).catch(() => {});
  }
});

test("inspect.knowledge_eval_sets:形状(counts + evalSets[])", async () => {
  const data = await inspectCliSystemSurface({ surfaceId: "inspect.knowledge_eval_sets" });
  assert.ok(typeof data.counts.total === "number");
  assert.ok(Array.isArray(data.evalSets));
});

// ── 未知集不触发回滚 ──
test("apply.knowledge_eval_run 未知集 → ok:true + ran:false(executor 不回滚)", async () => {
  const r = await executeAdminSurfaceOperation({
    surfaceId: "apply.knowledge_eval_run",
    payload: { kbId: "nope-kb", evalSetId: "nope-set" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ran, false);
  assert.ok(r.error);
});

test("apply.knowledge_eval_set_save:cases 容忍 JSON 串", async () => {
  const kbId = `evkb2-${Date.now()}`;
  try {
    const r = await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_eval_set_save",
      payload: { kbId, evalSetId: "base", cases: '[{"query":"q","expectedSourcePath":"a.md"}]' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.evalSet.cases.length, 1);
  } finally {
    await deleteKnowledgeEvalSet(kbId, "base").catch(() => {});
  }
});

// ── live:建库 → 配评测集 → 跑评测 → recall 命中(无 ollama 则 skip)──
test("live: e2e KB 评测(经 executeAdminSurfaceOperation,skip if ollama down)", { skip: !ollamaUp }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-eval-"));
  const kbId = `evlive-${Date.now()}`;
  const evalSetId = "base";
  try {
    await writeFile(join(dir, "deploy.md"), "# 运维手册\n\n用 launchctl kickstart 重启 openclaw 网关,端口 18789。\n");
    await writeFile(join(dir, "faq.txt"), "常见问题:知识库支持单文件和文件夹,二进制自动跳过。\n");
    await addKnowledgeBaseSource(kbId, dir, { label: "eval库" });
    await buildKbIndex(kbId, { force: true });

    // 发现 deploy 文件的真实 sourcePath(temp 在 OC 外 → 绝对路径形态),据此建标注
    const probe = await searchKb(kbId, "重启网关 launchctl 端口", { topK: 5 });
    assert.equal(probe.ok, true);
    const deployPath = probe.results.find((r) => r.sourcePath.endsWith("deploy.md"))?.sourcePath;
    assert.ok(deployPath, "探针应命中 deploy.md");

    await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_eval_set_save",
      payload: { kbId, evalSetId, label: "基线", cases: [{ query: "如何重启网关 端口", expectedSourcePath: deployPath, category: "ops" }] },
    });

    const run = await executeAdminSurfaceOperation({
      surfaceId: "apply.knowledge_eval_run",
      payload: { kbId, evalSetId },
    });
    assert.equal(run.ok, true);
    assert.equal(run.ran, true);
    assert.equal(run.run.total, 1);
    assert.ok(run.run.recallAt["5"] >= 1, `recall@5 应命中,实得 ${run.run.recallAt["5"]}`);

    // 运行摘要应已落历史
    const runs = await listKnowledgeEvalRuns({ kbId, evalSetId, limit: 5 });
    assert.ok(runs.length >= 1, "历史应有该运行");
    assert.equal(runs[0].kbId, kbId);
  } finally {
    await deleteKnowledgeEvalSet(kbId, evalSetId).catch(() => {});
    await removeKnowledgeBase(kbId).catch(() => {});
    await rm(knowledgeBaseIndexFile(kbId), { force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
