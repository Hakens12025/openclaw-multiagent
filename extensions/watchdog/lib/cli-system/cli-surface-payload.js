import {
  findMissingRequiredAdminSurfaceFields,
  normalizeAdminSurfacePayload,
} from "../admin/admin-surface-registry.js";

export function normalizeCliSystemSurfacePayload(surfaceId, payload) {
  return normalizeAdminSurfacePayload(surfaceId, payload);
}

export function findMissingRequiredCliSystemSurfaceFields(surfaceId, payload) {
  return findMissingRequiredAdminSurfaceFields(surfaceId, payload);
}
