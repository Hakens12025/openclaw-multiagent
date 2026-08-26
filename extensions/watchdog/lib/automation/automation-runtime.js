import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { listAutomationSpecs } from "./automation-registry.js";
import { normalizeEnum, normalizeFiniteNumber, normalizePositiveInteger, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { normalizeAutomationDecision } from "./automation-decision.js";
import { normalizeGovernanceSnapshot } from "./resolve-governance.js";
import { normalizeProfileLifecycle } from "./profile-lifecycle.js";
import { atomicWriteFile, withLock } from "../state.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

export const AUTOMATION_RUNTIME_STORE = CONTROL_PLANE_PATHS.automationRuntimeFile;
const AUTOMATION_RUNTIME_STORE_LOCK = "store:automation-runtime";

const VALID_AUTOMATION_RUNTIME_STATUSES = new Set([
  "idle",
  "running",
  "paused",
  "completed",
  "stopped",
  "error",
]);

function normalizeAutomationRuntimeStatus(value, fallback = "idle") {
  return normalizeEnum(value, VALID_AUTOMATION_RUNTIME_STATUSES, fallback);
}

function normalizeRoundSummary(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const round = normalizePositiveInteger(source.round, -1);
  if (round < 0) return null;

  return {
    round,
    score: normalizeFiniteNumber(source.score, null),
    decision: normalizeString(source.decision)?.toLowerCase() || null,
    status: normalizeString(source.status)?.toLowerCase() || null,
    artifact: normalizeString(source.artifact || source.output || source.path) || null,
    summary: normalizeString(source.summary) || null,
    ts: Number.isFinite(source.ts) ? source.ts : null,
  };
}

// （pendingReworkGuidance 已随评审链删除退役——它的唯一生产者是 reviewerResult
//  派生段，备忘录150 后无源，v226 一并摘除。历史落盘 state 的该键读进来即被丢弃。）

function buildDefaultRuntimeState(automationSpec) {
  const automationId = normalizeString(automationSpec?.id);
  if (!automationId) {
    throw new Error("automationSpec.id is required");
  }

  const now = Date.now();
  return {
    automationId,
    status: automationSpec?.enabled === false ? "paused" : "idle",
    currentRound: 0,
    activeContractId: null,
    lastWakeAt: null,
    nextWakeAt: null,
    lastResultAt: null,
    bestRound: null,
    bestScore: null,
    bestArtifact: null,
    lastScore: null,
    noImprovementStreak: 0,
    childAutomationIds: [],
    recentRounds: [],
    // harness 判定账字段（activeHarnessSpec/activeHarnessRun/lastHarnessRun/
    // lastReviewerResult/recentHarnessRuns）已随 harness 全退役删除
    // （v226 / 2026-08-23，备忘录149）；历史落盘 state 的这批键读进来即被丢弃。
    lastAutomationDecision: null,
    // governanceSnapshot：当前生效的治理参数快照（由 resolveGovernance 消费；缺省 null=用 spec 默认）。
    // governanceSnapshotDisabled：全局熔断开关，true 时忽略 snapshot 回退到 spec 默认。
    // profileLifecycle：profile 生命周期只读快照（streak/trustLevel 等）。
    governanceSnapshot: null,
    governanceSnapshotDisabled: false,
    profileLifecycle: null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeAutomationRuntimeState(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const automationId = normalizeString(source.automationId || source.id);
  if (!automationId) return null;

  return {
    automationId,
    status: normalizeAutomationRuntimeStatus(source.status),
    currentRound: normalizePositiveInteger(source.currentRound, 0),
    // 回路运行时退役(2026-08-18)：activeLoopId / activePipelineId 随之删除。
    // 在跑身份收口到 activeContractId 单源。历史落盘 state 的这两个键读进来即被丢弃。
    activeContractId: normalizeString(source.activeContractId) || null,
    lastWakeAt: Number.isFinite(source.lastWakeAt) ? source.lastWakeAt : null,
    nextWakeAt: Number.isFinite(source.nextWakeAt) ? source.nextWakeAt : null,
    lastResultAt: Number.isFinite(source.lastResultAt) ? source.lastResultAt : null,
    bestRound: Number.isFinite(source.bestRound) ? source.bestRound : null,
    bestScore: normalizeFiniteNumber(source.bestScore, null),
    bestArtifact: normalizeString(source.bestArtifact) || null,
    lastScore: normalizeFiniteNumber(source.lastScore, null),
    noImprovementStreak: normalizePositiveInteger(source.noImprovementStreak, 0),
    // 跨轮内容级 spin 检测状态（deriveDecision 的 no_progress_repeat 守卫消费）。
    repeatStreak: normalizePositiveInteger(source.repeatStreak, 0),
    lastArtifactFingerprint: normalizeString(source.lastArtifactFingerprint) || null,
    childAutomationIds: uniqueStrings(source.childAutomationIds),
    recentRounds: (Array.isArray(source.recentRounds) ? source.recentRounds : [])
      .map((entry) => normalizeRoundSummary(entry))
      .filter(Boolean)
      .sort((left, right) => right.round - left.round)
      .slice(0, 20),
    lastAutomationDecision: normalizeAutomationDecision(source.lastAutomationDecision),
    governanceSnapshot: normalizeGovernanceSnapshot(source.governanceSnapshot),
    governanceSnapshotDisabled: source.governanceSnapshotDisabled === true,
    profileLifecycle: normalizeProfileLifecycle(source.profileLifecycle),
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}
async function readAutomationRuntimeStore() {
  try {
    return JSON.parse(await readFile(AUTOMATION_RUNTIME_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortAutomationRuntimeStates(states) {
  return [...(Array.isArray(states) ? states : [])]
    .sort((left, right) => String(left?.automationId || "").localeCompare(String(right?.automationId || "")));
}

async function writeAutomationRuntimeStore(states) {
  const normalized = sortAutomationRuntimeStates(
    (Array.isArray(states) ? states : [])
      .map((entry) => normalizeAutomationRuntimeState(entry))
      .filter(Boolean),
  );
  await mkdir(dirname(AUTOMATION_RUNTIME_STORE), { recursive: true });
  await atomicWriteFile(AUTOMATION_RUNTIME_STORE, JSON.stringify({
    updatedAt: Date.now(),
    states: normalized,
  }, null, 2));
  return normalized;
}

export async function listAutomationRuntimeStates() {
  const parsed = await readAutomationRuntimeStore();
  return sortAutomationRuntimeStates(
    (Array.isArray(parsed?.states) ? parsed.states : [])
      .map((entry) => normalizeAutomationRuntimeState(entry))
      .filter(Boolean),
  );
}

export async function getAutomationRuntimeState(automationId) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) return null;
  const states = await listAutomationRuntimeStates();
  return states.find((entry) => entry.automationId === normalizedId) || null;
}

export async function ensureAutomationRuntimeState(automationSpec) {
  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const existing = await getAutomationRuntimeState(automationSpec?.id);
    if (existing) return existing;

    const defaults = buildDefaultRuntimeState(automationSpec);
    const states = await listAutomationRuntimeStates();
    const saved = await writeAutomationRuntimeStore(states.concat(defaults));
    return saved.find((entry) => entry.automationId === defaults.automationId) || null;
  });
}

export async function upsertAutomationRuntimeState(runtimeState) {
  const normalized = normalizeAutomationRuntimeState(runtimeState);
  if (!normalized?.automationId) {
    throw new Error("invalid automation runtime state");
  }

  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const now = Date.now();
    const states = await listAutomationRuntimeStates();
    const existing = states.find((entry) => entry.automationId === normalized.automationId) || null;
    const nextStates = states
      .filter((entry) => entry.automationId !== normalized.automationId)
      .concat({
        ...normalized,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAutomationRuntimeStore(nextStates);
    return saved.find((entry) => entry.automationId === normalized.automationId) || null;
  });
}

export async function setAutomationRuntimeStatus(automationId, status, {
  nextWakeAt = undefined,
} = {}) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }

  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const now = Date.now();
    const states = await listAutomationRuntimeStates();
    const existing = states.find((entry) => entry.automationId === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown automation runtime id: ${normalizedId}`);
    }

    const nextStates = states
      .filter((entry) => entry.automationId !== normalizedId)
      .concat({
        ...existing,
        status: normalizeAutomationRuntimeStatus(status, existing.status),
        ...(nextWakeAt !== undefined ? { nextWakeAt } : {}),
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAutomationRuntimeStore(nextStates);
    return saved.find((entry) => entry.automationId === normalizedId) || null;
  });
}

// P4 安全阀（非可选）：operator 经 apply 路径调此函数，
//  - disableGovernanceSnapshot=true/false：全局熔断开关（resolveGovernance 见 true 即忽略 snapshot 回 spec）。
//  - reviveProfile=true：retired profile 复活——清 governanceSnapshot + profileLifecycle（streak 是派生量，
//    清 lifecycle 即重置；下一轮从 spec 默认 + 静态 trustLevel 重新现算）。
// 经同一 store 锁串行化，避免 trustLevel 升降的写竞争（普查并发要求）。
export async function setAutomationGovernanceControl(automationId, {
  disableGovernanceSnapshot = undefined,
  reviveProfile = false,
} = {}) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }

  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const now = Date.now();
    const states = await listAutomationRuntimeStates();
    const existing = states.find((entry) => entry.automationId === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown automation runtime id: ${normalizedId}`);
    }

    const nextStates = states
      .filter((entry) => entry.automationId !== normalizedId)
      .concat({
        ...existing,
        ...(disableGovernanceSnapshot !== undefined
          ? { governanceSnapshotDisabled: disableGovernanceSnapshot === true }
          : {}),
        ...(reviveProfile === true
          ? { governanceSnapshot: null, profileLifecycle: null }
          : {}),
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAutomationRuntimeStore(nextStates);
    return saved.find((entry) => entry.automationId === normalizedId) || null;
  });
}

export async function deleteAutomationRuntimeState(automationId) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }

  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const states = await listAutomationRuntimeStates();
    const existing = states.find((entry) => entry.automationId === normalizedId) || null;
    if (!existing) {
      return {
        ok: true,
        deleted: false,
        runtime: null,
      };
    }

    await writeAutomationRuntimeStore(states.filter((entry) => entry.automationId !== normalizedId));
    return {
      ok: true,
      deleted: true,
      runtime: existing,
    };
  });
}

function summarizeAutomationInstance(spec, runtime) {
  return {
    id: spec.id,
    enabled: spec.enabled === true,
    objectiveSummary: spec.objective?.summary || null,
    objectiveDomain: spec.objective?.domain || spec.adapters?.domain || null,
    targetAgent: spec.entry?.targetAgent || null,
    wakeType: spec.wakePolicy?.type || null,
    wakeScheduleId: spec.wakePolicy?.scheduleId || null,
    runtimeStatus: runtime?.status || (spec.enabled === true ? "idle" : "paused"),
    currentRound: Number.isFinite(runtime?.currentRound) ? runtime.currentRound : 0,
    bestScore: runtime?.bestScore ?? null,
    activeContractId: runtime?.activeContractId || null,
    nextWakeAt: runtime?.nextWakeAt || null,
    childAutomationCount: Array.isArray(runtime?.childAutomationIds) ? runtime.childAutomationIds.length : 0,
    governance: spec.governance,
    // P4 ProfileLifecycle 尾段（只读投影）：trustLevel/status/streak + 本轮收紧治理参数。
    // governanceSnapshotDisabled = 安全阀熔断标志。这是「inspect.profile_lifecycle」的数据源——
    // 当前经 automation runtime summary 暴露（in-domain）。
    // 扩展点（P 后补，避免跨域改 cli-system）：在 cli-system catalog 增 inspect.profile_lifecycle
    // 只读 surface 指向此投影，不碰执行路径。
    profileLifecycle: runtime?.profileLifecycle || null,
    governanceSnapshotDisabled: runtime?.governanceSnapshotDisabled === true,
  };
}

export async function summarizeAutomationRuntimeRegistry({
  enabled = null,
  status = null,
} = {}) {
  const [automations, runtimeStates] = await Promise.all([
    listAutomationSpecs({ enabled }),
    listAutomationRuntimeStates(),
  ]);
  const runtimeById = new Map(runtimeStates.map((entry) => [entry.automationId, entry]));
  const entries = automations
    .map((automation) => ({
      ...automation,
      runtime: runtimeById.get(automation.id) || buildDefaultRuntimeState(automation),
    }))
    .filter((entry) => (
      status
        ? entry.runtime?.status === normalizeAutomationRuntimeStatus(status, entry.runtime?.status)
        : true
    ))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  const summarizedEntries = entries.map((entry) => ({
    ...entry,
    summary: summarizeAutomationInstance(entry, entry.runtime),
  }));

  return {
    automations: summarizedEntries,
    counts: {
      total: summarizedEntries.length,
      enabled: summarizedEntries.filter((entry) => entry.enabled === true).length,
      disabled: summarizedEntries.filter((entry) => entry.enabled !== true).length,
      idle: summarizedEntries.filter((entry) => entry.runtime?.status === "idle").length,
      running: summarizedEntries.filter((entry) => entry.runtime?.status === "running").length,
      paused: summarizedEntries.filter((entry) => entry.runtime?.status === "paused").length,
      completed: summarizedEntries.filter((entry) => entry.runtime?.status === "completed").length,
      error: summarizedEntries.filter((entry) => entry.runtime?.status === "error").length,
      // harness 执行模式/gate 判决计数已随 harness 全退役删除（v226 / 2026-08-23）。
    },
  };
}
