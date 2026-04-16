import { esc, getToken, shortModel, toast } from "./dashboard-common.js";
import {
  DEFAULT_AGENT_ROLE,
  normalizeAgentRoleDraft,
  renderAgentRoleInput,
} from "./dashboard-agent-role-input.js";
import {
  AGENT_REMOVAL_MODE,
  buildAgentDeleteConfirmation,
  resolveAgentRemovalAction,
} from "./dashboard-agent-management-actions.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";

const state = {
  loading: true,
  joiningAgentId: null,
  takingOverAgentId: null,
  deletingAgentId: null,
  deletingMode: null,
  modalOpen: false,
  modalQuery: "",
  modalSourceFilter: "all",
  rosterFilter: "all",
  rosterDetailId: null,
  roleDrafts: {},
  registryById: {},
  guidancePreview: {
    agentId: null,
    fileName: null,
    loading: false,
    editing: false,
    saving: false,
    exists: null,
    guidanceState: null,
    workspacePath: null,
    content: "",
    draftContent: "",
    error: "",
  },
  discovery: {
    agents: [],
    candidates: [],
    candidateCounts: {},
    localWorkspaceResidue: [],
    localWorkspaceResidueCounts: {},
    counts: {},
  },
};

function buildApiUrl(path) {
  const token = getToken();
  return token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
}

async function requestJson(path, options = {}) {
  const response = await fetch(buildApiUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text || "invalid json response" };
  }
  if (!response.ok) {
    throw new Error(data?.error || `request failed: ${response.status}`);
  }
  return data;
}

function statusLabel(status) {
  switch (status) {
    case "managed": return "系统已纳管";
    case "partial": return "部分纳管";
    case "customized": return "已接入 / 自定义引导";
    case "discovered": return "本地发现";
    case "unmanaged": return "未纳管";
    default: return status || "--";
  }
}

function sourceLabel(source) {
  return source === "local_workspace" ? "仅本地 workspace" : "已登记配置";
}

function boolLabel(value) {
  return value === true ? "YES" : "NO";
}

function guidanceStateLabel(stateValue) {
  switch (stateValue) {
    case "managed": return "系统引导";
    case "custom": return "自定义";
    case "missing": return "缺失";
    default: return stateValue || "--";
  }
}

function requirementLabel(item) {
  if (!item) return "--";
  if (item === "config_registration") return "写入 openclaw 配置";
  if (item === "agent_card") return "补齐 agent-card";
  if (item.startsWith("managed_guidance:")) {
    return `写入系统引导 ${item.slice("managed_guidance:".length)}`;
  }
  if (item.startsWith("custom_guidance:")) {
    return `保留自定义引导 ${item.slice("custom_guidance:".length)}`;
  }
  return item;
}

function getAttentionGuidanceFiles(agent) {
  const attention = Array.isArray(agent?.attentionReasons) ? agent.attentionReasons : [];
  return attention
    .filter((item) => item.startsWith("custom_guidance:"))
    .map((item) => item.slice("custom_guidance:".length));
}

function renderToolbar() {
  const toolbar = document.querySelector("#pageChrome .subpage-toolbar");
  if (!toolbar) return;

  let actions = toolbar.querySelector(".agent-toolbar-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "agent-toolbar-actions";
    toolbar.appendChild(actions);
  }

  const candidateCount = getCandidateCounts().total;
  actions.innerHTML = `
    <button class="agent-toolbar-btn secondary" type="button" data-agent-refresh="1">
      REFRESH
    </button>
    <button class="agent-toolbar-btn" type="button" data-agent-open-modal="1" ${state.loading ? "disabled" : ""}>
      ADD AGENT
      <span class="agent-toolbar-count">${candidateCount}</span>
    </button>
  `;

  const refreshButton = actions.querySelector("[data-agent-refresh]");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => loadDiscovery());
  }
  const openButton = actions.querySelector("[data-agent-open-modal]");
  if (openButton) {
    openButton.addEventListener("click", () => {
      state.modalOpen = true;
      renderPage();
    });
  }
}

function ensureRoleDraft(agent) {
  if (!agent?.id) return DEFAULT_AGENT_ROLE;
  if (!state.roleDrafts[agent.id]) {
    const resolvedRole = resolveAgentRole(agent);
    state.roleDrafts[agent.id] = normalizeAgentRoleDraft(resolvedRole);
  }
  return normalizeAgentRoleDraft(state.roleDrafts[agent.id]);
}

function resolveAgentRole(agent) {
  const runtimeRole = state.registryById?.[agent?.id]?.role;
  return runtimeRole || agent?.detectedRole || "--";
}

function renderSummaryCard(label, value, detail, tone = "default") {
  return `
    <article class="agents-summary-card ${esc(tone)}">
      <div class="agents-summary-label">${esc(label)}</div>
      <div class="agents-summary-value">${esc(value)}</div>
      <div class="agents-summary-detail">${esc(detail)}</div>
    </article>
  `;
}

function renderTelemetryChip(label, value, tone = "default") {
  return `
    <div class="agents-telemetry-chip ${esc(tone)}">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  `;
}

function normalizeSearchValue(value) {
  return String(value || "").trim().toLowerCase();
}

function filterRosterAgents(agents, filterKey) {
  switch (filterKey) {
    case "managed":
      return agents.filter((agent) => agent.status === "managed");
    case "customized":
      return agents.filter((agent) => agent.status === "customized");
    case "attention":
      return agents.filter((agent) => agent.needsAttention === true);
    case "partial":
      return agents.filter((agent) => agent.status === "partial");
    default:
      return agents;
  }
}

function renderRosterFilterButton(key, label, count) {
  const active = state.rosterFilter === key;
  return `
    <button class="agents-filter-btn${active ? " active" : ""}" type="button" data-roster-filter="${esc(key)}">
      <span>${esc(label)}</span>
      <strong>${esc(count)}</strong>
    </button>
  `;
}

function renderRequirementTags(agent) {
  const planned = Array.isArray(agent?.plannedActions) ? agent.plannedActions : [];
  const attention = Array.isArray(agent?.attentionReasons) ? agent.attentionReasons : [];
  if (planned.length === 0 && attention.length === 0) {
    return '<div class="agents-card-tags"><span class="agents-tag ok">纳管完整</span></div>';
  }
  return `
    <div class="agents-card-tags">
      ${planned.map((item) => `<span class="agents-tag plan">${esc(requirementLabel(item))}</span>`).join("")}
      ${attention.map((item) => `<span class="agents-tag attention">${esc(requirementLabel(item))}</span>`).join("")}
    </div>
  `;
}

function resetGuidancePreview(agentId = null) {
  state.guidancePreview = {
    agentId,
    fileName: null,
    loading: false,
    editing: false,
    saving: false,
    exists: null,
    guidanceState: null,
    workspacePath: null,
    content: "",
    draftContent: "",
    error: "",
  };
}

function getConfiguredCandidates() {
  return Array.isArray(state.discovery?.candidates) ? state.discovery.candidates : [];
}

function getLocalWorkspaceResidue() {
  return Array.isArray(state.discovery?.localWorkspaceResidue) ? state.discovery.localWorkspaceResidue : [];
}

function getDiscoveryCandidates() {
  return [...getConfiguredCandidates(), ...getLocalWorkspaceResidue()];
}

function getKnownDiscoveryAgents() {
  return [
    ...(Array.isArray(state.discovery?.agents) ? state.discovery.agents : []),
    ...getLocalWorkspaceResidue(),
  ];
}

function getCandidateCounts() {
  const candidateCounts = state.discovery?.candidateCounts || {};
  const configured = Number(candidateCounts.configured) || getConfiguredCandidates().length;
  const localWorkspace = Number(candidateCounts.localWorkspace) || getLocalWorkspaceResidue().length;
  return {
    total: Number(candidateCounts.total) || (configured + localWorkspace),
    configured,
    localWorkspace,
  };
}

function renderCandidateSummary(candidateCounts) {
  return `
    <div class="agents-modal-summary">
      <div class="agents-modal-summary-card">
        <span>JOINABLE</span>
        <strong>${esc(candidateCounts.total || 0)}</strong>
        <small>可直接接入、补齐画像或清理 residue</small>
      </div>
      <div class="agents-modal-summary-card">
        <span>CONFIGURED</span>
        <strong>${esc(candidateCounts.configured || 0)}</strong>
        <small>已在 openclaw.json 中登记</small>
      </div>
      <div class="agents-modal-summary-card">
        <span>LOCAL WORKSPACE</span>
        <strong>${esc(candidateCounts.localWorkspace || 0)}</strong>
        <small>仅在本地 workspace 中发现</small>
      </div>
    </div>
  `;
}

function renderJoinButton(agent) {
  if (agent?.joinable !== true) return "";
  const busy = state.joiningAgentId === agent.id;
  return `
    <button class="agents-action-btn" type="button" data-agent-join="${esc(agent.id)}" ${busy ? "disabled" : ""}>
      ${busy ? "JOINING..." : "JOIN TO SYSTEM"}
    </button>
  `;
}

function renderResidueHardDeleteButton(agent) {
  if (agent?.source !== "local_workspace") return "";
  const action = resolveAgentRemovalAction(AGENT_REMOVAL_MODE.HARD_DELETE, agent.id);
  const busy = state.deletingAgentId === agent.id && state.deletingMode === action.mode;
  return `
    <button class="agents-action-btn danger" type="button" data-agent-hard-delete="${esc(agent.id)}" ${busy ? "disabled" : ""}>
      ${busy ? action.busyLabel : "HARD DELETE"}
    </button>
  `;
}

function renderTakeOverButton(agent) {
  if (agent?.needsAttention !== true || agent?.joinable === true) return "";
  const files = getAttentionGuidanceFiles(agent);
  if (files.length === 0) return "";
  const busy = state.takingOverAgentId === agent.id;
  if (files.length === 1) {
    return `
      <button class="agents-action-btn warning" type="button" data-agent-takeover="${esc(agent.id)}" data-agent-takeover-files="${esc(files[0])}" ${busy ? "disabled" : ""}>
        ${busy ? "TAKING OVER..." : `TAKE OVER ${esc(files[0])}`}
      </button>
    `;
  }
  return `
    <button class="agents-action-btn warning" type="button" data-agent-takeover="${esc(agent.id)}" ${busy ? "disabled" : ""}>
      ${busy ? "TAKING OVER..." : "TAKE OVER ALL"}
    </button>
    ${files.map((fileName) => `
      <button class="agents-action-btn subtle" type="button" data-agent-takeover="${esc(agent.id)}" data-agent-takeover-files="${esc(fileName)}" ${busy ? "disabled" : ""}>
        ${esc(fileName)}
      </button>
    `).join("")}
  `;
}

function renderDetailButton(agent) {
  const expanded = state.rosterDetailId === agent.id;
  return `
    <button class="agents-action-btn subtle" type="button" data-agent-detail="${esc(agent.id)}">
      ${expanded ? "DETAIL ACTIVE" : "VIEW DETAIL"}
    </button>
  `;
}

function renderActionSummary(agent) {
  const planned = Array.isArray(agent?.plannedActions) ? agent.plannedActions : [];
  const attention = Array.isArray(agent?.attentionReasons) ? agent.attentionReasons : [];
  if (planned.length === 0 && attention.length === 0) {
    return "已完整纳管";
  }
  if (planned.length > 0 && attention.length === 0) {
    return planned.map(requirementLabel).join(" // ");
  }
  if (planned.length === 0) {
    return attention.map(requirementLabel).join(" // ");
  }
  return `${planned.map(requirementLabel).join(" // ")} // ${attention.map(requirementLabel).join(" // ")}`;
}

function renderGuidancePreview(agent) {
  const preview = state.guidancePreview?.agentId === agent?.id ? state.guidancePreview : null;
  if (!preview || !preview.fileName) {
    return '<div class="agents-detail-preview empty">点击上方引导文件名称，查看当前 workspace 中的只读内容。</div>';
  }
  if (preview.loading) {
    return `<div class="agents-detail-preview loading">正在读取 ${esc(preview.fileName)} …</div>`;
  }
  if (preview.error) {
    return `<div class="agents-detail-preview error">${esc(preview.error)}</div>`;
  }
  const showManagedWarning = preview.guidanceState === "managed";
  const actionMarkup = preview.editing
    ? `
      <div class="agents-detail-preview-actions">
        <button class="agents-action-btn subtle" type="button" data-agent-preview-cancel="1" ${preview.saving ? "disabled" : ""}>CANCEL</button>
        <button class="agents-action-btn" type="button" data-agent-preview-save="1" ${preview.saving ? "disabled" : ""}>
          ${preview.saving ? "SAVING..." : "SAVE FILE"}
        </button>
      </div>
    `
    : `
      <div class="agents-detail-preview-actions">
        <button class="agents-action-btn subtle" type="button" data-agent-preview-edit="1">
          ${preview.exists === false ? "CREATE FILE" : "EDIT FILE"}
        </button>
      </div>
    `;
  const bodyMarkup = preview.editing
    ? `<textarea class="agents-detail-preview-editor" data-agent-preview-input="1" spellcheck="false">${esc(preview.draftContent ?? preview.content ?? "")}</textarea>`
    : (preview.exists === false
        ? '<div class="agents-detail-preview-note">该文件当前不存在，保存后会在当前 workspace 中创建。</div>'
        : `<pre class="agents-detail-preview-body">${esc(preview.content || "")}</pre>`);
  return `
    <div class="agents-detail-preview">
      <div class="agents-detail-preview-toolbar">
        <div class="agents-detail-preview-head">
          <strong>${esc(preview.fileName)}</strong>
          <span>${esc(guidanceStateLabel(preview.guidanceState || "--"))}</span>
        </div>
        ${actionMarkup}
      </div>
      <div class="agents-detail-preview-meta">${esc(preview.workspacePath || "--")} // ${preview.editing ? "EDIT MODE" : "READ ONLY"}</div>
      ${showManagedWarning
        ? '<div class="agents-detail-preview-note warning">当前文件仍被判定为系统引导，手动保存后会转为自定义引导。</div>'
        : ""}
      ${bodyMarkup}
    </div>
  `;
}

function renderRoleSelect(agent, compact = false) {
  return renderAgentRoleInput({
    agentId: agent.id,
    value: ensureRoleDraft(agent),
    compact,
  });
}

function renderAgentCard(agent) {
  const cardClassName = [
    "agents-card",
    agent.joinable === true ? "joinable" : "managed",
    agent.needsAttention === true ? "attention" : "",
    state.rosterDetailId === agent.id ? "selected" : "",
  ].filter(Boolean).join(" ");
  const joinButton = renderJoinButton(agent);
  const takeoverButton = renderTakeOverButton(agent);
  const detailButton = renderDetailButton(agent);
  const showRolePicker = Boolean(joinButton);
  const actionMarkup = joinButton || takeoverButton || detailButton
    ? `
      <div class="agents-card-actions">
        ${showRolePicker ? renderRoleSelect(agent, true) : `<div class="agents-action-note">${esc(renderActionSummary(agent))}</div>`}
        <div class="agents-inline-actions">
          ${joinButton}
          ${takeoverButton}
          ${detailButton}
        </div>
      </div>
    `
    : "";
  return `
    <article class="${cardClassName}">
      <div class="agents-card-head">
        <div>
          <div class="agents-card-title">${esc(agent.name || agent.id)}</div>
          <div class="agents-card-meta">
            ${esc(agent.id)} // ${esc(statusLabel(agent.status))} // ${esc(sourceLabel(agent.source))}
          </div>
        </div>
        <div class="agents-card-status">${esc(statusLabel(agent.status))}</div>
      </div>
      <div class="agents-card-grid">
        <div><span>ROLE</span><strong>${esc(resolveAgentRole(agent))}</strong></div>
        <div><span>MODEL</span><strong>${esc(shortModel(agent.model))}</strong></div>
        <div><span>PROTECTED</span><strong>${boolLabel(agent.protected)}</strong></div>
        <div><span>SPECIALIZED</span><strong>${boolLabel(agent.specialized)}</strong></div>
        <div><span>画像卡</span><strong>${agent.hasAgentCard ? "READY" : "MISSING"}</strong></div>
        <div><span>引导文件</span><strong>${agent.guidance?.managed || 0}/${Array.isArray(agent.guidanceFiles) ? agent.guidanceFiles.length : 0}</strong></div>
      </div>
      <div class="agents-card-line">
        <span>WORKSPACE</span>
        <strong>${esc(agent.workspaceLabel || agent.workspacePath || "--")}</strong>
      </div>
      ${agent.description ? `<div class="agents-card-desc">${esc(agent.description)}</div>` : ""}
      ${renderRequirementTags(agent)}
      ${actionMarkup}
    </article>
  `;
}

function renderRosterDetail(agent) {
  if (!agent) {
    return `
      <section class="agents-detail-panel empty">
        <div class="agents-detail-placeholder">
          从左侧选择一个 agent 查看角色、画像卡和引导文件细节。未接入的本地对象统一通过右上角 <strong>ADD AGENT</strong> 处理。
        </div>
      </section>
    `;
  }
  const guidanceFiles = Array.isArray(agent.guidanceFiles) ? agent.guidanceFiles : [];
  const plannedActions = Array.isArray(agent.plannedActions) ? agent.plannedActions : [];
  const attentionReasons = Array.isArray(agent.attentionReasons) ? agent.attentionReasons : [];
  const isDeleting = state.deletingAgentId === agent.id;
  const deleteAction = resolveAgentRemovalAction(AGENT_REMOVAL_MODE.DELETE, agent.id);
  const hardDeleteAction = resolveAgentRemovalAction(AGENT_REMOVAL_MODE.HARD_DELETE, agent.id);
  return `
    <section class="agents-detail-panel">
      <div class="agents-detail-head">
        <div>
          <div class="agents-detail-title">${esc(agent.name || agent.id)}</div>
          <div class="agents-detail-meta">${esc(agent.id)} // ${esc(statusLabel(agent.status))} // ${esc(sourceLabel(agent.source))}</div>
        </div>
        <div class="agents-detail-head-actions">
          ${agent.protected === true
            ? '<span class="agents-delete-protected">PROTECTED</span>'
            : `
              <button class="agents-action-btn danger" type="button" data-agent-delete="${esc(agent.id)}" ${isDeleting ? "disabled" : ""}>${isDeleting && state.deletingMode === deleteAction.mode ? deleteAction.busyLabel : "REMOVE"}</button>
              <button class="agents-action-btn danger" type="button" data-agent-hard-delete="${esc(agent.id)}" ${isDeleting ? "disabled" : ""}>${isDeleting && state.deletingMode === hardDeleteAction.mode ? hardDeleteAction.busyLabel : "HARD DELETE"}</button>
            `}
          <button class="agents-action-btn subtle" type="button" data-agent-detail-close="1">CLEAR</button>
        </div>
      </div>
      <div class="agents-detail-grid">
        <div><span>ROLE</span><strong>${esc(resolveAgentRole(agent))}</strong></div>
        <div><span>MODEL</span><strong>${esc(shortModel(agent.model))}</strong></div>
        <div><span>WORKSPACE</span><strong>${esc(agent.workspaceLabel || agent.workspacePath || "--")}</strong></div>
        <div><span>引导纳管</span><strong>${esc(`${agent.guidance?.managed || 0}/${guidanceFiles.length}`)}</strong></div>
        <div><span>PROTECTED</span><strong>${boolLabel(agent.protected)}</strong></div>
        <div><span>SPECIALIZED</span><strong>${boolLabel(agent.specialized)}</strong></div>
      </div>
      <div class="agents-detail-columns">
        <div class="agents-detail-box">
          <div class="agents-detail-box-title">引导文件</div>
          <div class="agents-detail-filelist">
            ${guidanceFiles.length === 0
              ? '<div class="agents-detail-empty">当前没有引导文件记录。</div>'
              : guidanceFiles.map((entry) => `
                  <button
                    class="agents-detail-file ${state.guidancePreview?.agentId === agent.id && state.guidancePreview?.fileName === entry.name ? "active" : ""}"
                    type="button"
                    data-agent-preview="${esc(agent.id)}"
                    data-agent-preview-file="${esc(entry.name)}"
                  >
                    <div class="agents-detail-file-copy">
                      <strong>${esc(entry.name)}</strong>
                    </div>
                    <span class="state-${esc(entry.state || "unknown")}">${esc(guidanceStateLabel(entry.state))}</span>
                  </button>
                `).join("")}
          </div>
        </div>
        <div class="agents-detail-box">
          <div class="agents-detail-box-title">待补动作</div>
          <div class="agents-detail-list">
            ${plannedActions.length === 0
              ? '<div class="agents-detail-empty">当前没有待执行的自动补齐动作。</div>'
              : plannedActions.map((item) => `<div>${esc(requirementLabel(item))}</div>`).join("")}
          </div>
          <div class="agents-detail-box-title minor">保留项</div>
          <div class="agents-detail-list">
            ${attentionReasons.length === 0
              ? '<div class="agents-detail-empty">当前没有自定义引导保留项。</div>'
              : attentionReasons.map((item) => `<div>${esc(requirementLabel(item))}</div>`).join("")}
          </div>
        </div>
      </div>
      ${renderGuidancePreview(agent)}
    </section>
  `;
}

function renderCandidateModal() {
  if (!state.modalOpen) return "";
  const candidates = getDiscoveryCandidates();
  const candidateCounts = getCandidateCounts();
  const filteredCandidates = candidates.filter((agent) => {
    const query = normalizeSearchValue(state.modalQuery);
    const haystack = [
      agent.id,
      agent.name,
      agent.workspaceLabel,
      agent.workspacePath,
      agent.description,
      renderActionSummary(agent),
    ].map((item) => normalizeSearchValue(item)).join(" ");
    const matchesQuery = !query || haystack.includes(query);
    const matchesSource = state.modalSourceFilter === "all" || agent.source === state.modalSourceFilter;
    return matchesQuery && matchesSource;
  });
  return `
    <div class="agents-modal-backdrop" data-agent-close-modal="1">
      <div class="agents-modal" role="dialog" aria-modal="true" aria-label="Add agent">
        <div class="agents-modal-head">
          <div>
            <div class="agents-modal-title">ADD AGENT</div>
            <div class="agents-modal-subtitle">当前筛出 ${filteredCandidates.length}/${candidates.length} 个可立即接入、补齐画像或直接清理的候选对象</div>
          </div>
          <button class="agents-modal-close" type="button" data-agent-close-modal="1">CLOSE</button>
        </div>
        <div class="agents-modal-body">
          ${renderCandidateSummary(candidateCounts)}
          <div class="agents-modal-controls">
            <label class="agents-modal-search">
              <span>SEARCH</span>
              <input type="text" value="${esc(state.modalQuery)}" placeholder="按 agent id / name / workspace 搜索" data-modal-query="1">
            </label>
            <div class="agents-modal-filterbar">
              <button class="agents-filter-btn${state.modalSourceFilter === "all" ? " active" : ""}" type="button" data-modal-source="all"><span>ALL</span><strong>${esc(candidates.length)}</strong></button>
              <button class="agents-filter-btn${state.modalSourceFilter === "configured" ? " active" : ""}" type="button" data-modal-source="configured"><span>CONFIGURED</span><strong>${esc(candidates.filter((agent) => agent.source === "configured").length)}</strong></button>
              <button class="agents-filter-btn${state.modalSourceFilter === "local_workspace" ? " active" : ""}" type="button" data-modal-source="local_workspace"><span>LOCAL</span><strong>${esc(candidates.filter((agent) => agent.source === "local_workspace").length)}</strong></button>
            </div>
          </div>
          ${filteredCandidates.length === 0
            ? '<div class="agents-empty">没有可直接执行 join 的候选对象。若某些 agent 保留了自定义引导，会在下方 roster 中显示为需要关注。</div>'
            : filteredCandidates.map((agent) => `
                <article class="agents-modal-card">
                  <div class="agents-modal-card-head">
                    <strong>${esc(agent.name || agent.id)}</strong>
                    <span>${esc(statusLabel(agent.status))}</span>
                  </div>
                  <div class="agents-modal-card-meta">${esc(agent.id)} // ${esc(sourceLabel(agent.source))} // ${esc(agent.workspaceLabel || "--")}</div>
                  <div class="agents-modal-card-meta">${esc(renderActionSummary(agent))}</div>
                  ${renderRequirementTags(agent)}
                  <div class="agents-modal-card-actions">
                    ${renderRoleSelect(agent)}
                    ${renderJoinButton(agent)}
                    ${renderResidueHardDeleteButton(agent)}
                  </div>
                </article>
              `).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderPage() {
  renderToolbar();
  const host = document.getElementById("agentsExperience");
  if (!host) return;

  if (state.loading) {
    host.innerHTML = '<div class="agents-empty loading">正在加载 agent 看板…</div>';
    return;
  }

  const counts = state.discovery?.counts || {};
  const agents = Array.isArray(state.discovery?.agents) ? state.discovery.agents : [];
  const rosterAgents = agents.filter((agent) => agent.joinable !== true);
  const managedAgents = filterRosterAgents(rosterAgents, state.rosterFilter);
  const selectedRosterAgent = managedAgents.find((agent) => agent.id === state.rosterDetailId) || null;
  const candidateCount = getCandidateCounts().total;
  const heroStatus = candidateCount > 0 ? "待接入对象存在" : "当前编队稳定";
  const rosterCounts = {
    all: rosterAgents.length,
    managed: rosterAgents.filter((agent) => agent.status === "managed").length,
    customized: rosterAgents.filter((agent) => agent.status === "customized").length,
    attention: rosterAgents.filter((agent) => agent.needsAttention === true).length,
    partial: rosterAgents.filter((agent) => agent.status === "partial").length,
  };

  host.innerHTML = `
    <section class="agents-command-deck">
      <div class="agents-command-layout">
        <div class="agents-command-hero">
          <div class="agents-command-kicker">MISSION SUMMARY</div>
          <div class="agents-command-headerline">
            <h1 class="agents-command-title">代理总览</h1>
            <div class="agents-command-state ${candidateCount > 0 ? "pending" : "stable"}">${esc(heroStatus)}</div>
          </div>
          <p class="agents-command-copy">
            主视图只保留系统内编队和纳管状态。未接入的本地 agent 统一收束到右上角 <strong>ADD AGENT</strong>，
            避免候选对象和正式编队混在一起。
          </p>
          <div class="agents-telemetry-row">
            ${renderTelemetryChip("Configured", counts.configured || 0)}
            ${renderTelemetryChip("Joinable", candidateCount, candidateCount > 0 ? "amber" : "default")}
            ${renderTelemetryChip("Managed", counts.managed || 0, "green")}
            ${renderTelemetryChip("Attention", counts.attention || 0, (counts.attention || 0) > 0 ? "warning" : "default")}
          </div>
        </div>

        <div class="agents-summary-grid">
          ${renderSummaryCard("CONFIGURED", counts.configured || 0, "当前 openclaw.json 已登记的 agent 数量", "neutral")}
          ${renderSummaryCard("JOINABLE", candidateCount, "右上角弹层里可以直接接入或补齐画像的对象", "pending")}
          ${renderSummaryCard("MANAGED", counts.managed || 0, "画像卡与引导文件都已被系统完整纳管", "managed")}
          ${renderSummaryCard("ATTENTION", counts.attention || 0, "存在自定义引导保留项，系统不会自动覆盖", "attention")}
        </div>
      </div>
    </section>

    <section class="agents-panel">
      <div class="agents-panel-head">
        <div>
          <div class="agents-panel-title">SYSTEM ROSTER</div>
          <div class="agents-panel-subtitle">平台已识别的 agent 编队，包含完整纳管对象与保留自定义引导的实例</div>
        </div>
        <div class="agents-panel-stat">${managedAgents.length}</div>
      </div>
      <div class="agents-roster-shell">
        <div class="agents-roster-main">
          <div class="agents-roster-intro">
            <div class="agents-roster-intro-copy">
              <span>ROSTER NOTE</span>
              左侧是系统内 agent 卡片，右侧是选中对象的细节面板。若顶部仍显示 joinable，对应对象还没有正式加入系统编队。
            </div>
            <div class="agents-roster-intro-grid">
              <div><span>Managed</span><strong>${esc(counts.managed || 0)}</strong></div>
              <div><span>Customized</span><strong>${esc(counts.customized || 0)}</strong></div>
              <div><span>Partial</span><strong>${esc(counts.partial || 0)}</strong></div>
            </div>
          </div>
          <div class="agents-roster-filters">
            ${renderRosterFilterButton("all", "ALL", rosterCounts.all)}
            ${renderRosterFilterButton("managed", "MANAGED", rosterCounts.managed)}
            ${renderRosterFilterButton("customized", "CUSTOMIZED", rosterCounts.customized)}
            ${renderRosterFilterButton("attention", "ATTENTION", rosterCounts.attention)}
            ${renderRosterFilterButton("partial", "PARTIAL", rosterCounts.partial)}
          </div>
          <div class="agents-card-grid-list">
            ${managedAgents.length === 0
              ? '<div class="agents-empty">当前筛选条件下没有可显示的 system roster 对象。</div>'
              : managedAgents.map(renderAgentCard).join("")}
          </div>
        </div>
        <div class="agents-roster-side">
          ${renderRosterDetail(selectedRosterAgent)}
        </div>
      </div>
    </section>

    ${renderCandidateModal()}
  `;

  bindPageEvents(host);
}

function bindPageEvents(host) {
  host.querySelectorAll("[data-agent-role]").forEach((select) => {
    const updateRoleDraft = () => {
      state.roleDrafts[select.getAttribute("data-agent-role")] = normalizeAgentRoleDraft(select.value);
    };
    select.addEventListener("input", updateRoleDraft);
    select.addEventListener("change", updateRoleDraft);
  });

  host.querySelectorAll("[data-agent-join]").forEach((button) => {
    button.addEventListener("click", async () => {
      const agentId = button.getAttribute("data-agent-join");
      const agent = getKnownDiscoveryAgents().find((entry) => entry.id === agentId);
      if (!agent) return;
      await joinAgent(agent);
    });
  });

  host.querySelectorAll("[data-agent-takeover]").forEach((button) => {
    button.addEventListener("click", async () => {
      const agentId = button.getAttribute("data-agent-takeover");
      const fileList = button.getAttribute("data-agent-takeover-files");
      const agent = (state.discovery?.agents || []).find((entry) => entry.id === agentId);
      if (!agent) return;
      const files = fileList
        ? fileList.split(",").map((entry) => entry.trim()).filter(Boolean)
        : getAttentionGuidanceFiles(agent);
      const label = files.length === 0
        ? "全部平台引导文件"
        : files.join(", ");
      const confirmed = window.confirm(`接管 ${agent.name || agent.id} 的以下引导文件？${label}。这会覆盖 workspace 中对应的自定义文件。`);
      if (!confirmed) return;
      await takeOverAgentGuidance(agent, files);
    });
  });

  host.querySelectorAll("[data-agent-close-modal]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (button.classList.contains("agents-modal-backdrop") && event.target !== button) {
        return;
      }
      state.modalOpen = false;
      renderPage();
    });
  });

  host.querySelectorAll("[data-roster-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.rosterFilter = button.getAttribute("data-roster-filter") || "all";
      renderPage();
    });
  });

  host.querySelectorAll("[data-agent-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      const agentId = button.getAttribute("data-agent-detail");
      const nextId = state.rosterDetailId === agentId ? null : agentId;
      state.rosterDetailId = nextId;
      if (!nextId || state.guidancePreview?.agentId !== nextId) {
        resetGuidancePreview(nextId);
      }
      renderPage();
    });
  });

  host.querySelectorAll("[data-agent-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const agentId = button.getAttribute("data-agent-delete");
      if (!agentId) return;
      const confirmed = window.confirm(buildAgentDeleteConfirmation(agentId, AGENT_REMOVAL_MODE.DELETE));
      if (!confirmed) return;
      await deleteAgentFromSystem(agentId, AGENT_REMOVAL_MODE.DELETE);
    });
  });

  host.querySelectorAll("[data-agent-hard-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const agentId = button.getAttribute("data-agent-hard-delete");
      if (!agentId) return;
      const confirmed = window.confirm(buildAgentDeleteConfirmation(agentId, AGENT_REMOVAL_MODE.HARD_DELETE));
      if (!confirmed) return;
      await deleteAgentFromSystem(agentId, AGENT_REMOVAL_MODE.HARD_DELETE);
    });
  });

  host.querySelectorAll("[data-agent-detail-close]").forEach((button) => {
    button.addEventListener("click", () => {
      state.rosterDetailId = null;
      resetGuidancePreview(null);
      renderPage();
    });
  });

  host.querySelectorAll("[data-agent-preview]").forEach((button) => {
    button.addEventListener("click", async () => {
      const agentId = button.getAttribute("data-agent-preview");
      const fileName = button.getAttribute("data-agent-preview-file");
      if (!agentId || !fileName) return;
      if (state.guidancePreview?.agentId === agentId && state.guidancePreview?.fileName === fileName) {
        resetGuidancePreview(agentId);
        renderPage();
        return;
      }
      await loadGuidancePreview(agentId, fileName);
    });
  });

  host.querySelectorAll("[data-agent-preview-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      state.guidancePreview = {
        ...state.guidancePreview,
        editing: true,
        error: "",
        draftContent: state.guidancePreview?.draftContent ?? state.guidancePreview?.content ?? "",
      };
      renderPage();
    });
  });

  host.querySelectorAll("[data-agent-preview-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.guidancePreview = {
        ...state.guidancePreview,
        editing: false,
        saving: false,
        error: "",
        draftContent: state.guidancePreview?.content || "",
      };
      renderPage();
    });
  });

  host.querySelectorAll("[data-agent-preview-input]").forEach((input) => {
    input.addEventListener("input", () => {
      state.guidancePreview = {
        ...state.guidancePreview,
        draftContent: input.value || "",
      };
    });
  });

  host.querySelectorAll("[data-agent-preview-save]").forEach((button) => {
    button.addEventListener("click", async () => {
      await saveGuidancePreview();
    });
  });

  host.querySelectorAll("[data-modal-source]").forEach((button) => {
    button.addEventListener("click", () => {
      state.modalSourceFilter = button.getAttribute("data-modal-source") || "all";
      renderPage();
    });
  });

  host.querySelectorAll("[data-modal-query]").forEach((input) => {
    input.addEventListener("input", () => {
      state.modalQuery = input.value || "";
      renderPage();
    });
  });
}

async function joinAgent(agent) {
  state.joiningAgentId = agent.id;
  renderPage();
  try {
    const payload = {
      agentId: agent.id,
      role: ensureRoleDraft(agent),
    };
    if (agent.source === "local_workspace") {
      payload.workspacePath = agent.workspacePath;
    }
    const result = await requestJson("/watchdog/agents/join", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    toast(`已加入系统: ${result.agentId || agent.id}`, "success");
    state.modalOpen = false;
    await loadDiscovery();
  } catch (error) {
    toast(error.message || "加入系统失败", "error");
    state.joiningAgentId = null;
    renderPage();
  }
}

async function loadDiscovery() {
  state.loading = true;
  renderPage();
  try {
    const [discoveryResult, registryResult] = await Promise.allSettled([
      requestJson("/watchdog/agents/discovery?includeLocalWorkspace=true"),
      requestJson("/watchdog/agents"),
    ]);
    state.discovery = discoveryResult.status === "fulfilled"
      ? discoveryResult.value
      : {
          agents: [],
          candidates: [],
          candidateCounts: {},
          localWorkspaceResidue: [],
          localWorkspaceResidueCounts: {},
          counts: {},
        };
    state.registryById = registryResult.status === "fulfilled"
      ? Object.fromEntries((Array.isArray(registryResult.value) ? registryResult.value : []).map((agent) => [agent.id, agent]))
      : {};
    if (discoveryResult.status !== "fulfilled") {
      throw discoveryResult.reason;
    }
  } catch (error) {
    state.discovery = {
      agents: [],
      candidates: [],
      candidateCounts: {},
      localWorkspaceResidue: [],
      localWorkspaceResidueCounts: {},
      counts: {},
    };
    state.registryById = {};
    toast(error.message || "读取 agent discovery 失败", "error");
  } finally {
    const allAgents = Array.isArray(state.discovery?.agents) ? state.discovery.agents : [];
    if (!allAgents.some((agent) => agent.id === state.rosterDetailId && agent.joinable !== true)) {
      state.rosterDetailId = null;
      resetGuidancePreview(null);
    } else if (!allAgents.some((agent) => agent.id === state.guidancePreview?.agentId)) {
      resetGuidancePreview(state.rosterDetailId || null);
    }
    state.loading = false;
    state.joiningAgentId = null;
    state.takingOverAgentId = null;
    state.deletingAgentId = null;
    state.deletingMode = null;
    renderPage();
  }
}

async function loadGuidancePreview(agentId, fileName) {
  state.guidancePreview = {
    agentId,
    fileName,
    loading: true,
    editing: false,
    saving: false,
    exists: null,
    guidanceState: null,
    workspacePath: null,
    content: "",
    draftContent: "",
    error: "",
  };
  renderPage();
  try {
    const result = await requestJson(`/watchdog/agents/guidance/read?agentId=${encodeURIComponent(agentId)}&file=${encodeURIComponent(fileName)}`);
    state.guidancePreview = {
      agentId: result.agentId || agentId,
      fileName: result.fileName || fileName,
      loading: false,
      editing: false,
      saving: false,
      exists: result.exists === true,
      guidanceState: result.guidanceState || null,
      workspacePath: result.workspacePath || null,
      content: typeof result.content === "string" ? result.content : "",
      draftContent: typeof result.content === "string" ? result.content : "",
      error: "",
    };
  } catch (error) {
    state.guidancePreview = {
      agentId,
      fileName,
      loading: false,
      editing: false,
      saving: false,
      exists: null,
      guidanceState: null,
      workspacePath: null,
      content: "",
      draftContent: "",
      error: error.message || "读取引导文件失败",
    };
  }
  renderPage();
}

async function saveGuidancePreview() {
  const preview = state.guidancePreview || null;
  if (!preview?.agentId || !preview?.fileName) return;
  state.guidancePreview = {
    ...preview,
    saving: true,
    error: "",
  };
  renderPage();
  try {
    await requestJson("/watchdog/agents/guidance/write", {
      method: "POST",
      body: JSON.stringify({
        agentId: preview.agentId,
        file: preview.fileName,
        content: preview.draftContent || "",
      }),
    });
    toast(`已保存引导文件: ${preview.agentId} / ${preview.fileName}`, "success");
    await loadDiscovery();
    await loadGuidancePreview(preview.agentId, preview.fileName);
  } catch (error) {
    state.guidancePreview = {
      ...preview,
      saving: false,
      editing: true,
      error: error.message || "保存引导文件失败",
    };
    renderPage();
  }
}

async function takeOverAgentGuidance(agent, files = []) {
  state.takingOverAgentId = agent.id;
  renderPage();
  try {
    const result = await requestJson("/watchdog/agents/guidance/takeover", {
      method: "POST",
      body: JSON.stringify({
        agentId: agent.id,
        ...(Array.isArray(files) && files.length > 0 ? { files } : {}),
      }),
    });
    const changed = (result.updatedFiles || []).filter((entry) => entry?.updated).map((entry) => entry.name);
    toast(
      changed.length > 0
        ? `已接管引导: ${agent.id} (${changed.join(", ")})`
        : `已刷新引导: ${agent.id}`,
      "success",
    );
    await loadDiscovery();
  } catch (error) {
    toast(error.message || "接管引导失败", "error");
    state.takingOverAgentId = null;
    renderPage();
  }
}

async function deleteAgentFromSystem(agentId, mode = AGENT_REMOVAL_MODE.DELETE) {
  const action = resolveAgentRemovalAction(mode, agentId);
  state.deletingAgentId = agentId;
  state.deletingMode = action.mode;
  renderPage();
  try {
    await requestJson(action.path, {
      method: "POST",
      body: JSON.stringify({ agentId, explicitConfirm: true }),
    });
    toast(action.successToast, "success");
    state.rosterDetailId = null;
    resetGuidancePreview(null);
    await loadDiscovery();
  } catch (error) {
    toast(error.message || "移除 agent 失败", "error");
    state.deletingAgentId = null;
    state.deletingMode = null;
    renderPage();
  }
}

function init() {
  initDashboardSubpage({ page: "agents" });
  renderToolbar();
  loadDiscovery();
}

init();
