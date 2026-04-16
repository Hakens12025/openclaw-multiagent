import {
  deriveAdminSurfaceManagementContext,
  findMissingRequiredAdminSurfaceFields,
  getAdminSurface,
  normalizeAdminSurfacePayload,
} from "./admin-surface-registry.js";
import { mergeManagementContext } from "./admin-change-set-management.js";
import { normalizeBoolean, normalizeRecord, normalizeString } from "../core/normalize.js";

export function buildAdminChangeSetPreview(draft) {
  if (!draft) {
    throw new Error("missing draft");
  }

  const surfaceId = normalizeString(draft.surfaceId);
  if (!surfaceId) {
    throw new Error("draft missing surfaceId");
  }

  const surface = getAdminSurface(surfaceId, { includeTemplates: true });
  const payload = normalizeAdminSurfacePayload(surfaceId, draft?.changeSet?.payload);
  const inputFields = Array.isArray(surface?.changeSetTemplate?.inputFields)
    ? surface.changeSetTemplate.inputFields
    : [];
  const missingFields = findMissingRequiredAdminSurfaceFields(surfaceId, payload);
  const supported = surface?.status === "active" && surface?.executable === true;
  const managementContext = mergeManagementContext(
    deriveAdminSurfaceManagementContext(surfaceId, payload),
    draft?.managementContext,
  );

  return {
    draftId: draft.id,
    surfaceId,
    managementContext,
    executable: surface?.executable === true,
    verificationCapability: normalizeRecord(surface?.verificationCapability),
    supported,
    status: surface?.status || null,
    confirmation: surface?.confirmation || null,
    request: {
      method: surface?.method || null,
      path: surface?.path || null,
      payload,
    },
    payload,
    inputFields,
    missingFields,
    ready: missingFields.length === 0,
    note: missingFields.length
      ? `missing ${missingFields.map((field) => field.key).join(", ")}`
      : "ready",
  };
}

export function resolveAdminChangeSetVerificationRequest(draft, preview, {
  startVerification = false,
} = {}) {
  if (!startVerification) return null;
  const surfaceId = normalizeString(preview?.surfaceId) || normalizeString(draft?.surfaceId);
  if (!surfaceId) {
    throw new Error("missing preview surfaceId");
  }

  const surface = getAdminSurface(surfaceId, { includeTemplates: true });
  const verificationPlan = normalizeRecord(draft?.verificationPlan);
  const verificationRun = {
    ...normalizeRecord(surface?.verificationPlanTemplate?.verificationRun),
    ...normalizeRecord(verificationPlan.verificationRun),
  };
  if (verificationRun.supported === false) {
    throw new Error(`surface does not support post-execution verification: ${surfaceId}`);
  }
  if (!normalizeBoolean(verificationRun.enabled)) {
    throw new Error("verification plan is disabled for this draft");
  }

  const presetId = normalizeString(verificationRun.presetId);
  if (!presetId) {
    throw new Error("verification plan missing presetId");
  }

  return {
    kind: "test_run",
    presetId,
    cleanMode: normalizeString(verificationRun.cleanMode) || "session-clean",
  };
}
