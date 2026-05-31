// Suite runner functions: single, concurrent, loop-platform, direct-service

import { broadcast } from "./transport/sse.js";
import { EVENT_TYPE } from "./core/event-types.js";
import {
  sleep,
  waitForIdle,
  fullReset,
} from "./formal-runtime/infra.js";
import { loadGraph } from "./agent/agent-graph.js";
import { listRuntimeAgentIds } from "./agent/agent-identity.js";
import { listResolvedGraphLoops } from "./loop/graph-loop-registry.js";
import { createQQTestReplyTo } from "./formal-test-qq-target.js";
import { runSingleTest, SINGLE_CASES, summarizeTestDiagnosis } from "./formal-runtime/suite-single.js";
import { runLoopPlatformTest } from "./formal-runtime/suite-loop-platform.js";
import { runDirectServiceCase } from "./formal-runtime/suite-direct-service.js";
import {
  collectConcurrentCases,
  collectDirectServiceCases,
  collectLoopPlatformCases,
  collectSingleCases,
} from "./test-run-presets.js";
import {
  buildLoopRandomRunSingleOptions,
  buildRandomPresetRuntime,
  buildSystemRandomRunSingleOptions,
  buildUnsupportedRandomPresetResult,
  resolveLoopRandomSelection,
  resolveRandomPresetCandidateSet,
} from "./test-run-random-runtime.js";

export function applyRunStats(run) {
  run.completedCases = run.caseResults.length;
  run.passedCases = run.caseResults.filter((item) => item.pass).length;
  run.blockedCases = run.caseResults.filter((item) => item.blocked).length;
  run.failedCases = run.caseResults.filter((item) => !item.pass && !item.blocked).length;
}

export function emitRunEvent(type, run, extra = {}) {
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

export async function performCleanReset(run, logger, { includeResearchState = false } = {}) {
  run.status = "cleaning";
  emitRunEvent(EVENT_TYPE.TEST_RUN_CLEANING, run, { includeResearchState });
  await fullReset();
  await sleep(1200);
  logger?.info?.(`[watchdog:test-runs] clean reset complete for ${run.id}`);
}

function createReplyTo(runId) {
  return {
    kind: "test_run",
    runId,
    agentId: "test-run",
    sessionKey: `test-run:${runId}`,
  };
}

async function createPresetReplyTo(runId, preset) {
  if (preset?.transport === "qq") {
    return createQQTestReplyTo(runId);
  }
  return createReplyTo(runId);
}

function buildStaticRunSingleOptions({
  preset,
  replyTo,
  randomRuntime,
} = {}) {
  if (preset?.transport === "qq") {
    return {
      transport: "qq",
      replyTo,
      source: "qqbot",
      ingressMode: "standard",
      chosenAgent: randomRuntime?.chosenAgent || null,
      randomRuntime,
    };
  }
  return {
    transport: "isolated",
    replyTo,
    source: "webui",
    ingressMode: preset?.family === "user-random" ? "user-random" : "standard",
    chosenAgent: randomRuntime?.chosenAgent || null,
    randomRuntime,
  };
}

export async function runSingleSuite(run, preset, sse, logger) {
  const tasks = collectSingleCases(preset.caseIds);
  run.totalCases = tasks.length;
  const replyTo = await createPresetReplyTo(run.id, preset);
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
            loopBudget: preset.loopBudget || null,
          })
        : buildStaticRunSingleOptions({
            preset,
            replyTo,
            randomRuntime,
          });

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

export async function runConcurrentSuite(run, preset, sse) {
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

export async function runLoopPlatformSuite(run, preset, sse) {
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

export async function runDirectServiceSuite(run, preset, sse) {
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
