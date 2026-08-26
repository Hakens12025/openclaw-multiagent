import { join } from "node:path";

import { normalizeString } from "../../core/normalize.js";
import { attachOperatorContext, normalizeOperatorContext } from "../../operator/operator-context.js";
import {
  mergeRouteMetadataDiagnostics,
  normalizeRouteMetadata,
} from "../route-metadata.js";
import { agentWorkspace } from "../../state.js";
import { createDirectRequestEnvelope } from "../../protocol/protocol-primitives.js";
import { buildAgentMainSessionKey } from "../../session/session-keys.js";
import { deliveryEnqueueSystemActionReturn } from "./delivery-system-action-transport.js";
import {
  hasSystemActionDeliveryTicket,
  resolveSystemActionDeliveryTicketRoute,
} from "./delivery-system-action-ticket.js";

function normalizeRouteSourceLayer(layer) {
  if (!layer || typeof layer !== "object") return null;

  const routeMetadata = normalizeRouteMetadata({
    replyTo: layer.replyTo ?? layer.sourceReplyTo,
    upstreamReplyTo: layer.upstreamReplyTo,
    returnContext: layer.returnContext,
    serviceSession: layer.serviceSession,
    operatorContext: layer.operatorContext,
  }, {
    source: "system_action_delivery.route_source",
  });
  const systemActionDeliveryTicket = layer.systemActionDeliveryTicket && typeof layer.systemActionDeliveryTicket === "object"
    ? layer.systemActionDeliveryTicket
    : null;
  const source = layer.source && typeof layer.source === "object"
    ? layer.source
    : null;

  return {
    replyTo: routeMetadata.replyTo,
    upstreamReplyTo: routeMetadata.upstreamReplyTo,
    serviceSession: routeMetadata.serviceSession,
    returnContext: routeMetadata.returnContext,
    systemActionDeliveryTicket,
    sourceSessionKey: normalizeString(layer.sourceSessionKey)
      || normalizeString(routeMetadata.returnContext?.sourceSessionKey)
      || normalizeString(source?.sessionKey),
    sourceAgentId: normalizeString(layer.sourceAgentId)
      || normalizeString(routeMetadata.returnContext?.sourceAgentId)
      || normalizeString(source?.agentId),
    sourceContractId: normalizeString(layer.sourceContractId)
      || normalizeString(routeMetadata.returnContext?.sourceContractId)
      || normalizeString(source?.contractId),
    intentType: normalizeString(layer.intentType)
      || normalizeString(routeMetadata.returnContext?.intentType)
      || normalizeString(layer.protocol?.source),
    operatorContext: routeMetadata.operatorContext || normalizeOperatorContext(layer.operatorContext),
    routeMetadataDiagnostics: routeMetadata.routeMetadataDiagnostics,
  };
}

function pickRouteValue(layers, key) {
  for (const layer of layers) {
    const value = layer?.[key];
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return null;
}

export function mergeSystemActionDeliverySource(...layers) {
  const normalizedLayers = layers
    .map((layer) => normalizeRouteSourceLayer(layer))
    .filter(Boolean);

  if (!normalizedLayers.length) {
    return {
      replyTo: null,
      upstreamReplyTo: null,
      serviceSession: null,
      returnContext: null,
      systemActionDeliveryTicket: null,
      sourceSessionKey: null,
      sourceAgentId: null,
      sourceContractId: null,
      intentType: null,
      operatorContext: null,
      routeMetadataDiagnostics: null,
    };
  }

  return {
    replyTo: pickRouteValue(normalizedLayers, "replyTo"),
    upstreamReplyTo: pickRouteValue(normalizedLayers, "upstreamReplyTo"),
    serviceSession: pickRouteValue(normalizedLayers, "serviceSession"),
    returnContext: pickRouteValue(normalizedLayers, "returnContext"),
    systemActionDeliveryTicket: pickRouteValue(normalizedLayers, "systemActionDeliveryTicket"),
    sourceSessionKey: pickRouteValue(normalizedLayers, "sourceSessionKey"),
    sourceAgentId: pickRouteValue(normalizedLayers, "sourceAgentId"),
    sourceContractId: pickRouteValue(normalizedLayers, "sourceContractId"),
    intentType: pickRouteValue(normalizedLayers, "intentType"),
    operatorContext: pickRouteValue(normalizedLayers, "operatorContext"),
    routeMetadataDiagnostics: mergeRouteMetadataDiagnostics(
      ...normalizedLayers.map((layer) => layer.routeMetadataDiagnostics),
    ),
  };
}

export async function resolveSystemActionDeliveryRoute(routeSource) {
  const source = mergeSystemActionDeliverySource(routeSource);
  const route = await resolveSystemActionDeliveryTicketRoute({
    systemActionDeliveryTicket: source.systemActionDeliveryTicket,
    replyTo: source.replyTo,
    upstreamReplyTo: source.upstreamReplyTo,
    serviceSession: source.serviceSession,
    returnContext: source.returnContext || null,
    sourceSessionKey: source.sourceSessionKey || null,
  });

  return {
    ...source,
    ...route,
  };
}

export function buildSystemActionDeliveryContext(routeSource, {
  targetSessionKey = null,
  defaultIntentType = null,
} = {}) {
  const source = mergeSystemActionDeliverySource(routeSource);
  return {
    sourceAgentId: source.returnContext?.sourceAgentId || source.sourceAgentId || null,
    sourceContractId: source.returnContext?.sourceContractId || source.sourceContractId || null,
    ...(
      targetSessionKey
        ? { sourceSessionKey: targetSessionKey }
        : source.sourceSessionKey
          ? { sourceSessionKey: source.sourceSessionKey }
          : {}
    ),
    intentType: source.returnContext?.intentType || source.intentType || defaultIntentType || null,
  };
}

export function createSystemActionDeliveryContract({
  targetAgent,
  targetSessionKey = null,
  replyTo = null,
  upstreamReplyTo = null,
  serviceSession = null,
  returnContext = null,
  operatorContext = null,
  // 谱系(批①):回投信封是派生点 —— 调用方传 inheritLineage(完工子约);缺席=null。
  lineage = null,
  message,
  source,
} = {}) {
  const contract = createDirectRequestEnvelope({
    agentId: targetAgent,
    sessionKey: targetSessionKey || replyTo?.sessionKey || buildAgentMainSessionKey(targetAgent),
    replyTo: upstreamReplyTo || null,
    defaultReplyToSelf: false,
    serviceSession,
    returnContext,
    lineage,
    message,
    outputDir: join(agentWorkspace(targetAgent), "output"),
    source,
  });
  attachOperatorContext(contract, operatorContext);
  return contract;
}

export function hasSystemActionDeliverySourceTicket(routeSource) {
  return hasSystemActionDeliveryTicket(mergeSystemActionDeliverySource(routeSource).systemActionDeliveryTicket);
}

export async function enqueueSystemActionDeliveryContract({
  lane,
  targetAgent,
  contract,
  api,
  logger,
  wakeReason = null,
  targetSessionKey = null,
  deliveryTicketId = null,
  failureAlert = null,
  queuedLogMessage = null,
} = {}) {
  return deliveryEnqueueSystemActionReturn({
    lane,
    targetAgent,
    contract,
    api,
    logger,
    wake: {
      reason: wakeReason,
      targetSessionKey,
      // 回投腿的 SADT 票据 id(route.ticketId)——幂等键账"有身份才去重"的身份来源,
      // 缺了它回投腿的 wake/deliver 两种键全为 null、永不去重。
      deliveryTicketId,
      failureAlert,
    },
    queuedLogMessage,
  });
}
