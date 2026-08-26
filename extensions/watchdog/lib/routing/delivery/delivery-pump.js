// delivery-pump.js — 投递泵(备忘录141 §八 Phase 3 投递出栈)。
//
// agent_end 收口只记账落票(delivery-ticket-store),两段投递副作用——
// deliveryRunSystemActionChain(回投链)与 deliveryRunTerminalRuntime(终态投递)
// ——由本泵在回合边界外消费票据执行。泵运行时收尾已拆、tracker 已删:
// 票据只携带可序列化投影,盘上事实一律从 contract store 重读正本
// (readContractSnapshotById),禁止任何内存 tracker 依赖。
//
// 触发三层(备忘录141 §八):commit 后 poke(fire-and-forget,近零延迟)
// + gateway_start 启动扫描(崩溃恢复,startDeliveryPumpBackstop 首跑全量)
// + 慢背压间隔兜底。执行防重靠既有 deliver:{leg}:{ticketId} 键账,唤醒时机
// 靠既有相位门——两件都在被调深层(delivery-system-action-transport)就位,
// 出栈只挪调用点。
//
// 压制语义三分支与日志自 lib/lifecycle/agent-end/terminal.js
// handleSuccessfulTrackingCompletion 逐字迁移(deferred / suppressCompletionEgress
// / review-verdict-bridge;第三分支在现布尔结构下不可达,红线要求原样保留)。
// 变量源改写:effectiveContractData→正本重读、terminalOutcome→票据 terminalOutcome、
// primarySystemActionResult.actionType→票据 suppress.deferredBy(commit 时投影)、
// context.api→泵入参 api(apiRef 兜底)。
//
// 投递诊断经 mergeContractFields 按正本 path 直写(泵期 tracker 已删,
// mergeTrackingContractFields 不可用);重试预算 MAX_DELIVERY_TICKET_ATTEMPTS,
// 打满改名 .failed.json 留尸检 + broadcast alert。

import { deliveryRunSystemActionChain } from "./delivery-system-action-chain.js";
import { deliveryRunTerminalRuntime } from "./delivery-terminal-runtime.js";
import {
  completeDeliveryTicket,
  listPendingDeliveryTickets,
  markDeliveryTicketAttempt,
} from "./delivery-ticket-store.js";
import {
  getContractPath,
  mergeContractFields,
  readContractSnapshotById,
} from "../../contract/contracts.js";
import { mergeRuntimeDiagnostics } from "../../lifecycle/agent-end/contract-refresh.js";
import { SESSION_PHASE, getSessionPhase } from "../../session/session-phase-store.js";
import { hasDeliveryKey, recordDeliveryKey } from "../../store/delivery-idempotency-store.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { apiRef } from "../../state.js";
import { wireDelivered } from "../../archive/run-event-wiring.js";

// tracker 投影重建:两条链从 trackingState 实际消费的字段全量(侦察清单),
// tracker 独有字段取票据 trackerProjection,contract 取盘上正本展开。
function buildTrackingProjection(ticket, contract, terminalStatus, contractPath) {
  const projection = (ticket.trackerProjection && typeof ticket.trackerProjection === "object")
    ? ticket.trackerProjection
    : {};
  return {
    // CONTRACT_SEMANTIC_FAILURE alert 与链上 source 归属读 agentId,无 contractData 兜底
    agentId: ticket.agentId || projection.agentId || null,
    // deliveryRunTerminal 读 trackingState.status 当结果状态——投影为票据终态
    status: terminalStatus,
    startMs: Number.isFinite(projection.startMs) ? projection.startMs : (ticket.createdAt || Date.now()),
    toolCallTotal: Number.isFinite(projection.toolCallTotal) ? projection.toolCallTotal : 0,
    // trackingState.ioObservation 是结果源第一优先;commit 时已并进正本
    // runtimeDiagnostics.ioObservation,双源同值
    ioObservation: projection.ioObservation ?? contract.runtimeDiagnostics?.ioObservation ?? null,
    // 展开正本保真 replyTo『键存在但为 null』与『键不存在』的区别
    // (delivery-terminal resolveReplyTarget 的 hasOwnProperty 语义);
    // path 供 replyTo 缺席回退重读与诊断写回定址
    contract: { ...contract, path: contractPath },
  };
}

// 执行核心(无票据店操作;收口写票失败时的同步降级路也走这里)。
// 合约事实:共享正本可读则用最新,读不到回退【票据快照】。票据快照护的是
// 崩溃窗,不是店型兼容:正本写失败只 warn 不拦派发(dispatch-transport 直发路)、
// 索引行丢失、run 被 GC 时,票据是投递事实的唯一载体——必须保留。
export async function executeDeliveryTicketPayload(ticket, { api = null, logger = console } = {}) {
  const effectiveApi = api || apiRef || null;
  {
    let contract = null;
    try {
      contract = await readContractSnapshotById(ticket.contractId);
    } catch { /* 共享正本缺席 → 走票据快照 */ }
    if (!contract && ticket.contractSnapshot && typeof ticket.contractSnapshot === "object") {
      contract = ticket.contractSnapshot;
    }
    if (!contract) {
      throw new Error(`contract facts missing for ${ticket.contractId} (no shared snapshot, no ticket contractSnapshot)`);
    }
    const contractPath = contract.path || getContractPath(contract.id);
    const terminalStatus = ticket.terminalStatus || contract.status || null;
    const terminalOutcome = ticket.terminalOutcome ?? contract.terminalOutcome ?? null;
    const executionObservation = ticket.executionObservation ?? contract.executionObservation ?? null;
    const trackingState = buildTrackingProjection(ticket, contract, terminalStatus, contractPath);
    const agentId = trackingState.agentId;
    const deferredSystemAction = ticket.suppress?.deferred === true;
    const runtimeDiagnostics = {};

    const systemActionDeliveryResult = await deliveryRunSystemActionChain({
      agentId,
      trackingState,
      contractData: contract,
      terminalStatus,
      outcome: terminalOutcome,
      executionObservation,
      api: effectiveApi,
      logger,
    });
    const suppressTerminalDelivery = deferredSystemAction || systemActionDeliveryResult.suppressCompletionEgress;

    if (trackingState.contract && !suppressTerminalDelivery) {
      runtimeDiagnostics.terminalDelivery = await deliveryRunTerminalRuntime({
        trackingState,
        contractData: contract,
        terminalStatus,
        outcome: terminalOutcome,
        api: effectiveApi,
        logger,
      });

    } else if (suppressTerminalDelivery) {
      const deferredBy = deferredSystemAction
        ? ticket.suppress.deferredBy
        : systemActionDeliveryResult.suppressCompletionEgressBy || "unknown";
      logger.info(`[watchdog] terminal delivery deferred for ${agentId} via ${deferredBy}`);
    }

    if (Object.keys(systemActionDeliveryResult.diagnostics).length > 0) {
      runtimeDiagnostics.systemActionDelivery = systemActionDeliveryResult.diagnostics;
    }

    if (Object.keys(runtimeDiagnostics).length > 0) {
      // 诊断写回:临合并前重读基底(收口段 mergeTrackingContractFields 双写方
      // 竞态收缩,审查⑤);投递已执行,写回失败只 warn 不烧 attempt。
      try {
        let mergeBase = contract.runtimeDiagnostics;
        try {
          const fresh = await readContractSnapshotById(ticket.contractId);
          if (fresh?.runtimeDiagnostics) mergeBase = fresh.runtimeDiagnostics;
        } catch { /* 信封合约无共享正本 → 用手头基底 */ }
        await mergeContractFields(contractPath, logger, {
          runtimeDiagnostics: mergeRuntimeDiagnostics(mergeBase, runtimeDiagnostics),
        });
      } catch (mergeError) {
        logger.warn(`[watchdog] delivery diagnostics merge skipped for ${ticket.contractId}: ${mergeError?.message || mergeError}`);
      }
    }

    // 事件接线(批② §八):票据载荷执行完毕 = delivered 时刻(压制投递也是投递结局)。
    // 谱系取正本/票据快照上的 lineage;done 键重放路径不经此处,不会重复记账。
    void wireDelivered({
      contract,
      ticketId: ticket.id || null,
      suppressed: suppressTerminalDelivery === true,
      logger,
    });

    return {
      suppressed: suppressTerminalDelivery === true,
      runtimeDiagnostics,
      // 回投目标供泵 alert 载荷消费:取执行期合约事实(共享正本优先,退票据快照),
      // 拿不到即 null——不造假目标。
      replyTo: contract.replyTo ?? null,
    };
  }
}

// 一票 = (相位让路)→ 执行核心(done 键防跨重启重投,审查③)→ 记 done 键 → 删票。
// 执行抛错 → attempt 记账;打满 → .failed 尸检 + alert + error 日志。
// 删票失败(审查④)→ 转 attempt 而非谎报完成:done 键在手,重跑只补删不重投。
export async function processDeliveryTicket(ticket, { api = null, logger = console } = {}) {
  const ticketId = (typeof ticket?.id === "string" && ticket.id) ? ticket.id : null;
  if (!ticketId || typeof ticket.contractId !== "string" || !ticket.contractId) {
    logger.warn("[watchdog] delivery pump skipped invalid ticket (missing id/contractId)");
    return { completed: false, reason: "invalid_ticket" };
  }
  // 源会话收尾还在飞时让路(审查⑤:背压扫描不与活收口赛跑),poke/背压稍后再来。
  if (ticket.sessionKey && getSessionPhase(ticket.sessionKey) === SESSION_PHASE.CLOSING) {
    return { completed: false, deferred: "session_closing" };
  }

  const doneKey = `deliver:pumpdone:${ticketId}`;
  try {
    let executionResult = { suppressed: false, runtimeDiagnostics: {} };
    if (await hasDeliveryKey(doneKey)) {
      logger.info(`[watchdog] delivery pump ticket ${ticketId} already executed (done key) — completing cleanup only`);
    } else {
      executionResult = await executeDeliveryTicketPayload(ticket, { api, logger });
      await recordDeliveryKey(doneKey, { contractId: ticket.contractId });
      const completedReplyTo = executionResult.replyTo ?? ticket.contractSnapshot?.replyTo ?? null;
      broadcast("alert", {
        type: EVENT_TYPE.DELIVERY_PUMP_COMPLETED,
        ticketId,
        contractId: ticket.contractId,
        agentId: ticket.agentId || null,
        targetAgent: completedReplyTo?.agentId ?? null,
        replyTo: completedReplyTo,
        suppressed: executionResult.suppressed === true,
        ts: Date.now(),
      });
    }

    const removed = await completeDeliveryTicket(ticketId);
    if (!removed) {
      const attempt = await markDeliveryTicketAttempt(ticketId, new Error("ticket cleanup failed (unlink)"));
      logger.warn(`[watchdog] delivery pump ticket ${ticketId} executed but cleanup failed (attempt ${attempt.attempts})`);
      return { completed: false, executed: true, attempts: attempt.attempts };
    }
    return {
      completed: true,
      suppressed: executionResult.suppressed === true,
      runtimeDiagnostics: executionResult.runtimeDiagnostics,
    };
  } catch (error) {
    const attempt = await markDeliveryTicketAttempt(ticketId, error);
    if (attempt.exhausted) {
      logger.error(
        `[watchdog] delivery pump ticket ${ticketId} exhausted after ${attempt.attempts} attempt(s): ${error?.message || error}`,
      );
      // 耗尽路无执行期正本读取,回投目标只能取票据快照;缺席即 null,不造假。
      const exhaustedReplyTo = ticket.contractSnapshot?.replyTo ?? null;
      broadcast("alert", {
        type: EVENT_TYPE.DELIVERY_PUMP_EXHAUSTED,
        ticketId,
        contractId: ticket.contractId,
        agentId: ticket.agentId || null,
        targetAgent: exhaustedReplyTo?.agentId ?? null,
        replyTo: exhaustedReplyTo,
        attempts: attempt.attempts,
        error: error?.message || String(error),
        ts: Date.now(),
      });
    } else {
      logger.warn(
        `[watchdog] delivery pump ticket ${ticketId} attempt ${attempt.attempts} failed: ${error?.message || error}`,
      );
    }
    return {
      completed: false,
      exhausted: attempt.exhausted === true,
      attempts: attempt.attempts,
      error: error?.message || String(error),
    };
  }
}

// 同一时刻单飞:模块级 draining 旗标,重入直接返回;逐票串行,
// 单票失败已在 processDeliveryTicket 内记账,不断整泵。
let drainingDeliveryTickets = false;
let drainRequestedWhileBusy = false;

async function drainPendingDeliveryTickets({ api, logger }) {
  let total = 0;
  do {
    drainRequestedWhileBusy = false;
    const tickets = await listPendingDeliveryTickets();
    for (const ticket of tickets) {
      await processDeliveryTicket(ticket, { api, logger });
    }
    total += tickets.length;
    // drain 期间新落的票(poke 被单飞旗标弹回,审查⑧)收尾复扫,不等 30s 背压。
  } while (drainRequestedWhileBusy);
  return total;
}

// commit 后调用点:fire-and-forget 排空当前 pending。返回 { started, done? },
// done 为本轮排空 promise(永不 reject),调用方可忽略。
export function pokeDeliveryPump({ api = null, logger = console } = {}) {
  if (drainingDeliveryTickets) {
    drainRequestedWhileBusy = true;
    return { started: false, draining: true };
  }
  drainingDeliveryTickets = true;
  const done = drainPendingDeliveryTickets({ api, logger })
    .catch((error) => {
      logger.warn(`[watchdog] delivery pump drain failed: ${error?.message || error}`);
      return 0;
    })
    .finally(() => {
      drainingDeliveryTickets = false;
    });
  return { started: true, done };
}

// gateway_start 挂点:先跑一次全量扫描(崩溃恢复——收口已落票、泵未及消费
// 即进程死亡的票),再注册慢背压间隔兜底。返回 stop()。
export function startDeliveryPumpBackstop({ api = null, logger = console, intervalMs = 30000 } = {}) {
  pokeDeliveryPump({ api, logger });
  const backstopHandle = setInterval(() => {
    pokeDeliveryPump({ api, logger });
  }, intervalMs);
  return function stop() {
    clearInterval(backstopHandle);
  };
}
