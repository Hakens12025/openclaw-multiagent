// Aggregator — re-exports SURFACE_PLAN_HINTS, UNSUPPORTED_VERIFICATION_SURFACES,
// and SURFACE_DEFAULT_PAYLOADS assembled from domain slices.
// Callers import from this file and are unaffected by the internal split.

import { INSPECT_PLAN_HINTS } from "./plan-hints/inspect.js";
import { AGENTS_PLAN_HINTS } from "./plan-hints/agents.js";
import { APPLY_REST_PLAN_HINTS } from "./plan-hints/apply-rest.js";

export { UNSUPPORTED_VERIFICATION_SURFACES, SURFACE_DEFAULT_PAYLOADS } from "./plan-hints/meta.js";

export const SURFACE_PLAN_HINTS = Object.freeze({
  ...INSPECT_PLAN_HINTS,
  ...AGENTS_PLAN_HINTS,
  ...APPLY_REST_PLAN_HINTS,
});
