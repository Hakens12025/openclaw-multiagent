import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

export function normalizeManagementContext(value) {
  const record = normalizeRecord(value);
  const targetRef = normalizeRecord(record.targetRef);
  const selectorKey = normalizeString(record.selectorKey) || normalizeString(targetRef.key);
  const selectorValue = normalizeString(record.selectorValue) || normalizeString(targetRef.value);
  const normalized = {
    surfaceId: normalizeString(record.surfaceId),
    stage: normalizeString(record.stage),
    subjectKind: normalizeString(record.subjectKind),
    subjectScope: normalizeString(record.subjectScope),
    aspect: normalizeString(record.aspect),
    selectorKey,
    selectorValue,
    targetRef: selectorKey && selectorValue
      ? {
        key: selectorKey,
        value: selectorValue,
      }
      : null,
  };
  if (!normalized.surfaceId && !normalized.subjectKind) {
    return null;
  }
  return normalized;
}

export function mergeManagementContext(derived, stored) {
  const base = normalizeManagementContext(derived) || {};
  const patch = normalizeManagementContext(stored) || {};
  const merged = {
    ...base,
    ...patch,
  };
  if (!merged.selectorKey && merged.targetRef?.key) {
    merged.selectorKey = merged.targetRef.key;
  }
  if (!merged.selectorValue && merged.targetRef?.value) {
    merged.selectorValue = merged.targetRef.value;
  }
  merged.targetRef = merged.selectorKey && merged.selectorValue
    ? {
      key: merged.selectorKey,
      value: merged.selectorValue,
    }
    : null;
  if (!merged.surfaceId && !merged.subjectKind) {
    return null;
  }
  return merged;
}

export function buildManagementActivityTargetKey(context) {
  const normalized = normalizeManagementContext(context);
  if (!normalized?.subjectKind) return null;
  if (normalized.selectorKey && !normalized.selectorValue) return null;
  if (normalized.selectorKey && normalized.selectorValue) {
    return `${normalized.subjectKind}::${normalized.selectorKey}::${normalized.selectorValue}`;
  }
  return `${normalized.subjectKind}::${normalized.subjectScope || "global"}`;
}

function computeDraftLastActivityAt(draft) {
  return Math.max(
    Number(draft?.updatedAt) || 0,
    Number(draft?.lastExecutionAt) || 0,
    Number(draft?.lastVerificationAt) || 0,
    Number(draft?.createdAt) || 0,
  ) || null;
}

export function createManagementActivityTarget(context) {
  const normalized = normalizeManagementContext(context);
  if (!normalized?.subjectKind) return null;
  if (normalized.selectorKey && !normalized.selectorValue) return null;
  return {
    key: buildManagementActivityTargetKey(normalized),
    subjectKind: normalized.subjectKind,
    subjectScope: normalized.subjectScope || "global",
    aspect: normalized.aspect || null,
    selectorKey: normalized.selectorKey || null,
    selectorValue: normalized.selectorValue || null,
    targetRef: normalized.targetRef || null,
    draftCount: 0,
    executionCount: 0,
    verificationCount: 0,
    surfaceIds: [],
    lastActivityAt: null,
    lastDraft: null,
    lastExecution: null,
    lastVerification: null,
    recentDrafts: [],
  };
}

function summarizeActivityDraft(draft) {
  return {
    id: draft.id,
    title: draft.title || draft.surfaceId || draft.id,
    surfaceId: draft.surfaceId || null,
    status: draft.status || "draft",
    updatedAt: draft.updatedAt || draft.createdAt || null,
    executionCount: draft.executionCount || 0,
    verificationCount: draft.verificationCount || 0,
    lastExecutionAt: draft.lastExecutionAt || null,
    lastExecutionStatus: draft.lastExecutionStatus || null,
    lastVerificationAt: draft.lastVerificationAt || null,
    lastVerificationStatus: draft.lastVerificationStatus || null,
  };
}

function summarizeActivityExecution(draft) {
  if (!draft?.lastExecutionAt && !draft?.lastExecutionStatus) return null;
  return {
    draftId: draft.id,
    draftTitle: draft.title || draft.surfaceId || draft.id,
    surfaceId: draft.surfaceId || null,
    status: draft.lastExecutionStatus || null,
    at: draft.lastExecutionAt || null,
  };
}

function summarizeActivityVerification(draft) {
  if (!draft?.lastVerificationAt && !draft?.lastVerificationStatus) return null;
  return {
    draftId: draft.id,
    draftTitle: draft.title || draft.surfaceId || draft.id,
    surfaceId: draft.surfaceId || null,
    status: draft.lastVerificationStatus || null,
    runId: draft.lastVerificationRunId || null,
    at: draft.lastVerificationAt || null,
  };
}

export function mergeManagementActivityTarget(entry, draft) {
  entry.draftCount += 1;
  entry.executionCount += Number(draft?.executionCount) || 0;
  entry.verificationCount += Number(draft?.verificationCount) || 0;
  if (draft?.surfaceId && !entry.surfaceIds.includes(draft.surfaceId)) {
    entry.surfaceIds.push(draft.surfaceId);
    entry.surfaceIds.sort();
  }

  const draftSummary = summarizeActivityDraft(draft);
  entry.recentDrafts = [draftSummary, ...entry.recentDrafts]
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, 3);

  if ((Number(draftSummary.updatedAt) || 0) >= (Number(entry.lastDraft?.updatedAt) || 0)) {
    entry.lastDraft = draftSummary;
  }

  const execution = summarizeActivityExecution(draft);
  if (execution && (Number(execution.at) || 0) >= (Number(entry.lastExecution?.at) || 0)) {
    entry.lastExecution = execution;
  }

  const verification = summarizeActivityVerification(draft);
  if (verification && (Number(verification.at) || 0) >= (Number(entry.lastVerification?.at) || 0)) {
    entry.lastVerification = verification;
  }

  const lastActivityAt = computeDraftLastActivityAt(draft);
  if ((Number(lastActivityAt) || 0) >= (Number(entry.lastActivityAt) || 0)) {
    entry.lastActivityAt = lastActivityAt;
  }
}

export function buildManagementActivity(drafts) {
  const targets = new Map();
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const context = normalizeManagementContext(draft?.managementContext);
    const key = buildManagementActivityTargetKey(context);
    if (!key) continue;
    if (!targets.has(key)) {
      const target = createManagementActivityTarget(context);
      if (!target) continue;
      targets.set(key, target);
    }
    mergeManagementActivityTarget(targets.get(key), draft);
  }

  const targetList = [...targets.values()]
    .sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0));
  const subjectGroups = new Map();
  for (const target of targetList) {
    if (!subjectGroups.has(target.subjectKind)) {
      subjectGroups.set(target.subjectKind, []);
    }
    subjectGroups.get(target.subjectKind).push(target);
  }

  return {
    targets: targetList,
    subjects: [...subjectGroups.entries()]
      .map(([kind, subjectTargets]) => summarizeManagementActivitySubject(kind, subjectTargets))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
  };
}

export function summarizeManagementActivitySubject(kind, targets) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const lastActivityAt = normalizedTargets.reduce(
    (max, target) => Math.max(max, Number(target?.lastActivityAt) || 0),
    0,
  ) || null;
  const lastExecutionAt = normalizedTargets.reduce(
    (max, target) => Math.max(max, Number(target?.lastExecution?.at) || 0),
    0,
  ) || null;
  const lastVerificationAt = normalizedTargets.reduce(
    (max, target) => Math.max(max, Number(target?.lastVerification?.at) || 0),
    0,
  ) || null;
  return {
    kind,
    targetCount: normalizedTargets.length,
    draftCount: normalizedTargets.reduce((sum, target) => sum + (target?.draftCount || 0), 0),
    executionCount: normalizedTargets.reduce((sum, target) => sum + (target?.executionCount || 0), 0),
    verificationCount: normalizedTargets.reduce((sum, target) => sum + (target?.verificationCount || 0), 0),
    lastActivityAt,
    lastExecutionAt,
    lastVerificationAt,
    recentTargets: normalizedTargets
      .slice()
      .sort((a, b) => (Number(b?.lastActivityAt) || 0) - (Number(a?.lastActivityAt) || 0))
      .slice(0, 5)
      .map((target) => ({
        key: target.key,
        selectorKey: target.selectorKey,
        selectorValue: target.selectorValue,
        subjectScope: target.subjectScope,
        lastActivityAt: target.lastActivityAt,
        lastDraftStatus: target.lastDraft?.status || null,
        lastExecutionStatus: target.lastExecution?.status || null,
        lastVerificationStatus: target.lastVerification?.status || null,
      })),
  };
}

export function normalizeManagementActivitySubjectSummary(value) {
  const record = normalizeRecord(value);
  return {
    kind: normalizeString(record.kind) || null,
    targetCount: Number.isFinite(record.targetCount) ? record.targetCount : 0,
    draftCount: Number.isFinite(record.draftCount) ? record.draftCount : 0,
    executionCount: Number.isFinite(record.executionCount) ? record.executionCount : 0,
    verificationCount: Number.isFinite(record.verificationCount) ? record.verificationCount : 0,
    lastActivityAt: Number.isFinite(record.lastActivityAt) ? record.lastActivityAt : null,
    lastExecutionAt: Number.isFinite(record.lastExecutionAt) ? record.lastExecutionAt : null,
    lastVerificationAt: Number.isFinite(record.lastVerificationAt) ? record.lastVerificationAt : null,
    recentTargets: Array.isArray(record.recentTargets) ? record.recentTargets : [],
  };
}

export function normalizeManagementActivityTargetSummary(value) {
  const record = normalizeRecord(value);
  const targetRef = normalizeRecord(record.targetRef);
  if (!normalizeString(record.key) && !normalizeString(record.subjectKind)) {
    return null;
  }
  return {
    key: normalizeString(record.key) || null,
    subjectKind: normalizeString(record.subjectKind) || null,
    subjectScope: normalizeString(record.subjectScope) || null,
    aspect: normalizeString(record.aspect) || null,
    selectorKey: normalizeString(record.selectorKey) || normalizeString(targetRef.key) || null,
    selectorValue: normalizeString(record.selectorValue) || normalizeString(targetRef.value) || null,
    targetRef: normalizeString(targetRef.key) && normalizeString(targetRef.value)
      ? { key: normalizeString(targetRef.key), value: normalizeString(targetRef.value) }
      : null,
    draftCount: Number.isFinite(record.draftCount) ? record.draftCount : 0,
    executionCount: Number.isFinite(record.executionCount) ? record.executionCount : 0,
    verificationCount: Number.isFinite(record.verificationCount) ? record.verificationCount : 0,
    surfaceIds: uniqueStrings(record.surfaceIds),
    lastActivityAt: Number.isFinite(record.lastActivityAt) ? record.lastActivityAt : null,
    lastDraft: normalizeRecord(record.lastDraft),
    lastExecution: normalizeRecord(record.lastExecution),
    lastVerification: normalizeRecord(record.lastVerification),
    recentDrafts: Array.isArray(record.recentDrafts) ? record.recentDrafts : [],
  };
}

export function findManagementActivityTargetSummary(activity, {
  subjectKind,
  selectorKey = null,
  selectorValue = null,
} = {}) {
  const normalizedKind = normalizeString(subjectKind);
  if (!normalizedKind) return null;
  const normalizedSelectorKey = normalizeString(selectorKey);
  const normalizedSelectorValue = normalizeString(selectorValue);
  const targets = Array.isArray(activity?.targets) ? activity.targets : [];
  return targets.find((target) => {
    if (target.subjectKind !== normalizedKind) return false;
    if (normalizedSelectorKey && target.selectorKey !== normalizedSelectorKey) return false;
    if (normalizedSelectorValue) {
      return target.selectorValue === normalizedSelectorValue;
    }
    return !target.selectorKey && !target.selectorValue;
  }) || null;
}
