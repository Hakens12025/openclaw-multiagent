// system-action-trace-merge.js — B5 两源合流的语义层(spec §8)。
// L1 工具中场已执行的协作动作从会话 trace 读事实(不重派!),按票据账本
// 现状刷新 deferred 语义,合成 systemActionResults 条目进既有终态阶梯;
// 文本 [ACTION] 照常提取,但与已执行事实同 (intent,target) 的标记跳过,
// 防止同一动作被派两次。trace 缺失/不合格 → 空合成,完全现行为。

import { getSystemActionDeliveryTicket } from "../routing/delivery/delivery-system-action-ticket.js";

export function factDedupeKey(name, targetAgent) {
  return `${name || ""}:${targetAgent || ""}`;
}

export function factTarget(fact) {
  return fact?.receipt?.targetAgent || fact?.args?.targetAgent || null;
}

// 已受理(accepted)的事实 → 合成结果条目。拒绝的受理不合成:它没有产生
// 执行面副作用,文本路对同一动作的重试是合法的。
export async function synthesizeTraceSystemActionResults(facts, {
  ticketLookup = getSystemActionDeliveryTicket,
} = {}) {
  const results = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    const receipt = fact?.receipt;
    if (!receipt || receipt.accepted !== true) continue;

    let deferredCompletion = receipt.deferredCompletion === true;
    if (deferredCompletion && receipt.deliveryTicketId) {
      // 票据现状是回流真值:中场已 resolved 的动作不再把终态推进 deferred。
      try {
        const ticket = await ticketLookup(receipt.deliveryTicketId);
        if (ticket && ticket.status === "resolved") {
          deferredCompletion = false;
        }
      } catch {
        // 账本读不动 → 保守沿用凭证时刻的 deferred 语义
      }
    }

    results.push({
      actionType: receipt.actionType || fact.name || null,
      status: receipt.status || null,
      targetAgent: factTarget(fact),
      contractId: receipt.contractId || null,
      deliveryTicketId: receipt.deliveryTicketId || null,
      deferredCompletion,
      fromTrace: true,
    });
  }
  return results;
}

// 文本标记去重:同 (intent,target) 已有受理成功的 trace 事实 → 丢弃标记。
export function filterMarkersAgainstTraceFacts(markerActions, facts) {
  const executed = new Set(
    (Array.isArray(facts) ? facts : [])
      .filter((fact) => fact?.receipt?.accepted === true)
      .map((fact) => factDedupeKey(fact.name, factTarget(fact))),
  );
  if (executed.size === 0) return markerActions;
  return markerActions.filter(
    (action) => !executed.has(factDedupeKey(action?.type, action?.params?.targetAgent)),
  );
}
