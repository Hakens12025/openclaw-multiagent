import { esc, getToken } from "./dashboard-common.js";
import { renderProfileFocus } from "./dashboard-harness-atlas.js";
import { renderRunCard } from "./dashboard-harness-runs.js";
import {
  renderSummaryCards,
  formatFamilyLabel,
  formatMode,
  formatCount,
  formatTrust,
  formatTrustClass,
  tx,
} from "./dashboard-harness-shared.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";

// 合并视图（profile 为中心，单页，无 tab）：
//   左 = 塑形方案(profile)清单 + 家族过滤；右 = 选中方案详情 = focus(复用 atlas) +
//   用到它的落点 agent + 运行历史(按 run.profileId 从各落点 recentRuns 聚合，复用 runRunCard)。
// 决策：3 视图原为不同主键镜头(profile/agent/run)，无单一外键 → profile 为中心收口，
// 落点泳道看板降级为详情里的"落点于"。

const state = {
  loading: true,
  error: null,
  payload: null,
  selectedFamilyId: "all",
  selectedProfileId: null,
};

function tokenParam() {
  return encodeURIComponent(getToken() || "");
}

async function requestJson(path) {
  const response = await fetch(path);
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

function getPayload() {
  return state.payload || { counts: {}, catalog: { families: [], profiles: [], modules: [] }, placements: [] };
}
function getFamilies() {
  return Array.isArray(getPayload().catalog?.families) ? getPayload().catalog.families : [];
}
function getProfiles() {
  return Array.isArray(getPayload().catalog?.profiles) ? getPayload().catalog.profiles : [];
}
function getPlacements() {
  return Array.isArray(getPayload().placements) ? getPayload().placements : [];
}
function getFilteredProfiles() {
  const fam = state.selectedFamilyId;
  const profiles = getProfiles();
  return (!fam || fam === "all") ? profiles : profiles.filter((p) => p.family === fam);
}
function getSelectedProfile() {
  return getProfiles().find((p) => p.id === state.selectedProfileId) || null;
}

// 用到该 profile 的运行：从所有落点的 recentRuns 里按 run.profileId 匹配聚合（profile↔run 是唯一直接链接）。
function profileRuns(profileId, placements) {
  const runs = [];
  for (const placement of placements) {
    for (const run of (Array.isArray(placement?.recentRuns) ? placement.recentRuns : [])) {
      if (run?.profileId === profileId) runs.push(run);
    }
  }
  return runs;
}
// 用到该 profile 的落点 agent（其 recentRuns 含该 profileId）。
function profileAgents(profileId, placements) {
  const agents = new Set();
  for (const placement of placements) {
    const used = (Array.isArray(placement?.recentRuns) ? placement.recentRuns : []).some((run) => run?.profileId === profileId);
    if (used) agents.add(placement.targetAgent || placement.label || placement.id);
  }
  return [...agents].filter(Boolean);
}

function ensureSelection() {
  const families = getFamilies();
  const profiles = getFilteredProfiles();
  if (state.selectedFamilyId !== "all" && !families.some((f) => f.id === state.selectedFamilyId)) {
    state.selectedFamilyId = "all";
  }
  if (!profiles.some((p) => p.id === state.selectedProfileId)) {
    state.selectedProfileId = profiles[0]?.id || getProfiles()[0]?.id || null;
  }
}

function renderFamilyFilter(families, selectedFamilyId) {
  const chip = (id, label, active) =>
    `<button type="button" class="harness-fam-chip${active ? " is-active" : ""}" data-family-id="${esc(id)}">${esc(label)}</button>`;
  return `<div class="harness-fam-filter">
    ${chip("all", tx("all_families"), selectedFamilyId === "all")}
    ${families.map((f) => chip(f.id, formatFamilyLabel(f.id), selectedFamilyId === f.id)).join("")}
  </div>`;
}

function renderProfileList(profiles, selectedId) {
  if (!profiles.length) {
    return `<div class="harness-empty">${esc(tx("load_empty"))}</div>`;
  }
  return profiles.map((profile) => `
    <button type="button" class="harness-card is-clickable${profile.id === selectedId ? " active" : ""}" data-profile-id="${esc(profile.id)}">
      <div class="harness-card-head">
        <div>
          <div class="harness-card-title">${esc(profile.id)}</div>
          <div class="harness-card-meta">${esc(formatFamilyLabel(profile.family))} · ${esc(formatMode(profile.defaultMode || "freeform"))}</div>
        </div>
        <span class="harness-chip ${formatTrustClass(profile.trustLevel)}">${esc(formatTrust(profile.trustLevel))}</span>
      </div>
      <div class="harness-card-text">${esc(tx("label_modules"))} ${esc(formatCount(profile.moduleRefs?.length || 0))} · ${esc(tx("tag_usage", { count: formatCount(profile.usageCount) }))}</div>
    </button>
  `).join("");
}

function renderProfileDetail(profile, placements) {
  if (!profile) {
    return `<div class="harness-empty">${esc(tx("merged_profile_empty"))}</div>`;
  }
  const agents = profileAgents(profile.id, placements);
  const runs = profileRuns(profile.id, placements);
  return `
    ${renderProfileFocus(profile)}
    <div class="harness-box">
      <div class="harness-box-title">${esc(tx("merged_placed_title"))}</div>
      <div class="harness-tag-row">
        ${agents.length
          ? agents.map((agent) => `<span class="harness-chip">${esc(agent)}</span>`).join("")
          : `<span class="harness-empty-inline">${esc(tx("merged_no_placed"))}</span>`}
      </div>
    </div>
    <div class="harness-box">
      <div class="harness-box-title">${esc(tx("merged_runs_title"))} (${runs.length})</div>
      <div class="harness-run-list">
        ${runs.length
          ? runs.map((run) => renderRunCard(run)).join("")
          : `<div class="harness-empty">${esc(tx("merged_no_runs"))}</div>`}
      </div>
    </div>
  `;
}

function bindEvents() {
  const host = document.getElementById("harnessApp");
  if (!host) return;
  host.querySelectorAll("[data-family-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedFamilyId = button.getAttribute("data-family-id") || "all";
      state.selectedProfileId = null;
      ensureSelection();
      render();
    });
  });
  host.querySelectorAll("[data-profile-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedProfileId = button.getAttribute("data-profile-id");
      render();
    });
  });
}

function render() {
  const host = document.getElementById("harnessApp");
  if (!host) return;

  if (state.loading) {
    host.innerHTML = `<div class="harness-empty">${esc(tx("loading"))}</div>`;
    return;
  }
  if (state.error) {
    host.innerHTML = `<div class="harness-placeholder"><div class="harness-placeholder-title">${esc(tx("load_failed"))}</div><div class="harness-placeholder-copy">${esc(state.error)}</div></div>`;
    return;
  }
  if (!getProfiles().length && !getPlacements().length) {
    host.innerHTML = `<div class="harness-placeholder"><div class="harness-placeholder-title">${esc(tx("label_profiles"))}</div><div class="harness-placeholder-copy">${esc(tx("load_empty"))}</div></div>`;
    return;
  }

  ensureSelection();
  const counts = getPayload().counts || {};
  const families = getFamilies();
  const profiles = getFilteredProfiles();
  const selectedProfile = getSelectedProfile();
  const placements = getPlacements();

  host.innerHTML = `
    ${renderSummaryCards(counts)}
    ${renderFamilyFilter(families, state.selectedFamilyId)}
    <div class="harness-merged">
      <aside class="harness-merged-list">${renderProfileList(profiles, state.selectedProfileId)}</aside>
      <section class="harness-merged-detail">${renderProfileDetail(selectedProfile, placements)}</section>
    </div>
  `;
  bindEvents();
}

async function loadHarnessDashboard({ preserveLoading = false } = {}) {
  if (!preserveLoading) {
    state.loading = true;
  }
  state.error = null;
  render();
  try {
    state.payload = await requestJson(`/watchdog/harness?token=${tokenParam()}`);
    ensureSelection();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

initDashboardSubpage({ page: "harness" });
void loadHarnessDashboard();
window.setInterval(() => {
  void loadHarnessDashboard({ preserveLoading: true });
}, 30000);
