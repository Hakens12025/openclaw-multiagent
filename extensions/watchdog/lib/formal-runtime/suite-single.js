// Single task formal runner + report generator (black-box observer)

import {
  PORT,
  fetchJSON,
  sendTestInject,
  wakeAgentNow,
  sleep,
} from "./infra.js";
import { generateFormalReport } from "./formal-report.js";
import {
  listFormalConcurrentCases,
  listFormalSingleCases,
} from "../formal-test-case-catalog.js";
import { readContractSnapshotById } from "../contracts.js";
import { createTestTimeoutBudget } from "../test-timeout-policy.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import {
  drainSSEEvents,
  pollForContract,
  validateOutput,
  markTimedOutContract,
  pickSingleContractRuntimeSnapshot,
  buildResult,
} from "./suite-single-observer.js";

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
  E_QQ_DELIVERY_FAILED: { subsystem: "terminal-delivery", conclusion: "QQ 合约完成但最终 QQ 投递失败", suggestedFix: "检查 QQ outbound、目标 openid、限流和 terminalDelivery 诊断。" },
  E_RANDOM_PATH_BLOCKED:{ subsystem: "random-ingress",  conclusion: "随机入口未进入统一 execution contract 主链", suggestedFix: "检查 chosen agent 的正式外部入口能力和 shared-contract 收口。" },
};

export { drainSSEEvents, validateOutput, resolveValidationOutputPath } from "./suite-single-observer.js";

export function resolveSingleTestSendPlan({
  options = {},
} = {}) {
  const chosenAgent = typeof options.chosenAgent === "string" && options.chosenAgent.trim()
    ? options.chosenAgent.trim()
    : null;
  const source = typeof options.source === "string" && options.source.trim()
    ? options.source.trim()
    : "webui";
  const replyTo = options.replyTo && typeof options.replyTo === "object"
    ? options.replyTo
    : null;
  if (options.ingressMode === "user-random" && chosenAgent) {
    return {
      kind: "agent_wake",
      label: `user-random ingress to ${chosenAgent}`,
      agentId: chosenAgent,
      source,
      replyTo,
    };
  }
  return {
    kind: "trusted_ingress",
    label: "watchdog trusted ingress",
    agentId: null,
    source,
    replyTo,
  };
}

export function buildRandomPathVerdict(runtime) {
  if (runtime?.family === "user-random" && runtime?.actualPath === "direct_request") {
    return {
      pass: false,
      blocked: true,
      errorCode: "E_RANDOM_PATH_BLOCKED",
      detail: "user-random ingress resolved to topology-free direct intake instead of execution_contract",
    };
  }
  return null;
}

export function validateSingleTestTransportDelivery({ transport, contractRuntime } = {}) {
  if (transport !== "qq") return { ok: true };
  const terminalDelivery = contractRuntime?.runtimeDiagnostics?.terminalDelivery;
  const qqChannelDelivered = terminalDelivery?.channel === "qq" && terminalDelivery?.notified === true;
  if (terminalDelivery?.ok === true && qqChannelDelivered) return { ok: true };
  const detail = [
    "qq terminal delivery did not report a notified QQ delivery",
    terminalDelivery?.channel ? `channel=${terminalDelivery.channel}` : null,
    terminalDelivery?.stage ? `stage=${terminalDelivery.stage}` : null,
    typeof terminalDelivery?.notified === "boolean" ? `notified=${terminalDelivery.notified}` : null,
    terminalDelivery?.error ? `error=${terminalDelivery.error}` : null,
    terminalDelivery?.reason ? `reason=${terminalDelivery.reason}` : null,
    terminalDelivery?.detail ? `detail=${terminalDelivery.detail}` : null,
    terminalDelivery ? null : "terminalDelivery missing",
  ].filter(Boolean).join("; ");
  return {
    ok: false,
    errorCode: "E_QQ_DELIVERY_FAILED",
    detail,
  };
}

async function waitForSingleTestTransportRuntime({
  transport,
  loadContractRuntime,
  waitMs = 20000,
  pollMs = 500,
} = {}) {
  let runtimeResult = await loadContractRuntime();
  if (transport !== "qq") return runtimeResult;

  const deadline = Date.now() + waitMs;
  while (!runtimeResult.contractRuntime?.runtimeDiagnostics?.terminalDelivery && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    runtimeResult = await loadContractRuntime();
  }
  return runtimeResult;
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
  const loadContractRuntime = async () => {
    if (!contractId) {
      return { contractRuntime: null, incident: null };
    }
    try {
      const contract = await readContractSnapshotById(contractId);
      const contractRuntime = pickSingleContractRuntimeSnapshot(contract);
      return {
        contractRuntime,
        incident: contractRuntime?.runtimeDiagnostics?.executionIncident || null,
      };
    } catch {
      return { contractRuntime: null, incident: null };
    }
  };

  // ── Phase 1: Send ──────────────────────────────────────────────────────────
  const customSendMessage = typeof _options.sendMessage === "function"
    ? _options.sendMessage
    : null;
  const customSendLabel = typeof _options.sendMessageLabel === "string" && _options.sendMessageLabel.trim()
    ? _options.sendMessageLabel.trim()
    : null;
  const sendPlan = resolveSingleTestSendPlan({ options: _options });
  const chosenAgent = sendPlan.agentId;
  const userRandomIngress = sendPlan.kind === "agent_wake" && chosenAgent;
  console.log(customSendMessage
    ? `  Sending via ${customSendLabel || "custom sender"}: "${testCase.message}"`
    : `  Sending via ${sendPlan.label}: "${testCase.message}"`);
  let sendOk = false;
  try {
    const sendRes = customSendMessage
      ? await customSendMessage(testCase.message)
      : userRandomIngress
        ? await wakeAgentNow(chosenAgent, testCase.message)
        : await sendTestInject(testCase.message, sendPlan.source, sendPlan.replyTo);
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
      && e.data?.type === "inbox_dispatch"
      && String(e.data?.task || "").includes(testCase.message.slice(0, 50)),
    Math.min(30000, remainingMs()),
  );

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
    const detail = `contract did not reach terminal status within ${timeoutBudget.currentDeadlineMs - startMs}ms`;
    await markTimedOutContract(contractId, detail);
    const runtimeResult = await loadContractRuntime();
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: "E_TIMEOUT",
      detail,
      timeline,
      elapsed: elapsed(),
      contractId,
      contractRuntime: runtimeResult.contractRuntime,
      incident: runtimeResult.incident,
      randomRuntime,
    });
  }

  if (finalStatus === "failed" || finalStatus === "abandoned") {
    const runtimeResult = await loadContractRuntime();
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: "E_CONTRACT_FAILED",
      detail: `contract terminal status: ${finalStatus}`,
      timeline,
      elapsed: elapsed(),
      contractId,
      contractRuntime: runtimeResult.contractRuntime,
      incident: runtimeResult.incident,
      randomRuntime,
    });
  }

  const completedRuntimeResult = await waitForSingleTestTransportRuntime({
    transport: _options.transport,
    loadContractRuntime,
  });
  const transportDeliveryCheck = validateSingleTestTransportDelivery({
    transport: _options.transport,
    contractRuntime: completedRuntimeResult.contractRuntime,
  });
  if (!transportDeliveryCheck.ok) {
    return buildResult(testCase, {
      verdict: "FAIL",
      errorCode: transportDeliveryCheck.errorCode,
      detail: transportDeliveryCheck.detail,
      timeline,
      elapsed: elapsed(),
      contractId,
      contractRuntime: completedRuntimeResult.contractRuntime,
      incident: completedRuntimeResult.incident,
      randomRuntime,
    });
  }

  // Validate output
  const validate = testCase.validate || testCase.validateOutput || null;
  if (validate) {
    const check = await validateOutput(contractId, validate);
    if (!check.ok) {
      const runtimeResult = await loadContractRuntime();
      return buildResult(testCase, {
        verdict: "FAIL",
        errorCode: check.errorCode,
        detail: check.detail,
        timeline,
        elapsed: elapsed(),
        contractId,
        contractRuntime: runtimeResult.contractRuntime,
        incident: runtimeResult.incident,
        randomRuntime,
      });
    }
    const outputInfo = check.path
      ? `${check.path.split("/").pop()} (${check.size} bytes)`
      : null;
    const runtimeResult = await loadContractRuntime();
    return buildResult(testCase, {
      verdict: "PASS",
      timeline,
      elapsed: elapsed(),
      contractId,
      outputInfo,
      contractRuntime: runtimeResult.contractRuntime,
      incident: runtimeResult.incident,
      randomRuntime,
    });
  }

  const runtimeResult = await loadContractRuntime();
  return buildResult(testCase, {
    verdict: "PASS",
    timeline,
    elapsed: elapsed(),
    contractId,
    contractRuntime: runtimeResult.contractRuntime,
    incident: runtimeResult.incident,
    randomRuntime,
  });
}

// ── Report Generator ──────────────────────────────────────────────────────────

export function generateReport(testResults, suiteType, totalDuration) {
  return generateFormalReport({ suiteType, totalDuration, gatewayPort: PORT, testResults });
}
