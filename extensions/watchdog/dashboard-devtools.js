(function initDashboardDevtools() {
  const devtoolsModules = window.OpenClawDevtoolsModules || {};
  const VIEW_MODES = Object.freeze({
    TEST_RUNS: "test_runs",
    CHANGE_SETS: "change_sets",
    MANAGEMENT: "management",
  });

  const ROLE_FIELD_OPTIONS = Object.freeze([
    { value: "agent", label: "agent" },
    { value: "bridge", label: "bridge" },
    { value: "planner", label: "planner" },
    { value: "executor", label: "executor" },
    { value: "researcher", label: "researcher" },
    { value: "reviewer", label: "reviewer" },
  ]);

  const state = {
    viewMode: VIEW_MODES.CHANGE_SETS,
    presets: [],
    runs: [],
    activeRunId: null,
    selectedRunId: null,
    selectedRun: null,
    selectedCaseId: null,
    startingPresetId: null,
    changeSets: [],
    selectedDraftId: null,
    selectedDraft: null,
    selectedVerificationId: null,
    selectedExecutionId: null,
    adminSurfaceSummary: null,
    operatorSnapshot: null,
    agentRegistry: [],
    agentDefaults: null,
    skillRegistry: [],
    modelCatalog: [],
    systemActionDeliveryTickets: [],
    linkingVerification: false,
    executingDraftAction: null,
    composeSurfaceId: null,
    composeDraftId: null,
    composeTitle: "",
    composeSummary: "",
    composePayloadText: "{\n  \n}",
    composeFieldValues: {},
    capabilityRegistry: null,
    managementSubjects: [],
    selectedManagementKind: null,
    selectedManagementTargetId: null,
    creatingManagementDraftSurfaceId: null,
    savingDraft: false,
    loading: false,
  };

  function esc(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  }

  function tokenParam() {
    return encodeURIComponent(new URLSearchParams(window.location.search).get("token") || "");
  }

  async function requestJson(path, options) {
    const response = await fetch(path, options);
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  function formatTimestamp(ts) {
    if (!ts) return "--";
    try {
      return new Date(ts).toLocaleString("zh-CN");
    } catch {
      return "--";
    }
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "--";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value ?? "");
    }
  }

  function normalizeStatusClass(status) {
    const value = String(status || "").toLowerCase();
    if (value === "passed") return "pass";
    if (value === "verified" || value === "applied") return "pass";
    if (value === "failed") return "fail";
    if (value === "verification_failed") return "fail";
    if (value === "blocked" || value === "verification_blocked") return "blocked";
    if (value === "running" || value === "verifying") return "running";
    return value || "draft";
  }

  function cloneJsonValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function normalizeRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function normalizeStringList(value) {
    const values = Array.isArray(value)
      ? value
      : (typeof value === "string" ? value.split(/[\n,]+/g) : []);
    return [...new Set(values
      .map((item) => String(item ?? "").trim())
      .filter(Boolean))];
  }

  function normalizeOrderedStringList(value) {
    const values = Array.isArray(value)
      ? value
      : (typeof value === "string" ? value.split(/[\n,]+/g) : []);
    return values
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  function formatStringList(value) {
    return normalizeStringList(value).join("\n");
  }

  function formatOrderedStringList(value) {
    return normalizeOrderedStringList(value).join("\n");
  }

  function getManagementSubjects() {
    return Array.isArray(state.managementSubjects) ? state.managementSubjects : [];
  }

  function getSelectedManagementSubject() {
    return getManagementSubjects().find((subject) => subject.kind === state.selectedManagementKind)
      || getManagementSubjects()[0]
      || null;
  }

  function getManagementActivityRegistry() {
    const activity = state.capabilityRegistry?.management?.activity;
    return activity && typeof activity === "object"
      ? activity
      : { subjects: [], targets: [] };
  }

  function getManagementSubjectActivity(subjectOrKind) {
    const kind = typeof subjectOrKind === "string"
      ? subjectOrKind
      : subjectOrKind?.kind;
    if (!kind) return null;
    return (getManagementActivityRegistry().subjects || []).find((entry) => entry.kind === kind)
      || subjectOrKind?.activity
      || null;
  }

  function getManagementTargetActivity(subject, target) {
    if (!subject || !target) return null;
    const embeddedActivity = target?.snapshot?.management?.activity;
    if (embeddedActivity && (embeddedActivity.key || embeddedActivity.draftCount || embeddedActivity.lastActivityAt)) {
      return embeddedActivity;
    }

    const candidates = [
      target.composeAgentId,
      target.id,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const selectorKey = subject.selectorKey || null;
    const activities = Array.isArray(getManagementActivityRegistry().targets)
      ? getManagementActivityRegistry().targets
      : [];
    return activities.find((entry) => {
      if (entry.subjectKind !== subject.kind) return false;
      if (selectorKey) {
        if (entry.selectorKey !== selectorKey) return false;
        return candidates.includes(String(entry.selectorValue || "").trim());
      }
      return !entry.selectorKey && !entry.selectorValue;
    }) || null;
  }

  function buildManagementTargetEntries(subject) {
    if (Array.isArray(subject?.targets) && subject.targets.length) {
      return subject.targets.map((target) => ({
        ...target,
        snapshot: target?.snapshot && typeof target.snapshot === "object"
          ? cloneJsonValue(target.snapshot)
          : target?.snapshot,
      }));
    }

    const kind = subject?.kind;
    switch (kind) {
      case "agent":
        return state.agentRegistry.map((agent) => ({
          id: agent.id,
          label: agent.name || agent.id,
          meta: [
            agent.name && agent.name !== agent.id ? agent.id : null,
            agent.role || null,
            agent.model || null,
          ].filter(Boolean).join(" // "),
          detail: [
            agent.description || null,
            agent.gateway === true
              ? `gateway:${agent.ingressSource || "default"}`
              : "office",
            agent.protected === true ? "protected" : null,
            agent.specialized === true ? "specialized" : null,
          ].filter(Boolean).join(" // ") || null,
          description: agent.description || null,
          policies: agent.policies || agent.binding?.policies || null,
          policySummary: [
            agent.gateway === true
              ? `gateway:${agent.ingressSource || "default"}`
              : "office",
            agent.protected === true ? "protected" : null,
            agent.specialized === true ? "specialized" : null,
          ].filter(Boolean).join(" // "),
          composeAgentId: agent.id,
          snapshot: {
            id: agent.id,
            name: agent.name,
            role: agent.role,
            model: agent.model,
            configuredHeartbeatEvery: agent.configuredHeartbeatEvery,
            effectiveHeartbeatEvery: agent.effectiveHeartbeatEvery,
            constraints: agent.constraints,
            capabilities: agent.capabilities,
            configuredSkills: agent.configuredSkills,
            effectiveSkills: agent.effectiveSkills,
            gateway: agent.gateway === true,
            protected: agent.protected === true,
            ingressSource: agent.ingressSource || null,
            specialized: agent.specialized === true,
            policies: agent.policies || agent.binding?.policies || null,
            binding: agent.binding || null,
            management: agent.management,
          },
        }));
      case "agent_defaults":
        return [{
          id: "agent-defaults",
          label: "AGENT DEFAULTS",
          meta: [
            state.agentDefaults?.effectiveModelPrimary || "--",
            state.agentDefaults?.effectiveHeartbeatEvery || "--",
          ].join(" // "),
          detail: `${Array.isArray(state.agentDefaults?.configuredDefaultSkills) ? state.agentDefaults.configuredDefaultSkills.length : 0} configured default skills`,
          snapshot: {
            configuredModelPrimary: state.agentDefaults?.configuredModelPrimary,
            effectiveModelPrimary: state.agentDefaults?.effectiveModelPrimary,
            configuredHeartbeatEvery: state.agentDefaults?.configuredHeartbeatEvery,
            effectiveHeartbeatEvery: state.agentDefaults?.effectiveHeartbeatEvery,
            configuredDefaultSkills: state.agentDefaults?.configuredDefaultSkills,
            effectivePlatformDefaultSkills: state.agentDefaults?.effectivePlatformDefaultSkills,
            roleInjectedDefaultSkills: state.agentDefaults?.roleInjectedDefaultSkills,
          },
        }];
      case "runtime":
        return [{
          id: "runtime-control",
          label: "RUNTIME CONTROL",
          meta: `${subject?.counts?.inspect || 0} inspect // ${subject?.counts?.apply || 0} apply`,
          detail: "Global runtime read/reset surfaces live here.",
          snapshot: {
            counts: subject?.counts || null,
            inspectSurfaceIds: Array.isArray(subject?.inspectSurfaces) ? subject.inspectSurfaces.map((surface) => surface.id) : [],
            applySurfaceIds: Array.isArray(subject?.applySurfaces) ? subject.applySurfaces.map((surface) => surface.id) : [],
          },
        }];
      case "system_action_delivery":
        return state.systemActionDeliveryTickets.map((ticket) => ({
          id: ticket.id,
          label: ticket.id,
          meta: [
            ticket.status || "--",
            ticket.lane || ticket.intentType || "--",
            ticket.route?.targetAgent || ticket.route?.replyTo?.agentId || "--",
          ].join(" // "),
          detail: [
            ticket.source?.agentId || "--",
            ticket.source?.sessionKey || "--",
            ticket.source?.contractId || "--",
          ].join(" // "),
          snapshot: ticket,
        }));
      case "test_run":
        return state.runs.map((run) => ({
          id: run.id,
          label: run.label || run.id,
          meta: `${run.completedCases}/${run.totalCases} // ${run.status || "--"}`,
          detail: run.id,
          snapshot: run,
        }));
      case "test":
        return state.presets.map((preset) => ({
          id: preset.id,
          label: preset.label || preset.id,
          meta: preset.suite || preset.transport || "--",
          detail: preset.description || null,
          snapshot: preset,
        }));
      case "skill":
        return state.skillRegistry.map((skill) => ({
          id: skill.id,
          label: skill.id,
          meta: `${Array.isArray(skill.boundAgents) ? skill.boundAgents.length : 0} bound // ${skill.defaultEnabled ? "default" : "optional"}`,
          detail: skill.description || null,
          snapshot: skill,
        }));
      case "model":
        return state.modelCatalog.map((model) => ({
          id: model.id,
          label: model.id,
          meta: model.provider || "--",
          detail: model.family || null,
          snapshot: model,
        }));
      case "admin_change_set":
        return state.changeSets.map((draft) => ({
          id: draft.id,
          label: draft.title || draft.surfaceId || draft.id,
          meta: `${draft.surfaceId || "--"} // ${draft.status || "draft"}`,
          detail: `${draft.executionCount || 0} exec // ${draft.verificationCount || 0} evidence`,
          snapshot: draft,
        }));
      case "admin_surface":
        return (state.adminSurfaceSummary?.surfaces || []).map((surface) => ({
          id: surface.id,
          label: surface.id,
          meta: `${surface.stage || "--"} // ${surface.risk || "--"}`,
          detail: surface.summary || null,
          snapshot: surface,
        }));
      case "work_item":
        return [{
          id: "work-items",
          label: "WORK ITEM SNAPSHOT",
          meta: `${subject?.counts?.inspect || 0} inspect`,
          detail: "Lifecycle work item detail still lives in the main dashboard / work item lifecycle view.",
          snapshot: {
            counts: subject?.counts || null,
            inspectSurfaceIds: Array.isArray(subject?.inspectSurfaces) ? subject.inspectSurfaces.map((surface) => surface.id) : [],
          },
        }];
      default:
        return [];
    }
  }

  function getSelectedManagementTarget(subject = getSelectedManagementSubject()) {
    const targets = buildManagementTargetEntries(subject);
    return targets.find((target) => target.id === state.selectedManagementTargetId) || targets[0] || null;
  }

  function buildManagementSurfaceReadUrl(surface) {
    const path = String(surface?.path || "").trim();
    if (!path) return null;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}token=${tokenParam()}`;
  }

  function buildTokenizedPath(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return null;
    const separator = normalizedPath.includes("?") ? "&" : "?";
    return `${normalizedPath}${separator}token=${tokenParam()}`;
  }

  function openTokenizedPath(path) {
    const href = buildTokenizedPath(path);
    if (!href) return;
    window.open(href, "_blank", "noopener");
  }

  function getOperatorSnapshot() {
    return state.operatorSnapshot && typeof state.operatorSnapshot === "object"
      ? state.operatorSnapshot
      : null;
  }

  function getOperatorRecentDrafts() {
    const drafts = getOperatorSnapshot()?.changeSets?.recent;
    return Array.isArray(drafts) ? drafts : [];
  }

  function getOperatorWorkQueue() {
    const queue = getOperatorSnapshot()?.changeSets?.workQueue;
    return Array.isArray(queue) ? queue : [];
  }

  function getOperatorAttention() {
    const attention = getOperatorSnapshot()?.attention;
    return Array.isArray(attention) ? attention : [];
  }

  function getOperatorDraftSummaryById(draftId) {
    const normalizedId = String(draftId || "").trim();
    if (!normalizedId) return null;
    return getOperatorRecentDrafts().find((draft) => draft.id === normalizedId)
      || state.changeSets.find((draft) => draft.id === normalizedId)
      || null;
  }

  function getOperatorSelectedDraftSummary() {
    if (!state.selectedDraftId) return null;
    return getOperatorDraftSummaryById(state.selectedDraftId);
  }

  function getDraftVerificationRunConfig(draft = state.selectedDraft) {
    if (!draft || typeof draft !== "object") return null;
    const verificationRun = normalizeRecord(draft?.verificationPlan?.verificationRun);
    const executionHistory = Array.isArray(draft?.executionHistory) ? draft.executionHistory : [];
    const selectedExecution = executionHistory.find((item) => item.id === state.selectedExecutionId)
      || executionHistory[0]
      || null;
    const presetId = String(verificationRun.presetId || "").trim();
    const cleanMode = String(verificationRun.cleanMode || "").trim() || "session-clean";
    return {
      draftId: draft.id || null,
      surfaceId: draft.surfaceId || null,
      title: draft.title || draft.surfaceId || draft.id || null,
      supported: verificationRun.supported !== false,
      enabled: verificationRun.enabled !== false,
      presetId: presetId || null,
      cleanMode,
      executionId: selectedExecution?.id || null,
      executionStatus: selectedExecution?.executionStatus || selectedExecution?.status || null,
    };
  }

  function getRunSummaryById(runId) {
    const normalizedId = String(runId || "").trim();
    if (!normalizedId) return null;
    return state.runs.find((run) => run.id === normalizedId) || null;
  }

  function openDraftInChangeSets(draftId) {
    selectViewMode(VIEW_MODES.CHANGE_SETS);
    if (draftId) {
      selectDraft(draftId);
      return;
    }
    renderDevtools();
  }

  function openRunInTestRuns(runId) {
    selectViewMode(VIEW_MODES.TEST_RUNS);
    if (runId) {
      selectRun(runId);
      return;
    }
    renderDevtools();
  }

  function openOperatorRecommendedAction(action) {
    if (!action || typeof action !== "object") return;
    if (action.targetDraftId) {
      if (state.selectedDraftId !== action.targetDraftId || !state.selectedDraft) {
        selectDraft(action.targetDraftId);
      } else {
        state.selectedDraftId = action.targetDraftId;
      }
    }
    if (action.nextSurfaceId === "admin_change_sets.detail") {
      openDraftInChangeSets(action.targetDraftId);
      return;
    }
    if (action.nextSurfaceId === "admin_change_sets.preview" && action.nextMethod === "GET" && action.nextPath) {
      openDraftInChangeSets(action.targetDraftId);
      openTokenizedPath(action.nextPath);
      return;
    }
    if (String(action.nextSurfaceId || "").startsWith("admin_change_sets.")) {
      openDraftInChangeSets(action.targetDraftId);
      return;
    }
    if (String(action.nextSurfaceId || "").startsWith("test_runs.")) {
      openRunInTestRuns(action.targetRunId);
      return;
    }
    if (action.nextMethod === "GET" && action.nextPath) {
      openTokenizedPath(action.nextPath);
      renderDevtools();
      return;
    }
    renderDevtools();
  }

  function getAdminSurfaceEntry(surfaceId) {
    return (state.adminSurfaceSummary?.surfaces || []).find((surface) => surface.id === surfaceId) || null;
  }

  function getManagementSubjectByKind(kind) {
    return getManagementSubjects().find((subject) => subject.kind === kind) || null;
  }

  function getManagementTargetForSubject(subject, {
    payload = null,
    preferredTargetId = null,
  } = {}) {
    const targets = buildManagementTargetEntries(subject);
    if (!targets.length) return null;
    if (subject?.kind === "agent") {
      const agentId = String(payload?.agentId || "").trim();
      return targets.find((target) => target.composeAgentId === agentId || target.id === agentId)
        || targets.find((target) => target.id === preferredTargetId)
        || targets[0]
        || null;
    }
    return targets.find((target) => target.id === preferredTargetId) || targets[0] || null;
  }

  function deriveManagementContext(surfaceId, payload = null, {
    preferredKind = null,
    preferredTargetId = null,
  } = {}) {
    const surface = getAdminSurfaceEntry(surfaceId) || findAuthoringSurface(surfaceId);
    const subjectKind = preferredKind || surface?.subject?.kind || null;
    if (!subjectKind) return null;

    const subject = getManagementSubjectByKind(subjectKind);
    const target = getManagementTargetForSubject(subject, { payload, preferredTargetId });
    return {
      subjectKind,
      subjectLabel: subject?.label || subjectKind,
      subjectSummary: subject?.summary || null,
      targetId: target?.id || null,
      targetLabel: target?.label || null,
      targetMeta: target?.meta || target?.detail || null,
      targetComposeAgentId: target?.composeAgentId || null,
      surfaceId: surface?.id || surfaceId || null,
      surfaceSummary: surface?.summary || surface?.id || null,
      selectorKey: subject?.selectorKey || surface?.subject?.selectorKey || null,
    };
  }

  function normalizeManagementContextForUi(context) {
    if (!context || typeof context !== "object") return null;
    const subjectKind = String(context.subjectKind || "").trim();
    if (!subjectKind) return null;
    const subject = getManagementSubjectByKind(subjectKind);
    const targets = buildManagementTargetEntries(subject);
    const selectorValue = String(context.selectorValue || context.targetRef?.value || "").trim();
    const target = targets.find((item) => item.id === selectorValue || item.composeAgentId === selectorValue)
      || targets.find((item) => item.id === context.targetId)
      || null;

    return {
      subjectKind,
      subjectLabel: subject?.label || subjectKind,
      subjectSummary: subject?.summary || null,
      targetId: target?.id || selectorValue || null,
      targetLabel: target?.label || selectorValue || null,
      targetMeta: target?.meta || target?.detail || null,
      targetComposeAgentId: target?.composeAgentId || selectorValue || null,
      surfaceId: String(context.surfaceId || "").trim() || null,
      surfaceSummary: getAdminSurfaceEntry(context.surfaceId)?.summary || null,
      selectorKey: String(context.selectorKey || context.targetRef?.key || "").trim() || null,
    };
  }

  function getDraftPayload(draft) {
    return draft?.changeSet?.payload && typeof draft.changeSet.payload === "object"
      ? draft.changeSet.payload
      : {};
  }

  function buildComposerPayloadSnapshot(surface) {
    const fallbackPayload = state.composeFieldValues?.agentId
      ? { agentId: state.composeFieldValues.agentId }
      : {};
    try {
      const parsed = parseJsonInput(state.composePayloadText || "{}", "Payload");
      return applyComposeFieldValuesToPayload(surface, parsed, state.composeFieldValues);
    } catch {
      return applyComposeFieldValuesToPayload(surface, fallbackPayload, state.composeFieldValues);
    }
  }

  function getComposerManagementContext() {
    const surface = findAuthoringSurface(state.composeSurfaceId);
    if (!surface) return null;
    return deriveManagementContext(surface.id, buildComposerPayloadSnapshot(surface), {
      preferredKind: state.selectedManagementKind,
      preferredTargetId: state.selectedManagementTargetId,
    });
  }

  function resolveDraftManagementContext(draft, {
    preferCurrentSelection = true,
  } = {}) {
    if (!draft) return null;
    const normalized = normalizeManagementContextForUi(draft.managementContext);
    if (normalized) return normalized;
    return deriveManagementContext(draft.surfaceId, getDraftPayload(draft), {
      preferredKind: preferCurrentSelection ? state.selectedManagementKind : null,
      preferredTargetId: preferCurrentSelection ? state.selectedManagementTargetId : null,
    });
  }

  function getSelectedDraftManagementContext() {
    return resolveDraftManagementContext(state.selectedDraft, {
      preferCurrentSelection: true,
    });
  }

  function syncManagementSelectionFromContext(context) {
    if (!context?.subjectKind) return;
    const subject = getManagementSubjectByKind(context.subjectKind);
    if (!subject) return;
    state.selectedManagementKind = subject.kind;
    const targets = buildManagementTargetEntries(subject);
    if (!targets.length) {
      state.selectedManagementTargetId = null;
      return;
    }
    const target = targets.find((item) => item.id === context.targetId)
      || targets.find((item) => item.composeAgentId === context.targetComposeAgentId)
      || targets[0]
      || null;
    state.selectedManagementTargetId = target?.id || null;
  }

  function getSurfaceInputFields(surface) {
    return Array.isArray(surface?.changeSetTemplate?.inputFields)
      ? surface.changeSetTemplate.inputFields
      : [];
  }

  function getSurfacePayloadTemplate(surface) {
    const payload = surface?.changeSetTemplate?.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? cloneJsonValue(payload)
      : {};
  }

  function getValueAtPath(source, path) {
    if (!source || typeof source !== "object" || !path) return undefined;
    let current = source;
    for (const segment of String(path).split(".").filter(Boolean)) {
      if (!current || typeof current !== "object" || !(segment in current)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }

  function setValueAtPath(target, path, value) {
    const segments = String(path).split(".").filter(Boolean);
    if (!segments.length) return;
    let current = target;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) {
        current[segment] = {};
      }
      current = current[segment];
    }
    current[segments[segments.length - 1]] = value;
  }

  function deleteValueAtPath(target, path) {
    const segments = String(path).split(".").filter(Boolean);
    if (!segments.length || !target || typeof target !== "object") return;
    const parents = [];
    let current = target;
    for (const segment of segments) {
      if (!current || typeof current !== "object" || !(segment in current)) return;
      parents.push([current, segment]);
      current = current[segment];
    }
    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const [parent, key] = parents[index];
      delete parent[key];
      if (Object.keys(parent).length > 0) break;
    }
  }

  function getFieldOptions(field) {
    if (Array.isArray(field?.options)) {
      return field.options;
    }
    switch (field?.optionsSource) {
      case "roles":
        return ROLE_FIELD_OPTIONS;
      case "agents":
        return state.agentRegistry.map((agent) => ({
          value: agent.id,
          label: agent.name || agent.id,
          detail: [
            agent.name && agent.name !== agent.id ? agent.id : null,
            agent.role || null,
          ].filter(Boolean).join(" · ") || null,
        }));
      case "skills":
        return state.skillRegistry.map((skill) => ({
          value: skill.id,
          label: skill.id,
          detail: skill.description || null,
        }));
      case "models":
        return state.modelCatalog.map((model) => ({
          value: model.id,
          label: model.id,
          detail: model.provider || null,
        }));
      default:
        return [];
    }
  }

  function getFieldLookupPaths(field) {
    return [
      field?.path,
      field?.key,
      ...(Array.isArray(field?.aliases) ? field.aliases : []),
      ...(Array.isArray(field?.fallbackPaths) ? field.fallbackPaths : []),
    ].filter(Boolean);
  }

  function resolvePayloadFieldValue(payload, field) {
    for (const path of getFieldLookupPaths(field)) {
      const value = getValueAtPath(payload, path);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function normalizeFieldValueForState(field, payloadValue) {
    if (field?.type === "checkbox_group") {
      if (Array.isArray(payloadValue)) {
        return payloadValue.map((value) => String(value || "").trim()).filter(Boolean);
      }
      if (typeof payloadValue === "string") {
        return payloadValue.split(/[\n,]+/g).map((value) => value.trim()).filter(Boolean);
      }
      return Array.isArray(field?.defaultValue) ? [...field.defaultValue] : [];
    }

    if (field?.valueType === "ordered_string_list") {
      return formatOrderedStringList(payloadValue);
    }

    if (field?.valueType === "string_list") {
      return formatStringList(payloadValue);
    }

    if (field?.valueType === "boolean_token") {
      if (payloadValue === null) return "default";
      if (payloadValue === true) return "true";
      if (payloadValue === false) return "false";
      const normalized = String(payloadValue ?? "").trim().toLowerCase();
      if (!normalized && field?.defaultValue !== undefined) return String(field.defaultValue);
      return normalized;
    }

    if (payloadValue === undefined || payloadValue === null || payloadValue === "") {
      if (field?.defaultValue !== undefined) return String(field.defaultValue);
      return "";
    }
    return String(payloadValue);
  }

  function buildComposeFieldValues(surface, payload) {
    const fields = getSurfaceInputFields(surface);
    const values = {};
    for (const field of fields) {
      values[field.key] = normalizeFieldValueForState(field, resolvePayloadFieldValue(payload, field));
    }
    return values;
  }

  function coerceFieldValueForPayload(field, rawValue) {
    if (field?.type === "checkbox_group") {
      return Array.isArray(rawValue)
        ? rawValue.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
    }

    if (field?.valueType === "ordered_string_list") {
      const normalized = formatOrderedStringList(rawValue);
      return normalized || undefined;
    }

    if (field?.valueType === "string_list") {
      const normalized = formatStringList(rawValue);
      return normalized || undefined;
    }

    if (field?.valueType === "boolean_token") {
      const normalized = String(rawValue ?? "").trim().toLowerCase();
      if (!normalized) return undefined;
      if (normalized === "default") return null;
      if (normalized === "true") return true;
      if (normalized === "false") return false;
      return normalized;
    }

    const normalized = String(rawValue ?? "").trim();
    if (!normalized) return undefined;
    return normalized;
  }

  function applyComposeFieldValuesToPayload(surface, payload, fieldValues = state.composeFieldValues) {
    const nextPayload = payload && typeof payload === "object" && !Array.isArray(payload)
      ? cloneJsonValue(payload)
      : {};
    for (const field of getSurfaceInputFields(surface)) {
      const targetPath = field.path || field.key;
      deleteValueAtPath(nextPayload, targetPath);
      for (const alias of Array.isArray(field.aliases) ? field.aliases : []) {
        deleteValueAtPath(nextPayload, alias);
      }
      for (const fallbackPath of Array.isArray(field.fallbackPaths) ? field.fallbackPaths : []) {
        deleteValueAtPath(nextPayload, fallbackPath);
      }
      const nextValue = coerceFieldValueForPayload(field, fieldValues[field.key]);
      if (nextValue !== undefined) {
        setValueAtPath(nextPayload, targetPath, nextValue);
      }
    }
    return nextPayload;
  }

  function syncComposePayloadTextFromFields() {
    const surface = findAuthoringSurface(state.composeSurfaceId);
    if (!surface) return;
    let basePayload = getSurfacePayloadTemplate(surface);
    try {
      basePayload = parseJsonInput(state.composePayloadText || "{}", "Payload");
    } catch {}
    const nextPayload = applyComposeFieldValuesToPayload(surface, basePayload, state.composeFieldValues);
    state.composePayloadText = formatJson(nextPayload);
    const payloadInput = document.getElementById("composePayloadInput");
    if (payloadInput) {
      payloadInput.value = state.composePayloadText;
    }
  }

  function syncComposeFieldsFromPayloadText() {
    const surface = findAuthoringSurface(state.composeSurfaceId);
    if (!surface) {
      state.composeFieldValues = {};
      return true;
    }
    try {
      const payload = parseJsonInput(state.composePayloadText || "{}", "Payload");
      state.composeFieldValues = buildComposeFieldValues(surface, payload);
      return true;
    } catch {
      return false;
    }
  }

  function renderDetailCard(label, value, tag = "DETAIL") {
    if (!value) return "";
    return `
      <div class="devtool-detail-card">
        <div class="devtool-detail-head">
          <span>${esc(label)}</span>
          <strong>${esc(tag)}</strong>
        </div>
        <pre class="devtool-report">${esc(formatJson(value))}</pre>
      </div>
    `;
  }

  function chooseDefaultCase(run) {
    const cases = Array.isArray(run?.caseResults) ? run.caseResults : [];
    if (!cases.length) return null;
    const failed = cases.find((item) => item.pass !== true && item.blocked !== true);
    if (failed?.id) return failed.id;
    const blocked = cases.find((item) => item.blocked === true);
    if (blocked?.id) return blocked.id;
    return cases[0]?.id || null;
  }

  function chooseDefaultVerification(draft) {
    return Array.isArray(draft?.verificationHistory) && draft.verificationHistory.length
      ? draft.verificationHistory[0].id
      : null;
  }

  function chooseDefaultExecution(draft) {
    return Array.isArray(draft?.executionHistory) && draft.executionHistory.length
      ? draft.executionHistory[0].id
      : null;
  }

  function getAuthoringSurfaces() {
    return (state.adminSurfaceSummary?.surfaces || []).filter((surface) => (
      surface.stage !== "inspect"
      && surface.status === "active"
      && !String(surface.id || "").startsWith("admin_change_sets.")
    ));
  }

  function findAuthoringSurface(surfaceId) {
    return getAuthoringSurfaces().find((surface) => surface.id === surfaceId) || null;
  }

  function buildDefaultComposeTitle(surface) {
    return surface?.summary || surface?.id || "";
  }

  function getAgentRegistryEntry(agentId) {
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) return null;
    return state.agentRegistry.find((agent) => agent.id === normalizedAgentId) || null;
  }

  function getComposeTargetAgentId(surface, { agentIdHint = null } = {}) {
    const fields = getSurfaceInputFields(surface);
    if (!fields.some((field) => field.key === "agentId")) {
      return null;
    }
    const candidates = [
      agentIdHint,
      state.composeFieldValues?.agentId,
      state.selectedDraft?.changeSet?.payload?.agentId,
      state.agentRegistry[0]?.id,
    ];
    for (const candidate of candidates) {
      const agent = getAgentRegistryEntry(candidate);
      if (agent) return agent.id;
    }
    return null;
  }

  function getPreferredLoopPayload() {
    const activeSession = state.operatorSnapshot?.loops?.activeSession || null;
    const latestSession = Array.isArray(state.operatorSnapshot?.loops?.sessions)
      ? state.operatorSnapshot.loops.sessions[0] || null
      : null;
    const firstRegisteredLoop = Array.isArray(state.operatorSnapshot?.loops?.registered)
      ? state.operatorSnapshot.loops.registered[0] || null
      : null;
    return {
      loopId: activeSession?.loopId || latestSession?.loopId || firstRegisteredLoop?.id || "",
      startStage: latestSession?.currentStage || firstRegisteredLoop?.entryAgentId || "",
    };
  }

  function buildPrefilledComposePayload(surface, { agentIdHint = null } = {}) {
    const payload = getSurfacePayloadTemplate(surface);
    const agent = getAgentRegistryEntry(getComposeTargetAgentId(surface, { agentIdHint }));
    const defaults = state.agentDefaults && typeof state.agentDefaults === "object"
      ? state.agentDefaults
      : {};

    switch (surface?.id) {
      case "agents.create":
        if (!payload.role) payload.role = "agent";
        if (!payload.model && defaults.effectiveModelPrimary) {
          payload.model = defaults.effectiveModelPrimary;
        }
        return payload;
      case "agents.defaults.model":
        if (defaults.configuredModelPrimary || defaults.effectiveModelPrimary) {
          payload.model = defaults.configuredModelPrimary || defaults.effectiveModelPrimary;
        }
        return payload;
      case "agents.defaults.heartbeat":
        if (defaults.configuredHeartbeatEvery || defaults.effectiveHeartbeatEvery) {
          payload.every = defaults.configuredHeartbeatEvery || defaults.effectiveHeartbeatEvery;
        }
        return payload;
      case "agents.defaults.skills":
        payload.skills = Array.isArray(defaults.configuredDefaultSkills)
          ? [...defaults.configuredDefaultSkills]
          : [];
        return payload;
      case "agents.model":
        if (agent) {
          payload.agentId = agent.id;
          payload.model = agent.model || defaults.effectiveModelPrimary || "";
        }
        return payload;
      case "agents.heartbeat":
        if (agent) {
          payload.agentId = agent.id;
          payload.every = agent.configuredHeartbeatEvery || agent.effectiveHeartbeatEvery || "";
        }
        return payload;
      case "agents.policy":
        if (agent) {
          payload.agentId = agent.id;
          const policies = agent.policies && typeof agent.policies === "object"
            ? agent.policies
            : (agent.binding?.policies && typeof agent.binding.policies === "object" ? agent.binding.policies : {});
          if ("gateway" in policies) payload.gateway = policies.gateway;
          if ("protected" in policies) payload.protected = policies.protected;
          if ("ingressSource" in policies) payload.ingressSource = policies.ingressSource;
          if ("specialized" in policies) payload.specialized = policies.specialized;
        }
        return payload;
      case "agents.role":
        if (agent) {
          payload.agentId = agent.id;
          payload.role = agent.role || "";
        }
        return payload;
      case "agents.skills":
        if (agent) {
          payload.agentId = agent.id;
          payload.skills = Array.isArray(agent.configuredSkills) ? [...agent.configuredSkills] : [];
        }
        return payload;
      case "agents.constraints":
        if (agent) {
          payload.agentId = agent.id;
          const constraints = agent.constraints && typeof agent.constraints === "object"
            ? agent.constraints
            : {};
          if ("serialExecution" in constraints) payload.serialExecution = constraints.serialExecution;
          if ("maxConcurrent" in constraints) payload.maxConcurrent = constraints.maxConcurrent;
          if ("timeoutSeconds" in constraints) payload.timeoutSeconds = constraints.timeoutSeconds;
          if ("maxRetry" in constraints) payload.maxRetry = constraints.maxRetry;
        }
        return payload;
      case "agents.name":
        if (agent) {
          payload.agentId = agent.id;
          payload.name = agent.name || agent.id;
        }
        return payload;
      case "agents.description":
        if (agent) {
          payload.agentId = agent.id;
          payload.description = agent.description || "";
        }
        return payload;
      case "agents.card.tools":
        if (agent) {
          payload.agentId = agent.id;
          payload.toolsText = formatStringList(agent.capabilities?.tools);
        }
        return payload;
      case "agents.card.formats":
        if (agent) {
          payload.agentId = agent.id;
          payload.inputFormatsText = formatStringList(agent.capabilities?.inputFormats);
          payload.outputFormatsText = formatStringList(agent.capabilities?.outputFormats);
        }
        return payload;
      case "agents.delete":
        if (agent) {
          payload.agentId = agent.id;
        }
        return payload;
      case "agents.hard_delete":
        if (agent) {
          payload.agentId = agent.id;
        }
        return payload;
      case "graph.loop.repair": {
        const loop = getPreferredLoopPayload();
        if (loop.loopId) {
          payload.loopId = loop.loopId;
        }
        return payload;
      }
      case "runtime.loop.interrupt": {
        const loop = getPreferredLoopPayload();
        if (loop.loopId) {
          payload.loopId = loop.loopId;
        }
        return payload;
      }
      case "runtime.loop.resume": {
        const loop = getPreferredLoopPayload();
        if (loop.loopId) {
          payload.loopId = loop.loopId;
        }
        if (loop.startStage) {
          payload.startStage = loop.startStage;
        }
        return payload;
      }
      default:
        return payload;
    }
  }

  function refillComposerForCurrentTarget(surface, { agentIdHint = null } = {}) {
    if (!surface) return;
    const payload = buildPrefilledComposePayload(surface, { agentIdHint });
    state.composeFieldValues = buildComposeFieldValues(surface, payload);
    state.composePayloadText = formatJson(applyComposeFieldValuesToPayload(surface, payload, state.composeFieldValues));
  }

  function resetComposerForSurface(surfaceId, { agentIdHint = null } = {}) {
    const surface = findAuthoringSurface(surfaceId) || getAuthoringSurfaces()[0] || null;
    const payload = buildPrefilledComposePayload(surface, {
      agentIdHint: agentIdHint || state.composeFieldValues?.agentId,
    });
    state.composeDraftId = null;
    state.composeSurfaceId = surface?.id || null;
    state.composeTitle = buildDefaultComposeTitle(surface);
    state.composeSummary = "";
    state.composeFieldValues = buildComposeFieldValues(surface, payload);
    state.composePayloadText = formatJson(applyComposeFieldValuesToPayload(surface, payload, state.composeFieldValues));
  }

  function loadComposerFromDraft(draft) {
    if (!draft) return;
    const surface = findAuthoringSurface(draft.surfaceId) || null;
    const payload = draft.changeSet?.payload && typeof draft.changeSet.payload === "object"
      ? draft.changeSet.payload
      : {};
    state.composeDraftId = draft.id || null;
    state.composeSurfaceId = draft.surfaceId || state.composeSurfaceId;
    state.composeTitle = draft.title || "";
    state.composeSummary = draft.summary || "";
    state.composeFieldValues = buildComposeFieldValues(surface, payload);
    state.composePayloadText = formatJson(applyComposeFieldValuesToPayload(surface, payload, state.composeFieldValues));
  }

  function ensureComposeSurfaceSelection() {
    const surfaces = getAuthoringSurfaces();
    if (!surfaces.length) {
      state.composeSurfaceId = null;
      return;
    }
    if (state.composeSurfaceId && surfaces.some((surface) => surface.id === state.composeSurfaceId)) {
      return;
    }
    if (state.selectedDraft?.surfaceId && surfaces.some((surface) => surface.id === state.selectedDraft.surfaceId)) {
      resetComposerForSurface(state.selectedDraft.surfaceId);
      return;
    }
    resetComposerForSurface(surfaces[0].id);
  }

  function syncComposerInputsToState() {
    const surfaceSelect = document.getElementById("composeSurfaceSelect");
    const titleInput = document.getElementById("composeTitleInput");
    const summaryInput = document.getElementById("composeSummaryInput");
    const payloadInput = document.getElementById("composePayloadInput");
    if (surfaceSelect) state.composeSurfaceId = surfaceSelect.value || null;
    if (titleInput) state.composeTitle = titleInput.value;
    if (summaryInput) state.composeSummary = summaryInput.value;
    if (payloadInput) state.composePayloadText = payloadInput.value;
    const surface = findAuthoringSurface(state.composeSurfaceId);
    for (const field of getSurfaceInputFields(surface)) {
      state.composeFieldValues[field.key] = changeSetView.readComposeFieldValue(field);
    }
  }

  function parseJsonInput(text, label) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${label} JSON invalid: ${error.message}`);
    }
  }

  function resolvePreferredRunId(draftId = state.selectedDraftId) {
    const normalizedDraftId = String(draftId || "").trim();
    const currentRun = state.runs.find((item) => item.id === state.selectedRunId) || null;
    if (currentRun && (!normalizedDraftId || currentRun.originDraftId === normalizedDraftId)) {
      return currentRun.id;
    }
    if (normalizedDraftId) {
      const relatedRuns = state.runs
        .filter((run) => run.originDraftId === normalizedDraftId)
        .sort((left, right) => {
          const leftActive = left.id === state.activeRunId;
          const rightActive = right.id === state.activeRunId;
          if (leftActive !== rightActive) return leftActive ? -1 : 1;
          return (Number(right.startedAt) || Number(right.finishedAt) || 0)
            - (Number(left.startedAt) || Number(left.finishedAt) || 0);
        });
      if (relatedRuns.length) {
        return relatedRuns[0].id;
      }
    }
    if (state.activeRunId && state.runs.some((item) => item.id === state.activeRunId)) {
      return state.activeRunId;
    }
    return state.runs[0]?.id || null;
  }

  function ensureRunSelection() {
    const candidateIds = new Set(state.runs.map((item) => item.id));
    const preferredRunId = resolvePreferredRunId();
    if (preferredRunId && candidateIds.has(preferredRunId)) {
      state.selectedRunId = preferredRunId;
      return;
    }
    if (state.selectedRunId && candidateIds.has(state.selectedRunId)) return;
    state.selectedRunId = state.activeRunId || state.runs[0]?.id || null;
  }

  function ensureDraftSelection() {
    const candidateIds = new Set(state.changeSets.map((item) => item.id));
    if (state.selectedDraftId && candidateIds.has(state.selectedDraftId)) return;
    state.selectedDraftId = state.changeSets[0]?.id || null;
  }

  function ensureManagementSelection() {
    const subjects = getManagementSubjects();
    const subjectKinds = new Set(subjects.map((subject) => subject.kind));
    if (!state.selectedManagementKind || !subjectKinds.has(state.selectedManagementKind)) {
      state.selectedManagementKind = subjects[0]?.kind || null;
    }

    const selectedSubject = getSelectedManagementSubject();
    const targets = buildManagementTargetEntries(selectedSubject);
    const targetIds = new Set(targets.map((target) => target.id));
    if (!state.selectedManagementTargetId || !targetIds.has(state.selectedManagementTargetId)) {
      state.selectedManagementTargetId = targets[0]?.id || null;
    }
  }

  async function loadSelectedRun() {
    if (!state.selectedRunId) {
      state.selectedRun = null;
      state.selectedCaseId = null;
      return;
    }
    state.selectedRun = await requestJson(`/watchdog/test-runs/detail?token=${tokenParam()}&id=${encodeURIComponent(state.selectedRunId)}`);
    if (
      state.selectedRun?.originDraftId
      && state.selectedRun.originDraftId !== state.selectedDraftId
      && state.changeSets.some((item) => item.id === state.selectedRun.originDraftId)
    ) {
      state.selectedDraftId = state.selectedRun.originDraftId;
      state.selectedVerificationId = null;
      state.selectedExecutionId = null;
      await loadSelectedDraft();
    }
    const caseIds = new Set((state.selectedRun.caseResults || []).map((item) => item.id));
    if (!state.selectedCaseId || !caseIds.has(state.selectedCaseId)) {
      state.selectedCaseId = chooseDefaultCase(state.selectedRun);
    }
  }

  async function loadSelectedDraft() {
    if (!state.selectedDraftId) {
      state.selectedDraft = null;
      state.selectedVerificationId = null;
      state.selectedExecutionId = null;
      return;
    }
    const payload = await requestJson(`/watchdog/admin-change-sets/detail?token=${tokenParam()}&id=${encodeURIComponent(state.selectedDraftId)}`);
    state.selectedDraft = payload?.draft || null;
    syncManagementSelectionFromContext(resolveDraftManagementContext(state.selectedDraft, {
      preferCurrentSelection: false,
    }));
    const verificationIds = new Set((state.selectedDraft?.verificationHistory || []).map((item) => item.id));
    if (!state.selectedVerificationId || !verificationIds.has(state.selectedVerificationId)) {
      state.selectedVerificationId = chooseDefaultVerification(state.selectedDraft);
    }
    const executionIds = new Set((state.selectedDraft?.executionHistory || []).map((item) => item.id));
    if (!state.selectedExecutionId || !executionIds.has(state.selectedExecutionId)) {
      state.selectedExecutionId = chooseDefaultExecution(state.selectedDraft);
    }
  }

  async function refreshDevtools() {
    if (state.loading) return;
    state.loading = true;
    try {
      const [operatorSnapshotPayload, testRunsPayload, draftPayload, surfacePayload, capabilityPayload, defaultsPayload, modelsPayload, deliveryTicketPayload] = await Promise.all([
        requestJson(`/watchdog/operator-snapshot?token=${tokenParam()}&limit=8`),
        requestJson(`/watchdog/test-runs?token=${tokenParam()}`),
        requestJson(`/watchdog/admin-change-sets?token=${tokenParam()}`),
        requestJson(`/watchdog/admin-surfaces?token=${tokenParam()}&includeTemplates=1`),
        requestJson(`/watchdog/capability-registry?token=${tokenParam()}`),
        requestJson(`/watchdog/agents/defaults?token=${tokenParam()}`),
        requestJson(`/watchdog/models?token=${tokenParam()}`),
        requestJson(`/watchdog/system-action-delivery-tickets?token=${tokenParam()}`),
      ]);

      state.operatorSnapshot = operatorSnapshotPayload && typeof operatorSnapshotPayload === "object"
        ? operatorSnapshotPayload
        : null;
      state.presets = testRunsPayload.presets || [];
      state.runs = testRunsPayload.runs || [];
      state.activeRunId = testRunsPayload.activeRunId || null;
      state.changeSets = draftPayload.drafts || [];
      state.adminSurfaceSummary = surfacePayload || null;
      state.capabilityRegistry = capabilityPayload && typeof capabilityPayload === "object" ? capabilityPayload : null;
      state.agentRegistry = Array.isArray(capabilityPayload?.agents) ? capabilityPayload.agents : [];
      state.agentDefaults = defaultsPayload && typeof defaultsPayload === "object" ? defaultsPayload : null;
      state.skillRegistry = Array.isArray(capabilityPayload?.skills) ? capabilityPayload.skills : [];
      state.managementSubjects = Array.isArray(capabilityPayload?.management?.subjects)
        ? capabilityPayload.management.subjects
        : [];
      state.modelCatalog = Array.isArray(modelsPayload) ? modelsPayload : [];
      state.systemActionDeliveryTickets = Array.isArray(deliveryTicketPayload?.tickets)
        ? deliveryTicketPayload.tickets
        : [];

      ensureRunSelection();
      ensureDraftSelection();
      ensureManagementSelection();
      await Promise.all([loadSelectedRun(), loadSelectedDraft()]);
      ensureComposeSurfaceSelection();
      renderDevtools();
    } catch (e) {
      renderDevtools(e.message);
    } finally {
      state.loading = false;
    }
  }

  async function startPreset(presetId, {
    cleanMode = "session-clean",
    originDraftId = null,
    originExecutionId = null,
    originSurfaceId = null,
    openRunAfterStart = false,
  } = {}) {
    if (state.startingPresetId || state.activeRunId) return;
    state.startingPresetId = presetId;
    renderDevtools();
    try {
      const result = await requestJson(`/watchdog/test-runs/start?token=${tokenParam()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          presetId,
          cleanMode,
          originDraftId,
          originExecutionId,
          originSurfaceId,
        }),
      });
      const startedRunId = result?.run?.id || null;
      if (startedRunId) {
        state.selectedRunId = startedRunId;
      }
      await refreshDevtools();
      if (openRunAfterStart && startedRunId) {
        openRunInTestRuns(startedRunId);
      }
    } catch (e) {
      alert(`Start failed: ${e.message}`);
    } finally {
      state.startingPresetId = null;
      renderDevtools();
    }
  }

  async function attachSelectedRunToDraft() {
    await attachRunToDraft({
      draftId: state.selectedDraftId,
      runId: state.selectedRunId,
      note: "linked from TEST TOOLS",
    });
  }

  async function attachRunToDraft({
    draftId,
    runId,
    note = "linked from TEST TOOLS",
  } = {}) {
    if (state.linkingVerification || !draftId || !runId) return;
    state.linkingVerification = true;
    renderDevtools();
    try {
      const result = await requestJson(`/watchdog/admin-change-sets/verification?token=${tokenParam()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draftId,
          runId,
          note,
        }),
      });
      state.selectedDraftId = draftId;
      state.selectedRunId = runId;
      if (result?.verificationRecord?.id) {
        state.selectedVerificationId = result.verificationRecord.id;
      }
      await refreshDevtools();
    } catch (e) {
      alert(`Link failed: ${e.message}`);
    } finally {
      state.linkingVerification = false;
      renderDevtools();
    }
  }

  async function executeSelectedDraft({ dryRun = false } = {}) {
    if (state.executingDraftAction || !state.selectedDraftId || !state.selectedDraft) return;

    let explicitConfirm = false;
    if (state.selectedDraft.confirmation === "explicit") {
      const confirmed = window.confirm(
        `EXPLICIT CONFIRM\n\n${state.selectedDraft.surfaceId}\n\nThis draft is marked destructive/explicit. Continue?`,
      );
      if (!confirmed) return;
      explicitConfirm = true;
    }

    state.executingDraftAction = dryRun ? "dry-run" : "execute";
    renderDevtools();
    try {
      await requestJson(`/watchdog/admin-change-sets/execute?token=${tokenParam()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: state.selectedDraftId,
          dryRun,
          explicitConfirm,
        }),
      });
      await refreshDevtools();
    } catch (e) {
      alert(`Execute failed: ${e.message}`);
    } finally {
      state.executingDraftAction = null;
      renderDevtools();
    }
  }

  async function saveComposerDraft() {
    if (state.savingDraft) return;
    syncComposerInputsToState();

    if (!state.composeSurfaceId) {
      alert("No authoring surface selected.");
      return;
    }

    let payload;
    try {
      payload = parseJsonInput(state.composePayloadText || "{}", "Payload");
    } catch (error) {
      alert(error.message);
      return;
    }

    const editingDraft = state.selectedDraft?.id === state.composeDraftId
      ? state.selectedDraft
      : null;
    const nextTitle = state.composeTitle.trim() || buildDefaultComposeTitle(findAuthoringSurface(state.composeSurfaceId));
    const body = {
      surfaceId: state.composeSurfaceId,
      title: nextTitle,
      summary: state.composeSummary.trim() || undefined,
      changeSet: {
        ...(editingDraft?.changeSet || {}),
        payload,
      },
      verificationPlan: editingDraft?.verificationPlan || undefined,
    };
    if (state.composeDraftId) {
      body.id = state.composeDraftId;
    }

    state.savingDraft = true;
    renderDevtools();
    try {
      const result = await requestJson(`/watchdog/admin-change-sets?token=${tokenParam()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      state.selectedDraftId = result?.draft?.id || state.selectedDraftId;
      loadComposerFromDraft(result?.draft || null);
      await refreshDevtools();
    } catch (error) {
      alert(`Save draft failed: ${error.message}`);
    } finally {
      state.savingDraft = false;
      renderDevtools();
    }
  }

  function selectViewMode(mode) {
    if (!Object.values(VIEW_MODES).includes(mode) || state.viewMode === mode) return;
    state.viewMode = mode;
    if (mode === VIEW_MODES.MANAGEMENT) {
      ensureManagementSelection();
    } else if (mode === VIEW_MODES.TEST_RUNS) {
      ensureRunSelection();
      void loadSelectedRun().then(() => renderDevtools()).catch(() => {});
      return;
    }
    renderDevtools();
  }

  function selectRun(runId) {
    const runSummary = getRunSummaryById(runId);
    state.selectedRunId = runId;
    state.selectedCaseId = null;
    if (runSummary?.originDraftId && runSummary.originDraftId !== state.selectedDraftId) {
      state.selectedDraftId = runSummary.originDraftId;
      state.selectedVerificationId = null;
      state.selectedExecutionId = null;
      Promise.all([loadSelectedRun(), loadSelectedDraft()]).then(() => renderDevtools()).catch(() => {});
      return;
    }
    void loadSelectedRun().then(() => renderDevtools()).catch(() => {});
  }

  function selectCase(caseId) {
    state.selectedCaseId = caseId;
    renderDevtools();
  }

  function selectDraft(draftId) {
    const preferredRunId = resolvePreferredRunId(draftId);
    state.selectedDraftId = draftId;
    if (preferredRunId) {
      state.selectedRunId = preferredRunId;
      state.selectedCaseId = null;
    }
    state.selectedVerificationId = null;
    state.selectedExecutionId = null;
    Promise.all([
      loadSelectedDraft(),
      preferredRunId ? loadSelectedRun() : Promise.resolve(),
    ]).then(() => renderDevtools()).catch(() => {});
  }

  function selectVerification(verificationId) {
    state.selectedVerificationId = verificationId;
    renderDevtools();
  }

  function selectExecution(executionId) {
    state.selectedExecutionId = executionId;
    renderDevtools();
  }

  function selectManagementSubject(kind) {
    state.selectedManagementKind = kind;
    state.selectedManagementTargetId = null;
    ensureManagementSelection();
    renderDevtools();
  }

  function selectManagementTarget(targetId) {
    state.selectedManagementTargetId = targetId;
    renderDevtools();
  }

  function openManagementSurfaceInComposer(surfaceId) {
    const subject = getSelectedManagementSubject();
    const target = getSelectedManagementTarget(subject);
    state.viewMode = VIEW_MODES.CHANGE_SETS;
    resetComposerForSurface(surfaceId, {
      agentIdHint: subject?.kind === "agent" ? target?.composeAgentId || null : null,
    });
    renderDevtools();
  }

  function openManagementSurfaceRead(path) {
    if (!path) return;
    window.open(path, "_blank", "noopener");
  }

  function returnToManagementView() {
    state.viewMode = VIEW_MODES.MANAGEMENT;
    ensureManagementSelection();
    renderDevtools();
  }

  function focusManagementContext(context) {
    syncManagementSelectionFromContext(context);
    state.viewMode = VIEW_MODES.MANAGEMENT;
    ensureManagementSelection();
    renderDevtools();
  }

  async function createManagementDraft(surfaceId) {
    if (state.creatingManagementDraftSurfaceId) return;

    const surface = findAuthoringSurface(surfaceId);
    if (!surface) {
      alert(`Surface not available for draft creation: ${surfaceId}`);
      return;
    }

    const subject = getSelectedManagementSubject();
    const target = getSelectedManagementTarget(subject);
    const payload = buildPrefilledComposePayload(surface, {
      agentIdHint: subject?.kind === "agent" ? target?.composeAgentId || null : null,
    });
    const titleParts = [
      surface.summary || surface.id,
      target?.label || null,
    ].filter(Boolean);
    const summaryParts = [
      "Created from MANAGEMENT",
      subject?.label || null,
      target?.label || null,
    ].filter(Boolean);

    state.creatingManagementDraftSurfaceId = surface.id;
    renderDevtools();
    try {
      const result = await requestJson(`/watchdog/admin-change-sets?token=${tokenParam()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surfaceId: surface.id,
          title: titleParts.join(" :: "),
          summary: summaryParts.join(" / "),
          changeSet: { payload },
        }),
      });
      state.viewMode = VIEW_MODES.CHANGE_SETS;
      state.selectedDraftId = result?.draft?.id || state.selectedDraftId;
      loadComposerFromDraft(result?.draft || null);
      await refreshDevtools();
    } catch (error) {
      alert(`Create draft failed: ${error.message}`);
    } finally {
      state.creatingManagementDraftSurfaceId = null;
      renderDevtools();
    }
  }

  function renderManagementContextCard(context, {
    title = "MANAGEMENT CONTEXT",
    action = null,
  } = {}) {
    if (!context) return "";

    return `
      <div class="devtool-detail-card">
        <div class="devtool-detail-head">
          <span>${esc(title)}</span>
          <strong>${esc(context.subjectLabel || context.subjectKind || "--")}</strong>
        </div>
        <div class="devtool-detail-line"><span>SUBJECT</span><strong>${esc(context.subjectLabel || context.subjectKind || "--")}</strong></div>
        <div class="devtool-detail-line"><span>TARGET</span><strong>${esc(context.targetLabel || context.targetId || "--")}</strong></div>
        <div class="devtool-detail-line"><span>SURFACE</span><strong>${esc(context.surfaceId || "--")}</strong></div>
        <div class="devtool-detail-line"><span>SELECTOR</span><strong>${esc(context.selectorKey || "--")}</strong></div>
        ${context.targetMeta ? `<div class="devtool-detail-text">${esc(context.targetMeta)}</div>` : ""}
        ${context.surfaceSummary ? `<div class="devtool-detail-text">${esc(context.surfaceSummary)}</div>` : ""}
        ${action === "return"
          ? `<button class="devtool-btn compact" data-return-to-management="1">
              <span class="devtool-btn-title">RETURN TO MANAGEMENT</span>
              <span class="devtool-btn-desc">Go back to the current subject and target in the management map.</span>
            </button>`
          : ""}
      </div>
    `;
  }

  const app = {
    state,
    VIEW_MODES,
    esc,
    formatTimestamp,
    formatDuration,
    formatJson,
    normalizeStatusClass,
    normalizeRecord,
    renderDetailCard,
    renderManagementContextCard,
    getManagementSubjects,
    getSelectedManagementSubject,
    getSelectedManagementTarget,
    getManagementSubjectActivity,
    getManagementTargetActivity,
    buildManagementTargetEntries,
    buildManagementSurfaceReadUrl,
    buildTokenizedPath,
    getAuthoringSurfaces,
    findAuthoringSurface,
    getComposerManagementContext,
    getSelectedDraftManagementContext,
    getOperatorSnapshot,
    getOperatorRecentDrafts,
    getOperatorWorkQueue,
    getOperatorAttention,
    getOperatorDraftSummaryById,
    getOperatorSelectedDraftSummary,
    getDraftVerificationRunConfig,
    getRunSummaryById,
    getSurfaceInputFields,
    getFieldOptions,
    normalizeFieldValueForState,
    refillComposerForCurrentTarget,
    resetComposerForSurface,
    loadComposerFromDraft,
    syncComposePayloadTextFromFields,
    syncComposeFieldsFromPayloadText,
    startPreset,
    attachSelectedRunToDraft,
    attachRunToDraft,
    executeSelectedDraft,
    saveComposerDraft,
    selectCase,
    selectRun,
    selectDraft,
    selectVerification,
    selectExecution,
    selectManagementSubject,
    selectManagementTarget,
    openManagementSurfaceInComposer,
    openManagementSurfaceRead,
    createManagementDraft,
    returnToManagementView,
    focusManagementContext,
    selectViewMode,
    openDraftInChangeSets,
    openRunInTestRuns,
    openTokenizedPath,
    openOperatorRecommendedAction,
    renderDevtools: () => renderDevtools(),
  };

  function createView(factoryName, fallback = {}) {
    const factory = devtoolsModules[factoryName];
    if (typeof factory !== "function") return fallback;
    try {
      return factory(app) || fallback;
    } catch (error) {
      console.error(`[devtools] failed to init ${factoryName}`, error);
      return fallback;
    }
  }

  function createEmptyRenderer(label) {
    return () => {
      const host = document.getElementById("testDevtoolSummary");
      if (!host) return;
      host.innerHTML = `<div class="devtool-empty">${esc(label)} VIEW UNAVAILABLE</div>`;
    };
  }

  const testRunsView = createView("createTestRunsView", {
    renderActions: () => {},
    renderSummary: createEmptyRenderer("TEST RUNS"),
    renderHistory: () => {},
  });
  const managementView = createView("createManagementView", {
    renderActions: () => {},
    renderSummary: createEmptyRenderer("MANAGEMENT"),
    renderHistory: () => {},
  });
  const changeSetView = createView("createChangeSetView", {
    renderActions: () => {},
    renderSummary: createEmptyRenderer("CHANGE SETS"),
    renderHistory: () => {},
    readComposeFieldValue: (field) => normalizeFieldValueForState(field, undefined),
  });

  function getActiveView() {
    if (state.viewMode === VIEW_MODES.TEST_RUNS) return testRunsView;
    if (state.viewMode === VIEW_MODES.MANAGEMENT) return managementView;
    return changeSetView;
  }

  function renderViewTabs() {
    const host = document.getElementById("devtoolViewTabs");
    if (!host) return;
    const tabs = [
      { id: VIEW_MODES.TEST_RUNS, label: "TEST RUNS" },
      { id: VIEW_MODES.CHANGE_SETS, label: "CHANGE SETS" },
      { id: VIEW_MODES.MANAGEMENT, label: "MANAGEMENT" },
    ];
    host.innerHTML = tabs.map((tab) => `
      <button class="devtool-viewtab ${state.viewMode === tab.id ? "active" : ""}" data-view-mode="${esc(tab.id)}">
        ${esc(tab.label)}
      </button>
    `).join("");
    host.querySelectorAll("[data-view-mode]").forEach((button) => {
      button.addEventListener("click", () => selectViewMode(button.getAttribute("data-view-mode")));
    });
  }

  function renderTitles() {
    const actionsTitle = document.getElementById("testDevtoolActionsTitle");
    const summaryTitle = document.getElementById("testDevtoolSummaryTitle");
    const historyTitle = document.getElementById("testDevtoolHistoryTitle");
    if (!actionsTitle || !summaryTitle || !historyTitle) return;

    if (state.viewMode === VIEW_MODES.TEST_RUNS) {
      actionsTitle.textContent = state.selectedDraftId ? "VERIFY DRAFT" : "VERIFY DESK";
      summaryTitle.textContent = "VERIFICATION RUN";
      historyTitle.textContent = state.selectedDraftId ? "RELATED RUNS" : "RUN HISTORY";
      return;
    }

    if (state.viewMode === VIEW_MODES.MANAGEMENT) {
      actionsTitle.textContent = "SUBJECTS";
      summaryTitle.textContent = "MANAGEMENT DETAIL";
      historyTitle.textContent = "TARGETS";
      return;
    }

    actionsTitle.textContent = "OPERATOR DESK";
    summaryTitle.textContent = "CHANGE SET DETAIL";
    historyTitle.textContent = getOperatorRecentDrafts().length ? "RECENT DRAFTS" : "DRAFT HISTORY";
  }

  function renderActions() {
    getActiveView().renderActions();
  }

  function renderSummary(errorMessage) {
    getActiveView().renderSummary(errorMessage);
  }

  function renderHistory() {
    getActiveView().renderHistory();
  }

  function renderDevtools(errorMessage) {
    const status = document.getElementById("testDevtoolStatus");
    if (status) {
      if (state.viewMode === VIEW_MODES.TEST_RUNS) {
        const active = state.runs.find((item) => item.id === state.activeRunId);
        const selected = state.selectedRun
          || state.runs.find((item) => item.id === state.selectedRunId)
          || active
          || null;
        const selectedDraft = selected?.originDraftId
          ? getOperatorDraftSummaryById(selected.originDraftId) || state.changeSets.find((item) => item.id === selected.originDraftId) || null
          : state.selectedDraft;
        const verification = getDraftVerificationRunConfig(selectedDraft);
        status.textContent = selected
          ? `${selectedDraft?.surfaceId || selected.originDraftId || selected.label} // ${selected.label || selected.id} // ${String(selected.status || "running").toUpperCase()}`
          : verification?.draftId
            ? `${selectedDraft?.surfaceId || verification.draftId} // ${verification.presetId || "NO PRESET"} // READY TO VERIFY`
            : "TEST RUNS // IDLE // ISOLATED";
      } else if (state.viewMode === VIEW_MODES.MANAGEMENT) {
        const subject = getSelectedManagementSubject();
        const target = getSelectedManagementTarget(subject);
        const draftContext = getSelectedDraftManagementContext();
        const aligned = Boolean(
          draftContext
          && draftContext.subjectKind === subject?.kind
          && draftContext.targetId === target?.id,
        );
        status.textContent = subject
          ? `${subject.label || subject.kind} // ${subject.counts?.apply || 0} APPLY // ${target?.label || "GLOBAL"}${draftContext ? ` // ${aligned ? "DRAFT-ALIGNED" : "DRAFT-OFFSET"}` : ""}`
          : "MANAGEMENT // NO SUBJECTS";
      } else {
        const snapshotSummary = getOperatorSnapshot()?.summary || null;
        const verifiedCount = state.changeSets.filter((item) => item.verificationCount > 0).length;
        const selectedStatus = state.selectedDraft?.lastVerificationStatus || state.selectedDraft?.status || "draft";
        const selectedDraftContext = getSelectedDraftManagementContext();
        status.textContent = state.selectedDraft
          ? `${state.selectedDraft.surfaceId} // ${selectedDraftContext?.targetLabel || selectedDraftContext?.targetId || "GLOBAL"} // ${String(selectedStatus).toUpperCase()}`
          : `OPERATOR // ${String(snapshotSummary?.state || "idle").toUpperCase()} // ${state.changeSets.length} DRAFTS // ${verifiedCount} VERIFIED`;
      }
    }

    renderViewTabs();
    renderTitles();
    renderActions();
    renderSummary(errorMessage);
    renderHistory();
  }

  setInterval(() => { void refreshDevtools(); }, 4000);
  window.addEventListener("focus", () => { void refreshDevtools(); });
  void refreshDevtools();
})();
