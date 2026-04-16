import { relative, resolve } from "node:path";

import { listAgentRegistry } from "../capability/capability-registry.js";
import { getHarnessModule, resolveModuleId } from "./harness-registry.js";
import {
  normalizeHarnessRun,
  normalizeHarnessModuleRun,
} from "./harness-run.js";
import { normalizeRecord, normalizeString, normalizePositiveInteger, normalizeFiniteNumber, uniqueTools } from "../core/normalize.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { agentWorkspace } from "../state-agent-helpers.js";
import { HOME } from "../state-paths.js";
import {
  normalizeStageCompletion,
  normalizeStageRunResult,
  resolveStageArtifactEvidence,
  listMissingStageArtifacts,
} from "./stage-harness.js";
import { normalizeExecutionObservation } from "../execution-observation.js";

const POSITIVE_TEST_TOKENS = new Set([
  "approve",
  "approved",
  "pass",
  "passed",
  "success",
  "succeeded",
  "ok",
  "green",
]);

const NEGATIVE_TEST_TOKENS = new Set([
  "reject",
  "rejected",
  "fail",
  "failed",
  "error",
  "errors",
  "red",
]);

export const NETWORK_CAPABLE_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "browser",
]);

// Re-export for consumers that import from this module
export { normalizePositiveInteger, normalizeFiniteNumber };

function normalizeBooleanish(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "pass", "passed", "ok", "approve", "approved"].includes(normalized)) return true;
  if (["0", "false", "no", "fail", "failed", "reject", "rejected"].includes(normalized)) return false;
  return null;
}

export function expandConfiguredPath(filePath) {
  const normalized = normalizeString(filePath);
  if (!normalized) return null;
  return resolve(normalized.replace(/^~(?=\/|$)/, HOME));
}

export function isPathInsideRoot(targetPath, rootPath) {
  const normalizedTarget = expandConfiguredPath(targetPath);
  const normalizedRoot = expandConfiguredPath(rootPath);
  if (!normalizedTarget || !normalizedRoot) return false;
  const relation = relative(normalizedRoot, normalizedTarget);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"));
}

export function normalizeModuleResult({
  moduleId,
  kind,
  hardShaped = [],
  status = "pending",
  summary = null,
  reason = null,
  evidence = null,
  startedAt = null,
  finalizedAt = null,
} = {}) {
  return normalizeHarnessModuleRun({
    moduleId,
    kind,
    hardShaped,
    status,
    summary,
    reason,
    evidence,
    startedAt,
    finalizedAt,
  });
}

export function getModuleDefinition(moduleId) {
  const module = getHarnessModule(moduleId);
  return module || {
    id: moduleId,
    kind: null,
    hardShaped: [],
  };
}

export function listModuleIds(run) {
  const runModuleIds = Array.isArray(run?.moduleRuns)
    ? run.moduleRuns.map((entry) => entry?.moduleId).filter(Boolean)
    : [];
  const raw = runModuleIds.length > 0
    ? runModuleIds
    : Array.isArray(run?.moduleRefs) ? run.moduleRefs : [];
  const resolved = raw.map(id => resolveModuleId(id)).filter(Boolean);
  return [...new Set(resolved)];
}

export function resolveHarnessModuleConfig(automationSpec, moduleId) {
  const harness = normalizeRecord(automationSpec?.harness, {});
  const moduleConfig = normalizeRecord(harness.moduleConfig, {});
  return normalizeRecord(moduleConfig[moduleId], {});
}

export async function resolveExecutionContext(automationSpec) {
  const targetAgent = normalizeString(automationSpec?.entry?.targetAgent);
  const agents = targetAgent ? await listAgentRegistry().catch(() => []) : [];
  const targetProfile = targetAgent
    ? (Array.isArray(agents) ? agents.find((entry) => entry?.id === targetAgent) || null : null)
    : null;
  const tools = uniqueTools(targetProfile?.capabilities?.tools || []);
  const constraints = normalizeRecord(targetProfile?.constraints, {});
  return {
    targetAgent,
    targetProfile,
    role: normalizeString(targetProfile?.role) || null,
    tools,
    constraints,
    workspaceDir: targetAgent ? agentWorkspace(targetAgent) : null,
  };
}

export function resolveTimeoutBudgetSeconds(automationSpec, harnessRun) {
  const harness = normalizeRecord(automationSpec?.harness, {});
  const moduleConfig = normalizeRecord(harness.moduleConfig, {});
  const timeoutConfig = normalizeRecord(moduleConfig["harness:guard.budget"], {});
  const explicitBudget = normalizePositiveInteger(
    timeoutConfig.budgetSeconds
    || timeoutConfig.timeoutSeconds
    || harness.budgetSeconds
    || automationSpec?.governance?.budgetSeconds,
    null,
  );
  if (explicitBudget) return explicitBudget;

  switch (normalizeString(harnessRun?.assuranceLevel)) {
    case "high_assurance":
      return 1800;
    case "medium_assurance":
      return 3600;
    default:
      return null;
  }
}

function resolveArtifactEvidence(terminalSource, artifact) {
  const source = normalizeRecord(terminalSource, {});
  const executionObservation = normalizeExecutionObservation(source?.executionObservation || null);
  const candidates = [
    { value: artifact, source: "automation_terminal.artifact" },
    { value: source?.terminalOutcome?.artifact, source: "terminalOutcome.artifact" },
    { value: executionObservation.primaryOutputPath, source: "executionObservation.primaryOutputPath" },
    { value: executionObservation.artifactPaths[0], source: "executionObservation.artifactPaths[0]" },
    { value: source?.output, source: "contract.output" },
    { value: source?.conclusionArtifact?.path, source: "pipeline.conclusionArtifact.path" },
  ];

  for (const candidate of candidates) {
    const path = normalizeString(candidate.value);
    if (path) {
      return {
        present: true,
        path,
        source: candidate.source,
      };
    }
  }

  return {
    present: false,
    path: null,
    source: null,
  };
}

function resolveTestSignal(terminalSource) {
  const source = normalizeRecord(terminalSource, {});
  const booleanCandidates = [
    ["terminalOutcome.testsPassed", source?.terminalOutcome?.testsPassed],
    ["feedbackOutput.result.testsPassed", source?.feedbackOutput?.result?.testsPassed],
  ];
  for (const [field, candidate] of booleanCandidates) {
    const normalized = normalizeBooleanish(candidate);
    if (normalized === true) {
      return { status: "passed", signal: "tests_passed", source: field };
    }
    if (normalized === false) {
      return { status: "failed", signal: "tests_failed", source: field };
    }
  }

  const tokenCandidates = [
    [
      "runtimeDiagnostics.systemActionDelivery.system_action_review_verdict.verdict",
      source?.runtimeDiagnostics?.systemActionDelivery?.system_action_review_verdict?.verdict,
    ],
    ["terminalOutcome.verdict", source?.terminalOutcome?.verdict],
    ["feedbackOutput.result.verdict", source?.feedbackOutput?.result?.verdict],
    ["feedbackOutput.result.status", source?.feedbackOutput?.result?.status],
  ];
  for (const [field, candidate] of tokenCandidates) {
    const normalized = normalizeString(candidate)?.toLowerCase();
    if (!normalized) continue;
    if (POSITIVE_TEST_TOKENS.has(normalized)) {
      return { status: "passed", signal: normalized, source: field };
    }
    if (NEGATIVE_TEST_TOKENS.has(normalized)) {
      return { status: "failed", signal: normalized, source: field };
    }
  }

  return { status: null, signal: null, source: null };
}

function classifyFailure(terminalStatus, terminalSource) {
  const normalizedStatus = normalizeString(terminalStatus)?.toLowerCase() || null;
  if (!normalizedStatus || normalizedStatus === CONTRACT_STATUS.COMPLETED) return null;

  const reason = normalizeString(
    terminalSource?.terminalOutcome?.reason
    || terminalSource?.terminalOutcome?.clarification
    || terminalSource?.clarification,
  )?.toLowerCase() || null;

  if (reason && /timeout|timed?\s*out/.test(reason)) return "timeout";
  if (normalizedStatus === CONTRACT_STATUS.AWAITING_INPUT) return "awaiting_input";
  if (normalizedStatus === CONTRACT_STATUS.CANCELLED) return "cancelled";
  if (normalizedStatus === CONTRACT_STATUS.ABANDONED) return "abandoned";
  if (normalizedStatus === CONTRACT_STATUS.FAILED) return "failed";
  return normalizedStatus;
}

export function buildBaseEvidence(harnessRun, terminalSource, {
  terminalStatus = null,
  score = null,
  artifact = null,
  summary = null,
  finalizedAt = Date.now(),
  stageResult = null,
  stageCompletion = null,
} = {}) {
  const run = normalizeHarnessRun(harnessRun);
  const source = normalizeRecord(terminalSource, {});
  const executionObservation = normalizeExecutionObservation(source?.executionObservation || null);
  const durationMs = Number.isFinite(finalizedAt) && Number.isFinite(run?.startedAt)
    ? Math.max(0, finalizedAt - run.startedAt)
    : null;
  const normalizedStageResult = normalizeStageRunResult(stageResult) || executionObservation.stageRunResult;
  const normalizedStageCompletion = normalizeStageCompletion(stageCompletion) || executionObservation.stageCompletion;
  const artifactEvidence = resolveStageArtifactEvidence(normalizedStageResult) || resolveArtifactEvidence(source, artifact);
  const missingArtifacts = listMissingStageArtifacts(normalizedStageResult);
  return {
    run,
    source,
    finalizedAt,
    durationMs,
    terminalStatus: normalizeString(terminalStatus)?.toLowerCase() || null,
    score: normalizeFiniteNumber(score, null),
    summary: normalizeString(summary) || null,
    artifact: artifactEvidence,
    testSignal: resolveTestSignal(source),
    failureClass: classifyFailure(terminalStatus, source),
    stageResult: normalizedStageResult,
    stageCompletion: normalizedStageCompletion,
    missingArtifacts,
  };
}
