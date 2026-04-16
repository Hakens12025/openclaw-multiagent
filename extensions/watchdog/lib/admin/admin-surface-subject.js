import { normalizeString } from "../core/normalize.js";

export function buildAdminSurfaceSubject(surface) {
  const surfaceId = normalizeString(surface?.id || surface) || "unknown";

  if (surfaceId === "operator.snapshot") {
    return { kind: "platform", scope: "global", selectorKey: null, aspect: "operator_snapshot" };
  }
  if (surfaceId === "agents.list") {
    return { kind: "agent", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId === "agents.discovery") {
    return { kind: "agent", scope: "catalog", selectorKey: null, aspect: "discovery" };
  }
  if (surfaceId === "agents.create") {
    return { kind: "agent", scope: "collection", selectorKey: "agentId", aspect: "create" };
  }
  if (surfaceId === "agents.defaults.read") {
    return { kind: "agent_defaults", scope: "global", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId.startsWith("agents.defaults.")) {
    return {
      kind: "agent_defaults",
      scope: "global",
      selectorKey: null,
      aspect: surfaceId.slice("agents.defaults.".length),
    };
  }
  if (surfaceId.startsWith("agents.")) {
    return {
      kind: "agent",
      scope: "instance",
      selectorKey: "agentId",
      aspect: surfaceId.slice("agents.".length),
    };
  }
  if (surfaceId === "skills.list") {
    return { kind: "skill", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId === "admin_surfaces.list") {
    return { kind: "admin_surface", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId.startsWith("admin_change_sets.")) {
    const aspect = surfaceId.slice("admin_change_sets.".length);
    return {
      kind: "admin_change_set",
      scope: aspect === "list" ? "catalog" : "instance",
      selectorKey: aspect === "list" ? null : "id",
      aspect: aspect === "list" ? "registry" : aspect,
    };
  }
  if (surfaceId === "work_items.list") {
    return { kind: "work_item", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId === "schedules.list") {
    return { kind: "schedule", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId === "automations.list") {
    return { kind: "automation", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId === "agent_joins.list") {
    return { kind: "agent_join", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId.startsWith("automations.")) {
    return {
      kind: "automation",
      scope: "instance",
      selectorKey: "automationId",
      aspect: surfaceId.slice("automations.".length),
    };
  }
  if (surfaceId.startsWith("agent_joins.")) {
    return {
      kind: "agent_join",
      scope: "instance",
      selectorKey: "joinId",
      aspect: surfaceId.slice("agent_joins.".length),
    };
  }
  if (surfaceId === "system_action_delivery_tickets.list") {
    return { kind: "system_action_delivery", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId === "runtime.read") {
    return { kind: "runtime", scope: "global", selectorKey: null, aspect: "summary" };
  }
  if (surfaceId === "runtime.reset") {
    return { kind: "runtime", scope: "global", selectorKey: null, aspect: "reset" };
  }
  if (surfaceId === "runtime.loop.start") {
    return {
      kind: "loop",
      scope: "instance",
      selectorKey: "loopId",
      aspect: "start",
    };
  }
  if (surfaceId === "runtime.loop.interrupt" || surfaceId === "runtime.loop.resume") {
    return {
      kind: "loop_session",
      scope: "instance",
      selectorKey: "loopId",
      aspect: surfaceId.slice("runtime.loop.".length),
    };
  }
  if (surfaceId === "graph.loop.repair") {
    return {
      kind: "loop",
      scope: "instance",
      selectorKey: "loopId",
      aspect: "repair",
    };
  }
  if (surfaceId.startsWith("graph.")) {
    return {
      kind: "graph",
      scope: "global",
      selectorKey: null,
      aspect: surfaceId.slice("graph.".length),
    };
  }
  if (surfaceId === "models.list") {
    return { kind: "model", scope: "catalog", selectorKey: null, aspect: "registry" };
  }
  if (surfaceId.startsWith("test_runs.")) {
    const aspect = surfaceId.slice("test_runs.".length);
    return {
      kind: "test_run",
      scope: aspect === "detail" ? "instance" : "catalog",
      selectorKey: aspect === "detail" ? "id" : null,
      aspect: aspect === "list" ? "registry" : aspect,
    };
  }
  if (surfaceId === "test.inject") {
    return { kind: "test", scope: "global", selectorKey: null, aspect: "inject" };
  }
  return {
    kind: "platform",
    scope: "global",
    selectorKey: null,
    aspect: surfaceId,
  };
}
