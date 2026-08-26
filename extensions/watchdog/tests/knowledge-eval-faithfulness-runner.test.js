/**
 * knowledge-eval-faithfulness-runner.test.js — v156:faithfulness 接进 eval runner + apply 面
 *
 * runKnowledgeFaithfulness(judge 可注入)→ evaluateFaithfulness/ContextPrecision → 持久 kind:"faithfulness"。
 * judge 注入 fake = 确定式进 gate(不碰真 LLM)。surface 注册 + 未知集不回滚。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  saveKnowledgeEvalSet,
  deleteKnowledgeEvalSet,
  normalizeKnowledgeEvalSet,
} from "../lib/knowledge/knowledge-eval-registry.js";
import { runKnowledgeFaithfulness, listKnowledgeEvalRuns } from "../lib/knowledge/knowledge-eval-runner.js";
import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { executeAdminSurfaceOperation } from "../lib/admin/operations/admin-surface-operations.js";

const fakeJudge = {
  faithfulness: async () => ({ supported: true }),
  relevance: async () => ({ relevant: true }),
};

test("normalizeKnowledgeEvalSet:case 携带 gold answer", () => {
  const set = normalizeKnowledgeEvalSet({
    kbId: "k", evalSetId: "e",
    cases: [{ query: "q", expectedSourcePath: "a.md", answer: "答案是 200" }],
  });
  assert.equal(set.cases[0].answer, "答案是 200");
});

test("runKnowledgeFaithfulness:注入 fake judge → kind:faithfulness 摘要 + 落历史", async () => {
  const kbId = "fkb-faith";
  const evalSetId = "base";
  try {
    await saveKnowledgeEvalSet({
      kbId, evalSetId,
      cases: [
        { query: "如何重启网关", expectedSourcePath: "deploy.md", answer: "用 launchctl kickstart 重启" },
        { query: "无答案的 case", expectedSourcePath: "x.md" }, // 无 answer → 不参与 faithfulness
      ],
    });
    const r = await runKnowledgeFaithfulness(kbId, evalSetId, { judge: fakeJudge, votes: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.run.kind, "faithfulness");
    assert.equal(r.run.answered, 1, "只有 1 个 case 带 answer");
    assert.equal(r.run.faithfulness, 1, "fake judge 全 supported → faithfulness=1");
    // KB 不存在 → searchKb 空 context → contextPrecision 0(无 chunk 可判),degraded:true
    assert.equal(r.run.contextPrecision, 0);
    assert.equal(r.run.degraded, true);
    // 落历史(与 recall run 同 store,按 kind 区分)
    const runs = await listKnowledgeEvalRuns({ kbId, evalSetId, limit: 5 });
    assert.ok(runs.some((x) => x.runId === r.run.runId && x.kind === "faithfulness"));
  } finally {
    await deleteKnowledgeEvalSet(kbId, evalSetId).catch(() => {});
  }
});

test("runKnowledgeFaithfulness:无 answer 的集 → ok:false", async () => {
  const kbId = "fkb-noans";
  const evalSetId = "base";
  try {
    await saveKnowledgeEvalSet({ kbId, evalSetId, cases: [{ query: "q", expectedSourcePath: "a.md" }] });
    const r = await runKnowledgeFaithfulness(kbId, evalSetId, { judge: fakeJudge });
    assert.equal(r.ok, false);
    assert.ok(/no cases with 'answer'/.test(r.error));
  } finally {
    await deleteKnowledgeEvalSet(kbId, evalSetId).catch(() => {});
  }
});

test("apply.knowledge_eval_faithfulness 注册 + 未知集 → ok:true ran:false(不回滚)", async () => {
  const s = getCliSystemSurface("apply.knowledge_eval_faithfulness");
  assert.ok(s, "surface 应注册");
  assert.equal(s.family, "apply");
  assert.equal(s.operatorExecutable, true);
  const r = await executeAdminSurfaceOperation({
    surfaceId: "apply.knowledge_eval_faithfulness",
    payload: { kbId: "nope", evalSetId: "nope" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ran, false);
  assert.ok(r.error);
});
