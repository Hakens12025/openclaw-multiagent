// Meta exports: UNSUPPORTED_VERIFICATION_SURFACES and SURFACE_DEFAULT_PAYLOADS.
// These are small, tightly related, and don't belong to any single domain slice.

export const UNSUPPORTED_VERIFICATION_SURFACES = new Set([
  "agents.defaults.model",
  "agents.defaults.heartbeat",
  "agents.defaults.skills",
  "graph.edge.add",
  "graph.edge.delete",
  "graph.loop.compose",
  "graph.loop.repair",
  "runtime.loop.start",
  "runtime.loop.interrupt",
  "runtime.loop.resume",
  "runtime.reset",
  "test_runs.start",
  "test.inject",
  "apply.chart_create",
  "apply.chart_move",
]);

export const SURFACE_DEFAULT_PAYLOADS = Object.freeze({
  "agents.create": {
    id: "",
    role: "agent",
  },
  "skills.create": {
    skillId: "",
    description: "",
  },
  "agents.defaults.skills": {
    skills: [],
  },
  "agents.model": {
    agentId: "",
  },
  "agents.heartbeat": {
    agentId: "",
  },
  "agents.policy": {
    agentId: "",
  },
  "agents.skills": {
    agentId: "",
    skills: [],
  },
  "agents.constraints": {
    agentId: "",
  },
  "agents.name": {
    agentId: "",
  },
  "agents.description": {
    agentId: "",
  },
  "agents.tools": {
    agentId: "",
  },
  "agents.card.formats": {
    agentId: "",
  },
  "agents.role": {
    agentId: "",
  },
  "graph.edge.add": {
    from: "",
    to: "",
  },
  "graph.edge.delete": {
    from: "",
    to: "",
  },
  "graph.loop.compose": {
    agents: [],
  },
  "graph.loop.repair": {},
  "runtime.loop.start": {
    requestedTask: "",
  },
  "runtime.loop.interrupt": {},
  "runtime.loop.resume": {},
  "test.inject": {
    message: "",
    source: "webui",
  },
  "agents.delete": {
    agentId: "",
  },
  "agents.hard_delete": {
    agentId: "",
  },
});
