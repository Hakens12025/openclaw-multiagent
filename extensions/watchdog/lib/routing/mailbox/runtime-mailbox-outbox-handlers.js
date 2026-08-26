// lib/runtime-mailbox-outbox-handlers.js — role-specific outbox protocol handlers

import {
  readActiveInboxContract,
  collectRuntimeResult,
} from "./runtime-mailbox-outbox-helpers.js";
import { readContractSnapshotById, getContractPath } from "../../contract/contracts.js";
import { isDirectRequestEnvelope } from "../../protocol/protocol-primitives.js";
import { isTerminalContractStatus } from "../../core/runtime-status.js";

export async function collectWorkerOutbox({ agentId, outboxDir, files, logger, sessionStartMs = 0, declaredOutput = null, boundContractId = null, sessionKey = null, turnSucceeded = true, messageText = null }) {
  let inboxContract = await readActiveInboxContract(agentId);
  // 身份守卫(审查 2026-08-15):绑定合约 id 是本轮归属的唯一真值。清道夫删掉旧信封后
  // 判决回投/新约可能已顶替上位——占位者 id ≠ 绑定 id 时不得把别人的信封当本轮合约采集。
  if (boundContractId && inboxContract?.id && inboxContract.id !== boundContractId) {
    inboxContract = null;
  }
  // inbox 文件在场与否不是真值:清道夫(hooks/after-tool-call.js)会在 agent 读过
  // inbox/contract.json 的 10 秒后删文件,turn 长于这个窗口时采集就读不到信封,
  // 镜像/归属全部缺席(live 2026-08-15 复现,contract.output missing_file 假失败)。
  // 文件缺席/占位者错配 → 回退绑定合约 id 读共享正本(正本自带 output/createdAt)。
  if (!inboxContract?.id && boundContractId) {
    inboxContract = await readContractSnapshotById(boundContractId).catch(() => null);
  }
  let canonicalStatus = typeof inboxContract?.status === "string" ? inboxContract.status : null;
  // `output` (the canonical deliverable path control-plane/output/<id>.md) is ROUTING metadata that the
  // task-facing inbox copy STRIPS (it is not in TASK_FACING_INBOX_ALLOW_KEYS). collectRuntimeResult needs
  // it as the mirror target — without it the worker's primary artifact is only collected under its own
  // free-chosen name (output/artifact.md) and never lands at contract.output, so evaluateContractOutcome
  // fails the contract with "contract.output missing_file" despite a valid delivery. Resolve `output` from
  // the SHARED contract (the single routing truth) so the mirror fires; we do not expose the path into the
  // agent's inbox (agents keep using relative outbox/ paths).
  let activeContract = inboxContract;
  // 本轮合约创建时刻同样从共享正本取:inbox 投影剥掉了 createdAt,而采集侧
  // 要靠它区分"本轮产物"与"上一份合约的残件"(live 2026-08-05 复现)。
  if (inboxContract?.id && (!inboxContract.output || !inboxContract.createdAt || !canonicalStatus)) {
    const shared = await readContractSnapshotById(inboxContract.id);
    if (shared) {
      canonicalStatus = typeof shared.status === "string" ? shared.status : canonicalStatus;
      activeContract = {
        ...inboxContract,
        ...(shared.output ? { output: shared.output } : {}),
        ...(shared.createdAt ? { createdAt: shared.createdAt } : {}),
      };
    }
    // 镜像输入缺席留痕:正本不可读/缺 output ⇒ 主产物不会镜像到 contract.output
    // (v133 镜像 bug 家族的可观测化)。info 级——无 output 的合约(测试夹具/直达信封)
    // 走到这里是合法路径,warn 会误伤"正常交付零告警"锁。
    if (!inboxContract.output && !shared?.output) {
      logger?.info?.(
        `[mailbox] collectWorkerOutbox(${agentId}): shared contract ${inboxContract.id} `
        + `${shared ? "lacks output field" : "unreadable"} at ${getContractPath(inboxContract.id)} — mirror will not fire`,
      );
    }
  }
  // 终态守卫(审查 2026-08-15):合约已被外部判决(硬停终态化/重启孤儿收口)的迟到采集,
  // 不得再镜像覆写已判决合约的产物证据 —— 正常流采集时正本必为 running,终态即异常轮。
  if (activeContract && !isDirectRequestEnvelope(activeContract) && isTerminalContractStatus(canonicalStatus)) {
    logger?.info?.(
      `[mailbox] collectWorkerOutbox(${agentId}): contract ${activeContract.id} already terminal `
      + `(${canonicalStatus}) — late collection will not mirror onto decided output`,
    );
    activeContract = null;
  }
  return collectRuntimeResult({
    agentId,
    outboxDir,
    files,
    logger,
    activeContract,
    sessionStartMs,
    declaredOutput,
    sessionKey,
    turnSucceeded,
    messageText,
  });
}
