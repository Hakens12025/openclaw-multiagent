// tests/suite-single.js — Single task test runner + report generator (black-box observer)

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PORT, OUTPUT_DIR,
  fetchJSON, sendViaBridge, wakeAgentNow,
  sleep,
} from "./infra.js";
import { generateFormalReport } from "./formal-report.js";
import {
  listFormalConcurrentCases,
  listFormalSingleCases,
} from "../lib/formal-test-case-catalog.js";
import { evaluateOutputValidation } from "../lib/test-output-validation.js";
import { createTestTimeoutBudget } from "../lib/test-timeout-policy.js";

// ── Test Cases ────────────────────────────────────────────────────────────────

export const SINGLE_CASES = listFormalSingleCases();

export const CONCURRENT_CASES = listFormalConcurrentCases();

const TERMINAL_CONTRACT_STATUSES = new Set(["completed", "failed", "abandoned"]);

const ISSUE_CATALOG = {
  E_SEND_FAIL:          { subsystem: "bridge-entry",    conclusion: "消息发送失败",           suggestedFix: "检查 bridge agent 配置和 gateway 状态。" },
  E_CONTRACT_MISSING:   { subsystem: "ingress",         conclusion: "消息已发送但合约未创建",   suggestedFix: "检查 ingress 分流和合约创建逻辑。" },
  E_TIMEOUT:            { subsystem: "end-to-end",      conclusion: "合约未在超时内到达终态",   suggestedFix: "检查事件时间线，定位阻塞阶段。" },
  E_CONTRACT_FAILED:    { subsystem: "execution",       conclusion: "合约执行后状态为 failed", suggestedFix: "检查最后活跃的 agent session 和错误日志。" },
  E_OUTPUT_MISSING:     { subsystem: "output",          conclusion: "合约完成但输出文件不存在", suggestedFix: "检查 output 目录写入和 artifact 提交。" },
  E_OUTPUT_TOO_SMALL:   { subsystem: "output-quality",  conclusion: "输出文件内容过短",        suggestedFix: "检查 worker 产出和最小字数要求。" },
  E_OUTPUT_KEYWORD_MISS:{ subsystem: "output-quality",  conclusion: "输出文件缺少关键内容",    suggestedFix: "检查提示约束和验证关键字。" },
  E_RANDOM_PATH_BLOCKED:{ subsystem: "random-ingress",  conclusion: "随机入口未进入统一 execution contract 主链", suggestedFix: "检查 chosen agent 的正式外部入口能力和 shared-contract 收口。" },
};

// ── Helper: drain SSE events into timeline ────────────────────────────────────

function drainSSEEvents(sse, startMs, contractId, timeline) {
  let lastObservedAt = 0;
  for (const evt of sse.events) {
    if (evt.claimed || evt.replay || evt.receivedAt < startMs) continue;
    const evtCid = evt.data?.contractId;
    const matchesCid = !contractId || !evtCid || evtCid === contractId;
    if (!matchesCid) continue;

    if (evt.type === "track_start") {
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "agent session start", agentId: evt.data?.agentId });
    } else if (evt.type === "track_end") {
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "agent session end", agentId: evt.data?.agentId, status: evt.data?.status });
    } else if (evt.type === "track_progress") {
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "agent tool call", agentId: evt.data?.agentId, toolCallCount: evt.data?.toolCallCount });
    } else if (evt.type === "alert" && evt.data?.type === "delivery_created") {
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "delivery created", contractId: evt.data?.contractId });
    } else if (evt.type === "alert" && evt.data?.type === "delivery_notified") {
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "delivery notified", contractId: evt.data?.contractId, agentId: evt.data?.agentId });
    }
  }
  return lastObservedAt;
}

// ── Helper: poll contracts API to find contract by task text ──────────────────

async function pollForContract(taskText, afterMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contracts = await fetchJSON("/watchdog/work-items");
      const match = contracts.find((c) => {
        const createdAt = Number(c?.createdAt || 0);
        const task = String(c?.task || "");
        return task.includes(taskText.slice(0, 50)) && createdAt >= (afterMs - 2000);
      });
      if (match) return match;
    } catch {}
    await sleep(1000);
  }
  return null;
}

// ── Helper: validate output file ─────────────────────────────────────────────

async function validateOutput(contractId, validate) {
  if (!validate) return { ok: true };
  let outputPath = null;
  try {
    const files = await readdir(OUTPUT_DIR);
    const match = files.find((f) => f.includes(contractId));
    if (match) outputPath = join(OUTPUT_DIR, match);
  } catch {}

  if (!outputPath) {
    return { ok: false, errorCode: "E_OUTPUT_MISSING", detail: `no output file found for ${contractId}` };
  }

  let content = "";
  let size = 0;
  try {
    const buf = await readFile(outputPath);
    size = buf.length;
    content = buf.toString("utf8");
  } catch (e) {
    return { ok: false, errorCode: "E_OUTPUT_MISSING", detail: `read failed: ${e.message}` };
  }

  const minBytes = validate.minBytes || 0;
  const validation = evaluateOutputValidation({
    content,
    validate,
    sizeFailureCode: "E_OUTPUT_TOO_SMALL",
    keywordFailureCode: "E_OUTPUT_KEYWORD_MISS",
  });
  if (!validation.ok) {
    if (validation.status === "E_OUTPUT_TOO_SMALL") {
      return { ok: false, errorCode: "E_OUTPUT_TOO_SMALL", detail: `expected >= ${minBytes} bytes, got ${size}` };
    }
    return {
      ok: false,
      errorCode: "E_OUTPUT_KEYWORD_MISS",
      detail: `missing keywords: ${validation.missingKeywords.join(", ")}`,
    };
  }

  return { ok: true, size, path: outputPath };
}

// ── Helper: assemble result object ───────────────────────────────────────────

function buildResult(testCase, {
  verdict,
  errorCode,
  detail,
  timeline,
  elapsed,
  contractId,
  outputInfo,
  randomRuntime = null,
}) {
  return {
    testCase,
    results: timeline,
    duration: elapsed,
    pass: verdict === "PASS",
    blocked: verdict === "BLOCKED",
    contractId: contractId || null,
    outputInfo: outputInfo || null,
    errorCode: verdict !== "PASS" ? (errorCode || "UNKNOWN") : null,
    errorDetail: verdict !== "PASS" ? detail : null,
    randomRuntime,
  };
}

export function buildRandomPathVerdict(runtime) {
  if (runtime?.family === "user-random" && runtime?.actualPath === "direct_request") {
    return {
      pass: false,
      blocked: true,
      errorCode: "E_RANDOM_PATH_BLOCKED",
      detail: "user-random ingress resolved to direct_request instead of execution_contract",
    };
  }
  return null;
}

// ── Helper: summarize diagnosis from result ───────────────────────────────────

export function summarizeTestDiagnosis(result) {
  if (!result || result.pass) return null;
  const errorCode = result.errorCode || "UNKNOWN";
  const meta = ISSUE_CATALOG[errorCode] || {
    subsystem: "unknown",
    conclusion: "测试失败",
    suggestedFix: "检查事件时间线和合约状态。",
  };
  return {
    status: "FAIL",
    errorCode,
    subsystem: meta.subsystem,
    conclusion: meta.conclusion,
    evidence: [
      result.contractId ? `contract=${result.contractId}` : null,
      result.errorDetail ? result.errorDetail.slice(0, 180) : null,
    ].filter(Boolean).join(" | "),
    suggestedFix: meta.suggestedFix || null,
  };
}

// ── Core: run a single black-box test ────────────────────────────────────────

export async function runSingleTest(testCase, sse, _logOffset, queuePosition = 0, _options = {}) {
  const startMs = Date.now();
  const timeoutBudget = createTestTimeoutBudget({
    startMs,
    baseTimeoutMs: testCase.timeoutMs,
    groupTimeoutMs: _options.groupTimeoutMs,
    queuePosition,
  });
  const timeline = [];
  const randomRuntime = _options.randomRuntime && typeof _options.randomRuntime === "object"
    ? { ..._options.randomRuntime }
    : null;
  let contractId = null;
  let lastObservedStatus = null;
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);
  const remainingMs = () => timeoutBudget.remainingMs(Date.now());
  const timedOut = () => timeoutBudget.isExpired(Date.now());

  // ── Phase 1: Send ──────────────────────────────────────────────────────────
  const chosenAgent = typeof _options.chosenAgent === "string" && _options.chosenAgent.trim()
    ? _options.chosenAgent.trim()
    : null;
  const customSendMessage = typeof _options.sendMessage === "function"
    ? _options.sendMessage
    : null;
  const customSendLabel = typeof _options.sendMessageLabel === "string" && _options.sendMessageLabel.trim()
    ? _options.sendMessageLabel.trim()
    : null;
  const userRandomIngress = _options.ingressMode === "user-random" && chosenAgent;
  console.log(customSendMessage
    ? `  Sending via ${customSendLabel || "custom sender"}: "${testCase.message}"`
    : userRandomIngress
      ? `  Sending via user-random ingress to ${chosenAgent}: "${testCase.message}"`
      : `  Sending via bridge: "${testCase.message}"`);
  let sendOk = false;
  try {
    const sendRes = customSendMessage
      ? await customSendMessage(testCase.message)
      : userRandomIngress
        ? await wakeAgentNow(chosenAgent, testCase.message)
        : await sendViaBridge(testCase.message);
    sendOk = sendRes?.ok !== false;
  } catch (e) {
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: "E_SEND_FAIL",
      detail: e.message,
      timeline,
      elapsed: elapsed(),
      contractId: null,
      randomRuntime,
    });
  }
  if (!sendOk) {
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: "E_SEND_FAIL",
      detail: "bridge returned non-ok response",
      timeline,
      elapsed: elapsed(),
      contractId: null,
      randomRuntime,
    });
  }

  // ── Phase 2: Observe ──────────────────────────────────────────────────────

  const pathEvt = await sse.waitFor(
    (e) => e.type === "alert"
      && e.receivedAt >= startMs
      && (
        (
          e.data?.type === "inbox_dispatch"
          && String(e.data?.task || "").includes(testCase.message.slice(0, 50))
        ) || (
          userRandomIngress
          && e.data?.type === "direct_session"
          && e.data?.agentId === chosenAgent
          && String(e.data?.task || "").includes(testCase.message.slice(0, 50))
        )
      ),
    Math.min(30000, remainingMs()),
  );

  if (pathEvt?.data?.type === "direct_session") {
    pathEvt.claimed = true;
    timeoutBudget.noteProgress(pathEvt.receivedAt);
    if (randomRuntime) {
      randomRuntime.actualPath = "direct_request";
      randomRuntime.pathVerdict = "blocked";
      randomRuntime.pathVerdictReason = "fell back to direct session";
    }
    const blockedVerdict = buildRandomPathVerdict(randomRuntime);
    return buildResult(testCase, {
      verdict: blockedVerdict?.blocked ? "BLOCKED" : "FAIL",
      errorCode: blockedVerdict?.errorCode || "E_RANDOM_PATH_BLOCKED",
      detail: blockedVerdict?.detail || "random ingress path blocked",
      timeline,
      elapsed: elapsed(),
      contractId: null,
      randomRuntime,
    });
  }

  if (pathEvt?.data?.type === "inbox_dispatch") {
    contractId = pathEvt.data?.contractId || null;
    pathEvt.claimed = true;
    timeoutBudget.noteProgress(pathEvt.receivedAt);
    if (randomRuntime) {
      randomRuntime.actualPath = "execution_contract";
      randomRuntime.pathVerdict = "pass";
      randomRuntime.pathVerdictReason = null;
    }
    timeline.push({ at: pathEvt.receivedAt, event: "contract dispatched", contractId });
  } else {
    // Fallback: poll contracts API
    console.log("  (no inbox_dispatch SSE — polling contracts API)");
    const found = await pollForContract(testCase.message, startMs, Math.min(20000, remainingMs()));
    if (found) {
      contractId = found.id || null;
      timeoutBudget.noteProgress(Date.now());
      if (randomRuntime) {
        randomRuntime.actualPath = "execution_contract";
        randomRuntime.pathVerdict = "pass";
        randomRuntime.pathVerdictReason = null;
      }
      timeline.push({ at: Date.now(), event: "contract found via poll", contractId });
    }
  }

  if (!contractId) {
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: "E_CONTRACT_MISSING",
      detail: "no contract found after send",
      timeline,
      elapsed: elapsed(),
      contractId: null,
      randomRuntime,
    });
  }

  // Loop: drain events + poll contract status until terminal or timeout
  let finalStatus = null;
  while (!timedOut()) {
    const lastObservedAt = drainSSEEvents(sse, startMs, contractId, timeline);
    if (lastObservedAt > 0) {
      timeoutBudget.noteProgress(lastObservedAt);
    }

    try {
      const contracts = await fetchJSON("/watchdog/work-items");
      const contract = contracts.find((c) => c.id === contractId);
      if (contract) {
        const status = contract.status || "unknown";
        if (status !== lastObservedStatus) {
          lastObservedStatus = status;
          timeoutBudget.noteProgress(Date.now());
        }
        if (TERMINAL_CONTRACT_STATUSES.has(status)) {
          finalStatus = status;
          break;
        }
      }
    } catch {}

    await sleep(1000);
  }

  // Drain any remaining events
  drainSSEEvents(sse, startMs, contractId, timeline);

  // ── Phase 3: Verify ───────────────────────────────────────────────────────

  if (!finalStatus) {
    // Timed out
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: "E_TIMEOUT",
      detail: `contract did not reach terminal status within ${timeoutBudget.currentDeadlineMs - startMs}ms`,
      timeline,
      elapsed: elapsed(),
      contractId,
      randomRuntime,
    });
  }

  if (finalStatus === "failed" || finalStatus === "abandoned") {
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: "E_CONTRACT_FAILED",
      detail: `contract terminal status: ${finalStatus}`,
      timeline,
      elapsed: elapsed(),
      contractId,
      randomRuntime,
    });
  }

  // Validate output
  const validate = testCase.validate || testCase.validateOutput || null;
  if (validate) {
    const check = await validateOutput(contractId, validate);
    if (!check.ok) {
      return buildResult(testCase, {
        verdict: "FAIL",
        errorCode: check.errorCode,
        detail: check.detail,
        timeline,
        elapsed: elapsed(),
        contractId,
        randomRuntime,
      });
    }
    const outputInfo = check.path
      ? `${check.path.split("/").pop()} (${check.size} bytes)`
      : null;
    return buildResult(testCase, {
      verdict: "PASS",
      timeline,
      elapsed: elapsed(),
      contractId,
      outputInfo,
      randomRuntime,
    });
  }

  return buildResult(testCase, {
    verdict: "PASS",
    timeline,
    elapsed: elapsed(),
    contractId,
    randomRuntime,
  });
}

// ── Report Generator ──────────────────────────────────────────────────────────

export function generateReport(testResults, suiteType, totalDuration) {
  return generateFormalReport({ suiteType, totalDuration, gatewayPort: PORT, testResults });
}
