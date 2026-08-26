// session-progress-projection.js — 证据面的同步内存投影(spec §9 "退役并入新 store")。
//
// 账本(session-trace-store)是异步文件、且按设计对失败保持沉默;而 hard-stop 提交
// 决策与 runtime fault 判定在 after_tool_call 热路径上要一个同步、O(1)、可信的答案。
// 两种需求同源不同形:本模块在记账同一处同步维护一份最小事实投影,让活判定读它。
//
// 最小事实原则:投影只保留"该跳产物是否被提交"所需的那一个期望(contract.output),
// 完整的验收期望体系归 contract.expectations(平台专写)所有;核验它的判决面已于
// 2026-08-09 拔除待重做,本模块只做进度投影,不下判断。
// 这里刻意不复制。

import { sep } from "node:path";

import { clearSession as clearLoopSession, clearAllSessions as clearAllLoopSessions } from "../runtime/execution-hard-stop-registry.js";
import { participantOutboxDirFor } from "../archive/thread-tree-store.js";
import { resolvePhysicalWorkspacePath } from "../state/state-agent-helpers.js";

const progressBySession = new Map();

// 见过这么多次工具调用仍未提交产物 = 跑偏。阈值继承自退役的 execution-trace-store。
const OFF_TRACK_MIN_TOOL_CALLS = 15;

// 写类工具名(大小写不敏感)。判定口径继承自退役的 execution-trace-store。
const WRITE_TOOL_PATTERN = /^(write|create|edit|apply_patch)$/i;

function normalizeSessionKey(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
}

/**
 * 开账:登记该会话的最小期望(contract.output)。
 * 仅 before_agent_start 调用——主会话/复用会话走不到那里,投影对它们保持缺席,
 * 查询返回 null。刻意不做惰性开账:凭空补一条 outputCommitted:false 会让原本
 * "无判定"的会话变成"判定未提交",直接改写硬停与转发的活语义。
 */
export function openSessionProgress(sessionKey, contract, { agentId = null } = {}) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;

  // 树 outbox 落点(合约轮):agent 写 outbox/ 时落点物理化后住在
  // threads/…/participants/{agent}/outbox-{cid}/,该目录内的成功写与
  // contract.output 命中同权(树模式零镜像,contract.output 不再被写)。
  // 谱系/agent 缺一 → null,判定退回 outputPath 单判据。
  let treeOutboxDir = null;
  try {
    const lineage = contract?.lineage;
    if (agentId && contract?.id && lineage?.threadId && lineage?.runId) {
      treeOutboxDir = resolvePhysicalWorkspacePath(
        participantOutboxDirFor(lineage, agentId, contract.id),
      ) || null;
    }
  } catch {
    treeOutboxDir = null;
  }

  const record = {
    sessionKey: key,
    contractId: contract?.id || null,
    outputPath: typeof contract?.output === "string" && contract.output ? contract.output : null,
    treeOutboxDir,
    toolCallCount: 0,
    writeCount: 0,
    lastWritePath: null,
    outputCommitted: false,
    // 构成提交的那次写的实际落盘路径:树轮命中树 outbox 内文件、真目录轮命中
    // contract.output——硬停收口链(deriveHardStopCommitInfo)以它为 commitPath,
    // 树轮 contract.output 无文件,单靠 output 地址会让 reconcile 短路。
    committedWritePath: null,
    startedAt: Date.now(),
  };
  progressBySession.set(key, record);
  return record;
}

/**
 * 记一次工具调用。成功写入且落点命中 contract.output → 标记产物已提交。
 * 返回 true 表示这一步刚好构成产物提交,否则 false。
 */
export function recordProgressToolCall(sessionKey, { tool, targetPath, writeSucceeded = true } = {}) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return false;

  const record = progressBySession.get(key);
  if (!record) return false;

  record.toolCallCount += 1;

  const isWrite = WRITE_TOOL_PATTERN.test(String(tool || ""));
  if (!isWrite || !targetPath || writeSucceeded !== true) return false;

  record.writeCount += 1;
  record.lastWritePath = targetPath;

  // includes 而非 ===:落点是解析后的绝对路径,合约 output 可能是相对片段。
  if (record.outputPath && targetPath.includes(record.outputPath)) {
    record.outputCommitted = true;
    record.committedWritePath = targetPath;
    return true;
  }

  // 树内命中:写落点物理化后(outbox 链解析进树)落在本合约树 outbox 目录内。
  if (record.treeOutboxDir) {
    const physicalTarget = resolvePhysicalWorkspacePath(targetPath);
    if (
      physicalTarget
      && (physicalTarget === record.treeOutboxDir || physicalTarget.startsWith(record.treeOutboxDir + sep))
    ) {
      record.outputCommitted = true;
      record.committedWritePath = physicalTarget;
      return true;
    }
  }
  return false;
}

/**
 * 同步查询该会话的进展事实。未开账 → null(调用方据此退化,勿当作"未提交")。
 */
export function getSessionProgress(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;

  const record = progressBySession.get(key);
  if (!record) return null;

  return {
    contractId: record.contractId,
    totalCalls: record.toolCallCount,
    outputCommitted: record.outputCommitted,
    committedWritePath: record.committedWritePath,
    offTrack: Boolean(record.outputPath)
      && !record.outputCommitted
      && record.toolCallCount >= OFF_TRACK_MIN_TOOL_CALLS,
    writeCount: record.writeCount,
    lastWritePath: record.lastWritePath,
    elapsedMs: Date.now() - record.startedAt,
  };
}

// 清账顺带清 loop-detection 计数器:这层耦合继承自退役的 execution-trace-store,
// 是活语义——收官只调这一个清理点,漏清会让重复计数跨会话残留成假硬停。
export function clearSessionProgress(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return false;
  clearLoopSession(key);
  return progressBySession.delete(key);
}

export function clearAllSessionProgress() {
  const count = progressBySession.size;
  progressBySession.clear();
  clearAllLoopSessions();
  return count;
}
