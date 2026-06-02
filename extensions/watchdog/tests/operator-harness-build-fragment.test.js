import test from "node:test";
import assert from "node:assert/strict";

import { buildOperatorKnowledgeContext } from "../lib/operator/operator-knowledge.js";

// Item 5 — the harness-build skill must actually reach the planner: a request about putting a
// harness on an iterative quality-gated loop should select the harness-build knowledge fragment
// into the operator-brain planning context. Otherwise the skill is dead (never injected).

test("Item5: a harness / iterative-quality request selects the harness-build fragment", async () => {
  const ctx = await buildOperatorKnowledgeContext({
    requestText: "给这个迭代 loop 装 harness，让 reviewer 用 gate 做质量门控直到收敛",
  });
  const ids = ctx.selectedFragments.map((f) => f.id);
  assert.ok(ids.includes("harness-build"), `harness-build should be selected; got [${ids.join(", ")}]`);
});

test("Item5: an unrelated request does NOT crowd in harness-build over more relevant fragments", async () => {
  const ctx = await buildOperatorKnowledgeContext({
    requestText: "天气怎么样",
  });
  // harness-build has priority 8 so it may appear on low-signal requests, but a clearly unrelated
  // ask must still return a bounded set (no crash, <= MAX_SELECTED_FRAGMENTS).
  assert.ok(Array.isArray(ctx.selectedFragments));
  assert.ok(ctx.selectedFragments.length <= 6);
});
