// Core probe runner for direct-service tests

import { sleep, wakeAgentNow, fetchJSON, fullReset } from "./infra.js";
import {
  findTrackStart,
  findTrackEnd,
  interestingEvents,
  makeCheckpoint,
  buildStepIds,
} from "./suite-direct-service-events.js";

const TERMINAL_TRACK_STATUSES = new Set(["completed", "failed", "awaiting_input"]);

async function fetchContractStatus(contractId) {
  if (!contractId) return null;
  try {
    const contracts = await fetchJSON("/watchdog/work-items");
    const contract = contracts.find((entry) => entry.id === contractId);
    return contract?.status || null;
  } catch {
    return null;
  }
}

export function buildBlockedProbeResult(testCase, {
  reason,
  errorCode,
  topology = null,
} = {}) {
  return {
    testCase,
    results: [
      {
        id: "blocked",
        name: "Runtime topology",
        status: "BLOCKED",
        elapsed: "0.0",
        detail: reason,
        ...(errorCode ? { errorCode } : {}),
      },
    ],
    duration: "0.0",
    pass: false,
    blocked: true,
    pathLabel: "DIRECT-SERVICE",
    directServiceSessionKey: null,
    bridgeAlertSeen: false,
    resumedSameSession: false,
    probeTopology: topology,
    probeEvents: [],
  };
}

// Runs the observation poll loop, mutating state until all signals seen or deadline
async function runProbeObservationLoop(state, config, stepIds, elapsed) {
  const { callerAgentId, sse, startMs, results } = state;
  const deadline = Date.now() + (state.testCase.timeoutMs || 240000);

  while (Date.now() < deadline) {
    if (!state.firstStart) {
      state.firstStart = findTrackStart(sse.events, {
        agentId: callerAgentId,
        afterMs: startMs,
        hookOnly: true,
      });
      if (state.firstStart) {
        makeCheckpoint(results, {
          id: stepIds.firstStart,
          name: "First hook session start",
          status: "PASS",
          elapsed: elapsed(),
          detail: state.firstStart.data.sessionKey,
        });
      }
    }

    if (config.intermediateStepName && !state.intermediateEvent) {
      state.intermediateEvent = config.findIntermediateEvent?.(sse.events, startMs) || null;
      if (state.intermediateEvent) {
        makeCheckpoint(results, {
          id: stepIds.intermediate,
          name: config.intermediateStepName,
          status: "PASS",
          elapsed: elapsed(),
          detail: config.intermediateDetail ? config.intermediateDetail(state.intermediateEvent) : null,
        });
      }
    }

    if (state.firstStart && !state.firstEnd) {
      state.firstEnd = findTrackEnd(sse.events, {
        agentId: callerAgentId,
        sessionKey: state.firstStart.data.sessionKey,
        afterMs: state.firstStart.receivedAt + 1,
      });
      if (state.firstEnd) {
        makeCheckpoint(results, {
          id: stepIds.firstEnd,
          name: "First hook session end",
          status: "PASS",
          elapsed: elapsed(),
          detail: state.firstEnd.data.status || "completed",
        });
      }
    }

    if (state.firstEnd && !state.bridgeAlert) {
      state.bridgeAlert = config.findBridgeAlert(sse.events, state.firstEnd.receivedAt + 1);
      if (state.bridgeAlert) {
        makeCheckpoint(results, {
          id: stepIds.bridge,
          name: config.bridgeStepName,
          status: "PASS",
          elapsed: elapsed(),
          detail: config.bridgeDetail ? config.bridgeDetail(state.bridgeAlert) : null,
        });
      }
    }

    if (state.firstEnd && !state.resumedStart) {
      state.resumedStart = findTrackStart(sse.events, {
        agentId: callerAgentId,
        afterMs: state.firstEnd.receivedAt + 1,
        sessionKey: state.firstStart.data.sessionKey,
      });
      if (state.resumedStart) {
        makeCheckpoint(results, {
          id: stepIds.resume,
          name: "Same-session resume",
          status: "PASS",
          elapsed: elapsed(),
          detail: state.resumedStart.data.sessionKey,
        });
      }
    }

    if (state.resumedStart && !state.resumedEnd) {
      const resumedEndEvent = findTrackEnd(sse.events, {
        agentId: callerAgentId,
        sessionKey: state.firstStart.data.sessionKey,
        afterMs: state.resumedStart.receivedAt + 1,
      });
      if (resumedEndEvent && TERMINAL_TRACK_STATUSES.has(resumedEndEvent.data?.status || "completed")) {
        state.resumedEnd = resumedEndEvent;
        makeCheckpoint(results, {
          id: stepIds.resumeEnd,
          name: "Resumed session end",
          status: "PASS",
          elapsed: elapsed(),
          detail: state.resumedEnd.data.status || "completed",
        });
      }
    }

    if (state.bridgeAlert && !state.bridgeContractTerminal) {
      const bridgeContractId = config.contractIdFromAlert
        ? config.contractIdFromAlert(state.bridgeAlert, state.firstStart)
        : (state.bridgeAlert?.data?.contractId || null);
      const bridgeContractStatus = await fetchContractStatus(bridgeContractId);
      if (["completed", "failed", "awaiting_input", "abandoned", "cancelled"].includes(bridgeContractStatus)) {
        state.bridgeContractTerminal = { contractId: bridgeContractId, status: bridgeContractStatus };
        makeCheckpoint(results, {
          id: stepIds.bridgeContractTerminal,
          name: "Bridge contract terminal",
          status: "PASS",
          elapsed: elapsed(),
          detail: `${bridgeContractId} ${bridgeContractStatus}`,
        });
      }
    }

    const allSeen = Boolean(
      state.firstStart
      && state.firstEnd
      && state.bridgeAlert
      && state.resumedStart
      && state.resumedEnd
      && state.bridgeContractTerminal
      && (!config.intermediateStepName || state.intermediateEvent)
    );
    if (allSeen) break;

    await sleep(2000);
  }
}

// Records FAIL checkpoints for any signals not observed after the loop
function recordMissCheckpoints(state, config, stepIds, elapsed) {
  const { callerAgentId, results, firstStart, firstEnd, bridgeAlert, resumedStart, resumedEnd, bridgeContractTerminal, intermediateEvent } = state;

  if (!firstStart) {
    makeCheckpoint(results, {
      id: stepIds.firstStart,
      name: "First hook session start",
      status: "FAIL",
      elapsed: elapsed(),
      detail: `${callerAgentId} hook session not observed`,
      errorCode: "E_DIRECT_SERVICE_START_MISS",
    });
  }

  if (config.intermediateStepName && !intermediateEvent) {
    makeCheckpoint(results, {
      id: stepIds.intermediate,
      name: config.intermediateStepName,
      status: "FAIL",
      elapsed: elapsed(),
      detail: config.intermediateMissDetail || `${config.intermediateStepName} not observed`,
      errorCode: config.intermediateErrorCode || null,
    });
  }

  if (firstStart && !firstEnd) {
    makeCheckpoint(results, {
      id: stepIds.firstEnd,
      name: "First hook session end",
      status: "FAIL",
      elapsed: elapsed(),
      detail: "initial direct session did not finish",
      errorCode: "E_DIRECT_SERVICE_END_MISS",
    });
  }

  if (firstEnd && !bridgeAlert) {
    makeCheckpoint(results, {
      id: stepIds.bridge,
      name: config.bridgeStepName,
      status: "FAIL",
      elapsed: elapsed(),
      detail: config.bridgeMissDetail,
      errorCode: config.bridgeErrorCode,
    });
  }

  if (firstEnd && !resumedStart) {
    makeCheckpoint(results, {
      id: stepIds.resume,
      name: "Same-session resume",
      status: "FAIL",
      elapsed: elapsed(),
      detail: `${callerAgentId} did not resume on the original sessionKey`,
      errorCode: "E_SAME_SESSION_RESUME_MISS",
    });
  }

  if (resumedStart && !resumedEnd) {
    makeCheckpoint(results, {
      id: stepIds.resumeEnd,
      name: "Resumed session end",
      status: "FAIL",
      elapsed: elapsed(),
      detail: "resumed direct session did not reach terminal track_end status",
      errorCode: "E_RESUMED_SESSION_STUCK",
    });
  }

  if (bridgeAlert && !bridgeContractTerminal) {
    const bridgeContractId = config.contractIdFromAlert
      ? config.contractIdFromAlert(bridgeAlert, firstStart)
      : (bridgeAlert?.data?.contractId || null);
    makeCheckpoint(results, {
      id: stepIds.bridgeContractTerminal,
      name: "Bridge contract terminal",
      status: "FAIL",
      elapsed: elapsed(),
      detail: bridgeContractId
        ? `${bridgeContractId} did not reach terminal state in /watchdog/work-items`
        : "bridge contract id missing",
      errorCode: "E_BRIDGE_CONTRACT_STUCK",
    });
  }
}

export async function runDirectServiceProbe(testCase, sse, config) {
  const topology = config.topology || null;
  const callerAgentId = topology?.callerAgentId || null;
  const state = {
    testCase,
    sse,
    callerAgentId,
    results: [],
    firstStart: null,
    intermediateEvent: null,
    firstEnd: null,
    bridgeAlert: null,
    resumedStart: null,
    resumedEnd: null,
    bridgeContractTerminal: null,
  };
  let wakeContext = {};

  await fullReset();
  await sleep(1500);
  sse.resetBaseline();

  state.startMs = Date.now();
  const elapsed = () => ((Date.now() - state.startMs) / 1000).toFixed(1);
  const stepIds = buildStepIds(config);

  try {
    makeCheckpoint(state.results, {
      id: stepIds.reset,
      name: "Runtime reset",
      status: "PASS",
      elapsed: elapsed(),
    });

    if (config.beforeWake) {
      try {
        wakeContext = await config.beforeWake();
        makeCheckpoint(state.results, {
          id: stepIds.beforeWake,
          name: config.beforeWakeLabel,
          status: "PASS",
          elapsed: elapsed(),
          detail: config.beforeWakeDetail ? config.beforeWakeDetail(wakeContext) : null,
        });
      } catch (error) {
        makeCheckpoint(state.results, {
          id: stepIds.beforeWake,
          name: config.beforeWakeLabel,
          status: "FAIL",
          elapsed: elapsed(),
          detail: error?.message || String(error),
          errorCode: config.beforeWakeErrorCode || null,
        });
        return {
          testCase,
          results: state.results,
          duration: elapsed(),
          pass: false,
          pathLabel: "DIRECT-SERVICE",
          directServiceSessionKey: null,
          bridgeAlertSeen: false,
          resumedSameSession: false,
          probeTopology: topology,
          probeEvents: interestingEvents(sse.events, topology),
        };
      }
    }

    const wakeResult = await wakeAgentNow(callerAgentId, config.promptBuilder(wakeContext));
    if (!wakeResult?.ok) {
      makeCheckpoint(state.results, {
        id: stepIds.wake,
        name: "Direct service wake",
        status: "FAIL",
        elapsed: elapsed(),
        detail: JSON.stringify(wakeResult),
        errorCode: "E_DIRECT_SERVICE_WAKE_FAIL",
      });
      return {
        testCase,
        results: state.results,
        duration: elapsed(),
        pass: false,
        pathLabel: "DIRECT-SERVICE",
        directServiceSessionKey: null,
        bridgeAlertSeen: false,
        resumedSameSession: false,
        probeTopology: topology,
        probeEvents: interestingEvents(sse.events, topology),
      };
    }

    makeCheckpoint(state.results, {
      id: stepIds.wake,
      name: "Direct service wake",
      status: "PASS",
      elapsed: elapsed(),
      detail: wakeResult.runId || "wake requested",
    });

    await runProbeObservationLoop(state, config, stepIds, elapsed);
    recordMissCheckpoints(state, config, stepIds, elapsed);

    const { firstStart, intermediateEvent, bridgeAlert, resumedStart, resumedEnd, bridgeContractTerminal } = state;
    const pass = Boolean(
      firstStart
      && state.firstEnd
      && bridgeAlert
      && resumedStart
      && resumedEnd
      && bridgeContractTerminal
      && (!config.intermediateStepName || intermediateEvent)
    );
    const finalStats = config.buildFinalStats
      ? config.buildFinalStats({ firstStart, intermediateEvent, bridgeAlert })
      : null;

    return {
      testCase,
      results: state.results,
      duration: elapsed(),
      pass,
      pathLabel: "DIRECT-SERVICE",
      contractId: config.contractIdFromAlert
        ? config.contractIdFromAlert(bridgeAlert, firstStart)
        : (bridgeAlert?.data?.contractId || firstStart?.data?.contractId || null),
      directServiceSessionKey: firstStart?.data?.sessionKey || null,
      bridgeAlertSeen: Boolean(bridgeAlert),
      resumedSameSession: Boolean(resumedStart),
      finalStats,
      probeTopology: topology,
      probeEvents: interestingEvents(sse.events, topology),
      ...(config.extraResult ? config.extraResult({ intermediateEvent, bridgeAlert }) : {}),
    };
  } finally {
    if (typeof wakeContext?.cleanup === "function") {
      try {
        await wakeContext.cleanup();
      } catch (error) {
        makeCheckpoint(state.results, {
          id: `${stepIds.bridgeContractTerminal}-cleanup`,
          name: "Probe cleanup",
          status: "FAIL",
          elapsed: elapsed(),
          detail: error?.message || String(error),
        });
      }
    }
  }
}
