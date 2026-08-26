// lib/formal-runtime/test-run-suites.js — suite 分发器（CheckResult 体系）
//
// preset → suite 驱动（full = 全部段串行，CheckResult 聚进同一个 context）。
// 本模块只负责：分发、SSE 进度事件（事件名不变）、run 统计映射、clean reset。
// suite 永远不写报告；报告由 lib/test-run-artifacts.js 经 formal-report.js 渲染。

import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  sleep,
  waitForIdle,
  fullReset,
  postAdmin,
} from "./infra.js";
import { summarizeChecks } from "./checks/check-runner.js";
import { collectDispatchCases, collectPipelineCases } from "./test-run-presets.js";
import { getGlobalRange, countContractsCreatedSince } from "../record-plane/record-reader.js";

// suite 驱动惰性加载（执行期 import，模块缓存使开销一次性）。
// 必须惰性：health/operator 套件静态依赖 cli-surface-registry/executor，而本模块在
// admin-surface-operations → test-runs 的启动链上——静态 import 会把整个套件栈焊成
// 启动期环（admin-surface-operations ←→ cli-surface-executor），并让单测的
// mock.module 隔离失效（实测曾导致单测内真跑 dispatch run + fullReset）。

// full 串行段（顺序：先零 LLM 体检；model 紧跟 health——下游 live 段都依赖 provider，
// 先探能给出「模型 X 不能干活」而非深埋的困惑失败；再 live 链路（single→concurrent→
// pipeline，concurrent 同为真实收官驱动，紧跟 single 把并发残留在只读段之前清完）；
// 再动作/operator（collab 靠一次真实收官驱动）；然后知识库与只读段；unit 收口
// （npm test 全量单测，静态不碰 runtime）。
// （automation-eval 段已随 harness 全退役删除，v226 / 2026-08-23，备忘录149）
export const FULL_SUITE_SEGMENTS = Object.freeze([
  "health",
  "model",
  "single",
  "concurrent",
  "pipeline",
  "collab",
  "operator",
  "knowledge",
  "viz",
  "group",
  "unit",
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
      const { runHealthSuite } = await import("./suite-health.js");
      return runHealthSuite(run, context);
    }
    case "model": {
      const { runModelSuite } = await import("./suite-model.js");
      return runModelSuite(run, context);
    }
    case "single": {
      const { runDispatchSuite, runLinkSuite } = await import("./suite-link.js");
      return ownCaseIds
        ? runLinkSuite(run, context, { cases: collectDispatchCases(ownCaseIds) })
        : runDispatchSuite(run, context);
    }
    case "concurrent": {
      const { runConcurrentSuite } = await import("./suite-concurrent.js");
      return runConcurrentSuite(run, context);
    }
    case "pipeline": {
      const { runPipelineSuite, runLinkSuite } = await import("./suite-link.js");
      return ownCaseIds
        ? runLinkSuite(run, context, { cases: collectPipelineCases(ownCaseIds) })
        : runPipelineSuite(run, context);
    }
    case "collab": {
      const { runSystemActionSuite } = await import("./suite-collab.js");
      return runSystemActionSuite(run, context);
    }
    case "operator": {
      const { runOperatorSuite } = await import("./suite-operator.js");
      return runOperatorSuite(run, context);
    }
    case "knowledge": {
      const { runKnowledgeSuite } = await import("./suite-knowledge.js");
      return runKnowledgeSuite(run, context);
    }
    case "viz": {
      const { runVizSuite } = await import("./suite-viz.js");
      return runVizSuite(run, context);
    }
    case "group": {
      const { runAgentGroupSuite } = await import("./suite-group.js");
      return runAgentGroupSuite(run, context);
    }
    case "unit": {
      const { runUnitSuite } = await import("./suite-unit.js");
      return runUnitSuite(run, context);
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

// ── 合约预算哨兵(2026-08-26 用户裁决) ──────────────────────────────────────
// live 测试窗口内新建合约数超预算(preset.contractBudget,默认 10)即判定失控增殖
// (实例:bridge 对 hook 回执自发 assign_task,一晚 2 个计划外 DIRECT)——立刻放弃
// 活动合约止血,防无穷增殖烧 LLM。工厂纯逻辑可单测;读账失败(null)不误杀。
export const DEFAULT_CONTRACT_BUDGET = 10;

export function createContractBudgetSentinel({ budget, readCount, onBreach, intervalMs = 5000 }) {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    let n = null;
    try { n = readCount(); } catch { n = null; }
    if (n == null) return; // 账读不到时按兵不动,不误杀
    if (n > budget) {
      fired = true;
      clearInterval(timer);
      onBreach(n);
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stop() { clearInterval(timer); },
    get fired() { return fired; },
  };
}

// 统一 suite 入口：所有 preset 都走这一条路径（test-runs.js 只调这一个函数）。
// 每段发 test_case_started/test_case_finished（caseId = 段名），保持 SSE 事件契约。
export async function runFormalSuite(run, preset, context) {
  const segments = resolveSuiteSegments(preset);

  // 哨兵起点=当前账面水位;窗口内每 5s 数一次新建合约。
  const budget = Number.isFinite(preset?.contractBudget) ? preset.contractBudget : DEFAULT_CONTRACT_BUDGET;
  const watermark = (() => {
    try { return getGlobalRange()?.maxGseq ?? 0; } catch { return 0; }
  })();
  let budgetBreach = null;
  const sentinel = createContractBudgetSentinel({
    budget,
    readCount: () => countContractsCreatedSince(watermark),
    onBreach: (n) => {
      budgetBreach = { created: n, budget };
      context.addCheck({
        id: "runner.contract-budget",
        subsystem: "runner",
        title: `live 合约预算护栏:窗口内新建 ${n} > 预算 ${budget},疑似失控增殖,已中止并放弃活动合约`,
        status: "fail",
        code: "E-RUNNER-006",
        evidence: `watermark gseq=${watermark}, created=${n}, budget=${budget}, preset=${preset?.id || run?.presetId || "?"}`,
        durationMs: 0,
      });
      console.log(`[watchdog] contract budget breached: ${n} > ${budget} (preset ${preset?.id}); aborting run + runtime reset`);
      broadcast("alert", {
        type: EVENT_TYPE.ERROR,
        text: `测试合约预算护栏触发:窗口内新建 ${n} 个合约 > 预算 ${budget},已中止测试并放弃活动合约(E-RUNNER-006)`,
        ts: Date.now(),
      });
      // 止血:放弃全部活动合约(清 tracker/queue/state),停掉在飞 LLM 消耗。
      postAdmin("/watchdog/reset", {}).catch(() => {});
    },
  });

  try {
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

    // 预算破口:当前段收尾后立刻停,不进下一段(fail CheckResult 已入账,verdict 必 FAIL)。
    if (budgetBreach) {
      run.currentCaseMessage = `contract budget breached: ${budgetBreach.created} > ${budgetBreach.budget}`;
      break;
    }

    // full 串行段间：等系统静默（各 suite 自清理自己的探针产物，不做段间 fullReset）。
    if (i < segments.length - 1) {
      await waitForIdle();
      await sleep(1500);
    }
  }
  } finally {
    sentinel.stop();
  }
}
