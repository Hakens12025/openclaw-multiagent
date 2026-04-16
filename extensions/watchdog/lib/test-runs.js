import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { broadcast } from "./transport/sse.js";
import { EVENT_TYPE } from "./core/event-types.js";
import { listFormalTestPresets } from "./formal-test-presets.js";
import { loadGraph } from "./agent/agent-graph.js";
import { listRuntimeAgentIds } from "./agent/agent-identity.js";
import { dispatchAcceptIngressMessage } from "./ingress/dispatch-entry.js";
import { startRuntimeLoop } from "./admin/admin-surface-loop-operations.js";
import { listResolvedGraphLoops } from "./loop/graph-loop-registry.js";
import {
  REPORTS_DIR,
  loadConfig,
  fetchJSON,
  SSEClient,
  fullReset,
  restorePreservedWorkspaceState,
  sleep,
  waitForIdle,
} from "../tests/infra.js";
import { runSingleTest, generateReport, SINGLE_CASES, CONCURRENT_CASES, summarizeTestDiagnosis } from "../tests/suite-single.js";
import { cleanLoopRuntimeState, runResearcherSmoke, runPipelineTest, generateLoopReport, LOOP_CASES } from "../tests/suite-loop.js";
import { generateLoopPlatformReport, LOOP_PLATFORM_CASES, runLoopPlatformTest, summarizeLoopPlatformDiagnosis } from "../tests/suite-loop-platform.js";
import { DIRECT_SERVICE_CASES, runDirectServiceCase } from "../tests/suite-direct-service.js";
import { summarizeFormalCheckpointDiagnosis } from "../tests/formal-report.js";
import { runGlobalTestEnvironmentSerial } from "../tests/test-locks.js";

const MAX_RUN_HISTORY = 12;
const TEST_RUN_AGENT_ID = "test-run";

export const DEV_TEST_PRESETS = listFormalTestPresets();

const PRESET_MAP = new Map(DEV_TEST_PRESETS.map((preset) => [preset.id, preset]));
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

function createReplyTo(runId) {
  return {
    kind: "test_run",
    runId,
    agentId: TEST_RUN_AGENT_ID,
    sessionKey: `test-run:${runId}`,
  };
}

function getRun(runId) {
  return runs.find((run) => run.id === runId) || null;
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
    randomRuntime: result.randomRuntime || null,
  };
}

function applyRunStats(run) {
  run.completedCases = run.caseResults.length;
  run.passedCases = run.caseResults.filter((item) => item.pass).length;
  run.blockedCases = run.caseResults.filter((item) => item.blocked).length;
  run.failedCases = run.caseResults.filter((item) => !item.pass && !item.blocked).length;
}

function snapshotRun(run, includeDetails = false) {
  const base = {
    id: run.id,
    presetId: run.presetId,
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

function emitRunEvent(type, run, extra = {}) {
  broadcast("alert", {
    type,
    runId: run.id,
    presetId: run.presetId,
    label: run.label,
    status: run.status,
    totalCases: run.totalCases,
    completedCases: run.completedCases,
    passedCases: run.passedCases,
    failedCases: run.failedCases,
    blockedCases: run.blockedCases,
    currentCaseId: run.currentCaseId,
    currentCaseMessage: run.currentCaseMessage,
    ts: Date.now(),
    ...extra,
  });
}

async function ensureGatewayOnline() {
  await loadConfig();
  await fetchJSON("/watchdog/runtime");
}

async function performCleanReset(run, logger, { includeResearchState = false } = {}) {
  run.status = "cleaning";
  emitRunEvent(EVENT_TYPE.TEST_RUN_CLEANING, run, { includeResearchState });
  if (includeResearchState) {
    await cleanLoopRuntimeState();
  }
  await fullReset();
  await sleep(1200);
  logger?.info?.(`[watchdog:test-runs] clean reset complete for ${run.id}`);
}

function collectSingleCases(caseIds) {
  const caseMap = new Map(SINGLE_CASES.map((item) => [item.id, item]));
  return caseIds.map((id) => caseMap.get(id)).filter(Boolean);
}

function collectConcurrentCases(caseIds) {
  const caseMap = new Map(CONCURRENT_CASES.map((item) => [item.id, item]));
  return caseIds.map((id) => caseMap.get(id)).filter(Boolean);
}

function collectLoopCases(caseIds) {
  const caseMap = new Map(LOOP_CASES.map((item) => [item.id, item]));
  return caseIds.map((id) => caseMap.get(id)).filter(Boolean);
}

function collectLoopPlatformCases(caseIds) {
  const caseMap = new Map(LOOP_PLATFORM_CASES.map((item) => [item.id, item]));
  return caseIds.map((id) => caseMap.get(id)).filter(Boolean);
}

function collectDirectServiceCases(caseIds) {
  const caseMap = new Map(DIRECT_SERVICE_CASES.map((item) => [item.id, item]));
  return caseIds.map((id) => caseMap.get(id)).filter(Boolean);
}

function stableRandomIndex(seed, count) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const digest = createHash("sha256").update(String(seed || "")).digest();
  return digest.readUInt32BE(0) % count;
}

export function buildRandomPresetRuntime({
  preset,
  caseDef = null,
  candidateSet = [],
  seed = randomBytes(6).toString("hex"),
} = {}) {
  const sortedCandidates = [...candidateSet]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort();
  const chosenIndex = stableRandomIndex(seed, sortedCandidates.length);
  const chosenAgent = chosenIndex >= 0 ? sortedCandidates[chosenIndex] : null;
  return {
    family: preset?.family || null,
    seed,
    caseId: caseDef?.id || null,
    candidateSet: sortedCandidates,
    chosenAgent,
    chosenLoopMember: null,
    resolvedLoopId: null,
    actualPath: "unresolved",
    pathVerdict: "pending",
    pathVerdictReason: null,
  };
}

export function resolveRandomPresetCandidateSet({
  preset,
  runtimeAgentIds = [],
  graph = null,
  activeLoops = [],
} = {}) {
  const normalizedCandidates = [...new Set((Array.isArray(runtimeAgentIds) ? runtimeAgentIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];

  const activeLoopNodes = new Set((Array.isArray(activeLoops) ? activeLoops : [])
    .filter((loop) => loop?.active === true)
    .flatMap((loop) => Array.isArray(loop?.nodes) ? loop.nodes : [])
    .map((agentId) => String(agentId || "").trim())
    .filter(Boolean));

  if (preset?.family === "loop-random") {
    return normalizedCandidates.filter((agentId) => activeLoopNodes.has(agentId));
  }

  if (preset?.family !== "system-random") {
    return normalizedCandidates;
  }

  const outEdgeOwners = new Set((Array.isArray(graph?.edges) ? graph.edges : [])
    .map((edge) => String(edge?.from || "").trim())
    .filter(Boolean));

  return normalizedCandidates.filter((agentId) => (
    outEdgeOwners.has(agentId)
    && !activeLoopNodes.has(agentId)
  ));
}

export function buildUnsupportedRandomPresetResult({
  testCase,
  family,
  reason,
}) {
  return {
    testCase,
    results: [],
    duration: "0.0",
    pass: false,
    blocked: true,
    contractId: null,
    outputInfo: null,
    errorCode: "E_RANDOM_CAPABILITY_BLOCKED",
    errorDetail: reason,
    randomRuntime: {
      family,
      seed: null,
      caseId: testCase?.id || null,
      candidateSet: [],
      chosenAgent: null,
      chosenLoopMember: null,
      resolvedLoopId: null,
      actualPath: "unresolved",
      pathVerdict: "blocked",
      pathVerdictReason: reason,
    },
  };
}

export function buildSystemRandomRunSingleOptions({
  replyTo,
  randomRuntime,
  runtimeContext,
  logger,
  dispatchAcceptIngressMessageFn = dispatchAcceptIngressMessage,
} = {}) {
  const chosenAgent = typeof randomRuntime?.chosenAgent === "string" && randomRuntime.chosenAgent.trim()
    ? randomRuntime.chosenAgent.trim()
    : null;
  if (!chosenAgent) {
    throw new TypeError("buildSystemRandomRunSingleOptions requires randomRuntime.chosenAgent");
  }
  if (!runtimeContext?.api || typeof runtimeContext.enqueue !== "function" || typeof runtimeContext.wakePlanner !== "function") {
    throw new TypeError("buildSystemRandomRunSingleOptions requires runtimeContext.api/enqueue/wakePlanner");
  }
  if (typeof dispatchAcceptIngressMessageFn !== "function") {
    throw new TypeError("buildSystemRandomRunSingleOptions requires dispatchAcceptIngressMessageFn");
  }

  return {
    transport: "isolated",
    replyTo,
    source: "system",
    ingressMode: "standard",
    chosenAgent,
    randomRuntime,
    sendMessageLabel: `system-random ingress to ${chosenAgent}`,
    sendMessage: (message) => dispatchAcceptIngressMessageFn(message, {
      source: "system",
      replyTo,
      dispatchOwnerAgentId: chosenAgent,
      api: runtimeContext.api,
      enqueue: runtimeContext.enqueue,
      wakePlanner: runtimeContext.wakePlanner,
      logger,
    }),
  };
}

export function buildLoopRandomRunSingleOptions({
  randomRuntime,
  runtimeContext,
  logger,
  startRuntimeLoopFn = startRuntimeLoop,
} = {}) {
  const resolvedLoopId = typeof randomRuntime?.resolvedLoopId === "string" && randomRuntime.resolvedLoopId.trim()
    ? randomRuntime.resolvedLoopId.trim()
    : null;
  const chosenLoopMember = typeof randomRuntime?.chosenLoopMember === "string" && randomRuntime.chosenLoopMember.trim()
    ? randomRuntime.chosenLoopMember.trim()
    : null;
  if (!resolvedLoopId || !chosenLoopMember) {
    throw new TypeError("buildLoopRandomRunSingleOptions requires randomRuntime.resolvedLoopId/chosenLoopMember");
  }
  if (!runtimeContext?.api || typeof runtimeContext.enqueue !== "function") {
    throw new TypeError("buildLoopRandomRunSingleOptions requires runtimeContext.api/enqueue");
  }
  if (typeof startRuntimeLoopFn !== "function") {
    throw new TypeError("buildLoopRandomRunSingleOptions requires startRuntimeLoopFn");
  }

  return {
    transport: "isolated",
    source: "system",
    ingressMode: "standard",
    chosenAgent: chosenLoopMember,
    randomRuntime,
    sendMessageLabel: `loop-random runtime.loop.start ${resolvedLoopId}:${chosenLoopMember}`,
    sendMessage: async (message) => {
      const result = await startRuntimeLoopFn({
        payload: {
          loopId: resolvedLoopId,
          startAgent: chosenLoopMember,
          requestedTask: message,
          requestedSource: "watchdog.test.loop-random",
        },
        logger,
        runtimeContext,
      });
      return {
        ok: result?.ok !== false,
        contractId: result?.contractId || null,
      };
    },
  };
}

function resolveLoopRandomSelection({
  chosenAgent = null,
  activeLoops = [],
} = {}) {
  const chosenLoopMember = typeof chosenAgent === "string" && chosenAgent.trim()
    ? chosenAgent.trim()
    : null;
  if (!chosenLoopMember) {
    return {
      chosenLoopMember: null,
      resolvedLoopId: null,
      blockedReason: "loop-random has no active loop members in current graph",
    };
  }

  const matchingLoops = (Array.isArray(activeLoops) ? activeLoops : [])
    .filter((loop) => loop?.active === true)
    .filter((loop) => Array.isArray(loop?.nodes) && loop.nodes.includes(chosenLoopMember));

  if (matchingLoops.length === 1) {
    return {
      chosenLoopMember,
      resolvedLoopId: matchingLoops[0].id,
      blockedReason: null,
    };
  }
  if (matchingLoops.length > 1) {
    return {
      chosenLoopMember,
      resolvedLoopId: null,
      blockedReason: `loop-random start member ${chosenLoopMember} matches multiple active loops`,
    };
  }
  return {
    chosenLoopMember,
    resolvedLoopId: null,
    blockedReason: `loop-random start member ${chosenLoopMember} is not part of an active loop`,
  };
}

async function runSingleSuite(run, preset, sse, logger) {
  const tasks = collectSingleCases(preset.caseIds);
  run.totalCases = tasks.length;
  const replyTo = createReplyTo(run.id);
  const candidateGraph = preset.runtimeMode === "random"
    ? await loadGraph()
    : null;
  const activeLoops = preset.runtimeMode === "random"
    ? await listResolvedGraphLoops()
    : [];

  for (let i = 0; i < tasks.length; i++) {
    const tc = tasks[i];
    run.status = "running";
    run.currentCaseId = tc.id;
    run.currentCaseMessage = tc.message;
    emitRunEvent(EVENT_TYPE.TEST_CASE_STARTED, run, { caseId: tc.id, message: tc.message });

    if (preset.runtimeMode === "random" && !["user-random", "system-random", "loop-random"].includes(preset.family || "")) {
      const blockedReason = `${preset.family} runtime object is not implemented yet`;
      const result = buildUnsupportedRandomPresetResult({
        testCase: tc,
        family: preset.family,
        reason: blockedReason,
      });
      run.caseResults.push(result);
      applyRunStats(run);
      emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
        caseId: tc.id,
        message: tc.message,
        pass: false,
        blocked: true,
        duration: result.duration,
        contractId: null,
        diagnosis: summarizeTestDiagnosis(result),
      });
      continue;
    }

    const randomRuntime = preset.runtimeMode === "random"
      ? buildRandomPresetRuntime({
          preset,
          caseDef: tc,
          candidateSet: resolveRandomPresetCandidateSet({
            preset,
            runtimeAgentIds: listRuntimeAgentIds(),
            graph: candidateGraph,
            activeLoops,
          }),
        })
      : null;

    if (preset.family === "system-random" && !randomRuntime?.chosenAgent) {
      const blockedReason = "system-random has no routable start agents in current graph";
      const result = buildUnsupportedRandomPresetResult({
        testCase: tc,
        family: preset.family,
        reason: blockedReason,
      });
      run.caseResults.push(result);
      applyRunStats(run);
      emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
        caseId: tc.id,
        message: tc.message,
        pass: false,
        blocked: true,
        duration: result.duration,
        contractId: null,
        diagnosis: summarizeTestDiagnosis(result),
      });
      continue;
    }

    if (preset.family === "loop-random") {
      const loopSelection = resolveLoopRandomSelection({
        chosenAgent: randomRuntime?.chosenAgent || null,
        activeLoops,
      });
      if (randomRuntime) {
        randomRuntime.chosenLoopMember = loopSelection.chosenLoopMember;
        randomRuntime.resolvedLoopId = loopSelection.resolvedLoopId;
      }
      if (loopSelection.blockedReason) {
        const result = buildUnsupportedRandomPresetResult({
          testCase: tc,
          family: preset.family,
          reason: loopSelection.blockedReason,
        });
        if (result.randomRuntime) {
          result.randomRuntime.chosenAgent = randomRuntime?.chosenAgent || null;
          result.randomRuntime.chosenLoopMember = loopSelection.chosenLoopMember;
          result.randomRuntime.resolvedLoopId = loopSelection.resolvedLoopId;
        }
        run.caseResults.push(result);
        applyRunStats(run);
        emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
          caseId: tc.id,
          message: tc.message,
          pass: false,
          blocked: true,
          duration: result.duration,
          contractId: null,
          diagnosis: summarizeTestDiagnosis(result),
        });
        continue;
      }
    }

    const runSingleOptions = preset.family === "system-random"
      ? buildSystemRandomRunSingleOptions({
          replyTo,
          randomRuntime,
          runtimeContext: run.runtimeContext,
          logger,
        })
      : preset.family === "loop-random"
        ? buildLoopRandomRunSingleOptions({
            randomRuntime,
            runtimeContext: run.runtimeContext,
            logger,
          })
        : {
            transport: "isolated",
            replyTo,
            source: "webui",
            ingressMode: preset.family === "user-random" ? "user-random" : "standard",
            chosenAgent: randomRuntime?.chosenAgent || null,
            randomRuntime,
          };

    const result = await runSingleTest(tc, sse, undefined, 0, runSingleOptions);

    run.caseResults.push(result);
    applyRunStats(run);
    emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
      caseId: tc.id,
      message: tc.message,
      pass: result.pass,
      blocked: result.blocked === true,
      duration: result.duration,
      contractId: result.contractId || null,
      diagnosis: summarizeTestDiagnosis(result),
    });

    if (i < tasks.length - 1) {
      if (preset.resetBetweenCases) {
        await performCleanReset(run, null);
      } else {
        await waitForIdle();
        await sleep(2000);
      }
    }
  }
}

async function runConcurrentSuite(run, preset, sse) {
  const groups = collectConcurrentCases(preset.caseIds);
  const taskMap = new Map(SINGLE_CASES.map((item) => [item.id, item]));
  run.totalCases = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  const replyTo = createReplyTo(run.id);

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    run.status = "running";
    run.currentCaseId = group.id;
    run.currentCaseMessage = group.description || group.id;
    emitRunEvent(EVENT_TYPE.TEST_CASE_STARTED, run, { caseId: group.id, message: group.description || group.id, mode: "concurrent" });

    const taskDefs = group.tasks.map((id) => taskMap.get(id)).filter(Boolean);
    const results = await Promise.all(taskDefs.map((tc, idx) => (
      runSingleTest(tc, sse, undefined, idx, {
        transport: "isolated",
        replyTo,
        source: "webui",
      })
    )));

    for (const result of results) run.caseResults.push(result);
    applyRunStats(run);
    emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
      caseId: group.id,
      message: group.description || group.id,
      mode: "concurrent",
      pass: results.every((item) => item.pass),
      blocked: results.some((item) => item.blocked),
      duration: results.map((item) => item.duration).join(", "),
      summary: results.map((item) => `${item.testCase.id}:${item.pass ? "PASS" : item.blocked ? "BLOCKED" : "FAIL"}`).join(" "),
    });

    if (i < groups.length - 1) {
      if (preset.resetBetweenCases) {
        await performCleanReset(run, null);
      } else {
        await waitForIdle();
        await sleep(2000);
      }
    }
  }
}

async function runLoopSuite(run, preset, sse) {
  const tasks = collectLoopCases(preset.caseIds);
  run.totalCases = tasks.length;

  for (const tc of tasks) {
    run.status = "running";
    run.currentCaseId = tc.id;
    run.currentCaseMessage = tc.description || tc.id;
    emitRunEvent(EVENT_TYPE.TEST_CASE_STARTED, run, { caseId: tc.id, message: tc.description || tc.id, mode: "loop" });

    await performCleanReset(run, null, { includeResearchState: true });
    run.status = "running";

    let result;
    if (tc.id === "researcher-smoke" || tc.id.includes("smoke")) {
      result = await runResearcherSmoke(tc, sse);
    } else if (tc.pipeline) {
      result = await runPipelineTest(tc, sse);
    } else {
      result = await runPipelineTest(tc, sse);
    }

    run.caseResults.push(result);
    applyRunStats(run);
    emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
      caseId: tc.id,
      message: tc.description || tc.id,
      mode: "loop",
      pass: result.pass,
      blocked: result.blocked === true,
      duration: result.duration,
      finalStats: result.finalStats || null,
    });
  }
}

async function runLoopPlatformSuite(run, preset, sse) {
  const tasks = collectLoopPlatformCases(preset.caseIds);
  run.totalCases = tasks.length;

  for (const tc of tasks) {
    run.status = "running";
    run.currentCaseId = tc.id;
    run.currentCaseMessage = tc.description || tc.id;
    emitRunEvent(EVENT_TYPE.TEST_CASE_STARTED, run, { caseId: tc.id, message: tc.description || tc.id, mode: "loop-platform" });

    await performCleanReset(run, null, { includeResearchState: true });
    run.status = "running";

    const result = await runLoopPlatformTest(tc, sse);
    run.caseResults.push(result);
    applyRunStats(run);
    emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
      caseId: tc.id,
      message: tc.description || tc.id,
      mode: "loop-platform",
      pass: result.pass,
      blocked: result.blocked === true,
      duration: result.duration,
      contractId: result.contractId || null,
    });
  }
}

async function runDirectServiceSuite(run, preset, sse) {
  const tasks = collectDirectServiceCases(preset.caseIds);
  run.totalCases = tasks.length;

  for (const tc of tasks) {
    run.status = "running";
    run.currentCaseId = tc.id;
    run.currentCaseMessage = tc.message || tc.id;
    emitRunEvent(EVENT_TYPE.TEST_CASE_STARTED, run, { caseId: tc.id, message: tc.message || tc.id, mode: "direct-service" });

    const result = await runDirectServiceCase(tc, sse);
    run.caseResults.push(result);
    applyRunStats(run);
    emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
      caseId: tc.id,
      message: tc.message || tc.id,
      mode: "direct-service",
      pass: result.pass,
      blocked: result.blocked === true,
      duration: result.duration,
      finalStats: result.finalStats || null,
    });
  }
}

async function writeRunArtifacts(run, preset) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const ts = nowTs();
  const prefix = `devtool-${preset.id}`;
  const durationSec = ((run.finishedAt - run.startedAt) / 1000).toFixed(1);
  const reportText = preset.suite === "loop"
    ? generateLoopReport(run.caseResults, durationSec)
    : preset.suite === "loop-platform"
      ? generateLoopPlatformReport(run.caseResults, durationSec)
      : generateReport(run.caseResults, `devtool:${preset.id}`, durationSec);

  const reportFile = join(REPORTS_DIR, `${prefix}-${ts}.txt`);
  const rawFile = join(REPORTS_DIR, `${prefix}-${ts}.json`);
  run.reportFile = reportFile;
  run.rawReportFile = rawFile;
  await writeFile(reportFile, reportText, "utf8");
  await writeFile(rawFile, JSON.stringify(snapshotRun(run, true), null, 2), "utf8");
  run.reportText = reportText;
}

async function executeRun(run, preset, logger) {
  let sse = null;
  try {
    await runGlobalTestEnvironmentSerial(async () => {
      run.startedAt = Date.now();
      run.status = "preparing";
      emitRunEvent(EVENT_TYPE.TEST_RUN_STARTED, run);

      await ensureGatewayOnline();
      await performCleanReset(run, logger, { includeResearchState: preset.suite === "loop" || preset.suite === "loop-platform" });

      sse = new SSEClient();
      await sse.connect();
      await waitForIdle();

      if (preset.suite === "single") {
        await runSingleSuite(run, preset, sse, logger);
      } else if (preset.suite === "concurrent") {
        await runConcurrentSuite(run, preset, sse);
      } else if (preset.suite === "loop") {
        await runLoopSuite(run, preset, sse);
      } else if (preset.suite === "loop-platform") {
        await runLoopPlatformSuite(run, preset, sse);
      } else if (preset.suite === "direct-service") {
        await runDirectServiceSuite(run, preset, sse);
      } else {
        throw new Error(`unsupported preset suite: ${preset.suite}`);
      }

      run.finishedAt = Date.now();
      run.status = run.failedCases > 0 ? "failed" : "completed";
      run.currentCaseId = null;
      run.currentCaseMessage = null;
      await writeRunArtifacts(run, preset);
      emitRunEvent(EVENT_TYPE.TEST_RUN_FINISHED, run, { reportFile: run.reportFile });

      await performCleanReset(run, logger);
      run.status = run.failedCases > 0 ? "failed" : "completed";
    });
  } catch (e) {
    run.finishedAt = Date.now();
    run.status = "failed";
    run.error = e.message;
    run.currentCaseId = null;
    run.currentCaseMessage = null;
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
      transport: "isolated",
      cleanMode: "session-clean",
    })),
    activeRunId,
    runs: runs.map((run) => snapshotRun(run, false)),
  };
}

export function getTestRunDetails(runId) {
  const run = getRun(runId);
  return run ? snapshotRun(run, true) : null;
}

export function startTestRun({
  presetId,
  cleanMode = "session-clean",
  originDraftId = null,
  originExecutionId = null,
  originSurfaceId = null,
  runtimeContext = null,
}, logger) {
  const preset = PRESET_MAP.get(presetId);
  if (!preset) {
    throw new Error(`unknown preset: ${presetId}`);
  }
  if (activeRunId) {
    throw new Error("another test run is already active");
  }

  const run = {
    id: makeRunId(),
    presetId: preset.id,
    label: preset.label,
    description: preset.description,
    suite: preset.suite,
    randomFamily: preset.family || null,
    cleanMode,
    transport: "isolated",
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
