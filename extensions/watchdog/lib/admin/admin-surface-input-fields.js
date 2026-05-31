// Aggregator — re-exports SURFACE_INPUT_FIELDS assembled from domain slices.
// Callers import from this file and are unaffected by the internal split.

import { AGENT_INPUT_FIELDS } from "./input-fields/agents.js";
import { AGENT_JOINS_INPUT_FIELDS } from "./input-fields/agent-joins.js";
import { AUTOMATION_GRAPH_INPUT_FIELDS } from "./input-fields/automation-graph.js";

export const SURFACE_INPUT_FIELDS = Object.freeze({
  ...AGENT_INPUT_FIELDS,
  ...AGENT_JOINS_INPUT_FIELDS,
  ...AUTOMATION_GRAPH_INPUT_FIELDS,
});
