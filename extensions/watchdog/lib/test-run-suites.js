// lib/test-run-suites.js — suite 分发器（CheckResult 体系）
//
// 8 个 preset → 7 个 suite 驱动（full = 7 段串行，CheckResult 聚进同一个 context）。
// 本模块只负责：分发、SSE 进度事件（事件名不变）、run 统计映射、clean reset。
// suite 永远不写报告；报告由 lib/test-run-artifacts.js 经 formal-report.js 渲染。

import { broadcast } from "./transport/sse.js";
import { EVENT_TYPE } from "./core/event-types.js";
import {
  sleep,
  waitForIdle,
  fullReset,
} from "./formal-runtime/infra.js";
import { summarizeChecks } from "./formal-runtime/checks/check-runner.js";
import { collectDispatchCases, collectPipelineCases } from "./test-run-presets.js";

// suite 驱动惰性加载（执行期 import，模块缓存使开销一次性）。
// 必须惰性：health/operator 套件静态依赖 cli-surface-registry/executor，而本模块在
// admin-surface-operations → test-runs 的启动链上——静态 import 会把整个套件栈焊成
// 启动期环（admin-surface-operations ←→ cli-surface-executor），并让单测的
// mock.module 隔离失效（实测曾导致单测内真跑 dispatch run + fullReset）。

// full 串行段（顺序：先零 LLM 体检，后 live 链路，再回路/动作/operator，最后知识库）。
export const FULL_SUITE_SEGMENTS = Object.freeze([
  "health",
  "dispatch",
  "pipeline",
  "loop",
  "system-action",
  "operator",
  "knowledge",
]);

// check 统计 → run 计数字段（payload 字段名契约：passed/failed/blockedCases 不变）。
// skip 不是失败（verdict 不受影响），计入 passedCases 以保持
// pass+fail+blocked === completed 的行级一致性（caseResults 行同样把 skip 映成 pass）。
export function applyRunStats(run) {
  const totals = summarizeChecks(run.checks || []);
  run.totalCases = totals.total;
  run.completedCases = totals.total;
  run.passedCases = totals.pass + totals.skip;
  run.failedCases = totals.fail;
  run.blockedCases = totals.blocked;
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

// 单段执行。preset.caseIds 只在「段 == preset 自己的 suite」时生效（--case 子集）；
// full 串行各段一律用 suite 默认 case 集（full 的 caseIds 是描述性段名）。
async function executeSuiteSegment(suiteKey, run, preset, context) {
  const ownCaseIds = preset?.suite === suiteKey && Array.isArray(preset?.caseIds) && preset.caseIds.length > 0
    ? preset.caseIds
    : null;
  switch (suiteKey) {
    case "health": {
      const { runHealthSuite } = await import("./formal-runtime/suite-health.js");
      return runHealthSuite(run, context);
    }
    case "dispatch": {
      const { runDispatchSuite, runLinkSuite } = await import("./formal-runtime/suite-link.js");
      return ownCaseIds
        ? runLinkSuite(run, context, { cases: collectDispatchCases(ownCaseIds) })
        : runDispatchSuite(run, context);
    }
    case "pipeline": {
      const { runPipelineSuite, runLinkSuite } = await import("./formal-runtime/suite-link.js");
      return ownCaseIds
        ? runLinkSuite(run, context, { cases: collectPipelineCases(ownCaseIds) })
        : runPipelineSuite(run, context);
    }
    case "loop": {
      const { runLoopSuite } = await import("./formal-runtime/suite-loop.js");
      return runLoopSuite(run, context);
    }
    case "system-action": {
      const { runSystemActionSuite } = await import("./formal-runtime/suite-system-action.js");
      return runSystemActionSuite(run, context);
    }
    case "operator": {
      const { runOperatorSuite } = await import("./formal-runtime/suite-operator.js");
      return runOperatorSuite(run, context);
    }
    case "knowledge": {
      const { runKnowledgeSuite } = await import("./formal-runtime/suite-knowledge.js");
      return runKnowledgeSuite(run, context);
    }
    default:
      throw new Error(`unsupported preset suite: ${suiteKey}`);
  }
}

export function resolveSuiteSegments(preset) {
  if (preset?.suite === "full") return [...FULL_SUITE_SEGMENTS];
  if (typeof preset?.suite === "string" && preset.suite.trim()) return [preset.suite.trim()];
  throw new Error("preset is missing a suite");
}

// 统一 suite 入口：所有 preset 都走这一条路径（test-runs.js 只调这一个函数）。
// 每段发 test_case_started/test_case_finished（caseId = 段名），保持 SSE 事件契约。
export async function runFormalSuite(run, preset, context) {
  const segments = resolveSuiteSegments(preset);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    run.status = "running";
    run.currentCaseId = segment;
    run.currentCaseMessage = `suite:${segment}`;
    emitRunEvent(EVENT_TYPE.TEST_CASE_STARTED, run, { caseId: segment, message: `suite:${segment}` });

    const beforeCount = context.checks.length;
    await executeSuiteSegment(segment, run, preset, context);
    applyRunStats(run);

    const segmentTotals = summarizeChecks(context.checks.slice(beforeCount));
    emitRunEvent(EVENT_TYPE.TEST_CASE_FINISHED, run, {
      caseId: segment,
      message: `suite:${segment}`,
      pass: segmentTotals.verdict === "PASS",
      blocked: segmentTotals.blocked > 0,
      duration: segmentTotals.durationMs,
      summary: `${segmentTotals.pass}/${segmentTotals.total} pass, ${segmentTotals.fail} fail, ${segmentTotals.skip} skip, ${segmentTotals.blocked} blocked`,
    });

    // full 串行段间：等系统静默（各 suite 自清理自己的探针产物，不做段间 fullReset）。
    if (i < segments.length - 1) {
      await waitForIdle();
      await sleep(1500);
    }
  }
}
