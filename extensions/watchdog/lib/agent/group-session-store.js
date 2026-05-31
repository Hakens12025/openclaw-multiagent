// group-session-store.js — GroupSession（运行层）持久化追踪。
//
// 类比 loop-session-store.js：复用 atomicWriteFile + withLock，独立文件 +
// 独立 lock key，与 loop-session-store 完全独立存储（不融合）。space×time 正交：
// 本 store 追踪空间维度（组内成员完成状态），loop-session-store 追踪时间维度。
//
// 不造新并发原语 / 不造新 transport：等齐/先得只是 GroupSession 状态判定（advisory），
// 实际 dispatch 仍走既有 dispatch-graph-policy（dispatcher 感知不到 group）。
//
// 纯逻辑判定 re-export 自 group-session-normalize.js（无 IO，便于消费方直接复用）。

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeString } from "../core/normalize.js";
import { OC, atomicWriteFile, withLock } from "../state.js";
import {
  archiveGroupSession,
  buildDefaultGroupSessionState,
  buildGroupSessionId,
  groupSessionFitsTopology,
  normalizeGroupSessionEntry,
  normalizeGroupSessionState,
  applyMemberCompletion,
} from "./group-session-normalize.js";

export {
  isGroupAggregateSatisfied,
  pickGroupRaceWinner,
  applyMemberCompletion,
} from "./group-session-normalize.js";

const GROUP_SESSION_LOCK_KEY = "group-session-state";

// env 覆盖供测试隔离（默认与 loop-session 搭档落在 research-lab）。
function groupSessionDir() {
  return normalizeString(process.env.OPENCLAW_GROUP_SESSION_DIR) || join(OC, "research-lab");
}
function groupSessionFile() {
  return join(groupSessionDir(), "group_session_state.json");
}

async function readStateFromDisk() {
  try {
    const raw = await readFile(groupSessionFile(), "utf8");
    return normalizeGroupSessionState(JSON.parse(raw));
  } catch {
    return buildDefaultGroupSessionState();
  }
}

async function persistState(state) {
  const normalized = normalizeGroupSessionState(state);
  await mkdir(groupSessionDir(), { recursive: true });
  await atomicWriteFile(groupSessionFile(), JSON.stringify({
    savedAt: Date.now(),
    ...normalized,
  }, null, 2));
  return normalized;
}

export async function loadGroupSessionState() {
  return readStateFromDisk();
}

export async function getActiveGroupSession() {
  const state = await readStateFromDisk();
  return state.activeGroup || null;
}

export async function startGroupSession({
  groupId,
  members = [],
  entryAgentId = null,
  outputMode = "aggregate",
  round = 1,
  loopSessionId = null,
  metadata = null,
  now = Date.now(),
} = {}) {
  const seed = normalizeGroupSessionEntry({
    id: buildGroupSessionId(now),
    groupId,
    members,
    entryAgentId,
    outputMode,
    status: "executing",
    round,
    loopSessionId,
    metadata,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  });
  if (!seed) return null;

  return withLock(GROUP_SESSION_LOCK_KEY, async () => {
    const state = await readStateFromDisk();
    if (state.activeGroup) {
      archiveGroupSession(state, {
        ...state.activeGroup,
        status: "abandoned",
        concludeReason: "superseded_on_group_start",
        concludedAt: now,
        updatedAt: now,
      });
    }
    state.activeGroup = seed;
    state.recentGroups = state.recentGroups.filter((entry) => entry.id !== seed.id);
    await persistState(state);
    return seed;
  });
}

export async function updateGroupMemberState({
  groupSessionId,
  agentId,
  status = "completed",
  output = null,
  now = Date.now(),
} = {}) {
  const sessionId = normalizeString(groupSessionId);
  const member = normalizeString(agentId);
  if (!sessionId || !member) return null;

  return withLock(GROUP_SESSION_LOCK_KEY, async () => {
    const state = await readStateFromDisk();
    const active = normalizeGroupSessionEntry(state.activeGroup);
    if (!active || active.id !== sessionId) return null;

    const updated = applyMemberCompletion(active, member, { status, output, now });
    if (!updated) return null;
    state.activeGroup = updated;
    await persistState(state);
    return updated;
  });
}

export async function concludeGroupSession({
  groupSessionId,
  concludeReason = null,
  status = "concluded",
  aggregatedOutput = undefined,
  now = Date.now(),
} = {}) {
  const sessionId = normalizeString(groupSessionId);
  if (!sessionId) return null;

  return withLock(GROUP_SESSION_LOCK_KEY, async () => {
    const state = await readStateFromDisk();
    const active = normalizeGroupSessionEntry(state.activeGroup);
    if (!active || active.id !== sessionId) return null;

    const concluded = normalizeGroupSessionEntry({
      ...active,
      status: normalizeString(status) || "concluded",
      concludeReason: normalizeString(concludeReason) || null,
      aggregatedOutput: aggregatedOutput !== undefined ? aggregatedOutput : active.aggregatedOutput,
      concludedAt: now,
      updatedAt: now,
    });
    archiveGroupSession(state, concluded);
    await persistState(state);
    return concluded;
  });
}

export async function clearActiveGroupSession({
  reason = "group_not_active",
  status = "abandoned",
  now = Date.now(),
} = {}) {
  return withLock(GROUP_SESSION_LOCK_KEY, async () => {
    const state = await readStateFromDisk();
    if (!state.activeGroup) return null;
    const archived = normalizeGroupSessionEntry({
      ...state.activeGroup,
      status: normalizeString(status) || "abandoned",
      concludeReason: normalizeString(reason) || null,
      concludedAt: now,
      updatedAt: now,
    });
    archiveGroupSession(state, archived);
    await persistState(state);
    return archived;
  });
}

export async function listResolvedGroupSessions() {
  const state = await readStateFromDisk();
  return [
    state.activeGroup,
    ...(Array.isArray(state.recentGroups) ? state.recentGroups : []),
  ].filter(Boolean);
}

export async function pruneGroupSessionsForTopology({ agentIds = [], groupIds = [] } = {}) {
  const validAgentIds = new Set((Array.isArray(agentIds) ? agentIds : []).map(normalizeString).filter(Boolean));
  const validGroupIds = new Set((Array.isArray(groupIds) ? groupIds : []).map(normalizeString).filter(Boolean));
  const topology = { agentIds: validAgentIds, groupIds: validGroupIds };

  return withLock(GROUP_SESSION_LOCK_KEY, async () => {
    const state = await readStateFromDisk();
    const removed = [];

    let activeGroup = state.activeGroup;
    if (activeGroup && !groupSessionFitsTopology(activeGroup, topology)) {
      removed.push(normalizeGroupSessionEntry(activeGroup));
      activeGroup = null;
    }

    const recentGroups = [];
    for (const entry of Array.isArray(state.recentGroups) ? state.recentGroups : []) {
      if (groupSessionFitsTopology(entry, topology)) {
        recentGroups.push(entry);
      } else {
        removed.push(normalizeGroupSessionEntry(entry));
      }
    }

    if (removed.length === 0) {
      return { changed: false, state, removed: [] };
    }
    const nextState = await persistState({ activeGroup, recentGroups });
    return { changed: true, state: nextState, removed: removed.filter(Boolean) };
  });
}
