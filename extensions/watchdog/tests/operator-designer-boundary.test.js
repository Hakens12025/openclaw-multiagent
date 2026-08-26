import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildOperatorKnowledgeContext } from "../lib/operator/operator-knowledge.js";

// Designer-only boundary guard (user correction: "operator 不做任务,单纯设计结构和 agent 内容,
// 具体任务是 agent 做"). operator DESIGNS structure + agent content and ENDS at preview; it must
// NOT be instructed to run the user's concrete one-off task. The mandate was mirrored across THREE
// sources (system prompt, compiled knowledge fragment, SKILL playbook) — this pins all three in
// lockstep + asserts design capability survives (no over-revert).
// buildOperatorBrainSystemPrompt is module-private → assert on source text.

const BRAIN = path.resolve(import.meta.dirname, "../lib/operator/operator-brain.js");
const SKILL = path.resolve(import.meta.dirname, "../../../skills/operator-new-task/SKILL.md");

test("system prompt: no run-the-task tail; design + 通用机 capability intact", () => {
  const txt = readFileSync(BRAIN, "utf8");
  assert.doesNotMatch(txt, /Always end a build plan that creates a loop with runtime\.loop\.start/);
  assert.doesNotMatch(txt, /compose\+start the loop/);
  // Retired: there is no run/start surface for operator to name at all.
  assert.doesNotMatch(txt, /runtime\.loop\./);
  assert.match(txt, /Do NOT append any step that runs the user's concrete task/);
  assert.match(txt, /dispatched to the built structure SEPARATELY downstream/);
  // Cycle survives as a STRUCTURE shape (edges closed into a cycle), not a registered object.
  assert.match(txt, /closed into a cycle/);
  // non-regression: build-don't-refuse / general machine / design levers preserved
  assert.match(txt, /GENERAL multi-agent machine/);
  assert.match(txt, /skills\.create/);
  assert.match(txt, /agents\.tools/);
  assert.match(txt, /agents\.role/);
});

test("knowledge fragment ⑦ reframed to delivery-boundary; design clauses intact", async () => {
  const ctx = await buildOperatorKnowledgeContext({ requestText: "新任务 新项目 建结构 回路 环 因子" });
  const frag = ctx.selectedFragments.find((f) => f.id === "new-task-workflow");
  assert.ok(frag, "new-task-workflow fragment must be selected");
  assert.doesNotMatch(frag.summary, /必须末尾再 emit runtime\.loop\.start/);
  assert.doesNotMatch(frag.summary, /注入任务才真正运行/);
  assert.doesNotMatch(frag.summary, /runtime\.loop\.|graph\.loop\./);
  assert.match(frag.summary, /交付边界|只设计结构与 agent 内容/);
  assert.match(frag.summary, /skills\.create/);
  assert.match(frag.summary, /graph\.edge\.add/);
  // 迭代 = 把边连成环（识环能力保留，不是另一种对象）
  assert.match(frag.summary, /连成环/);
  assert.match(frag.summary, /inspect\.structure_preview/);
});

test("SKILL playbook: deliverable ends at structure+content+preview; no run-the-task mandate", () => {
  const txt = readFileSync(SKILL, "utf8");
  assert.doesNotMatch(txt, /建好结构\s*≠\s*跑起来/);
  assert.doesNotMatch(txt, /必须再 emit 一步把真实任务送进去/);
  assert.match(txt, /operator 不注入也不运行任务/);
  assert.match(txt, /交付到此为止/);
  // Retired: the playbook must not name a loop surface that no longer exists.
  assert.doesNotMatch(txt, /graph\.loop\.|runtime\.loop\./);
  // non-regression: design steps survive
  assert.match(txt, /skills\.create/);
  assert.match(txt, /graph\.edge\.add/);
  assert.match(txt, /agents\.role/);
});
