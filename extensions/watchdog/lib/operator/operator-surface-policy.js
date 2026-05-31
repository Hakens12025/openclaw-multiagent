import { getCliSystemSurface, listCliSystemSurfaces } from "../cli-system/cli-surface-registry.js";
import { normalizeString } from "../core/normalize.js";

// operator 主动治理可执行的 family：apply（写）+ verify（主动验证）。
// 二者均经 cli-surface-executor 四道门（family-agnostic）+ operatorExecutable 闸门
// 落地，故 operator 可把 inspect→apply→verify 串成一条治理 plan。
const OPERATOR_EXECUTABLE_FAMILIES = Object.freeze(["apply", "verify"]);

function listExecutableByFamily(options = {}) {
  const includeTemplates = options?.includeTemplates === true;
  return OPERATOR_EXECUTABLE_FAMILIES.flatMap((family) => listCliSystemSurfaces({
    family,
    status: "active",
    operatorExecutable: true,
  }, { includeTemplates })).filter((surface) => surface?.executable === true);
}

export function listOperatorExecutableSurfaceIds() {
  return listExecutableByFamily().map((surface) => surface.id);
}

export function isOperatorExecutableSurfaceId(surfaceId) {
  const surface = getCliSystemSurface(normalizeString(surfaceId));
  return OPERATOR_EXECUTABLE_FAMILIES.includes(surface?.family)
    && surface?.status === "active"
    && surface?.executable === true
    && surface?.operatorExecutable === true;
}

export function listOperatorExecutableCliSystemSurfaces(options = {}) {
  return listExecutableByFamily(options);
}
