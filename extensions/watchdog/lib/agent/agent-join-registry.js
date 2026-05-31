import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";

import { normalizeString } from "../core/normalize.js";
import { atomicWriteFile, withLock } from "../state.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { normalizeAgentJoinSpec } from "./agent-join-spec.js";

export { normalizeAgentJoinSpec } from "./agent-join-spec.js";

export const AGENT_JOIN_STORE = CONTROL_PLANE_PATHS.agentJoinRegistryFile;
const AGENT_JOIN_STORE_LOCK = "store:agent-joins";

async function readAgentJoinStore() {
  try {
    return JSON.parse(await readFile(AGENT_JOIN_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortAgentJoins(agentJoins) {
  return [...(Array.isArray(agentJoins) ? agentJoins : [])]
    .sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
}

async function writeAgentJoinStore(agentJoins) {
  const normalized = sortAgentJoins(
    (Array.isArray(agentJoins) ? agentJoins : [])
      .map((entry) => normalizeAgentJoinSpec(entry))
      .filter(Boolean),
  );
  const now = Date.now();
  await mkdir(dirname(AGENT_JOIN_STORE), { recursive: true });
  await atomicWriteFile(AGENT_JOIN_STORE, JSON.stringify({
    updatedAt: now,
    agentJoins: normalized,
  }, null, 2));
  return normalized;
}

export async function listAgentJoinSpecs({
  enabled = null,
  status = null,
  protocolType = null,
} = {}) {
  const parsed = await readAgentJoinStore();
  const entries = Array.isArray(parsed?.agentJoins) ? parsed.agentJoins : [];
  const normalizedStatus = normalizeString(status)?.toLowerCase() || null;
  const normalizedProtocolType = normalizeString(protocolType)?.toLowerCase() || null;
  return sortAgentJoins(entries
    .map((entry) => normalizeAgentJoinSpec(entry))
    .filter(Boolean)
    .filter((entry) => (typeof enabled === "boolean" ? entry.enabled === enabled : true))
    .filter((entry) => (normalizedStatus ? entry.summary?.status === normalizedStatus : true))
    .filter((entry) => (normalizedProtocolType ? entry.protocol?.type === normalizedProtocolType : true)));
}

export async function getAgentJoinSpec(joinId) {
  const normalizedId = normalizeString(joinId);
  if (!normalizedId) return null;
  const specs = await listAgentJoinSpecs();
  return specs.find((entry) => entry.id === normalizedId) || null;
}

export async function summarizeAgentJoinRegistry(options = {}) {
  const agentJoins = await listAgentJoinSpecs(options);
  const counts = {
    total: agentJoins.length,
    enabled: agentJoins.filter((entry) => entry.enabled === true).length,
    disabled: agentJoins.filter((entry) => entry.enabled !== true).length,
    ready: agentJoins.filter((entry) => entry.summary?.status === "ready").length,
    draft: agentJoins.filter((entry) => entry.summary?.status === "draft").length,
    byProtocol: {},
  };
  for (const entry of agentJoins) {
    const protocolType = entry?.protocol?.type || "unknown";
    counts.byProtocol[protocolType] = (counts.byProtocol[protocolType] || 0) + 1;
  }
  return {
    agentJoins,
    counts,
  };
}

export async function upsertAgentJoinSpec(agentJoinSpec) {
  const normalized = normalizeAgentJoinSpec(agentJoinSpec);
  if (!normalized?.id) {
    throw new Error("invalid agent join spec");
  }

  return withLock(AGENT_JOIN_STORE_LOCK, async () => {
    const now = Date.now();
    const agentJoins = await listAgentJoinSpecs();
    const existing = agentJoins.find((entry) => entry.id === normalized.id) || null;
    const nextAgentJoins = agentJoins
      .filter((entry) => entry.id !== normalized.id)
      .concat({
        ...normalized,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAgentJoinStore(nextAgentJoins);
    return saved.find((entry) => entry.id === normalized.id) || null;
  });
}

export async function setAgentJoinEnabled(joinId, enabled) {
  const normalizedId = normalizeString(joinId);
  if (!normalizedId) {
    throw new Error("missing agent join id");
  }

  return withLock(AGENT_JOIN_STORE_LOCK, async () => {
    const now = Date.now();
    const agentJoins = await listAgentJoinSpecs();
    const existing = agentJoins.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown agent join id: ${normalizedId}`);
    }

    const nextAgentJoins = agentJoins
      .filter((entry) => entry.id !== normalizedId)
      .concat({
        ...existing,
        enabled: enabled === true,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAgentJoinStore(nextAgentJoins);
    return saved.find((entry) => entry.id === normalizedId) || null;
  });
}

export async function deleteAgentJoinSpec(joinId) {
  const normalizedId = normalizeString(joinId);
  if (!normalizedId) {
    throw new Error("missing agent join id");
  }

  return withLock(AGENT_JOIN_STORE_LOCK, async () => {
    const agentJoins = await listAgentJoinSpecs();
    const existing = agentJoins.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      return {
        ok: true,
        deleted: false,
        agentJoin: null,
      };
    }

    await writeAgentJoinStore(agentJoins.filter((entry) => entry.id !== normalizedId));
    return {
      ok: true,
      deleted: true,
      agentJoin: existing,
    };
  });
}
