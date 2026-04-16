// lib/dispatch-entry.js — Unified runtime dispatch entry
// All 4 entry paths (controller hook, inbox write, test-inject, a2a) use this.

import {
  dispatchCreateExecutionContractEntry,
  dispatchResolveIngressReplyTarget,
} from "./dispatch-execution-contract-entry.js";
import { normalizeIngressDirective } from "../protocol-primitives.js";
import {
  normalizeIngressPhases,
  isSimpleTask,
} from "./ingress-classification.js";
import { normalizeRouteMetadata } from "../route-metadata.js";
import { planTaskStages } from "../task-stage-planner.js";

export {
  normalizeIngressPhases,
  isSimpleTask,
  isFastTrackTask,
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
  ingressDirective = null,
  routeHint = null,
  intentType = null,
  simple = null,
  phases = null,
  api,
  enqueue,
  wakePlanner,
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
    ...(routeHint != null ? { routeHint } : {}),
    ...(intentType != null ? { intentType } : {}),
    ...(simple != null ? { simple } : {}),
    ...(phases != null ? { phases } : {}),
  });

  const resolvedSimple = typeof normalizedDirective.simple === "boolean"
    ? normalizedDirective.simple
    : isSimpleTask(message);
  const resolvedPhases = normalizeIngressPhases(normalizedDirective.phases) || planTaskStages(message);
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
    simple: resolvedSimple,
    phases: resolvedPhases,
    api,
    logger,
  });
}
