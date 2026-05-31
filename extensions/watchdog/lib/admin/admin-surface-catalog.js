// Aggregator — re-exports ADMIN_SURFACES assembled from domain slices.
// Callers import from this file and are unaffected by the internal split.

import { INSPECT_SURFACES } from "./catalog/inspect.js";
import { AGENTS_APPLY_SURFACES } from "./catalog/agents-apply.js";
import { APPLY_REST_SURFACES } from "./catalog/apply-rest.js";

export const ADMIN_SURFACES = Object.freeze([
  ...INSPECT_SURFACES,
  ...AGENTS_APPLY_SURFACES,
  ...APPLY_REST_SURFACES,
]);
