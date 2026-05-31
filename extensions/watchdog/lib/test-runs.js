import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { EVENT_TYPE } from "./core/event-types.js";
import { CONTROL_PLANE_PATHS } from "./control-plane/control-plane-paths.js";
import { LOOP_SESSION_STATE_FILE } from "./loop/loop-session-store.js";
import {
  REPORTS_DIR,
  loadConfig,
  fetchJSON,
  SSEClient,
  restorePreservedWorkspaceState,
  sleep,
  waitForIdle,
} from "./formal-runtime/infra.js";
import { runSingleTest, summarizeTestDiagnosis } from "./formal-runtime/suite-single.js";
import { summarizeLoopPlatformDiagnosis } from "./formal-runtime/suite-loop-platform.js";
import { summarizeFormalCheckpointDiagnosis } from "./formal-runtime/formal-report.js";
import { runGlobalTestEnvironmentSerial } from "./formal-runtime/test-locks.js";
import { writeTestRunArtifacts } from "./test-run-artifacts.js";
import {
  buildLoopRandomRunSingleOptions,
  buildRandomPresetRuntime,
  buildSystemRandomRunSingleOptions,
  buildUnsupportedRandomPresetResult,
  resolveLoopRandomSelection,
  resolveRandomPresetCandidateSet,
} from "./test-run-random-runtime.js";
import {
  DEV_TEST_PRESETS,
  TEST_RUN_CLEAN_MODE,
  normalizeTestRunCleanMode,
  resolveRequestedFormalPreset,
} from "./test-run-presets.js";
import {
  applyRunStats,
  emitRunEvent,
  performCleanReset,
  runSingleSuite,
  runConcurrentSuite,
  runLoopPlatformSuite,
  runDirectServiceSuite,
} from "./test-run-suites.js";

export {
  buildLoopRandomRunSingleOptions,
  buildRandomPresetRuntime,
  buildSystemRandomRunSingleOptions,
  buildUnsupportedRandomPresetResult,
  resolveLoopRandomSelection,
  resolveRandomPresetCandidateSet,
} from "./test-run-random-runtime.js";

export { resolveRequestedFormalPreset } from "./test-run-presets.js";

const MAX_RUN_HISTORY = 12;
const RUNTIME_CONTROL_STATE_FILES = Object.freeze([
  CONTROL_PLANE_PATHS.agentGraphFile,
  CONTROL_PLANE_PATHS.graphLoopRegistryFile,
  LOOP_SESSION_STATE_FILE,
]);

const runs = [];
let activeRunId = null;

function nowTs() {
  return new Date().toISOString().replace(/[T:]/g, "-").slice(0, 19);
}

function makeRunId() {
  return `TR-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function captureFileSnapshot(filePath) {
  try {
    return {
      filePath,
      exists: true,
      raw: await readFile(filePath, "utf8"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        filePath,
        exists: false,
        raw: null,
      };
    }
    throw error;
  }
}

async function restoreFileSnapshot(snapshot) {
  if (!snapshot?.exists) {
    await rm(snapshot.filePath, { force: true });
    return;
  }
  await mkdir(dirname(snapshot.filePath), { recursive: true });
  await writeFile(snapshot.filePath, snapshot.raw, "utf8");
}

async function captureRuntimeControlStateSnapshot() {
  return Promise.all(RUNTIME_CONTROL_STATE_FILES.map((filePath) => captureFileSnapshot(filePath)));
}

async function restoreRuntimeControlStateSnapshot(snapshot) {
  for (const fileSnapshot of Array.isArray(snapshot) ? snapshot : []) {
    await restoreFileSnapshot(fileSnapshot);
  }
}

export async function withPreservedRuntimeGraph(callback) {
  if (typeof callback !== "function") {
    throw new TypeError("withPreservedRuntimeGraph requires a callback");
  }
  const snapshot = await captureRuntimeControlStateSnapshot();
  try {
    return await callback(snapshot);
  } finally {
    await restoreRuntimeControlStateSnapshot(snapshot);
  }
}

function summarizeRunDiagnosis(suite, result) {
  if (suite === "loop-platform") {
    return summarizeFormalCheckpointDiagnosis(result, summarizeLoopPlatformDiagnosis);
  }
  if (suite === "direct-service") {
    return summarizeFormalCheckpointDiagnosis(result);
  }
  return summarizeTestDiagnosis(result);
}

function summarizeCaseResult(result, suite) {
  return {
    id: result.testCase?.id || "unknown",
    message: result.testCase?.message || result.testCase?.description || "",
    pass: result.pass === true,
    blocked: result.blocked === true,
    duration: result.duration,
    contractId: result.contractId || null,
    finalStats: result.finalStats || null,
    diagnosis: summarizeRunDiagnosis(suite, result),
    checkpoints: Array.isArray(result.results) ? result.results : [],
    contractRuntime: result.contractRuntime || null,
    incident: result.incident || result.executionIncident || result.contractRuntime?.runtimeDiagnostics?.executionIncident || null,
    randomRuntime: result.randomRuntime || null,
  };
}

function snapshotRun(run, includeDetails = false) {
  const base = {
    id: run.id,
    presetId: run.presetId,
    requestedCaseId: run.requestedCaseId || null,
    label: run.label,
    description: run.description,
    suite: run.suite,
    cleanMode: run.cleanMode,
    transport: run.transport,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.startedAt ? ((run.finishedAt || Date.now()) - run.startedAt) : 0,
    totalCases: run.totalCases,
    completedCases: run.completedCases,
    passedCases: run.passedCases,
    failedCases: run.failedCases,
    blockedCases: run.blockedCases,
    currentCaseId: run.currentCaseId,
    currentCaseMessage: run.currentCaseMessage,
    reportFile: run.reportFile,
    rawReportFile: run.rawReportFile,
    error: run.error,
    originDraftId: run.originDraftId,
    originExecutionId: run.originExecutionId,
    originSurfaceId: run.originSurfaceId,
    active: activeRunId === run.id && !["completed", "failed"].includes(run.status),
  };
  if (!includeDetails) return base;
  return {
    ...base,
    caseResults: run.caseResults.map((result) => summarizeCaseResult(result, run.suite)),
    reportText: run.reportText,
  };
}

async function ensureGatewayOnline() {
  await loadConfig();
  await fetchJSON("/watchdog/runtime");
}

async function writeRunArtifacts(run, preset) {
  await writeTestRunArtifacts({
    run,
    preset,
    reportsDir: REPORTS_DIR,
    nowTs,
    snapshotRun,
  });
}

async function executeRun(run, preset, logger) {
  let sse = null;
  try {
    await runGlobalTestEnvironmentSerial(async () => {
      await withPreservedRuntimeGraph(async () => {
        run.startedAt = Date.now();
        run.status = "preparing";
        emitRunEvent(EVENT_TYPE.TEST_RUN_STARTED, run);

        await ensureGatewayOnline();
        await performCleanReset(run, logger, { includeResearchState: preset.suite === "loop-platform" });

        sse = new SSEClient();
        await sse.connect();
        await waitForIdle();

        if (preset.suite === "single") {
          await runSingleSuite(run, preset, sse, logger);
        } else if (preset.suite === "concurrent") {
          await runConcurrentSuite(run, preset, sse);
        } else if (preset.suite === "loop-platform") {
          await runLoopPlatformSuite(run, preset, sse);
        } else if (preset.suite === "direct-service") {
          await runDirectServiceSuite(run, preset, sse);
        } else {
          throw new Error(`unsupported preset suite: ${preset.suite}`);
        }

        run.status = "finalizing";
        run.currentCaseId = null;
        run.currentCaseMessage = null;
        run.finishedAt = Date.now();
        await writeRunArtifacts(run, preset);

        await performCleanReset(run, logger);
        run.finishedAt = Date.now();
        run.status = run.failedCases > 0 ? "failed" : "completed";
        await writeRunArtifacts(run, preset);
        emitRunEvent(EVENT_TYPE.TEST_RUN_FINISHED, run, { reportFile: run.reportFile });
      });
    });
  } catch (e) {
    run.finishedAt = Date.now();
    run.status = "failed";
    run.error = e.message;
    run.currentCaseId = null;
    run.currentCaseMessage = null;
    if (run.startedAt && run.caseResults.length > 0) {
      await writeRunArtifacts(run, preset).catch((artifactError) => {
        logger?.warn?.(`[watchdog:test-runs] failed to write failure artifacts for ${run.id}: ${artifactError.message}`);
      });
    }
    emitRunEvent(EVENT_TYPE.TEST_RUN_FAILED, run, { error: e.message });
    logger?.error?.(`[watchdog:test-runs] ${run.id} failed: ${e.stack || e.message}`);
  } finally {
    if (sse) sse.close();
    await restorePreservedWorkspaceState().catch((error) => {
      logger?.warn?.(`[watchdog:test-runs] failed to restore preserved workspace state: ${error.message}`);
    });
    if (activeRunId === run.id) activeRunId = null;
  }
}

export function listTestRuns() {
  return {
    presets: DEV_TEST_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      suite: preset.suite,
      family: preset.family || null,
      runtimeMode: preset.runtimeMode || "static",
      transport: preset.transport || "isolated",
      cleanMode: preset.cleanMode || "session-clean",
      caseIds: Array.isArray(preset.caseIds) ? [...preset.caseIds] : [],
      resetBetweenCases: preset.resetBetweenCases === true,
    })),
    activeRunId,
    runs: runs.map((run) => snapshotRun(run, false)),
  };
}

export function getTestRunDetails(runId) {
  const run = runs.find((r) => r.id === runId) || null;
  return run ? snapshotRun(run, true) : null;
}

export function startTestRun({
  presetId,
  caseId,
  cleanMode = TEST_RUN_CLEAN_MODE,
  originDraftId = null,
  originExecutionId = null,
  originSurfaceId = null,
  runtimeContext = null,
}, logger) {
  const preset = resolveRequestedFormalPreset({ presetId, caseId });
  const resolvedCleanMode = normalizeTestRunCleanMode(cleanMode);
  if (activeRunId) {
    throw new Error("another test run is already active");
  }

  const run = {
    id: makeRunId(),
    presetId: preset.id,
    requestedCaseId: preset.requestedCaseId || null,
    label: preset.label,
    description: preset.description,
    suite: preset.suite,
    randomFamily: preset.family || null,
    cleanMode: resolvedCleanMode,
    transport: preset.transport || "isolated",
    status: "queued",
    startedAt: null,
    finishedAt: null,
    totalCases: 0,
    completedCases: 0,
    passedCases: 0,
    failedCases: 0,
    blockedCases: 0,
    currentCaseId: null,
    currentCaseMessage: null,
    caseResults: [],
    reportFile: null,
    rawReportFile: null,
    reportText: "",
    error: null,
    originDraftId: typeof originDraftId === "string" && originDraftId.trim() ? originDraftId.trim() : null,
    originExecutionId: typeof originExecutionId === "string" && originExecutionId.trim() ? originExecutionId.trim() : null,
    originSurfaceId: typeof originSurfaceId === "string" && originSurfaceId.trim() ? originSurfaceId.trim() : null,
    runtimeContext,
  };

  activeRunId = run.id;
  runs.unshift(run);
  if (runs.length > MAX_RUN_HISTORY) runs.length = MAX_RUN_HISTORY;

  void executeRun(run, preset, logger);
  return deepClone(snapshotRun(run, false));
}
