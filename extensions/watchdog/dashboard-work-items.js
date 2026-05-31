import { esc, getToken } from "./dashboard-common.js";
import { formatDateTime, t } from "./dashboard-i18n.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";
import {
  buildWorkItemViewSearch,
  buildWorkItemSummary,
  filterAndSortWorkItems,
  normalizeWorkItemFilters,
  parseWorkItemViewState,
  resolveSelectedWorkItemId,
} from "./dashboard-work-items-state.js";

const REFRESH_INTERVAL_MS = 30000;
const INITIAL_VIEW_STATE = (
  typeof window !== "undefined" && window.location
    ? parseWorkItemViewState(window.location.search)
    : { filters: normalizeWorkItemFilters(), selectedId: null }
);

const state = {
  loading: true,
  error: "",
  items: [],
  filters: INITIAL_VIEW_STATE.filters,
  selectedId: INITIAL_VIEW_STATE.selectedId,
  backHref: INITIAL_VIEW_STATE.backHref || "/watchdog/progress",
};


function buildApiUrl(path) {
  const token = getToken();
  return token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
}

async function requestJson(path) {
  const response = await fetch(buildApiUrl(path));
  const text = await response.text();
  let data = [];
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    data = { error: text || `request failed: ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(data?.error || `request failed: ${response.status}`);
  }
  return data;
}

function resolveWorkItemsPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
}

function formatTimestamp(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) {
    return "--";
  }
  return formatDateTime(ts);
}

function formatStatusLabel(status) {
  const normalized = String(status || "").toLowerCase();
  if (!normalized) {
    return "--";
  }
  const key = `work_items.status.${normalized}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

function buildStatusOptions(items) {
  const preferred = ["pending", "running", "awaiting_input", "completed", "failed", "cancelled"];
  const seen = new Set(preferred);
  const discovered = (Array.isArray(items) ? items : [])
    .map((item) => String(item?.status || "").trim())
    .filter(Boolean)
    .filter((status) => !seen.has(status));
  return ["all", ...preferred, ...discovered];
}

function buildAssigneeOptions(items) {
  return ["all", ...(Array.from(new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item?.assignee || "").trim())
    .filter(Boolean))))
    .sort((left, right) => left.localeCompare(right, "zh-CN"))];
}

// 统计卡可点 → 设状态筛选（statusValue=null 则为不可点的纯展示卡，如加载/错误占位）。
function renderSummaryCard(label, value, tone = "default", statusValue = null, active = false) {
  const clickable = statusValue !== null && statusValue !== undefined;
  const cls = `work-items-summary-card tone-${esc(tone)}${clickable ? " is-clickable" : ""}${active ? " is-active" : ""}`;
  if (!clickable) {
    return `<article class="${cls}"><div class="work-items-summary-label">${esc(label)}</div><div class="work-items-summary-value">${esc(value)}</div></article>`;
  }
  return `
    <button type="button" class="${cls}" data-stat-filter="${esc(statusValue)}" aria-pressed="${active ? "true" : "false"}">
      <div class="work-items-summary-label">${esc(label)}</div>
      <div class="work-items-summary-value">${esc(value)}</div>
    </button>
  `;
}

function resolveDisplayValue(value) {
  if (value === null || value === undefined || value === "") {
    return "--";
  }
  return String(value);
}

function resolveStageDisplay(item) {
  const activityProgress = item?.activityProgress || {};
  const stageProjection = item?.stageProjection || {};
  const stageRuntime = item?.stageRuntime || {};
  const stage = (
    activityProgress.currentStage
    || activityProgress.stage
    || stageProjection.currentStage
    || stageProjection.stage
    || stageRuntime.currentStage
    || stageRuntime.stage
    || item?.replyTargetAgent
    || "--"
  );
  const round = (
    activityProgress.round
    ?? stageProjection.round
    ?? stageRuntime.round
  );
  return {
    stage,
    round: Number.isFinite(Number(round)) ? String(round) : "--",
  };
}

function formatBooleanLabel(value) {
  if (value === true) {
    return t("work_items.bool.yes");
  }
  if (value === false) {
    return t("work_items.bool.no");
  }
  return "--";
}

function renderToolbar({ filters, items }) {
  const statuses = buildStatusOptions(items);
  const assignees = buildAssigneeOptions(items);
  return `
    <div class="work-items-toolbar-grid">
      <label class="work-items-filter">
        <span>${esc(t("work_items.filter.status"))}</span>
        <select data-filter-status>
          ${statuses.map((status) => `
            <option value="${esc(status)}"${status === filters.status ? " selected" : ""}>
              ${esc(status === "all" ? t("work_items.filter.all") : formatStatusLabel(status))}
            </option>
          `).join("")}
        </select>
      </label>
      <label class="work-items-filter">
        <span>${esc(t("work_items.filter.assignee"))}</span>
        <select data-filter-assignee>
          ${assignees.map((assignee) => `
            <option value="${esc(assignee)}"${assignee === filters.assignee ? " selected" : ""}>
              ${esc(assignee === "all" ? t("work_items.filter.all") : assignee)}
            </option>
          `).join("")}
        </select>
      </label>
      <label class="work-items-filter">
        <span>${esc(t("work_items.filter.search"))}</span>
        <input
          type="search"
          placeholder="${esc(t("work_items.filter.search_placeholder"))}"
          value="${esc(filters.query)}"
          data-filter-query
        >
      </label>
    </div>
  `;
}

function renderListItem(item, active = false) {
  const status = String(item?.status || "").toLowerCase();
  const stageDisplay = resolveStageDisplay(item);
  return `
    <button class="work-item-row${active ? " active" : ""}" type="button" data-select-work-item="${esc(item?.id || "")}">
      <div class="work-item-row-top">
        <strong>${esc(item?.task || item?.id || t("work_items.list.unnamed"))}</strong>
        <span class="work-item-status status-${esc(status || "unknown")}">${esc(formatStatusLabel(item?.status))}</span>
      </div>
      <div class="work-item-row-meta">
        <span>${esc(item?.id || "--")}</span>
        <span>${esc(item?.assignee || "--")}</span>
      </div>
      <div class="work-item-row-foot">
        <span>${esc(stageDisplay.stage)}</span>
        <span>${esc(formatTimestamp(item?.updatedAt || item?.createdAt))}</span>
      </div>
    </button>
  `;
}

function renderField(label, value) {
  return `
    <div class="work-item-field">
      <span>${esc(label)}</span>
      <strong>${esc(resolveDisplayValue(value))}</strong>
    </div>
  `;
}

function renderFieldGroup(fields = []) {
  return fields.map(({ label, value }) => renderField(label, value)).join("");
}

function renderDetailSection(title, fields = []) {
  return `
    <section class="work-item-detail-section">
      <div class="work-item-detail-section-title">${esc(title)}</div>
      <div class="work-item-detail-grid">
        ${renderFieldGroup(fields)}
      </div>
    </section>
  `;
}

function renderDetail(item) {
  if (!item) {
    return `
      <div class="work-items-empty">
        <div class="work-items-empty-title">${esc(t("work_items.empty.title"))}</div>
        <div class="work-items-empty-copy">${esc(t("work_items.empty.copy"))}</div>
      </div>
    `;
  }

  const stageDisplay = resolveStageDisplay(item);
  const stageLabel = stageDisplay.stage;
  const roundLabel = stageDisplay.round;
  const originSurface = item?.operatorContext?.originSurfaceId || item?.requestedSource || "--";
  const terminalReason = item?.terminalOutcome?.reason || item?.failReason || "--";
  const operatorContextSection = renderDetailSection(t("work_items.section.operator_context"), [
    { label: t("work_items.operator.requested_source"), value: item?.requestedSource },
    { label: t("work_items.operator.origin_surface"), value: item?.operatorContext?.originSurfaceId },
    { label: t("work_items.operator.origin_draft"), value: item?.operatorContext?.originDraftId },
    { label: t("work_items.operator.origin_execution"), value: item?.operatorContext?.originExecutionId },
  ]);
  const coordinationSection = renderDetailSection(t("work_items.section.coordination"), [
    { label: t("work_items.coordination.owner"), value: item?.coordination?.owner?.agentId || item?.assignee },
    { label: t("work_items.coordination.caller"), value: item?.coordination?.caller?.agentId || item?.caller },
    { label: t("work_items.coordination.reply_target"), value: item?.replyTargetAgent },
    { label: t("work_items.coordination.upstream_reply_target"), value: item?.upstreamReplyTargetAgent },
    { label: t("work_items.coordination.return_mode"), value: item?.coordination?.return?.mode },
    { label: t("work_items.coordination.return_source_agent"), value: item?.coordination?.return?.sourceAgentId || item?.returnSourceAgent },
  ]);
  const terminalSection = renderDetailSection(t("work_items.section.terminal_outcome"), [
    { label: t("work_items.terminal.status"), value: formatStatusLabel(item?.terminalOutcome?.status) },
    { label: t("work_items.terminal.source"), value: item?.terminalOutcome?.source },
    { label: t("work_items.terminal.reason"), value: item?.terminalOutcome?.reason || item?.failReason },
    { label: t("work_items.terminal.retryable"), value: formatBooleanLabel(item?.terminalOutcome?.retryable) },
    { label: t("work_items.terminal.tests_passed"), value: formatBooleanLabel(item?.terminalOutcome?.testsPassed) },
    { label: t("work_items.terminal.timestamp"), value: formatTimestamp(item?.terminalOutcome?.ts) },
  ]);

  return `
    <section class="work-item-detail-card">
      <header class="work-item-detail-head">
        <div>
          <div class="work-item-detail-kicker">${esc(t("work_items.detail.selected"))}</div>
          <h2>${esc(item?.task || item?.id || t("work_items.list.unnamed"))}</h2>
        </div>
        <span class="work-item-status status-${esc(String(item?.status || "").toLowerCase())}">${esc(formatStatusLabel(item?.status))}</span>
      </header>
      <div class="work-item-detail-grid">
        ${renderField(t("work_items.detail.work_item"), item?.id)}
        ${renderField(t("work_items.detail.assignee"), item?.assignee)}
        ${renderField(t("work_items.detail.stage"), stageLabel)}
        ${renderField(t("work_items.detail.round"), roundLabel)}
        ${renderField(t("work_items.detail.origin"), originSurface)}
        ${renderField(t("work_items.detail.protocol"), item?.protocolEnvelope || item?.protocol?.envelope)}
        ${renderField(t("work_items.detail.output"), item?.output)}
        ${renderField(t("work_items.detail.terminal_reason"), terminalReason)}
        ${renderField(t("work_items.detail.created_at"), formatTimestamp(item?.createdAt))}
        ${renderField(t("work_items.detail.updated_at"), formatTimestamp(item?.updatedAt))}
      </div>
      <div class="work-item-detail-sections">
        ${operatorContextSection}
        ${coordinationSection}
        ${terminalSection}
      </div>
    </section>
  `;
}

function renderLoading(host) {
  host.summary.innerHTML = renderSummaryCard(t("work_items.summary.total"), t("work_items.loading.value"));
  host.toolbar.innerHTML = "";
  host.list.innerHTML = `
    <div class="work-items-empty">
      <div class="work-items-empty-title">${esc(t("work_items.loading.title"))}</div>
      <div class="work-items-empty-copy">${esc(t("work_items.loading.copy"))}</div>
    </div>
  `;
  host.detail.innerHTML = `
    <div class="work-items-empty">
      <div class="work-items-empty-title">${esc(t("work_items.loading.detail_title"))}</div>
      <div class="work-items-empty-copy">${esc(t("work_items.loading.detail_copy"))}</div>
    </div>
  `;
}

function renderError(host, message) {
  host.summary.innerHTML = renderSummaryCard(t("work_items.error.summary_label"), t("work_items.error.summary_value"), "failed");
  host.toolbar.innerHTML = "";
  host.list.innerHTML = `
    <div class="work-items-empty">
      <div class="work-items-empty-title">${esc(t("work_items.error.title"))}</div>
      <div class="work-items-empty-copy">${esc(message || t("work_items.error.unknown"))}</div>
    </div>
  `;
  host.detail.innerHTML = `
    <div class="work-items-empty">
      <div class="work-items-empty-title">${esc(t("work_items.error.detail_title"))}</div>
      <div class="work-items-empty-copy">${esc(t("work_items.error.detail_copy"))}</div>
    </div>
  `;
}

export function renderWorkItemsPage({ items, filters, selectedId, host }) {
  const visible = filterAndSortWorkItems(items, filters);
  const summary = buildWorkItemSummary(visible);
  const resolvedId = resolveSelectedWorkItemId(visible, selectedId);
  const selected = visible.find((item) => item?.id === resolvedId) || null;

  const activeStatus = normalizeWorkItemFilters(filters).status;
  host.summary.innerHTML = [
    renderSummaryCard(t("work_items.summary.total"), summary.total, "default", "all", activeStatus === "all"),
    renderSummaryCard(t("work_items.summary.active"), summary.active, "active", "running", activeStatus === "running"),
    renderSummaryCard(t("work_items.summary.completed"), summary.completed, "completed", "completed", activeStatus === "completed"),
    renderSummaryCard(t("work_items.summary.failed"), summary.failed, "failed", "failed", activeStatus === "failed"),
    renderSummaryCard(t("work_items.summary.awaiting_input"), summary.awaitingInput, "awaiting", "awaiting_input", activeStatus === "awaiting_input"),
  ].join("");

  host.toolbar.innerHTML = renderToolbar({ filters: normalizeWorkItemFilters(filters), items });

  // 空时：布局收为单列，只显示一个设计过的空状态（修复此前左右栏重复同一空框的 bug）。
  // 经 host.layout 或 host 容器取布局元素;无 DOM 环境(单测桩)时优雅跳过——不裸调全局 document。
  const hasVisible = visible.length > 0;
  const layout = host.layout
    || (typeof host.querySelector === "function" ? host.querySelector(".work-items-layout") : null)
    || (typeof document !== "undefined" ? document.querySelector(".work-items-layout") : null);
  if (layout) layout.classList.toggle("is-empty", !hasVisible);
  if (hasVisible) {
    host.list.innerHTML = visible.map((item) => renderListItem(item, item?.id === resolvedId)).join("");
    host.detail.innerHTML = renderDetail(selected);
  } else {
    host.list.innerHTML = `
      <div class="work-items-empty">
        <div class="work-items-empty-mark">∅</div>
        <div class="work-items-empty-title">${esc(t("work_items.empty.title"))}</div>
        <div class="work-items-empty-copy">${esc(t("work_items.empty.copy"))}</div>
      </div>
    `;
    host.detail.innerHTML = "";
  }

  return { visible, selectedId: resolvedId };
}

function getHost() {
  return {
    summary: document.getElementById("workItemsSummary"),
    toolbar: document.getElementById("workItemsToolbar"),
    list: document.getElementById("workItemsList"),
    detail: document.getElementById("workItemsDetail"),
  };
}

function syncViewStateToUrl() {
  if (
    typeof window === "undefined"
    || !window.location
    || !window.history?.replaceState
  ) {
    return;
  }

  const nextSearchBody = buildWorkItemViewSearch(window.location.search, {
    filters: state.filters,
    selectedId: state.selectedId,
  });
  const nextSearch = nextSearchBody ? `?${nextSearchBody}` : "";
  const currentSearch = window.location.search || "";
  if (nextSearch === currentSearch) {
    return;
  }

  window.history.replaceState(
    null,
    "",
    `${window.location.pathname || ""}${nextSearch}${window.location.hash || ""}`,
  );
}

function bindToolbarEvents(host) {
  const statusField = host.toolbar.querySelector("[data-filter-status]");
  const assigneeField = host.toolbar.querySelector("[data-filter-assignee]");
  const queryField = host.toolbar.querySelector("[data-filter-query]");

  if (statusField) {
    statusField.addEventListener("change", () => {
      state.filters = normalizeWorkItemFilters({
        ...state.filters,
        status: statusField.value,
      });
      render();
    });
  }

  if (assigneeField) {
    assigneeField.addEventListener("change", () => {
      state.filters = normalizeWorkItemFilters({
        ...state.filters,
        assignee: assigneeField.value,
      });
      render();
    });
  }

  if (queryField) {
    queryField.addEventListener("input", () => {
      state.filters = normalizeWorkItemFilters({
        ...state.filters,
        query: queryField.value,
      });
      render();
    });
  }
}

function bindListEvents(host) {
  host.list.querySelectorAll("[data-select-work-item]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.getAttribute("data-select-work-item");
      render();
    });
  });
}

function render() {
  const host = getHost();
  if (!host.summary || !host.toolbar || !host.list || !host.detail) {
    return;
  }

  if (state.loading) {
    renderLoading(host);
    return;
  }

  if (state.error) {
    renderError(host, state.error);
    return;
  }

  const result = renderWorkItemsPage({
    items: state.items,
    filters: state.filters,
    selectedId: state.selectedId,
    host,
  });
  state.selectedId = result.selectedId;
  syncViewStateToUrl();
  bindToolbarEvents(host);
  bindStatEvents(host);
  bindListEvents(host);
}

// 统计卡点击 = 设状态筛选（与工具栏下拉等价；点已选中的卡则回到「全部」）。
function bindStatEvents(host) {
  host.summary.querySelectorAll("[data-stat-filter]").forEach((card) => {
    card.addEventListener("click", () => {
      const next = card.getAttribute("data-stat-filter");
      const cur = normalizeWorkItemFilters(state.filters).status;
      state.filters = normalizeWorkItemFilters({
        ...state.filters,
        status: cur === next ? "all" : next,
      });
      render();
    });
  });
}

async function loadWorkItems({ preserveLoading = false } = {}) {
  if (!preserveLoading) {
    state.loading = true;
    render();
  }

  state.error = "";
  try {
    const payload = await requestJson("/watchdog/work-items");
    state.items = resolveWorkItemsPayload(payload);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

function bootWorkItemsPage() {
  initDashboardSubpage({
    page: "work-items",
    backHref: state.backHref,
  });
  render();
  void loadWorkItems();
  window.setInterval(() => {
    void loadWorkItems({ preserveLoading: true });
  }, REFRESH_INTERVAL_MS);
}

if (
  typeof window !== "undefined"
  && typeof document !== "undefined"
  && document.body?.dataset?.watchdogPage === "work-items"
) {
  bootWorkItemsPage();
}
