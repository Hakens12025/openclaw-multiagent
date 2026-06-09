import { buildAdminSurfaceSubject } from "../admin/admin-surface-subject.js";
import { normalizeString } from "../core/normalize.js";

// Meta-agent surface ownership: actor -> owned admin-surface families.
// "*" = universal (operator owns every family). A meta-agent is a meta-agent
// because it is the SOLE WRITER of a surface family, not because it owns a
// platform truth. viz-master owns the "chart" family (charts.json is a
// non-truth control-plane store, sibling of knowledge-bases.json).
export const META_AGENT_SURFACE_OWNERSHIP = Object.freeze({
  operator: "*",
  "viz-master": ["chart"],
});

// Shared verify infrastructure any meta-agent may use regardless of ownership.
const SHARED_FAMILIES = Object.freeze(new Set(["test_run"]));

// Content/data families backed by a non-truth control-plane store. A
// destructive op on these must NOT trigger a structure snapshot.
export const NON_TRUTH_BACKED_FAMILIES = Object.freeze(new Set(["knowledge", "chart"]));

export function resolveSurfaceFamily(surfaceId) {
  return buildAdminSurfaceSubject(surfaceId).kind;
}

export function assertActorOwnsSurface(actor, surfaceId) {
  const a = normalizeString(actor);
  const owned = a ? META_AGENT_SURFACE_OWNERSHIP[a] : undefined;
  if (!owned) {
    throw new Error(`cli-system surface requires a meta-agent actor: ${surfaceId}`);
  }
  if (owned === "*") return;
  const fam = resolveSurfaceFamily(surfaceId);
  if (owned.includes(fam) || SHARED_FAMILIES.has(fam)) return;
  throw new Error(`actor ${a} does not own surface family "${fam}": ${surfaceId}`);
}

// Narrow a list of executable surfaces to only those an actor may write. Mirrors
// assertActorOwnsSurface as a non-throwing filter (for catalog/scoping reads):
// unknown actor → none; operator ("*") → all; meta-agent → owned families plus
// shared verify infra. Each surface is shaped { id, ... }.
export function filterExecutableSurfacesForActor(actor, surfaces) {
  const owned = META_AGENT_SURFACE_OWNERSHIP[normalizeString(actor)];
  if (!owned) return [];
  if (owned === "*") return surfaces;
  return surfaces.filter((s) => {
    const fam = resolveSurfaceFamily(s.id);
    return owned.includes(fam) || SHARED_FAMILIES.has(fam);
  });
}
