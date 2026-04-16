// tests/suite-loop-live.js — Live loop end-to-end test with structured diagnostic log
//
// This suite runs a REAL loop (researcher → worker-d → evaluator → researcher)
// through the admin API, waits for each stage to complete, and produces a
// structured diagnostic log so failures can be traced to a specific stage.

import { readFile, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  BASE, OC, PORT, REPORTS_DIR, tokens,
  fetchJSON, httpFetch, loadConfig, RUNTIME_AGENT_IDS, WORKER_IDS, sleep,
} from "./infra.js";
import { loadActiveLoopRuntime } from "../lib/loop/loop-round-runtime.js";
import { loadLoopSessionState, LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";

const LOOP_AGENTS = ["researcher", "worker-d", "evaluator"];

export const LOOP_LIVE_CASES = [
  {
    id: "live-loop-huffman",
    description: "Live 研究回路：卡夫曼编码优化 — researcher→worker-d→evaluator 全链路",
    message: "帮我优化一下卡夫曼编码",
    loopId: "test-live-loop",
    loopAgents: LOOP_AGENTS,
    stageTimeoutMs: 180000,
    totalTimeoutMs: 600000,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function postAdmin(path, payload) {
  const res = await httpFetch(`${BASE}${path}?token=${tokens.gateway}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  try { return JSON.parse(res.body); } catch { return { ok: false, error: res.body }; }
}

async function readJsonFile(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function readContractFromApi(contractId) {
  if (!contractId) return null;
  try {
    const contracts = await fetchJSON("/watchdog/work-items");
    return contracts.find((c) => c.id === contractId) || null;
  } catch { return null; }
}

async function cleanLoopState(loopAgents = LOOP_AGENTS) {
  await unlink(LOOP_SESSION_STATE_FILE).catch(() => {});
  for (const agent of loopAgents) {
    const inbox = join(OC, "workspaces", agent, "inbox");
    await unlink(join(inbox, "contract.json")).catch(() => {});
    await rm(join(inbox, ".runtime-direct-queue"), { recursive: true, force: true }).catch(() => {});
  }
}

function ts() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

function resolveLiveLoopAgents(requestedAgents = null) {
  const availableAgents = new Set(Array.isArray(RUNTIME_AGENT_IDS) ? RUNTIME_AGENT_IDS : []);
  const requested = Array.isArray(requestedAgents) ? requestedAgents.filter(Boolean) : [];
  if (requested.length >= 2 && requested.every((agentId) => availableAgents.has(agentId))) {
    return requested;
  }

  const fallbacks = [
    ["researcher", "worker-d", "evaluator"],
    ["worker-3", "worker-4"],
  ];
  for (const candidate of fallbacks) {
    if (candidate.every((agentId) => availableAgents.has(agentId))) {
      return candidate;
    }
  }

  const runtimeWorkers = (Array.isArray(WORKER_IDS) ? WORKER_IDS : []).filter((agentId) => availableAgents.has(agentId));
  return runtimeWorkers.slice(0, Math.min(runtimeWorkers.length, 3));
}

// ── Diagnostic Log Builder ──────────────────────────────────────────────────

class DiagnosticLog {
  constructor(testCase) {
    this.testCase = testCase;
    this.entries = [];
    this.startMs = Date.now();
  }

  log(stage, event, detail = null) {
    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
    const entry = { ts: ts(), elapsed, stage, event, ...(detail ? { detail } : {}) };
    this.entries.push(entry);
    const detailStr = detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}` : "";
    console.log(`    [${elapsed}s] ${stage.padEnd(12)} ${event}${detailStr}`);
  }

  stageContract(stage, contract) {
    if (!contract) {
      this.log(stage, "CONTRACT_MISSING");
      return;
    }
    this.log(stage, "CONTRACT", {
      id: contract.id,
      status: contract.status,
      task: (contract.task || "").slice(0, 80),
      previousFeedback: contract.pipelineStage?.previousFeedback?.slice(0, 80) || null,
      previousArtifactPath: contract.pipelineStage?.previousArtifactPath || null,
      previousStage: contract.pipelineStage?.previousStage || null,
    });
  }

  stageResult(stage, contract) {
    if (!contract) return;
    const observedStageRunResult = contract.executionObservation?.stageRunResult || null;
    this.log(stage, "RESULT", {
      status: contract.status,
      totalCalls: contract.runtimeDiagnostics?.executionTrace?.totalCalls ?? "?",
      elapsedMs: contract.runtimeDiagnostics?.executionTrace?.elapsedMs ?? "?",
      outputCommitted: contract.runtimeDiagnostics?.executionTrace?.outputCommitted ?? false,
      terminalOutcome: contract.terminalOutcome?.reason?.slice(0, 100) || null,
      stageRunSummary: observedStageRunResult?.summary?.slice(0, 100) || null,
      primaryArtifact: observedStageRunResult?.primaryArtifactPath || null,
      progression: contract.runtimeDiagnostics?.pipelineProgression?.action || null,
      progressionTo: contract.runtimeDiagnostics?.pipelineProgression?.to || null,
    });
  }

  toReport() {
    const lines = [];
    const duration = ((Date.now() - this.startMs) / 1000).toFixed(1);
    lines.push("══════════════════════════════════════════════════");
    lines.push(" OPENCLAW LIVE LOOP DIAGNOSTIC LOG");
    lines.push(` Test: ${this.testCase.id}`);
    lines.push(` Task: ${this.testCase.message}`);
    lines.push(` Run: ${ts()}  Duration: ${duration}s`);
    lines.push("══════════════════════════════════════════════════");
    lines.push("");
    for (const entry of this.entries) {
      const detail = entry.detail
        ? `  ${typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail)}`
        : "";
      lines.push(`[${entry.elapsed}s] ${entry.stage.padEnd(12)} ${entry.event}${detail}`);
    }
    lines.push("");
    lines.push("══════════════════════════════════════════════════");
    return lines.join("\n");
  }
}

// ── Wait for a pipeline stage to complete or fail ───────────────────────────

function resolveLoopSessionSnapshot(loopSessionState, loopSessionId) {
  const activeSession = loopSessionState?.activeSession?.id === loopSessionId
    ? loopSessionState.activeSession
    : null;
  if (activeSession) {
    return { session: activeSession, archived: false };
  }
  const archivedSession = (Array.isArray(loopSessionState?.recentSessions) ? loopSessionState.recentSessions : [])
    .find((entry) => entry?.id === loopSessionId) || null;
  return { session: archivedSession, archived: Boolean(archivedSession) };
}

async function waitForStageTransition({
  expectedStage,
  stageTimeoutMs,
  loopSessionId,
  diag,
}) {
  const deadline = Date.now() + stageTimeoutMs;

  while (Date.now() < deadline) {
    const [activeRuntime, loopSessionState] = await Promise.all([
      loadActiveLoopRuntime(),
      loadLoopSessionState(),
    ]);
    const { session, archived } = resolveLoopSessionSnapshot(loopSessionState, loopSessionId);
    const runtimeMatches = activeRuntime?.loopSessionId === loopSessionId;

    if (runtimeMatches) {
      if (activeRuntime.currentStage !== expectedStage) {
        return { ok: true, nextStage: activeRuntime.currentStage, loopRuntime: activeRuntime, loopSession: session };
      }
      await sleep(3000);
      continue;
    }

    if (session) {
      const nextStage = session.status === "concluded"
        ? "concluded"
        : (session.currentStage || session.status || null);
      if (archived || session.currentStage !== expectedStage) {
        return { ok: true, nextStage, loopRuntime: null, loopSession: session };
      }
    }

    await sleep(2000);
  }

  // Timeout — check final state
  const [activeRuntime, loopSessionState] = await Promise.all([
    loadActiveLoopRuntime(),
    loadLoopSessionState(),
  ]);
  const { session } = resolveLoopSessionSnapshot(loopSessionState, loopSessionId);
  return {
    ok: false,
    reason: `stage_timeout (${(stageTimeoutMs / 1000).toFixed(0)}s)`,
    loopRuntime: activeRuntime?.loopSessionId === loopSessionId ? activeRuntime : null,
    loopSession: session,
  };
}

async function findStageContractId(stage, loopSessionId) {
  const contractPath = join(OC, "workspaces", stage, "inbox", "contract.json");
  const contract = await readJsonFile(contractPath);
  if (contract?.pipelineStage?.loopSessionId === loopSessionId) {
    return contract.id;
  }
  // Fallback: scan CONTRACTS_DIR
  try {
    const contracts = await fetchJSON("/watchdog/work-items");
    const match = contracts.find((c) =>
      c.pipelineStage?.stage === stage
      && c.pipelineStage?.loopSessionId === loopSessionId,
    );
    return match?.id || null;
  } catch { return null; }
}

// ── Main Test Runner ────────────────────────────────────────────────────────

export async function runLoopLiveCase(testCase) {
  const diag = new DiagnosticLog(testCase);
  const results = [];
  const elapsed = () => ((Date.now() - diag.startMs) / 1000).toFixed(1);

  console.log(`  Live loop: ${testCase.message}`);

  try {
    await loadConfig().catch(() => {});
    const loopAgents = resolveLiveLoopAgents(testCase.loopAgents);
    if (loopAgents.length < 2) {
      const detail = { requested: testCase.loopAgents || null, runtimeAgents: RUNTIME_AGENT_IDS };
      diag.log("setup", "AGENTS_UNAVAILABLE", detail);
      results.push({ id: "L0", name: "Resolve loop agents", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(detail).slice(0, 200) });
      return { testCase, results, duration: elapsed(), pass: false, diag };
    }
    // ── Setup ──
    await cleanLoopState(loopAgents);
    diag.log("setup", "CLEAN_STATE");

    // Compose loop
    const composeResult = await postAdmin("/watchdog/graph/loop/compose", {
      loopId: testCase.loopId,
      label: "live loop test",
      agents: loopAgents,
    });
    if (!composeResult?.ok) {
      diag.log("setup", "COMPOSE_FAIL", composeResult);
      results.push({ id: "L0", name: "Compose loop", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(composeResult).slice(0, 200) });
      return { testCase, results, duration: elapsed(), pass: false, diag };
    }
    diag.log("setup", "COMPOSE_OK", { loopId: testCase.loopId });
    results.push({ id: "L0", name: "Compose loop", status: "PASS", elapsed: elapsed() });

    // Start loop
    const startResult = await postAdmin("/watchdog/runtime/loop/start", {
      loopId: testCase.loopId,
      requestedTask: testCase.message,
      startAgent: loopAgents[0],
    });
    if (!startResult?.ok || startResult?.action !== "started") {
      diag.log("setup", "START_FAIL", startResult);
      results.push({ id: "L1", name: "Start loop", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(startResult).slice(0, 200) });
      return { testCase, results, duration: elapsed(), pass: false, diag };
    }
    const loopSessionId = startResult.loopSessionId;
    diag.log("setup", "START_OK", {
      contractId: startResult.contractId,
      loopSessionId,
      stage: startResult.currentStage,
    });
    results.push({ id: "L1", name: "Start loop", status: "PASS", elapsed: elapsed(), detail: `contract=${startResult.contractId}` });

    // ── Track each stage ──
    const expectedSequence = [...loopAgents];
    const stageContracts = {};

    for (let i = 0; i < expectedSequence.length; i++) {
      const stage = expectedSequence[i];
      const nextStage = expectedSequence[i + 1] || loopAgents[0];
      const stepId = `L${i + 2}`;

      diag.log(stage, "STAGE_START");

      // Find this stage's contract
      await sleep(2000); // Give time for contract to be written
      const contractId = await findStageContractId(stage, loopSessionId);
      if (contractId) {
        const contractSnapshot = await readContractFromApi(contractId);
        diag.stageContract(stage, contractSnapshot);
        stageContracts[stage] = { contractId, snapshot: contractSnapshot };
      } else {
        diag.log(stage, "CONTRACT_NOT_FOUND");
      }

      // Wait for stage to complete
      const waitResult = await waitForStageTransition({
        expectedStage: stage,
        stageTimeoutMs: testCase.stageTimeoutMs,
        loopSessionId,
        diag,
      });

      // Read final contract state from API
      const finalContract = contractId ? await readContractFromApi(contractId) : null;
      if (finalContract) {
        diag.stageResult(stage, finalContract);
        stageContracts[stage] = { contractId, snapshot: finalContract };
      }

      if (!waitResult.ok) {
        diag.log(stage, "STAGE_FAIL", { reason: waitResult.reason });
        results.push({
          id: stepId,
          name: `${stage} completes`,
          status: "FAIL",
          errorCode: `E_STAGE_${stage.toUpperCase().replace("-", "_")}`,
          elapsed: elapsed(),
          detail: `reason=${waitResult.reason}, totalCalls=${finalContract?.runtimeDiagnostics?.executionTrace?.totalCalls ?? "?"}`,
        });
        return { testCase, results, duration: elapsed(), pass: false, diag, stageContracts };
      }

      diag.log(stage, "STAGE_OK", { nextStage: waitResult.nextStage });
      results.push({
        id: stepId,
        name: `${stage} → ${waitResult.nextStage}`,
        status: "PASS",
        elapsed: elapsed(),
        detail: `calls=${finalContract?.runtimeDiagnostics?.executionTrace?.totalCalls ?? "?"}, ms=${finalContract?.runtimeDiagnostics?.executionTrace?.elapsedMs ?? "?"}`,
      });
    }

    // ── Verify round 2 started ──
    const [finalRuntime, finalLoopSessionState] = await Promise.all([
      loadActiveLoopRuntime(),
      loadLoopSessionState(),
    ]);
    const { session: finalLoopSession, archived: finalLoopArchived } = resolveLoopSessionSnapshot(finalLoopSessionState, loopSessionId);
    if (finalRuntime?.loopSessionId === loopSessionId && finalRuntime?.round === 2 && finalRuntime?.currentStage === loopAgents[0]) {
      diag.log("loop", "ROUND2_OK", { round: 2, stage: loopAgents[0] });
      results.push({ id: `L${expectedSequence.length + 2}`, name: "Loop-back to round 2", status: "PASS", elapsed: elapsed() });
    } else if (finalLoopArchived && finalLoopSession?.status === "concluded") {
      // Evaluator concluded the loop — still valid
      diag.log("loop", "CONCLUDED", { reason: finalLoopSession?.concludeReason });
      results.push({ id: `L${expectedSequence.length + 2}`, name: "Loop concluded by evaluator", status: "PASS", elapsed: elapsed(), detail: finalLoopSession?.concludeReason });
    } else {
      diag.log("loop", "ROUND2_UNEXPECTED", { loopRuntime: finalRuntime, loopSession: finalLoopSession });
      results.push({
        id: `L${expectedSequence.length + 2}`,
        name: "Loop-back or conclusion",
        status: "FAIL",
        elapsed: elapsed(),
        detail: `stage=${finalRuntime?.currentStage || finalLoopSession?.currentStage} round=${finalRuntime?.round || finalLoopSession?.round}`,
      });
      return { testCase, results, duration: elapsed(), pass: false, diag, stageContracts };
    }

    // Interrupt after success to clean up
    await postAdmin("/watchdog/runtime/loop/interrupt", {
      loopId: testCase.loopId,
      reason: "test_complete",
    }).catch(() => {});

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
      diag,
      stageContracts,
    };
  } catch (err) {
    diag.log("error", "UNCAUGHT", err.message);
    results.push({ id: "ERR", name: "Uncaught error", status: "FAIL", elapsed: elapsed(), detail: err.message });
    return { testCase, results, duration: elapsed(), pass: false, diag };
  }
}

// ── Report Generator ────────────────────────────────────────────────────────

export function generateLoopLiveReport(testResults, totalDuration) {
  const lines = [];
  const now = ts();
  const passed = testResults.filter((r) => r.pass).length;
  const failed = testResults.filter((r) => !r.pass).length;

  lines.push("══════════════════════════════════════════════════");
  lines.push(" OPENCLAW LIVE LOOP TEST REPORT");
  lines.push(` Run: ${now}  Duration: ${totalDuration}s`);
  lines.push(` Tests: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`);
  lines.push("══════════════════════════════════════════════════");
  lines.push("");

  for (const result of testResults) {
    lines.push(`── TEST: ${result.testCase.id} ──`);
    lines.push(`Task: ${result.testCase.message}`);
    lines.push(`Duration: ${result.duration}s  Result: ${result.pass ? "PASS" : "FAIL"}`);
    lines.push("");

    for (const cp of result.results) {
      const statusStr = `[${cp.status}]`.padEnd(8);
      const nameStr = cp.name.padEnd(35);
      const elapsedStr = `${cp.elapsed}s`.padStart(8);
      let line = `  ${statusStr} ${cp.id} ${nameStr} ${elapsedStr}`;
      if (cp.detail) line += `  ${cp.detail}`;
      lines.push(line);
    }
    lines.push("");

    // Append diagnostic log
    if (result.diag) {
      lines.push("── DIAGNOSTIC LOG ──");
      lines.push(result.diag.toReport());
      lines.push("");
    }
  }

  lines.push("══════════════════════════════════════════════════");
  lines.push(` SUMMARY: ${passed}/${testResults.length} PASSED  ${failed} FAILED`);
  lines.push("══════════════════════════════════════════════════");
  return lines.join("\n");
}
