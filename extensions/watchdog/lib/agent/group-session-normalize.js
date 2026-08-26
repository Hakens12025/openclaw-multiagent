// group-session-normalize.js — GroupSession（运行层）纯函数 normalize + 判定。
//
// 与 loop-session-normalize.js 对称：normalize + 等齐/先得判定全是无 IO 纯函数，
// store（group-session-store.js）只负责 atomicWriteFile + withLock 持久化。
//
// GroupSession 追踪「空间维度」：一个 group 内各成员的完成状态（等齐 / 先得）。
//
// 复用 normalize 核心（normalizeRecord/normalizeString/uniqueStrings），不另造。

import { randomBytes } from "node:crypto";
import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

const MAX_RECENT_GROUP_SESSIONS = 20;
const MEMBER_STATUSES = Object.freeze(["pending", "executing", "completed", "failed", "cancelled"]);
const SESSION_STATUSES = Object.freeze(["initialized", "executing", "concluded", "abandoned"]);

export function buildGroupSessionId(now = Date.now()) {
  return `GS-${now}-${randomBytes(3).toString("hex")}`;
}

function normalizeMemberState(value) {
  const record = normalizeRecord(value, null);
  const status = record && MEMBER_STATUSES.includes(record.status) ? record.status : "pending";
  return {
    status,
    completedAt: record && Number.isFinite(record.completedAt) ? record.completedAt : null,
    output: record && record.output !== undefined ? record.output : null,
  };
}

export function normalizeGroupSessionEntry(value) {
  const record = normalizeRecord(value, null);
  if (!record) return null;

  const id = normalizeString(record.id);
  const groupId = normalizeString(record.groupId);
  const members = uniqueStrings(record.members);
  if (!id || !groupId || members.length < 1) return null;

  // memberStates 以 members 为准（成员全集），缺省补 pending；不认 members 之外的键。
  const sourceStates = normalizeRecord(record.memberStates, {});
  const memberStates = {};
  for (const member of members) {
    memberStates[member] = normalizeMemberState(sourceStates[member]);
  }

  const status = SESSION_STATUSES.includes(record.status) ? record.status : "initialized";

  return {
    id,
    groupId,
    members,
    entryAgentId: normalizeString(record.entryAgentId) || members[0],
    outputMode: normalizeString(record.outputMode) || "aggregate",
    status,
    memberStates,
    round: Number.isFinite(record.round) ? record.round : 1,
    aggregatedOutput: record.aggregatedOutput !== undefined ? record.aggregatedOutput : null,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
    concludedAt: Number.isFinite(record.concludedAt) ? record.concludedAt : null,
    concludeReason: normalizeString(record.concludeReason) || null,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
    metadata: normalizeRecord(record.metadata, null),
  };
}

export function buildDefaultGroupSessionState() {
  return { activeGroup: null, recentGroups: [] };
}

export function normalizeGroupSessionState(value) {
  const record = normalizeRecord(value, null);
  const activeGroup = normalizeGroupSessionEntry(record?.activeGroup);
  const recentGroups = (Array.isArray(record?.recentGroups) ? record.recentGroups : [])
    .map((entry) => normalizeGroupSessionEntry(entry))
    .filter(Boolean)
    .filter((entry, index, array) => array.findIndex((c) => c.id === entry.id) === index)
    .slice(0, MAX_RECENT_GROUP_SESSIONS);

  return {
    activeGroup,
    recentGroups: activeGroup
      ? recentGroups.filter((entry) => entry.id !== activeGroup.id)
      : recentGroups,
  };
}

export function archiveGroupSession(state, session) {
  const normalized = normalizeGroupSessionEntry(session);
  state.activeGroup = null;
  if (!normalized) return state;
  state.recentGroups = [
    normalized,
    ...(Array.isArray(state.recentGroups) ? state.recentGroups : []),
  ]
    .filter((entry, index, array) => array.findIndex((c) => c.id === entry.id) === index)
    .slice(0, MAX_RECENT_GROUP_SESSIONS);
  return state;
}

// ── 成员完成（纯更新，不 mutate 入参）─────────────────────────────────────────

export function applyMemberCompletion(entry, agentId, { status = "completed", output = null, now = Date.now() } = {}) {
  const normalized = normalizeGroupSessionEntry(entry);
  if (!normalized) return null;
  const member = normalizeString(agentId);
  if (!member || !normalized.memberStates[member]) return normalized;

  const nextStatus = MEMBER_STATUSES.includes(status) ? status : "completed";
  return normalizeGroupSessionEntry({
    ...normalized,
    status: "executing",
    updatedAt: now,
    memberStates: {
      ...normalized.memberStates,
      [member]: {
        status: nextStatus,
        completedAt: nextStatus === "completed" ? now : normalized.memberStates[member].completedAt,
        output: output !== null ? output : normalized.memberStates[member].output,
      },
    },
  });
}

// ── aggregate 等齐 / race 先得 判定（纯函数）──────────────────────────────────

// aggregate：所有成员都 completed 才算齐（任一非 completed → 未满足）。
export function isGroupAggregateSatisfied(entry) {
  const normalized = normalizeGroupSessionEntry(entry);
  if (!normalized) return false;
  return normalized.members.every((m) => normalized.memberStates[m]?.status === "completed");
}

// race：第一个 completed 的成员胜出（按 members 声明顺序取首个 completed）；无则 null。
export function pickGroupRaceWinner(entry) {
  const normalized = normalizeGroupSessionEntry(entry);
  if (!normalized) return null;
  for (const m of normalized.members) {
    if (normalized.memberStates[m]?.status === "completed") return m;
  }
  return null;
}

// 拓扑剪枝判定：成员或 group 不在白名单 → 不 fit。
// groupIds === null 表示「组维不参与判定」——group 没有独立注册表，本 store 自身就是
// group 的全集，拿 store 去过滤 store 恒为真；agent 删除级联只需按成员剪枝，故显式传 null
// 而不是先读一遍 store 再把它当白名单传回来（那是 TOCTOU）。
export function groupSessionFitsTopology(entry, { agentIds, groupIds } = {}) {
  const normalized = normalizeGroupSessionEntry(entry);
  if (!normalized) return false;
  const validAgentIds = agentIds instanceof Set ? agentIds : new Set(uniqueStrings(agentIds));
  if (normalized.members.some((m) => !validAgentIds.has(m))) return false;
  if (groupIds === null) return true;
  const validGroupIds = groupIds instanceof Set ? groupIds : new Set(uniqueStrings(groupIds));
  if (!validGroupIds.has(normalized.groupId)) return false;
  return true;
}
