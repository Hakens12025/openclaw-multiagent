// lib/contract/terminal-outcome.js — 合约收口(执行面)。
//
// 收口按事实走,不下质量判断。三类事实,按可信度排:
//   1. agent 声明(submit_output 工具 > runtime_result.json 文件)      —— 转述,不是平台的看法
//   2. 中断事实(硬停/超时/崩溃)                                       —— 平台自证
//   3. 采集事实(outbox 里收到了什么)                                   —— 平台自证
//
// 判决面(lib/judgment,机械核对甲方期望)是**纯外挂**:收口经动态 import 问它一次,
// 目录不存在 → 跳过核对(没兜底);它自己抛错 → warn 后照样按事实收口(判决崩了
// 不拖累执行)。曾经这里是静态 import——rm -rf lib/judgment 会让执行面当场
// ERR_MODULE_NOT_FOUND,同一类"判决焊进执行"的跑偏第三次出现,故改为下述形态并配消融锁。
//
// "有没有交付物"(存在+非空)是执行面自己对事实的机械定义,不是判决——
// 判决核对的是**甲方期望**;这条区别决定了 checkDeliverable 住在本文件。
// 内容长相(控制文本分类)不属于机械定义:同一份交付因多一句散文而翻转判定
// 即启发式越界(2026-08-17 裸标记探针假失败案),分类器只守 delivery 用户读面。
//
// 本文件曾经 import contract-outcome.js(287 行判定器:五路优先级、语义猜测、
// 判决语汇 verdict/score/testsPassed 的派生)。那一套已随判决面重做整体删除。

import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { findSealedOutbox } from "../archive/outbox-seal.js";
import { classifyToolFailureResidue } from "../delivery/runtime-user-facing-output.js";
import {
  normalizeBoolean,
  normalizeFiniteNumber,
  normalizeRecord,
  normalizeString,
} from "../core/normalize.js";

const HOME = homedir();

// 执行面的交付物事实核对:存在 → 非空 → 非工具失败残渣。零 LLM,平台可自证。
// "工具失败残渣"是平台自己的失败形态(错误回声/路径残渣/纯空白)=事实识别;
// 内容长相启发式(裸标记 control_text 类)不在此列——那是 delivery 用户读面的
// 展示过滤,判定层无权按长相否决交付(2026-08-17 拆分裁定)。
async function checkDeliverable(path, { label = "deliverable" } = {}) {
  const raw = typeof path === "string" ? path.trim() : "";
  if (!raw) return null;
  const normalizedPath = resolve(raw.replace(/^~/, HOME));
  try {
    const fileStat = await stat(normalizedPath);
    if (!fileStat.isFile()) {
      return { ok: false, label, path: normalizedPath, reason: "not_a_file" };
    }
    if (fileStat.size <= 0) {
      return { ok: false, label, path: normalizedPath, reason: "empty_file" };
    }
    const content = await readFile(normalizedPath, "utf8");
    const failureResidue = classifyToolFailureResidue(content, { outputPath: normalizedPath });
    if (failureResidue) {
      return { ok: false, label, path: normalizedPath, reason: `invalid_semantic_payload:${failureResidue}` };
    }
    return { ok: true, label, path: normalizedPath };
  } catch (e) {
    return { ok: false, label, path: normalizedPath, reason: e.code === "ENOENT" ? "missing_file" : e.message };
  }
}

// 判决面外挂消费点(全系统唯一)。动态 import + 双层容错:
//   模块不存在 → null(判决被拔除,照跑没兜底);核对自身抛错 → null + warn。
let judgmentModulePromise;
async function resolveJudgment(logger) {
  if (judgmentModulePromise === undefined) {
    judgmentModulePromise = import("../judgment/expectation-check.js").catch(() => null);
  }
  const judgmentModule = await judgmentModulePromise;
  if (!judgmentModule?.checkExpectations) return null;
  return async (input) => {
    try {
      return await judgmentModule.checkExpectations(input);
    } catch (judgmentError) {
      logger?.warn?.(`[terminal] judgment check threw (ignored, closing on facts): ${judgmentError?.message || judgmentError}`);
      return null;
    }
  };
}

function normalizeTerminalArtifact(value) {
  const normalizedPath = normalizeString(value);
  if (normalizedPath) {
    return normalizedPath;
  }
  return normalizeRecord(value, null);
}

export function normalizeTerminalOutcome(outcome, {
  terminalStatus = null,
  ts = null,
} = {}) {
  const source = normalizeRecord(outcome, {});
  const status = normalizeString(
    terminalStatus
    || source.status
    || CONTRACT_STATUS.FAILED,
  ) || CONTRACT_STATUS.FAILED;
  return {
    version: Number.isFinite(source.version) ? Math.max(1, Math.trunc(source.version)) : 1,
    status,
    source: normalizeString(source.source) || "session",
    reason: normalizeString(source.reason) || null,
    summary: normalizeString(source.summary) || null,
    clarification: normalizeString(source.clarification) || null,
    verdict: normalizeString(source.verdict) || null,
    score: normalizeFiniteNumber(source.score, null),
    testsPassed: normalizeBoolean(source.testsPassed),
    actionType: normalizeString(source.actionType) || null,
    retryable: source.retryable === true,
    artifact: normalizeTerminalArtifact(source.artifact),
    // 判决在场的可观察凭据:核对过 N 项、缺 M 项。判决缺席/零期望 → null,
    // 与"零期望不冒充合格"同一纪律——没核对就不留痕。
    expectationCheck: normalizeExpectationCheck(source.expectationCheck),
    ts: Number.isFinite(source.ts) ? source.ts : (Number.isFinite(ts) ? ts : Date.now()),
  };
}

function normalizeExpectationCheck(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const checked = Number.isFinite(value.checked) ? Math.max(0, Math.trunc(value.checked)) : 0;
  if (checked <= 0) {
    return null;
  }
  const missing = Number.isFinite(value.missing) ? Math.max(0, Math.trunc(value.missing)) : 0;
  return { checked, missing };
}

// agent 本轮声明:L1 工具(submit_output → trackingState.submittedOutput)优先,
// L3 文件(runtime_result.json → stageRunResult.status)降级。都缺 → null,平台不代填。
function resolveDeclaration(trackingState, executionObservation) {
  const declared = trackingState?.submittedOutput;
  if (declared?.status) {
    return {
      status: normalizeString(declared.status),
      summary: normalizeString(declared.summary) || null,
      reason: normalizeString(declared.reason) || null,
      via: "tool",
    };
  }
  const fileStatus = normalizeString(executionObservation?.stageRunResult?.status);
  // 采集侧对缺声明的轮次会以 "completed" 默认值合成 stageRunResult —— 那是平台代填,
  // 不是 agent 说的,不作为声明采信。只转述 agent 明确写下的非默认状态。
  if (fileStatus === "failed") {
    return {
      status: fileStatus,
      summary: normalizeString(executionObservation?.stageRunResult?.summary) || null,
      reason: normalizeString(executionObservation?.stageRunResult?.feedback) || null,
      via: "file",
    };
  }
  return null;
}

function collectArtifactPaths(executionObservation) {
  const paths = Array.isArray(executionObservation?.artifactPaths)
    ? executionObservation.artifactPaths.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const primary = normalizeString(executionObservation?.primaryOutputPath);
  if (primary && !paths.includes(primary)) paths.push(primary);
  return paths;
}

/**
 * 收口。halted=true 表示本轮被平台中断(硬停/超时/崩溃)——中断且 agent 一句话没说时,
 * 盘上产物的含义不确定(可能是半成品),不能当交付采信。
 */
export async function resolveTerminalOutcome({
  trackingState,
  contractData,
  executionObservation,
  logger,
  halted = false,
}) {
  if (!trackingState?.contract) {
    const terminalOutcome = normalizeTerminalOutcome({
      status: CONTRACT_STATUS.COMPLETED,
      reason: "session completed",
      source: "session",
    }, {
      terminalStatus: CONTRACT_STATUS.COMPLETED,
    });
    return { terminalOutcome, terminalStatus: terminalOutcome.status };
  }

  const effectiveContract = contractData || trackingState.contract;
  const declaration = resolveDeclaration(trackingState, executionObservation);
  const artifactPaths = collectArtifactPaths(executionObservation);
  const primaryPath = normalizeString(executionObservation?.primaryOutputPath) || artifactPaths[0] || null;

  // 判决核对痕迹(第 2 步核对后填充);声明失败路(第 1 步)先于核对返回,无痕正确。
  let expectationSummary = null;

  const finalize = (outcome) => {
    const terminalOutcome = normalizeTerminalOutcome(
      { artifact: primaryPath, expectationCheck: expectationSummary, ...outcome },
      { terminalStatus: outcome.status },
    );
    return { terminalOutcome, terminalStatus: terminalOutcome.status };
  };

  // 1. agent 声明失败 —— 转述原话,盘上有什么都不改变它自己的结论。
  if (declaration?.status === "failed") {
    return finalize({
      status: CONTRACT_STATUS.FAILED,
      reason: declaration.reason || declaration.summary || "agent declared failure",
      summary: declaration.summary || declaration.reason || null,
      source: "declaration",
    });
  }

  // 2. 判决面核对甲方期望(纯外挂:不在场/自身崩溃都不拦路;零期望返回空,不冒充合格)。
  // 期望两个来源都喂:completionCriteria.requiredFiles(测试/历史面)+
  // expectations.requiredArtifacts(assign_task 派工声明,2026-08-12 前只写不读=断供)。
  const judge = await resolveJudgment(logger);
  const expectationReport = judge
    ? await judge({
        requiredFiles: effectiveContract?.completionCriteria?.requiredFiles,
        requiredArtifacts: effectiveContract?.expectations?.requiredArtifacts,
      })
    : null;
  if (expectationReport && expectationReport.checked.length > 0) {
    expectationSummary = {
      checked: expectationReport.checked.length,
      missing: expectationReport.missing.length,
    };
  }
  if (expectationReport && expectationReport.missing.length > 0) {
    const detail = expectationReport.missing
      .map((entry) => `${entry.label} ${entry.reason}`)
      .join("; ");
    logger?.warn?.(`[terminal] contract ${effectiveContract?.id || "unknown"} expectation check: ${detail}`);
    return finalize({
      status: CONTRACT_STATUS.FAILED,
      reason: detail,
      source: "expectation_check",
    });
  }

  // 3. 中断且无声明 —— 产物含义不确定,不当交付采信。
  if (halted && !declaration) {
    return finalize({
      status: CONTRACT_STATUS.FAILED,
      reason: "session halted before the agent declared an outcome",
      source: "halt",
    });
  }

  // 4. 按交付事实收口,读序:
  //    ① 树封包 seal.primary(合约轮正本,树模式零镜像,封条即采集事实;
  //       读端只采信 seal.contractId 与本合约一致的封条——归属核对在
  //       findSealedOutbox 内)
  //    ② 本轮采集观测 primaryPath(树轮 seal 缺席/写失败时,观测里的树内
  //       正本是本轮事实的第一回退)
  //    ③ contract.output 落点(直写链路仍写该地址)
  //    任一级命中即达标;前级核对未过继续后级(逐级回退,零短路),
  //    全部未过 → 照旧 missing 家族。
  //    基线核对(非空+非控制载荷)是平台对「有产物」的机械定义,不是质量判断。
  // assignee = 最后一跳受托人:多跳同 cid 多封条时按它锁定终局封条。
  const sealedOutbox = findSealedOutbox(effectiveContract?.id || null, {
    agentId: normalizeString(effectiveContract?.assignee) || null,
  });
  if (sealedOutbox?.primaryPath) {
    const sealedDeliverable = await checkDeliverable(sealedOutbox.primaryPath, { label: "sealed deliverable" });
    if (sealedDeliverable?.ok) {
      return finalize({
        status: CONTRACT_STATUS.COMPLETED,
        reason: declaration?.summary || executionObservation?.stageRunResult?.summary || "deliverable verified",
        summary: declaration?.summary || executionObservation?.stageRunResult?.summary || null,
        source: "deliverable",
        artifact: sealedDeliverable.path,
      });
    }
  }
  const declaredOutput = normalizeString(effectiveContract?.output);
  const fallbackTargets = [];
  if (primaryPath) {
    // 标签归属:primaryPath 可能就是 contract.output 的回填镜像
    // (terminal.js materializeExecutionObservation 的 contract_output_fallback)——
    // 去重后唯一目标必须保留 contract.output 标签,失败 reason 才指得回声明地址。
    fallbackTargets.push({
      path: primaryPath,
      label: primaryPath === declaredOutput ? "contract.output" : "deliverable",
    });
  }
  if (declaredOutput && declaredOutput !== primaryPath) {
    fallbackTargets.push({ path: declaredOutput, label: "contract.output" });
  }
  let lastMiss = null;
  for (const target of fallbackTargets) {
    const deliverable = await checkDeliverable(target.path, { label: target.label });
    if (deliverable?.ok) {
      return finalize({
        status: CONTRACT_STATUS.COMPLETED,
        reason: declaration?.summary || executionObservation?.stageRunResult?.summary || "deliverable verified",
        summary: declaration?.summary || executionObservation?.stageRunResult?.summary || null,
        source: "deliverable",
        artifact: deliverable.path,
      });
    }
    if (deliverable) lastMiss = deliverable;
  }
  if (lastMiss) {
    return finalize({
      status: CONTRACT_STATUS.FAILED,
      reason: `${lastMiss.label} ${lastMiss.reason}`,
      source: "deliverable",
    });
  }

  // 5. 无落点声明、无采集产物:agent 说完成也没有东西可交 —— 记失败并说清缺什么。
  return finalize({
    status: CONTRACT_STATUS.FAILED,
    reason: artifactPaths.length === 0 ? "no deliverable collected" : "no primary deliverable resolved",
    source: "deliverable",
  });
}
