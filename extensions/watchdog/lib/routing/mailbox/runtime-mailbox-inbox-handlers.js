// lib/runtime-mailbox-inbox-handlers.js — role-specific inbox routing handlers

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../state.js";
import {
  cacheContractSnapshot,
  evictContractSnapshotByPath,
  readCachedContractSnapshotById,
  readContractSnapshotByPath,
} from "../../store/contract-store.js";
import { getContractPath } from "../../contract/contracts.js";
import {
  getTrackingState,
  hasOtherRunningBoundTrackingSessionForAgent,
  listOtherRunningTrackingSessionsForAgent,
} from "../../store/tracker-store.js";
import {
  getDispatchTargetCurrentContract,
} from "../dispatch/dispatch-runtime-state.js";
import { isDirectRequestEnvelope } from "../../protocol/protocol-primitives.js";
import { ensureRuntimeDirectEnvelopeInbox } from "../runtime-direct-envelope-queue.js";
import { normalizeContractIdentity, normalizeString } from "../../core/normalize.js";
import { isActiveContractStatus } from "../../core/runtime-status.js";

// Agent-facing inbox 投影白名单(账物分离 批1):
// 只放 agent 真需要读的字段 + 系统绑定门真读 inbox 文件本身的字段。
// 其余系统态读的是树内正本(resolveTrackingEnvelopeBinding 按 id 重读树正本,
// session-contract-binding.js:66-96)或内存态,不读 inbox 文件的副本;简单任务里多数恒空。
// 删干净,避免把系统噪声灌进 LLM 上下文。
const TASK_FACING_INBOX_ALLOW_KEYS = Object.freeze([
  "id",               // 系统 join key:binding 按 id 反查树正本、requiredContractId 比对都读它(session-contract-binding.js:219)
  "task",             // 任务本体,agent 唯一必读
  "status",           // ⚠仅系统绑定门用、非 agent-facing:session-contract-binding.js:230 非活跃过滤门真读 inbox 文件的 status,删了破坏绑定
  "expectations",     // role directive 真读(role-spec-registry.js:8):交付前逐条核对的审计判据
  "upstreamPackages", // role directive 真读(role-spec-registry.js:17):上游产物清单,agent 据此读 inbox/ 下的输入
  "runtimeContext",   // 瘦身版:投影侧只留 currentTime.text 一句报时(见 projectTaskFacingRuntimeContext)
]);
// 从白名单删除的键——证据:均无 inbox 文件读者,删除不破坏任何系统读者:
//   taskType / protocol / assignee:binding 用的是树正本的这些字段(resolveTrackingEnvelopeBinding 按 id 重读),inbox 副本零读者
//   completionCriteria / codingSpec / stagePlan / stageRuntime / phases / total:stage 机与判定读树正本/内存态,不读 inbox 文件副本
//   followUp / systemActionDelivery / systemActionDeliveryTicket / systemAction:派工与投递态在内存与树,inbox 副本零读者;简单任务恒空
//   executionObservation / terminalOutcome:结局判定读树正本,inbox 副本零读者;简单任务恒空

function isDispatchOwnedContract(agentId, contractId) {
  const currentContractId = normalizeContractIdentity(getDispatchTargetCurrentContract(agentId));
  const normalizedContractId = normalizeContractIdentity(contractId);
  return Boolean(currentContractId && normalizedContractId && currentContractId === normalizedContractId);
}

async function removeInboxContractIfExists(inboxDir, logger, agentId) {
  const contractPath = join(inboxDir, "contract.json");
  try {
    const contract = await readContractSnapshotByPath(contractPath, { preferCache: false });
    if (isDirectRequestEnvelope(contract)) {
      logger.info(`[mailbox] routeInbox(${agentId}): preserved direct_request inbox/contract.json`);
      return { removed: false, preserved: "direct_request" };
    }
  } catch {}

  try {
    await unlink(contractPath);
    evictContractSnapshotByPath(contractPath);
    logger.info(`[mailbox] routeInbox(${agentId}): removed stale inbox/contract.json`);
    await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
    return { removed: true, preserved: null };
  } catch {
    return { removed: false, preserved: null };
  }
}

// runtimeContext 投影瘦身(批1b):agent 只用 currentTime.text 一句报时。
// version + currentTime 其余 7 个子字段(unixMs/iso/timeZone/date/time/weekday/weekdayZh)
// 零 agent 读者。只裁投影,不动正本 buildRuntimeContext(protocol-primitives.js:104,
// 别的调用方仍用全量 runtimeContext)。text 缺席时(防御)保留原样,不冒险丢数据。
function projectTaskFacingRuntimeContext(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== "object") {
    return runtimeContext;
  }
  const text = runtimeContext?.currentTime?.text;
  if (typeof text === "string" && text) {
    return { currentTime: { text } };
  }
  return runtimeContext;
}

function projectTaskFacingInboxContract(contract, agentId = null) {
  if (!contract || typeof contract !== "object") {
    return contract;
  }
  const projected = {};
  for (const key of TASK_FACING_INBOX_ALLOW_KEYS) {
    if (Object.prototype.hasOwnProperty.call(contract, key)) {
      projected[key] = key === "runtimeContext"
        ? projectTaskFacingRuntimeContext(contract[key])
        : contract[key];
    }
  }
  return projected;
}

function serializeContract(contract, agentId) {
  return JSON.stringify(projectTaskFacingInboxContract(contract, agentId), null, 2);
}

async function stageInboxContract(inboxDir, contract, logger, agentId) {
  const dest = join(inboxDir, "contract.json");
  await atomicWriteFile(dest, serializeContract(contract, agentId));
  cacheContractSnapshot(dest, contract);
  logger.info(`[mailbox] routeInbox(${agentId}): ${contract.id}.json → inbox/contract.json`);
}

export async function routeWorkerInbox({
  agentId,
  inboxDir,
  logger,
  sessionKey = null,
  contractIdHint = null,
  contractPathHint = null,
}) {
  const directInboxState = await ensureRuntimeDirectEnvelopeInbox({
    inboxDir,
    agentId,
    logger,
  });
  if (directInboxState.active) {
    logger.info(`[mailbox] routeInbox(${agentId}): preserved direct_request inbox/contract.json`);
    return;
  }

  const resumedTrackingState = sessionKey ? getTrackingState(sessionKey) : null;
  const resumedTrackingContract = resumedTrackingState?.contract || null;
  const resumedContractPath = resumedTrackingContract?.path || null;
  let resumedContractSnapshot = resumedContractPath
    ? await readContractSnapshotByPath(resumedContractPath, { preferCache: false })
    : resumedTrackingContract;
  if (!resumedContractSnapshot && resumedContractPath && resumedTrackingContract?.id) {
    // 批② 迁树:tracker 里的 path 可能指旧平铺定址(claim 早于正本改道树内)。
    // 路径失效≠合约消失 —— 按 id 经正本解析底座(树索引)重读,传送带
    // "同会话 resume 必须重新 stage 自己的合约"语义不因迁店回归。
    resumedContractSnapshot = await readCachedContractSnapshotById(resumedTrackingContract.id, {
      preferCache: false,
    });
  }
  if (
    resumedContractSnapshot
    && isActiveContractStatus(resumedContractSnapshot.status)
    && resumedContractSnapshot.assignee === agentId
  ) {
    await stageInboxContract(inboxDir, resumedContractSnapshot, logger, agentId);
    return;
  }

  const normalizedContractIdHint = normalizeContractIdentity(contractIdHint);
  const normalizedContractPathHint = normalizeString(contractPathHint);
  const hasExactContractHint = Boolean(normalizedContractIdHint || normalizedContractPathHint);
  const otherRunningBoundSessions = listOtherRunningTrackingSessionsForAgent(agentId, sessionKey)
    .filter((entry) => entry.hasContract);

  if (!hasExactContractHint && hasOtherRunningBoundTrackingSessionForAgent(agentId, sessionKey)) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(`[mailbox] routeInbox(${agentId}): skipped scan restaging while another bound tracker is active`);
    return;
  }

  if (
    hasExactContractHint
    && normalizedContractIdHint
    && otherRunningBoundSessions.some((entry) => entry.contractId !== normalizedContractIdHint)
  ) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(
      `[mailbox] routeInbox(${agentId}): skipped exact staging for ${normalizedContractIdHint} `
      + "while another bound tracker is active",
    );
    return;
  }

  if (normalizedContractPathHint) {
    try {
      const requestedContract = normalizedContractIdHint
        ? await readCachedContractSnapshotById(normalizedContractIdHint, {
            contractPathHint: normalizedContractPathHint,
            preferCache: false,
          })
        : await readContractSnapshotByPath(normalizedContractPathHint, {
            preferCache: false,
          });
      if (
        requestedContract
        && isActiveContractStatus(requestedContract.status)
        && requestedContract.assignee === agentId
        && isDispatchOwnedContract(agentId, requestedContract.id)
        && (
          !normalizedContractIdHint
          || normalizeContractIdentity(requestedContract.id) === normalizedContractIdHint
        )
      ) {
        await stageInboxContract(inboxDir, requestedContract, logger, agentId);
        return;
      }
    } catch (error) {
      logger.warn(
        `[mailbox] routeInbox(${agentId}): requested worker lookup failed for `
        + `${normalizedContractIdHint || normalizedContractPathHint}: ${error.message}`,
      );
    }
  }

  if (hasExactContractHint) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(
      `[mailbox] routeInbox(${agentId}): exact contract `
      + `${normalizedContractIdHint || normalizedContractPathHint} not claimable`,
    );
    return;
  }

  const dispatchOwnerContractId = normalizeContractIdentity(getDispatchTargetCurrentContract(agentId));
  if (dispatchOwnerContractId) {
    try {
      const contract = await readCachedContractSnapshotById(dispatchOwnerContractId, {
        contractPathHint: getContractPath(dispatchOwnerContractId),
        preferCache: false,
      });
      if (
        contract
        && isActiveContractStatus(contract.status)
        && contract.assignee === agentId
      ) {
        await stageInboxContract(inboxDir, contract, logger, agentId);
        return;
      }
    } catch (e) {
      logger.warn(`[mailbox] routeInbox: failed to read dispatch owner ${dispatchOwnerContractId}: ${e.message}`);
    }
  }

  await removeInboxContractIfExists(inboxDir, logger, agentId);
  logger.info(`[mailbox] routeInbox(${agentId}): no dispatch-owned contract found`);
}
