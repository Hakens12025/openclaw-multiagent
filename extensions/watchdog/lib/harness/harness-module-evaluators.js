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
  normalizeModuleResult,
  getModuleDefinition,
  resolveHarnessModuleConfig,
  resolveTimeoutBudgetSeconds,
  buildBaseEvidence,
} from "./harness-module-evidence.js";

import { GUARD_REGISTRY } from "./harness-guard-registry.js";

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
      const schemaValid = normalizedBase.stageResult?.metadata?.schemaValid === true;
      const stageSchemaValid = normalizedBase.stageResult?.metadata?.stageSchemaValid === true;
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
