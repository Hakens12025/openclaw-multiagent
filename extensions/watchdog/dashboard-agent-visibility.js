export const PRIMARY_DASHBOARD_BRIDGE_AGENT_ID = "controller";

export function isFoldedGatewayBridgeRecord(agent) {
  if (!agent || typeof agent !== "object") return false;
  const agentId = typeof agent.id === "string" ? agent.id : null;
  if (!agentId || agentId === PRIMARY_DASHBOARD_BRIDGE_AGENT_ID) return false;
  if (agentId === "agent-for-kksl") return true;
  return agent.role === "bridge" && agent.gateway === true;
}

export function isRuntimeOperatorRecord(agent) {
  if (!agent || typeof agent !== "object") return false;
  const agentId = typeof agent.id === "string" ? agent.id.toLowerCase() : null;
  const role = typeof agent.role === "string" ? agent.role.toLowerCase() : null;
  return agentId === "operator"
    || role === "operator"
    || agent.operatorOnly === true
    || agent.systemControl === true;
}

export function isSystemControlSurfaceRecord(agent) {
  if (!agent || typeof agent !== "object") return false;
  const agentId = typeof agent.id === "string" ? agent.id.toLowerCase() : "";
  const role = typeof agent.role === "string" ? agent.role.toLowerCase() : "";
  const kind = typeof agent.kind === "string" ? agent.kind.toLowerCase() : "";
  const surface = typeof agent.surface === "string" ? agent.surface.toLowerCase() : "";
  const systemSurfaceIds = new Set(["harness", "cli-system", "automation"]);
  const systemSurfaceRoles = new Set(["harness", "cli-system", "automation"]);
  return systemSurfaceIds.has(agentId)
    || systemSurfaceRoles.has(role)
    || systemSurfaceRoles.has(kind)
    || systemSurfaceRoles.has(surface)
    || agent.harness === true
    || agent.cliSystem === true
    || agent.automation === true;
}

export function shouldDisplayDashboardAgentRecord(agent) {
  if (agent?.mainViewVisible === false) return false;
  if (isRuntimeOperatorRecord(agent)) return false;
  if (isSystemControlSurfaceRecord(agent)) return false;
  return !isFoldedGatewayBridgeRecord(agent);
}

export function filterDashboardAgentCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((agent) => shouldDisplayDashboardAgentRecord(agent));
}
