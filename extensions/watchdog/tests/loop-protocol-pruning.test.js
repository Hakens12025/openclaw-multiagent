import test from "node:test";
import assert from "node:assert/strict";

import {
  INTENT_TYPES,
  isKnownIntentType,
  normalizeSystemIntent,
} from "../lib/protocol-primitives.js";
import { getSemanticSkillSpec } from "../lib/semantic-skill-registry.js";

test("loop system_action intent names are canonical and pipeline aliases are removed", () => {
  assert.equal(INTENT_TYPES.START_LOOP, "start_loop");
  assert.equal(INTENT_TYPES.ADVANCE_LOOP, "advance_loop");
  assert.equal("START_PIPELINE" in INTENT_TYPES, false);
  assert.equal("ADVANCE_PIPELINE" in INTENT_TYPES, false);
  assert.equal(isKnownIntentType("start_loop"), true);
  assert.equal(isKnownIntentType("advance_loop"), true);
  assert.equal(isKnownIntentType("start_pipeline"), false);
  assert.equal(isKnownIntentType("advance_pipeline"), false);
});

test("normalizeSystemIntent preserves canonical start_loop and does not revive legacy pipeline actions", () => {
  const normalized = normalizeSystemIntent({
    action: "start_loop",
    params: {
      startAgent: "researcher",
      requestedTask: "验证 loop graph-router 真值",
    },
  });

  assert.equal(normalized.type, INTENT_TYPES.START_LOOP);
  assert.equal(normalized.protocol.intentType, INTENT_TYPES.START_LOOP);
  assert.equal(normalized.params?.startAgent, "researcher");
  assert.equal(normalized.params?.requestedTask, "验证 loop graph-router 真值");

  const legacy = normalizeSystemIntent({
    action: "start_pipeline",
    params: {
      startAgent: "researcher",
    },
  });

  assert.equal(legacy.type, "start_pipeline");
  assert.equal(isKnownIntentType(legacy.type), false);
});

test("system-action semantic skill only advertises loop actions", () => {
  const spec = getSemanticSkillSpec("system-action");
  assert.deepEqual(
    spec?.toolRefs?.filter((entry) => entry.includes("loop") || entry.includes("pipeline")),
    ["start_loop", "advance_loop"],
  );
});
