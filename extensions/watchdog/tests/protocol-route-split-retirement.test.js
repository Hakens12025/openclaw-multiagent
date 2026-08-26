import test from "node:test";
import assert from "node:assert/strict";

import {
  INTENT_TYPES,
  annotateExecutionContract,
  isKnownIntentType,
  normalizeSystemIntent,
} from "../lib/protocol/protocol-primitives.js";
import { getSemanticSkillSpec } from "../lib/prompt/semantic-skill-registry.js";

// 2026-08-18 loop 退役:本文件原名 loop-protocol-pruning,原先靠 start_loop/advance_loop
// 在场来证明「现代 loop 动作已取代 legacy start_pipeline」。回路机制退役后两个 intent
// 一并消失,锁的方向反转为「pipeline 与 loop 两族编排动作都不得再回到词表」。
// legacy 别名不复活这层保护由本文件承担,与回路本身是否存在无关。
test("retired orchestration intents never revive in the intent vocabulary", () => {
  for (const key of ["START_LOOP", "ADVANCE_LOOP", "START_PIPELINE", "ADVANCE_PIPELINE", "RESUME_FINALIZATION"]) {
    assert.equal(key in INTENT_TYPES, false, `${key} must not be in INTENT_TYPES`);
  }
  for (const name of ["start_loop", "advance_loop", "start_pipeline", "advance_pipeline", "resume_finalization"]) {
    assert.equal(isKnownIntentType(name), false, `${name} must not be a known intent type`);
  }
});

test("normalizeSystemIntent does not revive retired orchestration actions", () => {
  for (const action of ["start_loop", "advance_loop", "start_pipeline"]) {
    const normalized = normalizeSystemIntent({
      action,
      params: { startAgent: "researcher" },
    });

    assert.equal(normalized.type, action, "normalize keeps the raw verb as-is");
    assert.equal(isKnownIntentType(normalized.type), false, `${action} must stay unknown`);
  }
});

test("system-action semantic skill advertises no loop or pipeline actions", () => {
  const spec = getSemanticSkillSpec("system-action");
  assert.deepEqual(
    spec?.toolRefs?.filter((entry) => entry.includes("loop") || entry.includes("pipeline")),
    [],
  );
});

test("execution contract annotation strips legacy route split truth", () => {
  const annotated = annotateExecutionContract({
    id: "TC-ROUTE-LEGACY",
    task: "route split residue should not survive annotation",
    assignee: "worker",
    protocol: {
      envelope: "execution_contract",
      route: "long",
    },
  });

  assert.equal(annotated.protocol.envelope, "execution_contract");
  assert.equal("route" in annotated.protocol, false);
});
