import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  appendExecutionRecord,
  makeExecutionId,
  mergeVerificationRecord,
  normalizeExecutionHistory,
  normalizeExecutionStatus,
  normalizeVerificationHistory,
  resolveDraftStatus,
  summarizeExecutionHistory,
  summarizeVerificationHistory,
} from "./admin-change-set-history.js";
import {
  buildManagementActivity,
  mergeManagementContext,
} from "./admin-change-set-management.js";
import {
  resolveVerificationRun,
  summarizeVerificationRun,
} from "./admin-change-set-verification.js";
import { OC, atomicWriteFile, withLock } from "../state.js";
// Dynamic import: capability-registry imports admin-change-sets (circular).
// invalidateCapabilityRegistryCache is only needed after writes, not at load time.
async function invalidateCapabilityRegistryCache() {
  const mod = await import("../capability/capability-registry.js");
  mod.invalidateCapabilityRegistryCache();
}
import {
  deriveAdminSurfaceManagementContext,
  listAdminSurfaces,
  normalizeAdminSurfacePayload,
} from "./admin-surface-registry.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";

const ADMIN_CHANGE_SET_DIR = join(OC, "workspaces", "controller", "admin-change-sets");

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeDraftId() {
  return `ACS-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

function draftPath(id) {
  return join(ADMIN_CHANGE_SET_DIR, `${id}.json`);
}

function withAdminChangeSetDraftLock(id, fn) {
  const normalizedId = normalizeString(id);
  return normalizedId
    ? withLock(`admin-change-set:${normalizedId}`, fn)
    : fn();
}


function decorateDraft(draft) {
  const normalized = normalizeRecord(draft);
  const surface = resolveSurfaceTemplate(normalizeString(normalized.surfaceId));
  const verification = summarizeVerificationHistory(normalized.verificationHistory);
  const execution = summarizeExecutionHistory(normalized.executionHistory);
  const managementContext = mergeManagementContext(
    deriveAdminSurfaceManagementContext(surface || normalizeString(normalized.surfaceId), normalized.changeSet?.payload),
    normalized.managementContext,
  );
  return {
    ...normalized,
    surfaceExecutable: normalized.surfaceExecutable === true || surface?.executable === true,
    managementContext,
    verificationHistory: verification.verificationHistory,
    verificationCount: verification.verificationCount,
    lastVerificationAt: verification.lastVerificationAt,
    lastVerificationStatus: verification.lastVerificationStatus,
    lastVerificationRunId: verification.lastVerificationRunId,
    executionHistory: execution.executionHistory,
    executionCount: execution.executionCount,
    lastExecutionAt: execution.lastExecutionAt,
    lastExecutionStatus: execution.lastExecutionStatus,
    status: resolveDraftStatus({
      storedStatus: normalized.status,
      lastExecutionStatus: execution.lastExecutionStatus,
      lastVerificationStatus: verification.lastVerificationStatus,
    }),
  };
}

function summarizeDraft(draft) {
  const decorated = decorateDraft(draft);
  return {
    id: decorated.id,
    surfaceId: decorated.surfaceId,
    title: decorated.title || null,
    summary: decorated.summary || null,
    status: decorated.status || "draft",
    stage: decorated.stage || null,
    riskLevel: decorated.riskLevel || null,
    confirmation: decorated.confirmation || null,
    operatorPhase: decorated.operatorPhase || null,
    surfacePath: decorated.surfacePath || null,
    surfaceMethod: decorated.surfaceMethod || null,
    surfaceStatus: decorated.surfaceStatus || null,
    surfaceExecutable: decorated.surfaceExecutable === true,
    managementContext: decorated.managementContext || null,
    verificationCount: decorated.verificationCount || 0,
    lastVerificationAt: decorated.lastVerificationAt || null,
    lastVerificationStatus: decorated.lastVerificationStatus || null,
    lastVerificationRunId: decorated.lastVerificationRunId || null,
    executionCount: decorated.executionCount || 0,
    lastExecutionAt: decorated.lastExecutionAt || null,
    lastExecutionStatus: decorated.lastExecutionStatus || null,
    createdAt: decorated.createdAt || null,
    updatedAt: decorated.updatedAt || null,
  };
}


async function ensureStoreDir() {
  await mkdir(ADMIN_CHANGE_SET_DIR, { recursive: true });
}

async function loadDraft(id) {
  const normalized = normalizeString(id);
  if (!normalized) return null;
  try {
    return decorateDraft(JSON.parse(await readFile(draftPath(normalized), "utf8")));
  } catch {
    return null;
  }
}

function resolveSurfaceTemplate(surfaceId) {
  return listAdminSurfaces({ id: surfaceId }, { includeTemplates: true })[0] || null;
}

function mergeTemplate(base, patch) {
  return {
    ...deepClone(base || {}),
    ...normalizeRecord(patch),
  };
}

function buildDraftFromSurface(surface, payload, existing = null) {
  const now = Date.now();
  const normalizedPayload = normalizeRecord(payload);
  const existingDraft = normalizeRecord(existing);

  const id = normalizeString(existingDraft.id) || makeDraftId();
  const title = normalizeString(normalizedPayload.title)
    || normalizeString(existingDraft.title)
    || normalizeString(surface.summary)
    || surface.id;
  const summary = normalizeString(normalizedPayload.summary)
    || normalizeString(existingDraft.summary)
    || null;
  const status = normalizeString(normalizedPayload.status)
    || normalizeString(existingDraft.status)
    || "draft";

  const changeSet = mergeTemplate(
    normalizedPayload.changeSetTemplate || existingDraft.changeSetTemplate || surface.changeSetTemplate,
    normalizedPayload.changeSet,
  );
  if (surface.changeSetTemplate && changeSet && typeof changeSet === "object") {
    changeSet.payload = normalizeAdminSurfacePayload(surface.id, changeSet.payload);
  }
  const managementContext = mergeManagementContext(
    deriveAdminSurfaceManagementContext(surface, changeSet?.payload),
    normalizedPayload.managementContext || existingDraft.managementContext,
  );
  const verificationPlan = mergeTemplate(
    normalizedPayload.verificationPlanTemplate || existingDraft.verificationPlanTemplate || surface.verificationPlanTemplate,
    normalizedPayload.verificationPlan,
  );

  return decorateDraft({
    id,
    surfaceId: surface.id,
    title,
    summary,
    status,
    stage: surface.stage,
    riskLevel: surface.risk,
    confirmation: surface.confirmation,
    operatorPhase: surface.operatorPhase,
    surfacePath: surface.path,
    surfaceMethod: surface.method,
    surfaceStatus: surface.status,
    surfaceExecutable: surface.executable === true,
    managementContext,
    changeSetTemplate: surface.changeSetTemplate || null,
    verificationPlanTemplate: surface.verificationPlanTemplate || null,
    changeSet: surface.changeSetTemplate ? changeSet : null,
    verificationPlan,
    verificationHistory: normalizeVerificationHistory(existingDraft.verificationHistory),
    executionHistory: normalizeExecutionHistory(existingDraft.executionHistory),
    createdAt: existingDraft.createdAt || now,
    updatedAt: now,
  });
}

export async function listAdminChangeSets() {
  await ensureStoreDir();
  const files = await readdir(ADMIN_CHANGE_SET_DIR);
  const drafts = [];
  for (const file of files.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const raw = await readFile(join(ADMIN_CHANGE_SET_DIR, file), "utf8");
      drafts.push(decorateDraft(JSON.parse(raw)));
    } catch {}
  }
  drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return drafts.map(summarizeDraft);
}

export async function getAdminChangeSetManagementActivity() {
  const drafts = await listAdminChangeSets();
  return buildManagementActivity(drafts);
}

export async function getAdminChangeSetDetails(id) {
  return loadDraft(id);
}

export async function saveAdminChangeSetDraft(payload) {
  const normalizedPayload = normalizeRecord(payload);
  const surfaceId = normalizeString(normalizedPayload.surfaceId);
  if (!surfaceId) {
    throw new Error("missing surfaceId");
  }

  const surface = resolveSurfaceTemplate(surfaceId);
  if (!surface) {
    throw new Error(`unknown surfaceId: ${surfaceId}`);
  }

  const existingId = normalizeString(normalizedPayload.id);
  return withAdminChangeSetDraftLock(existingId, async () => {
    const existing = existingId ? await loadDraft(existingId) : null;
    if (existingId && !existing) {
      throw new Error(`draft not found: ${existingId}`);
    }

    const draft = buildDraftFromSurface(surface, normalizedPayload, existing);
    await ensureStoreDir();
    await atomicWriteFile(draftPath(draft.id), JSON.stringify(draft, null, 2));
    await invalidateCapabilityRegistryCache();
    return draft;
  });
}

export async function attachAdminChangeSetVerification(payload) {
  const normalizedPayload = normalizeRecord(payload);
  const id = normalizeString(normalizedPayload.id);
  if (!id) {
    throw new Error("missing id");
  }

  return withAdminChangeSetDraftLock(id, async () => {
    const existing = await loadDraft(id);
    if (!existing) {
      throw new Error(`draft not found: ${id}`);
    }

    const resolved = await resolveVerificationRun(normalizedPayload);
    const record = summarizeVerificationRun(resolved.run, {
      source: resolved.source,
      reportPath: resolved.reportPath,
      note: normalizeString(normalizedPayload.note),
    });

    const draft = decorateDraft({
      ...existing,
      verificationHistory: mergeVerificationRecord(existing.verificationHistory, record),
      updatedAt: Date.now(),
    });

    await ensureStoreDir();
    await atomicWriteFile(draftPath(draft.id), JSON.stringify(draft, null, 2));
    await invalidateCapabilityRegistryCache();
    return {
      draft,
      verificationRecord: record,
    };
  });
}

export async function recordAdminChangeSetExecution(payload) {
  const normalizedPayload = normalizeRecord(payload);
  const id = normalizeString(normalizedPayload.id);
  if (!id) {
    throw new Error("missing id");
  }

  return withAdminChangeSetDraftLock(id, async () => {
    const existing = await loadDraft(id);
    if (!existing) {
      throw new Error(`draft not found: ${id}`);
    }

    const record = {
      id: normalizeString(normalizedPayload.executionId) || makeExecutionId(),
      surfaceId: normalizeString(normalizedPayload.surfaceId) || existing.surfaceId || null,
      dryRun: normalizedPayload.dryRun === true,
      status: normalizeString(normalizedPayload.status) || "completed",
      executionStatus: normalizeExecutionStatus(normalizedPayload),
      note: normalizeString(normalizedPayload.note),
      startedAt: Number.isFinite(normalizedPayload.startedAt) ? normalizedPayload.startedAt : Date.now(),
      finishedAt: Number.isFinite(normalizedPayload.finishedAt) ? normalizedPayload.finishedAt : Date.now(),
      durationMs: Number.isFinite(normalizedPayload.durationMs) ? normalizedPayload.durationMs : null,
      payload: normalizeRecord(normalizedPayload.payload),
      result: normalizeRecord(normalizedPayload.result),
      error: normalizeString(normalizedPayload.error),
      managementContext: mergeManagementContext(
        deriveAdminSurfaceManagementContext(
          normalizeString(normalizedPayload.surfaceId) || existing.surfaceId,
          normalizedPayload.payload,
        ),
        normalizedPayload.managementContext || existing.managementContext,
      ),
    };

    const draft = decorateDraft({
      ...existing,
      executionHistory: appendExecutionRecord(existing.executionHistory, record),
      updatedAt: Date.now(),
    });

    await ensureStoreDir();
    await atomicWriteFile(draftPath(draft.id), JSON.stringify(draft, null, 2));
    await invalidateCapabilityRegistryCache();
    return {
      draft,
      executionRecord: record,
    };
  });
}
