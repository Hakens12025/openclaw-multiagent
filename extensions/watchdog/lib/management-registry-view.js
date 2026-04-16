import { listAdminSurfaces } from "./admin/admin-surface-registry.js";
import {
  findManagementActivityTargetSummary,
  normalizeManagementActivitySubjectSummary,
  normalizeManagementActivityTargetSummary,
} from "./admin/admin-change-set-management.js";
import {
  buildAgentDefaultsManagementTarget,
  buildAgentManagement,
  buildAgentManagementTarget,
  buildAgentJoinManagementTarget,
  buildAutomationManagementTarget,
  buildModelManagementTarget,
} from "./capability/capability-management-targets.js";
import { normalizeRecord, normalizeString } from "./core/normalize.js";

const MANAGEMENT_LABELS = Object.freeze({
  admin_change_set: "Admin Change Sets",
  admin_surface: "Admin Surfaces",
  agent: "Agent Instances",
  agent_defaults: "Agent Defaults",
  agent_join: "External Agent Joins",
  automation: "Automations",
  contract: "Contracts",
  model: "Models",
  platform: "Platform",
  runtime: "Runtime",
  system_action_delivery: "System-Action Deliveries",
  skill: "Skills",
  test: "Test Tools",
  test_run: "Test Runs",
});

const MANAGEMENT_SUMMARIES = Object.freeze({
  admin_change_set: "Typed admin drafts, previews, execution, and verification evidence.",
  admin_surface: "Current inspect/apply/verify management surface catalog.",
  agent: "Per-agent profile, runtime, and lifecycle management surfaces.",
  agent_defaults: "Global defaults injected into new or unconfigured agents.",
  agent_join: "Declarative join specs that describe how external agents map into the platform.",
  automation: "Long-running automation objectives, runtime state, and optional harness shaping.",
  contract: "Contract runtime snapshots and lifecycle inspection.",
  model: "Configured model catalog available to the platform.",
  platform: "Platform-level or uncategorized management surfaces.",
  runtime: "Runtime state, dispatch internals, and reset controls.",
  system_action_delivery: "Deferred delivery tickets owned by runtime and used for same-session system_action resume.",
  skill: "Installed skill catalog and bindings.",
  test: "Ad hoc test injection tools.",
  test_run: "Structured verification run catalog and execution.",
});

const MANAGEMENT_ORDER = Object.freeze([
  "agent",
  "agent_defaults",
  "agent_join",
  "automation",
  "runtime",
  "system_action_delivery",
  "test_run",
  "test",
  "contract",
  "skill",
  "model",
  "admin_change_set",
  "admin_surface",
  "platform",
]);

function compareById(a, b) {
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function getManagementOrder(kind) {
  const index = MANAGEMENT_ORDER.indexOf(kind);
  return index === -1 ? MANAGEMENT_ORDER.length : index;
}

function createManagementSurfaceRef(surface) {
  const subject = normalizeRecord(surface?.subject);
  return {
    id: normalizeString(surface?.id) || "unknown",
    stage: normalizeString(surface?.stage) || null,
    risk: normalizeString(surface?.risk) || null,
    method: normalizeString(surface?.method) || null,
    path: normalizeString(surface?.path) || null,
    operatorPhase: normalizeString(surface?.operatorPhase) || null,
    operatorExecutable: surface?.operatorExecutable === true,
    confirmation: normalizeString(surface?.confirmation) || null,
    status: normalizeString(surface?.status) || null,
    summary: normalizeString(surface?.summary) || null,
    executable: surface?.executable === true,
    verificationCapability: normalizeRecord(surface?.verificationCapability),
    subjectScope: normalizeString(subject.scope) || null,
    selectorKey: normalizeString(subject.selectorKey) || null,
    aspect: normalizeString(subject.aspect) || null,
  };
}

function finalizeManagementSubject(group, activity = null) {
  const inspectSurfaces = [...group.inspectSurfaces].sort(compareById);
  const applySurfaces = [...group.applySurfaces].sort(compareById);
  const verifySurfaces = [...group.verifySurfaces].sort(compareById);
  const managedAspects = applySurfaces.map((surface) => ({
    aspect: surface.aspect || surface.id,
    surfaceId: surface.id,
    risk: surface.risk,
    confirmation: surface.confirmation,
    executable: surface.executable === true,
    operatorExecutable: surface.operatorExecutable === true,
    verificationCapability: normalizeRecord(surface.verificationCapability),
    summary: surface.summary,
  }));

  return {
    kind: group.kind,
    label: MANAGEMENT_LABELS[group.kind] || group.kind,
    summary: MANAGEMENT_SUMMARIES[group.kind] || null,
    selectorKey: group.selectorKey,
    scopes: [...group.scopes].sort(),
    counts: {
      total: inspectSurfaces.length + applySurfaces.length + verifySurfaces.length,
      inspect: inspectSurfaces.length,
      apply: applySurfaces.length,
      verify: verifySurfaces.length,
      operatorExecutable: applySurfaces
        .filter((surface) => surface.operatorExecutable === true).length,
      executable: [...inspectSurfaces, ...applySurfaces, ...verifySurfaces]
        .filter((surface) => surface.executable === true).length,
      verificationSupported: applySurfaces
        .filter((surface) => surface.verificationCapability?.supported === true).length,
    },
    inspectSurfaces,
    applySurfaces,
    verifySurfaces,
    managedAspects,
    activity: normalizeManagementActivitySubjectSummary(activity || { kind: group.kind }),
  };
}

function buildManagementRegistrySkeleton(activity = null) {
  const groups = new Map();
  const subjectActivity = new Map(
    (Array.isArray(activity?.subjects) ? activity.subjects : [])
      .map((entry) => {
        const normalized = normalizeManagementActivitySubjectSummary(entry);
        return normalized.kind ? [normalized.kind, normalized] : null;
      })
      .filter(Boolean),
  );

  for (const surface of listAdminSurfaces()) {
    const subject = normalizeRecord(surface?.subject);
    const kind = normalizeString(subject.kind) || "platform";
    if (!groups.has(kind)) {
      groups.set(kind, {
        kind,
        selectorKey: normalizeString(subject.selectorKey) || null,
        scopes: new Set(),
        inspectSurfaces: [],
        applySurfaces: [],
        verifySurfaces: [],
      });
    }

    const group = groups.get(kind);
    if (!group.selectorKey) {
      group.selectorKey = normalizeString(subject.selectorKey) || null;
    }
    group.scopes.add(normalizeString(subject.scope) || "global");

    const surfaceRef = createManagementSurfaceRef(surface);
    if (surfaceRef.stage === "inspect") group.inspectSurfaces.push(surfaceRef);
    else if (surfaceRef.stage === "verify") group.verifySurfaces.push(surfaceRef);
    else group.applySurfaces.push(surfaceRef);
  }

  const subjects = [...groups.values()]
    .map((group) => finalizeManagementSubject(group, subjectActivity.get(group.kind)))
    .sort((a, b) => {
      const orderDiff = getManagementOrder(a.kind) - getManagementOrder(b.kind);
      return orderDiff !== 0 ? orderDiff : a.kind.localeCompare(b.kind);
    });

  return {
    subjects,
    activity: {
      targets: (Array.isArray(activity?.targets) ? activity.targets : [])
        .map(normalizeManagementActivityTargetSummary)
        .filter(Boolean),
      subjects: subjects.map((subject) => subject.activity),
    },
  };
}

export function buildManagementRegistry({
  activity = null,
  agents = [],
  agentJoins = [],
  models = [],
  automations = [],
  agentDefaults = { ok: true },
} = {}) {
  const baseManagement = buildManagementRegistrySkeleton(activity);
  const agentSubject = baseManagement.subjects.find((subject) => subject.kind === "agent") || null;
  const managedAgents = (Array.isArray(agents) ? agents : []).map((agent) => ({
    ...agent,
    management: buildAgentManagement(
      agent.id,
      agentSubject,
      findManagementActivityTargetSummary(activity, {
        subjectKind: "agent",
        selectorKey: "agentId",
        selectorValue: agent.id,
      }),
    ),
  }));

  const subjects = baseManagement.subjects.map((subject) => {
    if (subject.kind === "agent") {
      return {
        ...subject,
        targets: managedAgents.map((agent) => buildAgentManagementTarget(
          agent,
          subject,
          findManagementActivityTargetSummary(activity, {
            subjectKind: "agent",
            selectorKey: "agentId",
            selectorValue: agent.id,
          }),
        )),
      };
    }
    if (subject.kind === "model") {
      return {
        ...subject,
        targets: (Array.isArray(models) ? models : []).map((model) => buildModelManagementTarget(model)),
      };
    }
    if (subject.kind === "automation") {
      return {
        ...subject,
        targets: (Array.isArray(automations) ? automations : []).map((automation) => buildAutomationManagementTarget(
          automation,
          subject,
          findManagementActivityTargetSummary(activity, {
            subjectKind: "automation",
            selectorKey: "automationId",
            selectorValue: automation.id,
          }),
        )),
      };
    }
    if (subject.kind === "agent_join") {
      return {
        ...subject,
        targets: (Array.isArray(agentJoins) ? agentJoins : []).map((agentJoin) => buildAgentJoinManagementTarget(
          agentJoin,
          subject,
          findManagementActivityTargetSummary(activity, {
            subjectKind: "agent_join",
            selectorKey: "joinId",
            selectorValue: agentJoin.id,
          }),
        )),
      };
    }
    if (subject.kind === "agent_defaults") {
      return {
        ...subject,
        targets: [buildAgentDefaultsManagementTarget(agentDefaults)],
      };
    }
    return { ...subject };
  });

  return {
    agents: managedAgents,
    management: {
      ...baseManagement,
      subjects,
    },
  };
}
