import { uniqueStrings } from "../core/normalize.js";
import { resolveTimeoutBudgetSeconds } from "./harness-module-evidence.js";
import {
  evaluateToolAccessGuard,
  evaluateScopeGuard,
} from "./harness-guard-checks.js";

// ---------------------------------------------------------------------------
// Guard registry — each guard defined once.
//
// Guards with identical start/final decision logic use `evaluate()`.
// Guards with divergent start/final logic use `start()` and `final()`.
// ---------------------------------------------------------------------------

export const GUARD_REGISTRY = {
  "harness:guard.tool_access": { evaluate: evaluateToolAccessGuard },
  "harness:guard.scope": { evaluate: evaluateScopeGuard },

  "harness:guard.budget": {
    start(ctx) {
      const { timeoutBudgetSeconds, retryBudget } = ctx;
      const hasTimeout = !!timeoutBudgetSeconds;
      const hasRetry = Number.isFinite(retryBudget);
      if (!hasTimeout && !hasRetry) {
        return { status: "skipped", summary: "no budget constraints configured", reason: "budget_missing", evidence: { timeoutBudgetSeconds: null, maxRetry: null } };
      }
      return {
        status: hasTimeout ? "pending" : "passed",
        summary: [hasTimeout ? `timeout ${timeoutBudgetSeconds}s armed` : null, hasRetry ? `retry budget ${retryBudget}` : null].filter(Boolean).join("; "),
        reason: hasTimeout ? "budget_armed" : "retry_budget_declared",
        evidence: { timeoutBudgetSeconds: timeoutBudgetSeconds || null, maxRetry: retryBudget },
      };
    },
    final(ctx) {
      const { automationSpec, run, base } = ctx;
      const timeoutBudgetSeconds = resolveTimeoutBudgetSeconds(automationSpec, run);
      const retryBudget = ctx.retryBudget;

      let timeoutStatus = "skipped";
      let timeoutSummary = "no timeout configured";
      if (timeoutBudgetSeconds) {
        const exceeded = Number.isFinite(base.durationMs) && base.durationMs > (timeoutBudgetSeconds * 1000);
        timeoutStatus = exceeded ? "failed" : "passed";
        timeoutSummary = exceeded ? `exceeded ${timeoutBudgetSeconds}s` : `within ${timeoutBudgetSeconds}s`;
      }

      const retryStatus = Number.isFinite(retryBudget) ? "passed" : "skipped";
      const worstStatus = timeoutStatus === "failed" ? "failed" : (timeoutStatus === "passed" || retryStatus === "passed") ? "passed" : "skipped";

      return {
        status: worstStatus,
        summary: `timeout: ${timeoutSummary}` + (Number.isFinite(retryBudget) ? `; retry budget: ${retryBudget}` : ""),
        reason: worstStatus === "failed" ? "timeout_budget_exceeded" : worstStatus === "passed" ? "budget_ok" : "budget_missing",
        evidence: { timeoutBudgetSeconds, durationMs: base.durationMs, maxRetry: retryBudget },
      };
    },
  },

  "harness:collector.trace": {
    start(ctx) {
      const { ids } = ctx;
      const hasIdentity = ids.contractId || ids.pipelineId || ids.loopId;
      return {
        status: hasIdentity ? "passed" : "pending",
        summary: hasIdentity ? "trace identity captured" : "waiting for identity",
        reason: hasIdentity ? "trace_bound" : "trace_pending",
        evidence: ids,
      };
    },
    final(ctx) {
      const { run } = ctx;
      const hasIdentity = run?.contractId || run?.pipelineId || run?.loopId;
      return {
        status: hasIdentity ? "passed" : "failed",
        summary: hasIdentity ? "trace identity captured" : "trace identity missing",
        reason: hasIdentity ? "trace_bound" : "trace_missing",
        evidence: { contractId: run?.contractId || null, pipelineId: run?.pipelineId || null, loopId: run?.loopId || null },
      };
    },
  },
};
