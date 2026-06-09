import test from "node:test";
import assert from "node:assert/strict";

import { composeLoopSpecFromAgents } from "../lib/loop/graph-loop-registry.js";
import {
  DEFAULT_LOOP_MAX_ROUNDS,
  buildLoopBudgetEcho,
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

test("invalid (<=0 / non-numeric / 空串) maxRounds is dropped, not forced to a bad cap", () => {
  // 空串 "" 是 operator 生成 loop 时未填 maxRounds 的真实形态(graph.loop.compose payload）——
  // 必须和 0/-2/"abc"/null 一样被丢弃,绝不作为脏值存进 spec 流到下游。
  for (const bad of [0, -2, "abc", null, "", "  ", NaN]) {
    const spec = composeLoopSpecFromAgents(["planner", "worker"], { maxRounds: bad, maxExperiments: bad });
    assert.ok(!("maxRounds" in spec), `maxRounds=${JSON.stringify(bad)} must be dropped`);
    assert.ok(!("maxExperiments" in spec), `maxExperiments=${JSON.stringify(bad)} must be dropped`);
  }
});

test("空串 maxRounds(operator 默认未填)→ 有界:resolveLoopStartBudget 兜底到 DEFAULT(不无界)", () => {
  // 钉死用户场景:operator 生成的 loop payload maxRounds:"" → spec 不存该字段 → 启动预算兜底 DEFAULT。
  const spec = composeLoopSpecFromAgents(["researcher1", "worker3", "reviewer1"], {
    entryAgentId: "researcher1",
    maxRounds: "",
    maxExperiments: "",
  });
  const budget = resolveLoopStartBudget({}, { loopSpec: spec });
  assert.equal(budget.maxRounds, DEFAULT_LOOP_MAX_ROUNDS, "空串 maxRounds → 有界 DEFAULT(环自带 limit,非无界)");
  assert.ok(budget.maxRounds > 0, "有效上限必 > 0(force-conclude 才会触发)");
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

// graph.loop.compose 响应回显:让 operator/调用方看见有效上限(透明度,composeGraphLoop 调此 helper）。
test("buildLoopBudgetEcho:未声明 maxRounds → resolvedBudget 兜底 DEFAULT + source=default", () => {
  const spec = composeLoopSpecFromAgents(["researcher1", "worker3", "reviewer1"], { entryAgentId: "researcher1" });
  const echo = buildLoopBudgetEcho(spec, { normMaxRounds: null, normMaxExperiments: null });
  assert.equal(echo.resolvedBudget.maxRounds, DEFAULT_LOOP_MAX_ROUNDS, "未声明 → 回显有效上限=DEFAULT(可见有界)");
  assert.equal(echo.budgetSource.maxRounds, "default", "未声明 → source=default");
  assert.equal(echo.budgetSource.maxExperiments, "default");
});

test("buildLoopBudgetEcho:显式 maxRounds=5 → resolvedBudget 5 + source=declared", () => {
  const spec = composeLoopSpecFromAgents(["a", "b"], { maxRounds: 5 });
  const echo = buildLoopBudgetEcho(spec, { normMaxRounds: 5, normMaxExperiments: null });
  assert.equal(echo.resolvedBudget.maxRounds, 5);
  assert.equal(echo.budgetSource.maxRounds, "declared", "显式声明 → source=declared");
  assert.equal(echo.budgetSource.maxExperiments, "default", "未声明 maxExperiments → default");
});
