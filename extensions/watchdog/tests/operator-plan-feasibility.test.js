import test from "node:test";
import assert from "node:assert/strict";

import { assertOperatorPlanAgentFeasibility, collectOperatorPlanInfeasibilities, normalizeOperatorPlan } from "../lib/operator/operator-plan.js";
import { listAgentRegistry } from "../lib/management/capability-registry.js";

// E2 pre-flight feasibility: a STRUCTURE-creating step (edge/loop/group) referencing an agent that
// neither already exists nor is created by an earlier step in the SAME plan must be rejected before
// any step applies (else the structure half-applies then throws). agents.* mutations are NOT checked.

async function anchorAgentId() {
  const ids = (await listAgentRegistry()).map((a) => a?.id).filter(Boolean);
  assert.ok(ids.length > 0, "need at least one live agent");
  return ids[0];
}

test("E2: edge → non-existent agent is rejected (OPERATOR_PLAN_AGENT_INFEASIBLE)", async () => {
  const anchor = await anchorAgentId();
  const plan = normalizeOperatorPlan({
    intent: "platform_mutation", summary: "dangling edge",
    steps: [{ surfaceId: "graph.edge.add", title: "e", summary: "e", payload: { from: anchor, to: "no-such-ghost-agent-e2e" } }],
  });
  await assert.rejects(
    () => assertOperatorPlanAgentFeasibility(plan),
    (err) => {
      assert.equal(err.code, "OPERATOR_PLAN_AGENT_INFEASIBLE");
      assert.ok(err.failures.some((f) => f.missingAgentId === "no-such-ghost-agent-e2e"));
      return true;
    },
  );
});

test("E2: edge → an agent created earlier in the SAME plan is allowed", async () => {
  const anchor = await anchorAgentId();
  const plan = normalizeOperatorPlan({
    intent: "platform_mutation", summary: "create then wire",
    steps: [
      { surfaceId: "agents.create", title: "c", summary: "c", payload: { id: "fresh-e2e-agent", role: "worker" } },
      { surfaceId: "graph.edge.add", title: "e", summary: "e", payload: { from: "fresh-e2e-agent", to: anchor } },
    ],
  });
  await assert.doesNotReject(() => assertOperatorPlanAgentFeasibility(plan));
});

test("E2: edge BEFORE its create (wrong order) is rejected", async () => {
  const anchor = await anchorAgentId();
  const plan = normalizeOperatorPlan({
    intent: "platform_mutation", summary: "wrong order",
    steps: [
      { surfaceId: "graph.edge.add", title: "e", summary: "e", payload: { from: "later-created-e2e", to: anchor } },
      { surfaceId: "agents.create", title: "c", summary: "c", payload: { id: "later-created-e2e", role: "worker" } },
    ],
  });
  await assert.rejects(() => assertOperatorPlanAgentFeasibility(plan), (err) => err.code === "OPERATOR_PLAN_AGENT_INFEASIBLE");
});

// E2b — the NON-throwing core that powers the plan-build canExecute downgrade (buildOperatorPlan).
test("E2b: collectOperatorPlanInfeasibilities returns failures (no throw) for a dangling edge", async () => {
  const anchor = await anchorAgentId();
  const plan = normalizeOperatorPlan({
    intent: "platform_mutation", summary: "dangling edge",
    steps: [{ surfaceId: "graph.edge.add", title: "e", summary: "e", payload: { from: anchor, to: "no-such-ghost-agent-e2b" } }],
  });
  const failures = await collectOperatorPlanInfeasibilities(plan);
  assert.ok(failures.some((f) => f.missingAgentId === "no-such-ghost-agent-e2b"));
});

test("E2b: collectOperatorPlanInfeasibilities returns [] for a feasible create-then-wire plan", async () => {
  const anchor = await anchorAgentId();
  const plan = normalizeOperatorPlan({
    intent: "platform_mutation", summary: "create then wire",
    steps: [
      { surfaceId: "agents.create", title: "c", summary: "c", payload: { id: "fresh-e2b-agent", role: "worker" } },
      { surfaceId: "graph.edge.add", title: "e", summary: "e", payload: { from: "fresh-e2b-agent", to: anchor } },
    ],
  });
  assert.deepEqual(await collectOperatorPlanInfeasibilities(plan), []);
});
