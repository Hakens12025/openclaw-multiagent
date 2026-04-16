import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  normalizeReplyTarget,
  normalizeReturnContext,
} from "../coordination-primitives.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import {
  normalizeServiceSession,
  resolveResumableServiceSession,
  resolveServiceSessionTargetSessionKey,
} from "../service-session.js";
import {
  OC,
  atomicWriteFile,
  withLock,
} from "../state.js";

const SYSTEM_ACTION_DELIVERY_TICKET_STORE = join(OC, "workspaces", "controller", ".system-action-delivery-tickets.json");
const systemActionDeliveryTickets = new Map();
let systemActionDeliveryTicketsHydrated = false;

function normalizeSystemActionDeliveryTicketRef(value) {
  if (typeof value === "string" && value.trim()) {
    return { id: value.trim() };
  }

  const record = normalizeRecord(value, null);
  const id = normalizeString(record?.id);
  if (!id) {
    return null;
  }

  return {
    id,
    lane: normalizeString(record?.lane),
    createdAt: Number.isFinite(record?.createdAt) ? record.createdAt : null,
    intentType: normalizeString(record?.intentType),
    sourceAgentId: normalizeString(record?.sourceAgentId),
    sourceSessionKey: normalizeString(record?.sourceSessionKey),
    sourceContractId: normalizeString(record?.sourceContractId),
    status: normalizeString(record?.status),
  };
}

function buildNormalizedRoute({
  replyTo,
  upstreamReplyTo = null,
  serviceSession = null,
  returnContext = null,
  sourceSessionKey = null,
} = {}) {
  const normalizedReplyTo = normalizeReplyTarget(replyTo);
  const normalizedUpstreamReplyTo = normalizeReplyTarget(upstreamReplyTo);
  const normalizedServiceSession = normalizeServiceSession(serviceSession);
  const targetAgent = normalizedReplyTo?.agentId || null;
  const resumableServiceSession = resolveResumableServiceSession(normalizedServiceSession, {
    agentId: targetAgent,
  }) || normalizedServiceSession;
  const normalizedReturnContext = normalizeReturnContext(returnContext);
  const targetSessionKey = resolveServiceSessionTargetSessionKey(
    resumableServiceSession,
    sourceSessionKey
      || normalizedReturnContext?.sourceSessionKey
      || normalizedReplyTo?.sessionKey
      || null,
  );
  const effectiveReturnContext = normalizeReturnContext({
    ...(normalizedReturnContext || {}),
    ...(targetSessionKey ? { sourceSessionKey: targetSessionKey } : {}),
  });

  return {
    replyTo: normalizedReplyTo,
    upstreamReplyTo: normalizedUpstreamReplyTo,
    serviceSession: resumableServiceSession,
    returnContext: effectiveReturnContext,
    targetAgent,
    targetSessionKey,
  };
}

function normalizeSystemActionDeliveryTicketEntry(value) {
  const entry = normalizeRecord(value, null);
  const id = normalizeString(entry?.id);
  if (!id) {
    return null;
  }

  const source = normalizeRecord(entry.source, {});
  const route = buildNormalizedRoute({
    replyTo: entry.route?.replyTo,
    upstreamReplyTo: entry.route?.upstreamReplyTo,
    serviceSession: entry.route?.serviceSession,
    returnContext: entry.route?.returnContext,
    sourceSessionKey: source.sessionKey || null,
  });

  return {
    id,
    lane: normalizeString(entry.lane) || null,
    intentType: normalizeString(entry.intentType) || null,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    status: normalizeString(entry.status) || "active",
    source: {
      agentId: normalizeString(source.agentId) || null,
      sessionKey: normalizeString(source.sessionKey) || route.targetSessionKey || null,
      contractId: normalizeString(source.contractId) || null,
    },
    route,
    metadata: normalizeRecord(entry.metadata, null),
    resolvedAt: Number.isFinite(entry.resolvedAt) ? entry.resolvedAt : null,
    resolvedByAgentId: normalizeString(entry.resolvedByAgentId) || null,
    resolvedByContractId: normalizeString(entry.resolvedByContractId) || null,
  };
}

async function ensureSystemActionDeliveryTicketStoreHydrated() {
  if (systemActionDeliveryTicketsHydrated) {
    return;
  }

  systemActionDeliveryTicketsHydrated = true;
  try {
    const raw = await readFile(SYSTEM_ACTION_DELIVERY_TICKET_STORE, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.tickets) ? parsed.tickets : [];
    for (const entry of entries) {
      const normalized = normalizeSystemActionDeliveryTicketEntry(entry);
      if (normalized) {
        systemActionDeliveryTickets.set(normalized.id, normalized);
      }
    }
  } catch {}
}

async function persistSystemActionDeliveryTicketStore() {
  const tickets = [...systemActionDeliveryTickets.values()]
    .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  await atomicWriteFile(SYSTEM_ACTION_DELIVERY_TICKET_STORE, JSON.stringify({
    savedAt: Date.now(),
    tickets,
  }, null, 2));
}

export function attachSystemActionDeliveryTicket(target, systemActionDeliveryTicket, extra = null) {
  if (!target || typeof target !== "object") {
    return target;
  }

  const normalizedTicket = normalizeSystemActionDeliveryTicketRef(systemActionDeliveryTicket);
  if (!normalizedTicket) {
    return target;
  }

  target.systemActionDeliveryTicket = {
    id: normalizedTicket.id,
    lane: normalizedTicket.lane || null,
    createdAt: normalizedTicket.createdAt || null,
    intentType: normalizedTicket.intentType || null,
    sourceAgentId: normalizedTicket.sourceAgentId || null,
    sourceSessionKey: normalizedTicket.sourceSessionKey || null,
    sourceContractId: normalizedTicket.sourceContractId || null,
    status: normalizedTicket.status || null,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
  return target;
}

export function hasSystemActionDeliveryTicket(value) {
  return Boolean(normalizeSystemActionDeliveryTicketRef(value));
}

export async function registerSystemActionDeliveryTicket({
  lane,
  intentType = null,
  sourceAgentId = null,
  sourceSessionKey = null,
  sourceContractId = null,
  replyTo,
  upstreamReplyTo = null,
  serviceSession = null,
  returnContext = null,
  metadata = null,
  now = Date.now(),
} = {}) {
  const route = buildNormalizedRoute({
    replyTo,
    upstreamReplyTo,
    serviceSession,
    returnContext: normalizeReturnContext({
      ...(returnContext && typeof returnContext === "object" ? returnContext : {}),
      ...(sourceAgentId ? { sourceAgentId } : {}),
      ...(sourceContractId ? { sourceContractId } : {}),
      ...(sourceSessionKey ? { sourceSessionKey } : {}),
      ...(intentType ? { intentType } : {}),
    }),
    sourceSessionKey,
  });
  const id = `SADT-${now}-${randomBytes(3).toString("hex")}`;
  const ticket = normalizeSystemActionDeliveryTicketEntry({
    id,
    lane,
    intentType,
    createdAt: now,
    status: "active",
    source: {
      agentId: sourceAgentId,
      sessionKey: sourceSessionKey || route.targetSessionKey || null,
      contractId: sourceContractId,
    },
    route,
    metadata,
  });

  await withLock("system-action-delivery-tickets", async () => {
    await ensureSystemActionDeliveryTicketStoreHydrated();
    systemActionDeliveryTickets.set(ticket.id, ticket);
    await persistSystemActionDeliveryTicketStore();
  });

  return ticket;
}

export async function getSystemActionDeliveryTicket(ticketRef) {
  const normalizedTicket = normalizeSystemActionDeliveryTicketRef(ticketRef);
  if (!normalizedTicket) {
    return null;
  }

  await ensureSystemActionDeliveryTicketStoreHydrated();
  return systemActionDeliveryTickets.get(normalizedTicket.id) || null;
}

async function listSystemActionDeliveryTickets({
  status = null,
} = {}) {
  await ensureSystemActionDeliveryTicketStoreHydrated();
  const normalizedStatus = normalizeString(status);
  return [...systemActionDeliveryTickets.values()]
    .filter((ticket) => !normalizedStatus || ticket.status === normalizedStatus)
    .sort((left, right) => {
      const leftResolved = left.status === "resolved";
      const rightResolved = right.status === "resolved";
      if (leftResolved !== rightResolved) {
        return leftResolved ? 1 : -1;
      }
      return (right.createdAt || 0) - (left.createdAt || 0);
    });
}

export async function summarizeSystemActionDeliveryTickets(options = {}) {
  const tickets = await listSystemActionDeliveryTickets(options);
  return {
    tickets,
    counts: {
      total: tickets.length,
      active: tickets.filter((ticket) => ticket.status !== "resolved").length,
      resolved: tickets.filter((ticket) => ticket.status === "resolved").length,
    },
  };
}

export async function resolveSystemActionDeliveryTicketRoute({
  systemActionDeliveryTicket = null,
  replyTo = null,
  upstreamReplyTo = null,
  serviceSession = null,
  returnContext = null,
  sourceSessionKey = null,
} = {}) {
  const normalizedTicket = normalizeSystemActionDeliveryTicketRef(systemActionDeliveryTicket);
  const resolvedTicket = normalizedTicket
    ? await getSystemActionDeliveryTicket(normalizedTicket)
    : null;
  if (resolvedTicket) {
    return {
      ticket: resolvedTicket,
      ticketId: resolvedTicket.id,
      resolvedBy: "ticket",
      ...resolvedTicket.route,
    };
  }

  return {
    ticket: null,
    ticketId: normalizedTicket?.id || null,
    resolvedBy: normalizedTicket?.id ? "fallback_ticket_missing" : "fallback_direct",
    ...buildNormalizedRoute({
      replyTo,
      upstreamReplyTo,
      serviceSession,
      returnContext,
      sourceSessionKey,
    }),
  };
}

export async function markSystemActionDeliveryTicketResolved(systemActionDeliveryTicket, {
  resolvedByAgentId = null,
  resolvedByContractId = null,
  resolvedAt = Date.now(),
} = {}) {
  const normalizedTicket = normalizeSystemActionDeliveryTicketRef(systemActionDeliveryTicket);
  if (!normalizedTicket) {
    return false;
  }

  return withLock("system-action-delivery-tickets", async () => {
    await ensureSystemActionDeliveryTicketStoreHydrated();
    const existing = systemActionDeliveryTickets.get(normalizedTicket.id);
    if (!existing) {
      return false;
    }

    systemActionDeliveryTickets.set(normalizedTicket.id, {
      ...existing,
      status: "resolved",
      resolvedAt,
      resolvedByAgentId: normalizeString(resolvedByAgentId) || existing.resolvedByAgentId || null,
      resolvedByContractId: normalizeString(resolvedByContractId) || existing.resolvedByContractId || null,
    });
    await persistSystemActionDeliveryTicketStore();
    return true;
  });
}

export async function clearSystemActionDeliveryTicketStore() {
  return withLock("system-action-delivery-tickets", async () => {
    await ensureSystemActionDeliveryTicketStoreHydrated();
    const count = systemActionDeliveryTickets.size;
    systemActionDeliveryTickets.clear();
    await persistSystemActionDeliveryTicketStore();
    return count;
  });
}
