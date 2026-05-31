import { executeAdminSurfaceOperation } from "../admin/admin-surface-operations.js";
import { normalizeString } from "../core/normalize.js";
import { getCliSystemSurface } from "./cli-surface-registry.js";

export async function executeCliSystemSurface({
  surfaceId,
  payload = {},
  actor = null,
  logger = null,
  onAlert = null,
  runtimeContext = null,
} = {}) {
  const normalizedSurfaceId = normalizeString(surfaceId);
  const surface = getCliSystemSurface(normalizedSurfaceId);
  if (!surface) {
    throw new Error(`unknown cli-system surface: ${normalizedSurfaceId || "unknown"}`);
  }

  if (actor !== "operator") {
    throw new Error(`cli-system surface requires operator actor: ${normalizedSurfaceId}`);
  }
  if (surface.operatorExecutable !== true) {
    throw new Error(`cli-system surface is not operator executable: ${normalizedSurfaceId}`);
  }
  if (surface.executable !== true) {
    throw new Error(`cli-system surface is not executable: ${normalizedSurfaceId}`);
  }
  if (surface.source !== "admin_surface") {
    throw new Error(`cli-system surface has no admin executor: ${normalizedSurfaceId}`);
  }

  return executeAdminSurfaceOperation({
    surfaceId: normalizedSurfaceId,
    payload,
    logger,
    onAlert,
    runtimeContext,
  });
}
