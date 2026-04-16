import { ADMIN_SURFACES } from "./admin-surface-catalog.js";
import { SURFACE_INPUT_FIELDS } from "./admin-surface-input-fields.js";
import {
  hasAdminSurfaceOperationHandler,
} from "./admin-surface-operations.js";
import {
  SURFACE_DEFAULT_PAYLOADS,
  SURFACE_PLAN_HINTS,
  UNSUPPORTED_VERIFICATION_SURFACES,
} from "./admin-surface-plan-hints.js";
import { buildAdminSurfaceSubject } from "./admin-surface-subject.js";
import { normalizeBoolean, normalizeRecord, normalizeString } from "../core/normalize.js";

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[\n,]+/g) : []);
  return [...new Set(values
    .map((item) => normalizeString(item))
    .filter(Boolean))];
}

function normalizeOrderedStringArray(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[\n,]+/g) : []);
  return values
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function getValueAtPath(source, path) {
  if (!source || typeof source !== "object" || !path) return undefined;
  let current = source;
  for (const segment of String(path).split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setValueAtPath(target, path, value) {
  const segments = String(path).split(".").filter(Boolean);
  if (!segments.length) return;
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

function deleteValueAtPath(target, path) {
  const segments = String(path).split(".").filter(Boolean);
  if (!segments.length || !target || typeof target !== "object") return;
  const parents = [];
  let current = target;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) return;
    parents.push([current, segment]);
    current = current[segment];
  }
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, key] = parents[index];
    delete parent[key];
    if (Object.keys(parent).length > 0) break;
  }
}

function getFieldLookupPaths(field) {
  return [
    field?.canonicalPath,
    field?.path,
    field?.key,
    ...(Array.isArray(field?.aliases) ? field.aliases : []),
    ...(Array.isArray(field?.fallbackPaths) ? field.fallbackPaths : []),
  ].filter(Boolean);
}

function getFieldCanonicalPath(field) {
  return field?.canonicalPath || field?.path || field?.key;
}

function resolvePayloadFieldValue(payload, field) {
  for (const path of getFieldLookupPaths(field)) {
    const value = getValueAtPath(payload, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function coercePayloadFieldValue(field, rawValue) {
  if (field?.valueType === "ordered_string_list") {
    return normalizeOrderedStringArray(rawValue);
  }

  if (field?.type === "checkbox_group" || field?.valueType === "string_list") {
    return normalizeStringArray(rawValue);
  }

  if (field?.valueType === "boolean_token") {
    if (rawValue === null || typeof rawValue === "boolean") return rawValue;
    const normalized = normalizeString(rawValue)?.toLowerCase();
    if (!normalized) return undefined;
    if (["default", "inherit", "reset"].includes(normalized)) return null;
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return normalized;
  }

  if (typeof rawValue === "string") return rawValue.trim();
  return rawValue;
}

function isMissingRequiredValue(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  return value == null;
}

export function getAdminSurfaceInputFields(surfaceOrId) {
  const surface = typeof surfaceOrId === "string"
    ? getAdminSurface(surfaceOrId, { includeTemplates: true })
    : surfaceOrId;
  const fields = surface?.changeSetTemplate?.inputFields;
  return Array.isArray(fields) ? cloneJsonValue(fields) : [];
}

export function normalizeAdminSurfacePayload(surfaceOrId, payload) {
  const sourcePayload = cloneJsonValue(normalizeRecord(payload));
  const nextPayload = cloneJsonValue(normalizeRecord(payload));
  for (const field of getAdminSurfaceInputFields(surfaceOrId)) {
    const canonicalPath = getFieldCanonicalPath(field);
    for (const path of new Set(getFieldLookupPaths(field))) {
      deleteValueAtPath(nextPayload, path);
    }
    const nextValue = coercePayloadFieldValue(field, resolvePayloadFieldValue(sourcePayload, field));
    if (nextValue !== undefined) {
      setValueAtPath(nextPayload, canonicalPath, nextValue);
    }
  }
  return nextPayload;
}

export function findMissingRequiredAdminSurfaceFields(surfaceOrId, payload) {
  const normalizedPayload = normalizeAdminSurfacePayload(surfaceOrId, payload);
  return getAdminSurfaceInputFields(surfaceOrId)
    .filter((field) => field?.required)
    .filter((field) => isMissingRequiredValue(getValueAtPath(normalizedPayload, getFieldCanonicalPath(field))))
    .map((field) => ({
      key: field.key,
      label: field.label || field.key,
      canonicalPath: getFieldCanonicalPath(field),
    }));
}

export function deriveAdminSurfaceManagementContext(surfaceOrId, payload) {
  const surface = typeof surfaceOrId === "string"
    ? getAdminSurface(surfaceOrId, { includeTemplates: true })
    : surfaceOrId;
  if (!surface) return null;

  const normalizedPayload = normalizeAdminSurfacePayload(surface.id, payload);
  const subject = normalizeRecord(surface.subject);
  const selectorKey = normalizeString(subject.selectorKey);
  const selectorValue = selectorKey
    ? normalizeString(getValueAtPath(normalizedPayload, selectorKey))
    : null;

  return {
    surfaceId: surface.id,
    stage: normalizeString(surface.stage) || null,
    subjectKind: normalizeString(subject.kind) || "platform",
    subjectScope: normalizeString(subject.scope) || "global",
    aspect: normalizeString(subject.aspect) || surface.id,
    selectorKey,
    selectorValue,
    targetRef: selectorKey && selectorValue
      ? {
        key: selectorKey,
        value: selectorValue,
      }
      : null,
  };
}

function normalizeSurface(surface) {
  const executable = hasAdminSurfaceOperationHandler(surface.id);
  return {
    id: surface.id,
    stage: surface.stage,
    risk: surface.risk,
    method: surface.method,
    path: surface.path,
    operatorPhase: surface.operatorPhase,
    operatorExecutable: surface.operatorExecutable === true,
    confirmation: surface.confirmation,
    status: surface.status,
    summary: surface.summary,
    subject: buildAdminSurfaceSubject(surface),
    executable,
    verificationCapability: buildVerificationCapability(surface, { executable }),
  };
}

function buildVerificationCapability(surface, { executable = hasAdminSurfaceOperationHandler(surface.id) } = {}) {
  const supported = surface.stage === "apply"
    && executable === true
    && !UNSUPPORTED_VERIFICATION_SURFACES.has(surface.id);
  return {
    supported,
    defaultEnabled: supported,
    presetId: supported ? "single" : null,
    cleanMode: supported ? "session-clean" : null,
  };
}

function buildChangeSetTemplate(surface) {
  if (surface.stage === "inspect") return null;
  const hints = SURFACE_PLAN_HINTS[surface.id] || {};
  const defaultPayload = cloneJsonValue(SURFACE_DEFAULT_PAYLOADS[surface.id] || {});
  const inputFields = cloneJsonValue(SURFACE_INPUT_FIELDS[surface.id] || []);
  const verificationCapability = buildVerificationCapability(surface);
  return {
    goal: surface.id.replace(/\./g, "_"),
    surfaceId: surface.id,
    stage: surface.stage,
    payload: defaultPayload,
    inputFields,
    reads: [...(hints.reads || [])],
    writes: [...(hints.writes || [])],
    apiCalls: [{ method: surface.method, path: surface.path }],
    generatedFiles: [...(hints.generatedFiles || [])],
    tests: [...(hints.tests || [])],
    memos: [...(hints.memos || [])],
    riskLevel: surface.risk,
    confirmation: surface.confirmation,
    executable: hasAdminSurfaceOperationHandler(surface.id),
    verificationCapability,
  };
}

function buildVerificationPlanTemplate(surface) {
  const hints = SURFACE_PLAN_HINTS[surface.id] || {};
  const verificationCapability = buildVerificationCapability(surface);
  return {
    scope: surface.id,
    surfaceId: surface.id,
    stage: surface.stage,
    apiChecks: [...(hints.apiChecks || [`${surface.method} ${surface.path}`])],
    commands: [],
    expectedSignals: [...(hints.expectedSignals || [])],
    blockers: [
      ...(surface.status === "hold" ? ["surface_on_hold"] : []),
      ...(hints.blockers || []),
    ],
    verificationRun: {
      supported: verificationCapability.supported,
      enabled: verificationCapability.defaultEnabled,
      presetId: verificationCapability.presetId,
      cleanMode: verificationCapability.cleanMode,
    },
  };
}

function decorateSurface(surface, { includeTemplates = false } = {}) {
  const normalized = normalizeSurface(surface);
  if (!includeTemplates) return normalized;
  return {
    ...normalized,
    changeSetTemplate: buildChangeSetTemplate(surface),
    verificationPlanTemplate: buildVerificationPlanTemplate(surface),
  };
}

export function listAdminSurfaces(filters = {}, options = {}) {
  const stage = normalizeString(filters.stage);
  const risk = normalizeString(filters.risk);
  const status = normalizeString(filters.status);
  const phase = normalizeString(filters.operatorPhase);
  const id = normalizeString(filters.id);
  const hasOperatorExecutableFilter = Object.prototype.hasOwnProperty.call(filters, "operatorExecutable");
  const operatorExecutable = hasOperatorExecutableFilter ? filters.operatorExecutable === true : null;
  const includeTemplates = normalizeBoolean(options.includeTemplates);

  return ADMIN_SURFACES.filter((surface) => {
    if (id && surface.id !== id) return false;
    if (stage && surface.stage !== stage) return false;
    if (risk && surface.risk !== risk) return false;
    if (status && surface.status !== status) return false;
    if (phase && surface.operatorPhase !== phase) return false;
    if (hasOperatorExecutableFilter && (surface.operatorExecutable === true) !== operatorExecutable) return false;
    return true;
  }).map((surface) => decorateSurface(surface, { includeTemplates }));
}

export function getAdminSurface(id, options = {}) {
  return listAdminSurfaces({ id }, options)[0] || null;
}

export function summarizeAdminSurfaces(filters = {}, options = {}) {
  const surfaces = listAdminSurfaces(filters, options);
  const counts = {
    total: surfaces.length,
    inspect: surfaces.filter((surface) => surface.stage === "inspect").length,
    apply: surfaces.filter((surface) => surface.stage === "apply").length,
    verify: surfaces.filter((surface) => surface.stage === "verify").length,
    operatorExecutable: surfaces.filter((surface) => surface.operatorExecutable === true).length,
    hold: surfaces.filter((surface) => surface.status === "hold").length,
    destructive: surfaces.filter((surface) => surface.risk === "destructive").length,
  };

  return { counts, surfaces };
}

// ---------------------------------------------------------------------------
// Unified registry: combines catalog + input-fields + plan-hints into a
// single lookup keyed by surface id.  Built lazily on first access.
// ---------------------------------------------------------------------------

let _unifiedRegistryCache = null;

function buildUnifiedRegistry() {
  const registry = Object.create(null);
  for (const surface of ADMIN_SURFACES) {
    const hints = SURFACE_PLAN_HINTS[surface.id] || {};
    registry[surface.id] = {
      // catalog meta
      id: surface.id,
      stage: surface.stage,
      risk: surface.risk,
      method: surface.method,
      path: surface.path,
      operatorPhase: surface.operatorPhase,
      operatorExecutable: surface.operatorExecutable === true,
      confirmation: surface.confirmation,
      status: surface.status,
      summary: surface.summary,
      // input-fields
      fields: SURFACE_INPUT_FIELDS[surface.id] || [],
      // plan-hints
      planHint: Object.keys(hints).length > 0 ? hints : null,
      defaultPayload: SURFACE_DEFAULT_PAYLOADS[surface.id] || null,
      unsupportedVerification: UNSUPPORTED_VERIFICATION_SURFACES.has(surface.id),
    };
  }
  return registry;
}

/**
 * Returns the unified registry map (surface id -> unified entry).
 * The returned object is shared (not cloned); treat as read-only.
 */
export function getUnifiedSurfaceMap() {
  if (!_unifiedRegistryCache) {
    _unifiedRegistryCache = buildUnifiedRegistry();
  }
  return _unifiedRegistryCache;
}

/**
 * Returns a single unified entry for the given surface id, or null.
 */
export function getUnifiedSurface(id) {
  return getUnifiedSurfaceMap()[id] || null;
}
