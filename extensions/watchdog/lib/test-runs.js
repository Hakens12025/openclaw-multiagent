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
  restorePreservedWorkspaceState,
  waitForIdle,
} from "./formal-runtime/infra.js";
import { createCheckContext } from "./formal-runtime/checks/check-runner.js";
import { runGlobalTestEnvironmentSerial } from "./formal-runtime/test-locks.js";
import { writeTestRunArtifacts } from "./test-run-artifacts.js";
import {
  DEV_TEST_PRESETS,
  TEST_RUN_CLEAN_MODE,
  resolveRunCleanMode,
  resolveRequestedFormalPreset,
} from "./test-run-presets.js";
import {
  applyRunStats,
  emitRunEvent,
  performCleanReset,
  runFormalSuite,
} from "./test-run-suites.js";

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

// CheckResult → 详情 payload 的 caseResults 行（消费者契约：id/pass/blocked/message/duration）。
// skip 不是失败 → pass:true（与 applyRunStats 的计数语义一致）；status/code/evidence 带真相。
function summarizeCheckResult(check) {
  return {
    id: check.id,
    message: check.title,
    pass: check.status === "pass" || check.status === "skip",
    blocked: check.status === "blocked",
    status: check.status,
    subsystem: check.subsystem,
    code: check.code || null,
    evidence: check.evidence || "",
    hint: check.hint || null,
    duration: check.durationMs,
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
    caseResults: (run.checks || []).map(summarizeCheckResult),
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
  });
}

async function executeRun(run, preset, logger) {
  try {
    await runGlobalTestEnvironmentSerial(async () => {
      await withPreservedRuntimeGraph(async () => {
        run.startedAt = Date.now();
        run.status = "preparing";
        emitRunEvent(EVENT_TYPE.TEST_RUN_STARTED, run);

        await ensureGatewayOnline();
        // cleanMode:"none" = 只读/自恢复 suite（health/operator/knowledge）：
        // 不 fullReset —— reset 本身会制造体检要捕捉的残留。
        const liveClean = run.cleanMode !== "none";
        if (liveClean) {
          await performCleanReset(run, logger, { includeResearchState: false });
          await waitForIdle();
        }

        const context = createCheckContext({ presetId: preset.id });
        run.checks = context.checks;

        await runFormalSuite(run, preset, context);
        applyRunStats(run);

        run.status = "finalizing";
        run.currentCaseId = null;
        run.currentCaseMessage = null;
        run.finishedAt = Date.now();
        await writeRunArtifacts(run, preset);

        if (liveClean) {
          await performCleanReset(run, logger);
        }
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
    if (run.startedAt && (run.checks || []).length > 0) {
      await writeRunArtifacts(run, preset).catch((artifactError) => {
        logger?.warn?.(`[watchdog:test-runs] failed to write failure artifacts for ${run.id}: ${artifactError.message}`);
      });
    }
    emitRunEvent(EVENT_TYPE.TEST_RUN_FAILED, run, { error: e.message });
    logger?.error?.(`[watchdog:test-runs] ${run.id} failed: ${e.stack || e.message}`);
  } finally {
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
  const resolvedCleanMode = resolveRunCleanMode(preset, cleanMode);
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
    checks: [],
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
