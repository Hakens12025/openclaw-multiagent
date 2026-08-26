// lib/dispatch-entry.js — Unified runtime dispatch entry
// All 4 entry paths (controller hook, inbox write, test-inject, a2a) use this.

import {
  dispatchCreateExecutionContractEntry,
  dispatchResolveIngressReplyTarget,
} from "./dispatch-execution-contract-entry.js";
import { normalizeIngressDirective } from "../protocol/protocol-primitives.js";
import { normalizeIngressPhases } from "./ingress-classification.js";
import { normalizeRouteMetadata } from "../routing/route-metadata.js";

export {
  normalizeIngressPhases,
} from "./ingress-classification.js";

export async function dispatchAcceptIngressMessage(message, {
  source,
  replyTo,
  dispatchOwnerAgentId = null,
  deliveryTargets = null,
  scheduleContext = null,
  automationContext = null,
  operatorContext = null,
  upstreamReplyTo = null,
  returnContext = null,
  serviceSession = null,
  systemActionDeliveryTicket = null,
  // 谱系(批①):不带默认值 —— undefined=触发点(建约侧铸新);显式传入(含 null)=
  // 派生点继承结果原样透传。给 null 默认会把触发点误判成"旧约派生",永远铸不出谱系。
  lineage,
  ingressDirective = null,
  intentType = null,
  phases = null,
  api,
  logger,
}) {
  const normalizedRouteMetadata = normalizeRouteMetadata({
    replyTo,
    upstreamReplyTo,
    returnContext,
    serviceSession,
    operatorContext,
  }, {
    source: `ingress:${source || "unknown"}`,
  });
  const effectiveReplyTo = dispatchResolveIngressReplyTarget(source, normalizedRouteMetadata.replyTo);
  const normalizedDirective = normalizeIngressDirective({
    ...(ingressDirective && typeof ingressDirective === "object" ? ingressDirective : {}),
    ...(intentType != null ? { intentType } : {}),
    ...(phases != null ? { phases } : {}),
  });
  const resolvedPhases = normalizeIngressPhases(normalizedDirective.phases) || null;
  return dispatchCreateExecutionContractEntry({
    message,
    source,
    effectiveReplyTo,
    dispatchOwnerAgentId,
    deliveryTargets,
    scheduleContext,
    automationContext,
    operatorContext: normalizedRouteMetadata.operatorContext,
    upstreamReplyTo: normalizedRouteMetadata.upstreamReplyTo,
    returnContext: normalizedRouteMetadata.returnContext,
    serviceSession: normalizedRouteMetadata.serviceSession,
    routeMetadataDiagnostics: normalizedRouteMetadata.routeMetadataDiagnostics,
    systemActionDeliveryTicket,
    lineage,
    phases: resolvedPhases,
    api,
    logger,
  });
}
