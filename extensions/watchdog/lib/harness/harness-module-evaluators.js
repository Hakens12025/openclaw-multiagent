import { normalizeHarnessRun } from "./harness-run.js";
import { normalizeString, uniqueStrings, uniqueTools } from "../core/normalize.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import {
  buildHarnessModuleFinalizeInput,
  buildHarnessModuleStartInput,
} from "./harness-module-contract.js";

import {
  NETWORK_CAPABLE_TOOLS,
  normalizePositiveInteger,
  expandConfiguredPath,
  isPathInsideRoot,
  normalizeModuleResult,
  getModuleDefinition,
  resolveHarnessModuleConfig,
  resolveTimeoutBudgetSeconds,
  buildBaseEvidence,
} from "./harness-module-evidence.js";

// ---------------------------------------------------------------------------
// Shared guard helpers
// ---------------------------------------------------------------------------

function evaluateToolWhitelist(ctx) {
  const { moduleConfig, targetTools, allowedTools, configuredAllowedTools, executionContext } = ctx;
  const mode = normalizeString(moduleConfig.mode)?.toLowerCase() === "exact" ? "exact" : "subset";
  const extraTools = targetTools.filter((tool) => !allowedTools.includes(tool));
  const missingAllowedTools = allowedTools.filter((tool) => !targetTools.includes(tool));
  const matched = mode === "exact"
    ? extraTools.length === 0 && missingAllowedTools.length === 0
    : extraTools.length === 0;
  return {
    status: matched ? "passed" : "failed",
    summary: configuredAllowedTools.length > 0
      ? (matched ? "tool whitelist satisfied" : "tool whitelist drift detected")
      : "declared tool surface captured as whitelist",
    reason: configuredAllowedTools.length > 0
      ? (matched ? "tool_whitelist_matched" : "tool_whitelist_drift")
      : "tool_surface_declared",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      mode,
      targetTools,
      allowedTools,
      extraTools,
      missingAllowedTools,
    },
  };
}

function evaluateSandboxPolicy(ctx) {
  const { moduleConfig, workspaceDir, effectiveWorkspaceRoots, executionContext } = ctx;
  const policy = normalizeString(moduleConfig.policy)?.toLowerCase() || null;
  if (!policy && effectiveWorkspaceRoots.length === 0) {
    return {
      status: "skipped",
      summary: "no explicit sandbox policy configured",
      reason: "sandbox_policy_missing",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        workspaceDir,
      },
    };
  }
  const workspaceAllowed = workspaceDir
    ? (effectiveWorkspaceRoots.length === 0 || effectiveWorkspaceRoots.some((root) => isPathInsideRoot(workspaceDir, root)))
    : false;
  return {
    status: workspaceAllowed ? "passed" : "failed",
    summary: workspaceAllowed ? "sandbox policy anchored to workspace scope" : "sandbox workspace scope mismatch",
    reason: workspaceAllowed ? "sandbox_policy_declared" : "sandbox_scope_mismatch",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      policy,
      workspaceDir,
      allowedWorkspaceRoots: effectiveWorkspaceRoots,
    },
  };
}

function evaluateNetworkPolicy(ctx) {
  const { moduleConfig, networkTools, executionContext } = ctx;
  if (networkTools.length === 0) {
    return {
      status: "passed",
      summary: "network closed by declared tool surface",
      reason: "network_closed",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        networkTools,
        allowNetwork: false,
      },
    };
  }
  if (moduleConfig.allowNetwork === true) {
    return {
      status: "passed",
      summary: "network-capable tools allowed by explicit policy",
      reason: "network_policy_open",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        networkTools,
        allowNetwork: true,
        allowedDomains: uniqueStrings(moduleConfig.allowedDomains || []),
      },
    };
  }
  if (moduleConfig.allowNetwork === false) {
    return {
      status: "failed",
      summary: "network-capable tools violate closed network policy",
      reason: "network_policy_violation",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        networkTools,
        allowNetwork: false,
      },
    };
  }
  return {
    status: "skipped",
    summary: "network-capable tools present but policy missing",
    reason: "network_policy_missing",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      networkTools,
      allowNetwork: null,
    },
  };
}

function evaluateWorkspaceScope(ctx) {
  const { workspaceDir, effectiveWorkspaceRoots, executionContext } = ctx;
  if (!workspaceDir || effectiveWorkspaceRoots.length === 0) {
    return {
      status: "failed",
      summary: "workspace scope could not be resolved",
      reason: "workspace_scope_missing",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        workspaceDir,
        allowedWorkspaceRoots: effectiveWorkspaceRoots,
      },
    };
  }
  const withinScope = effectiveWorkspaceRoots.some((root) => isPathInsideRoot(workspaceDir, root));
  return {
    status: withinScope ? "passed" : "failed",
    summary: withinScope ? "workspace scope resolved" : "workspace outside allowed roots",
    reason: withinScope ? "workspace_scope_ok" : "workspace_scope_violation",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      workspaceDir,
      allowedWorkspaceRoots: effectiveWorkspaceRoots,
    },
  };
}

// ---------------------------------------------------------------------------
// Merged guard wrappers — combine sub-checks, worst status wins
// ---------------------------------------------------------------------------

function combineStatuses(a, b) {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "passed" && b === "passed") return "passed";
  if (a === "skipped" && b === "skipped") return "skipped";
  return a;
}

function evaluateToolAccessGuard(ctx) {
  const whitelistResult = evaluateToolWhitelist(ctx);
  const networkResult = evaluateNetworkPolicy(ctx);
  const worstStatus = combineStatuses(whitelistResult.status, networkResult.status);
  return {
    status: worstStatus,
    summary: `tool_access: ${whitelistResult.summary}; network: ${networkResult.summary}`,
    reason: worstStatus === "failed" ? (whitelistResult.status === "failed" ? whitelistResult.reason : networkResult.reason) : whitelistResult.reason,
    evidence: { toolWhitelist: whitelistResult.evidence, networkPolicy: networkResult.evidence },
  };
}

function evaluateScopeGuard(ctx) {
  const sandboxResult = evaluateSandboxPolicy(ctx);
  const workspaceResult = evaluateWorkspaceScope(ctx);
  const worstStatus = combineStatuses(sandboxResult.status, workspaceResult.status);
  return {
    status: worstStatus,
    summary: `sandbox: ${sandboxResult.summary}; workspace: ${workspaceResult.summary}`,
    reason: worstStatus === "failed" ? (sandboxResult.status === "failed" ? sandboxResult.reason : workspaceResult.reason) : sandboxResult.reason,
    evidence: { sandboxPolicy: sandboxResult.evidence, workspaceScope: workspaceResult.evidence },
  };
}

// ---------------------------------------------------------------------------
// Guard registry — each guard defined once.
//
// Guards with identical start/final decision logic use `evaluate()`.
// Guards with divergent start/final logic use `start()` and `final()`.
// ---------------------------------------------------------------------------

const GUARD_REGISTRY = {
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

// ---------------------------------------------------------------------------
// Shared context builder — computes all derived values used by guards
// ---------------------------------------------------------------------------

function buildGuardContext(moduleId, run, automationSpec, executionContext) {
  const moduleConfig = resolveHarnessModuleConfig(automationSpec, moduleId);
  const targetTools = uniqueTools(executionContext?.tools || []);
  const configuredAllowedTools = uniqueTools(moduleConfig.allowedTools || []);
  const allowedTools = configuredAllowedTools.length > 0 ? configuredAllowedTools : targetTools;
  const workspaceDir = normalizeString(executionContext?.workspaceDir) || null;
  const configuredWorkspaceRoots = uniqueStrings(moduleConfig.allowedWorkspaceRoots || [])
    .map((entry) => expandConfiguredPath(entry))
    .filter(Boolean);
  const effectiveWorkspaceRoots = moduleId === "harness:guard.scope"
    ? (configuredWorkspaceRoots.length > 0
      ? configuredWorkspaceRoots
      : (workspaceDir ? [expandConfiguredPath(workspaceDir)] : []))
    : configuredWorkspaceRoots;
  const networkTools = targetTools.filter((tool) => NETWORK_CAPABLE_TOOLS.has(tool));
  const retryBudget = normalizePositiveInteger(
    moduleConfig.maxRetry ?? executionContext?.constraints?.maxRetry,
    null,
  );

  return {
    moduleConfig,
    targetTools,
    configuredAllowedTools,
    allowedTools,
    workspaceDir,
    effectiveWorkspaceRoots,
    networkTools,
    retryBudget,
    executionContext,
  };
}

// ---------------------------------------------------------------------------
// Start-phase pending modules (no start-time evaluation, just "pending")
// ---------------------------------------------------------------------------

const START_PENDING_MODULES = new Set([
  "harness:collector.artifact",
  "harness:gate.artifact",
  "harness:gate.test",
  "harness:gate.schema",
  "harness:normalizer.eval_input",
  "harness:normalizer.failure",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildStartModuleRun(moduleId, harnessRun, automationSpec, executionContext = null) {
  const input = buildHarnessModuleStartInput({
    module: getModuleDefinition(moduleId),
    moduleId,
    harnessRun,
    automationSpec,
    executionContext,
  });
  const module = input?.module || getModuleDefinition(moduleId);
  const run = normalizeHarnessRun(input?.run || harnessRun);
  const timeoutBudgetSeconds = resolveTimeoutBudgetSeconds(automationSpec, run);
  const ids = {
    contractId: run?.contractId || null,
    pipelineId: run?.pipelineId || null,
    loopId: run?.loopId || null,
  };

  // --- Registry guards ---
  const guard = GUARD_REGISTRY[moduleId];
  if (guard) {
    const ctx = buildGuardContext(
      moduleId,
      run,
      input?.automationSpec || automationSpec,
      input?.executionContext || executionContext,
    );
    ctx.timeoutBudgetSeconds = timeoutBudgetSeconds;
    ctx.ids = ids;
    const result = guard.evaluate
      ? guard.evaluate(ctx)
      : guard.start(ctx);
    return normalizeModuleResult({
      moduleId,
      kind: module.kind,
      hardShaped: module.hardShaped,
      startedAt: run?.startedAt || null,
      ...result,
    });
  }

  // --- Modules that wait for terminal evidence ---
  if (START_PENDING_MODULES.has(moduleId)) {
    return normalizeModuleResult({
      moduleId,
      kind: module.kind,
      hardShaped: module.hardShaped,
      status: "pending",
      summary: "waiting for terminal evidence",
      reason: "awaiting_terminal_evidence",
      startedAt: run?.startedAt || null,
    });
  }

  // --- Default fallback ---
  return normalizeModuleResult({
    moduleId,
    kind: module.kind,
    hardShaped: module.hardShaped,
    status: "skipped",
    summary: "module runner not implemented yet",
    reason: "module_not_implemented",
    startedAt: run?.startedAt || null,
  });
}

export function buildFinalModuleRun(moduleId, harnessRun, automationSpec, terminalSource, context, executionContext = null) {
  const run = normalizeHarnessRun(harnessRun);
  const base = buildBaseEvidence(run, terminalSource, context);
  const input = buildHarnessModuleFinalizeInput({
    module: getModuleDefinition(moduleId),
    moduleId,
    harnessRun,
    automationSpec,
    executionContext,
    terminalSource,
    baseEvidence: base,
  });
  const module = input?.module || getModuleDefinition(moduleId);
  const normalizedRun = normalizeHarnessRun(input?.run || harnessRun);
  const normalizedBase = input?.baseEvidence || base;
  const common = {
    moduleId,
    kind: module.kind,
    hardShaped: module.hardShaped,
    startedAt: normalizedRun?.startedAt || null,
    finalizedAt: normalizedBase.finalizedAt,
  };

  // --- Registry guards ---
  const guard = GUARD_REGISTRY[moduleId];
  if (guard) {
    const ctx = buildGuardContext(
      moduleId,
      normalizedRun,
      input?.automationSpec || automationSpec,
      input?.executionContext || executionContext,
    );
    ctx.automationSpec = input?.automationSpec || automationSpec;
    ctx.run = normalizedRun;
    ctx.base = normalizedBase;
    const result = guard.evaluate
      ? guard.evaluate(ctx)
      : guard.final(ctx);
    return normalizeModuleResult({ ...common, ...result });
  }

  // --- Final-only modules ---
  switch (moduleId) {
    case "harness:collector.artifact": {
      const path = normalizedBase.artifact.path || "";
      const looksLikeDiff = /\.patch$/i.test(path) || /\.diff$/i.test(path);
      return normalizeModuleResult({
        ...common,
        status: normalizedBase.artifact.present ? "passed" : "skipped",
        summary: normalizedBase.artifact.present ? "artifact captured" : "no artifact emitted",
        reason: normalizedBase.artifact.present ? "artifact_captured" : "artifact_missing",
        evidence: {
          ...normalizedBase.artifact,
          looksLikeDiff,
        },
      });
    }
    case "harness:gate.artifact": {
      // Aggregate required artifact, stage artifact set, and experiment linkage checks.
      const artifactPresent = normalizedBase.artifact.present;
      const missing = normalizedBase.missingArtifacts || [];
      const experimentConnected = normalizedBase.terminalStatus === CONTRACT_STATUS.COMPLETED
        && (artifactPresent || normalizedBase.summary || normalizedBase.score != null);

      const artifactStatus = artifactPresent ? "passed" : "failed";
      const stageStatus = missing.length === 0 ? "passed" : "failed";
      const experimentStatus = experimentConnected ? "passed" : "failed";

      const worstStatus = artifactStatus === "failed" || stageStatus === "failed" || experimentStatus === "failed"
        ? "failed"
        : "passed";

      return normalizeModuleResult({
        ...common,
        status: worstStatus,
        summary: worstStatus === "passed"
          ? "artifact gate passed"
          : [
              !artifactPresent ? "required artifact missing" : null,
              missing.length > 0 ? "missing required stage artifacts" : null,
              !experimentConnected ? "experiment output not connected" : null,
            ].filter(Boolean).join("; "),
        reason: worstStatus === "passed" ? "artifact_gate_ok" : "artifact_gate_failed",
        evidence: {
          artifact: normalizedBase.artifact,
          stageArtifacts: {
            stage: normalizedBase.stageResult?.stage || null,
            missing,
            artifactCount: Array.isArray(normalizedBase.stageResult?.artifacts) ? normalizedBase.stageResult.artifacts.length : 0,
          },
          experiment: {
            terminalStatus: normalizedBase.terminalStatus,
            score: normalizedBase.score,
            summaryPresent: Boolean(normalizedBase.summary),
          },
        },
      });
    }
    case "harness:gate.schema": {
      // Schema gate uses stage metadata; missing or invalid schema fails.
      const schemaValid = normalizedBase.stageResult?.metadata?.schemaValid === true;
      const stageSchemaValid = normalizedBase.stageResult?.metadata?.schemaValid === true;
      const allValid = schemaValid && stageSchemaValid;
      return normalizeModuleResult({
        ...common,
        status: allValid ? "passed" : "failed",
        summary: allValid ? "schema validated" : "schema missing or invalid",
        reason: allValid ? "schema_valid" : "schema_invalid",
        evidence: {
          stage: normalizedBase.stageResult?.stage || null,
          schemaMeta: normalizedBase.stageResult?.metadata?.schema || null,
          schemaValid,
        },
      });
    }
    case "harness:gate.test":
      if (normalizedBase.testSignal.status === "passed") {
        return normalizeModuleResult({
          ...common,
          status: "passed",
          summary: "explicit test pass signal observed",
          reason: "test_signal_passed",
          evidence: normalizedBase.testSignal,
        });
      }
      return normalizeModuleResult({
        ...common,
        status: "failed",
        summary: normalizedBase.testSignal.status === "failed"
          ? "explicit failing test signal observed"
          : "missing explicit test pass signal",
        reason: normalizedBase.testSignal.status === "failed" ? "test_signal_failed" : "missing_test_signal",
        evidence: normalizedBase.testSignal,
      });
    case "harness:normalizer.eval_input": {
      // Pass when terminal evidence or staged evaluation input can seed evaluator input.
      const primaryReady = normalizedBase.artifact.present || normalizedBase.summary || normalizedBase.score != null;
      const evaluationInput = normalizedBase.stageResult?.evaluationInput;
      const stageReady = evaluationInput && typeof evaluationInput === "object" && Object.keys(evaluationInput).length > 0;
      const ready = primaryReady || stageReady;
      return normalizeModuleResult({
        ...common,
        status: ready ? "passed" : "failed",
        summary: ready
          ? "evaluation input normalized from terminal evidence"
          : "terminal evidence insufficient for evaluation input",
        reason: ready ? "evaluation_input_ready" : "evaluation_input_missing",
        evidence: {
          artifactPresent: normalizedBase.artifact.present,
          score: normalizedBase.score,
          summaryPresent: Boolean(normalizedBase.summary),
          stageEvaluationInput: stageReady ? evaluationInput : null,
          stage: normalizedBase.stageResult?.stage || null,
        },
      });
    }
    case "harness:normalizer.failure":
      return normalizeModuleResult({
        ...common,
        status: normalizedBase.failureClass ? "passed" : "skipped",
        summary: normalizedBase.failureClass
          ? `failure classified as ${normalizedBase.failureClass}`
          : "run completed without failure classification",
        reason: normalizedBase.failureClass ? "failure_classified" : "no_failure_to_classify",
        evidence: {
          failureClass: normalizedBase.failureClass,
          terminalStatus: normalizedBase.terminalStatus,
        },
      });
    default:
      return normalizeModuleResult({
        ...common,
        status: "skipped",
        summary: "module runner not implemented yet",
        reason: "module_not_implemented",
      });
  }
}
