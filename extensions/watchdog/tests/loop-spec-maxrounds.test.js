import test from "node:test";
import assert from "node:assert/strict";

import { composeLoopSpecFromAgents } from "../lib/loop/graph-loop-registry.js";
import {
  DEFAULT_LOOP_MAX_ROUNDS,
  resolveLoopStartBudget,
} from "../lib/loop/loop-budget.js";

// ⑥ 环自带 limit: LoopSpec carries a declarative maxRounds; runtime budget resolves
// it as the structural cap so a loop force-concludes even with no conclude-emitting agent.

test("LoopSpec declares maxRounds and it survives normalization", () => {
  const spec = composeLoopSpecFromAgents(["researcher1", "worker-e", "reviewer1"], {
    entryAgentId: "researcher1",
    maxRounds: 4,
  });
  assert.equal(spec.maxRounds, 4, "declared maxRounds must persist on the LoopSpec");
  assert.equal(spec.entryAgentId, "researcher1");
  assert.equal(spec.nodes.length, 3);
});

test("LoopSpec without maxRounds omits the field (clean registry, falls through to default)", () => {
  const spec = composeLoopSpecFromAgents(["planner", "worker"], {});
  assert.ok(!("maxRounds" in spec), "undeclared maxRounds must not be persisted as null/noise");
});

test("invalid (<=0 / non-numeric) maxRounds is dropped, not forced to a bad cap", () => {
  for (const bad of [0, -2, "abc", null]) {
    const spec = composeLoopSpecFromAgents(["planner", "worker"], { maxRounds: bad });
    assert.ok(!("maxRounds" in spec), `maxRounds=${JSON.stringify(bad)} must be dropped`);
  }
});

test("resolveLoopStartBudget uses LoopSpec.maxRounds as the structural cap (not the global default)", () => {
  const loopSpec = composeLoopSpecFromAgents(["a", "b"], { maxRounds: 2 });
  const budget = resolveLoopStartBudget({ startAgent: "a" }, { loopSpec });
  assert.equal(budget.maxRounds, 2, "LoopSpec.maxRounds must be the truth source when config is silent");
});

test("resolveLoopStartBudget falls through to DEFAULT_LOOP_MAX_ROUNDS when nothing declares a cap", () => {
  const loopSpec = composeLoopSpecFromAgents(["a", "b"], {}); // no maxRounds declared
  const budget = resolveLoopStartBudget({ startAgent: "a" }, { loopSpec });
  assert.equal(budget.maxRounds, DEFAULT_LOOP_MAX_ROUNDS, "undeclared cap → platform default floor");
});

test("explicit runtime config overrides LoopSpec.maxRounds (precedence: config > spec > default)", () => {
  const loopSpec = composeLoopSpecFromAgents(["a", "b"], { maxRounds: 2 });
  const budget = resolveLoopStartBudget({ startAgent: "a", maxRounds: 7 }, { loopSpec });
  assert.equal(budget.maxRounds, 7, "explicit runtime maxRounds must win over the LoopSpec cap");
});

test("no loopSpec passed → behavior unchanged (backward compatible, default applies)", () => {
  const budget = resolveLoopStartBudget({ startAgent: "a" });
  assert.equal(budget.maxRounds, DEFAULT_LOOP_MAX_ROUNDS);
});
