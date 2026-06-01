import { esc, getToken } from "./dashboard-common.js";
import { renderAtlasView } from "./dashboard-harness-atlas.js";
import { renderPlacementView } from "./dashboard-harness-placement.js";
import { renderRunsView } from "./dashboard-harness-runs.js";
import {
  VIEW_MODES,
  renderPlaceholder,
  renderViewTabs,
  tx,
} from "./dashboard-harness-shared.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";

const state = {
  loading: true,
  error: null,
  payload: null,
  activeView: VIEW_MODES.ATLAS,
  selectedFamilyId: "all",
  selectedProfileId: null,
  selectedAutomationId: null,
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
  return state.payload || {
    counts: {},
    catalog: { families: [], profiles: [], modules: [] },
    placements: [],
  };
}

function getFamilies() {
  return Array.isArray(getPayload().catalog?.families) ? getPayload().catalog.families : [];
}

function getProfiles() {
  return Array.isArray(getPayload().catalog?.profiles) ? getPayload().catalog.profiles : [];
}

function getModules() {
  return Array.isArray(getPayload().catalog?.modules) ? getPayload().catalog.modules : [];
}

function getPlacements() {
  return Array.isArray(getPayload().placements) ? getPayload().placements : [];
}

function hasRunTrack(placement) {
  return Array.isArray(placement?.recentRuns) && placement.recentRuns.length > 0;
}

function getRunPlacements() {
  const placements = getPlacements();
  const withRuns = placements.filter((placement) => hasRunTrack(placement));
  return withRuns.length ? withRuns : placements;
}

function getFilteredProfiles() {
  const familyId = state.selectedFamilyId;
  const profiles = getProfiles();
  if (!familyId || familyId === "all") return profiles;
  return profiles.filter((profile) => profile.family === familyId);
}

function getSelectedProfile() {
  return getProfiles().find((profile) => profile.id === state.selectedProfileId) || null;
}

function getFilteredModules() {
  const familyId = state.selectedFamilyId;
  const selectedProfile = getSelectedProfile();
  const selectedProfileModules = new Set(Array.isArray(selectedProfile?.moduleRefs) ? selectedProfile.moduleRefs : []);
  return [...getModules()]
    .filter((module) => {
      if (!familyId || familyId === "all") return true;
      return Array.isArray(module.familyIds) && module.familyIds.includes(familyId);
    })
    .sort((left, right) => {
      const leftInProfile = selectedProfileModules.has(left.id) ? 1 : 0;
      const rightInProfile = selectedProfileModules.has(right.id) ? 1 : 0;
      if (rightInProfile !== leftInProfile) return rightInProfile - leftInProfile;
      if ((right.usageCount || 0) !== (left.usageCount || 0)) return (right.usageCount || 0) - (left.usageCount || 0);
      return String(left.id || "").localeCompare(String(right.id || ""));
    });
}

function ensureSelection() {
  const families = getFamilies();
  const profiles = getFilteredProfiles();
  const allPlacements = getPlacements();
  const placements = state.activeView === VIEW_MODES.RUNS ? getRunPlacements() : allPlacements;

  if (state.selectedFamilyId !== "all" && !families.some((family) => family.id === state.selectedFamilyId)) {
    state.selectedFamilyId = "all";
  }

  if (!profiles.some((profile) => profile.id === state.selectedProfileId)) {
    state.selectedProfileId = profiles[0]?.id || getProfiles()[0]?.id || null;
  }

  if (!placements.some((placement) => placement.id === state.selectedAutomationId)) {
    state.selectedAutomationId = placements[0]?.id || allPlacements[0]?.id || null;
  }
}

function buildViewModel() {
  const allProfiles = getProfiles();
  const placements = getPlacements();
  const runPlacements = getRunPlacements();
  const selectedPlacement = placements.find((placement) => placement.id === state.selectedAutomationId) || null;
  const selectedRunPlacement = runPlacements.find((placement) => placement.id === state.selectedAutomationId) || runPlacements[0] || null;

  return {
    counts: getPayload().counts || {},
    families: getFamilies(),
    allProfiles,
    filteredProfiles: getFilteredProfiles(),
    filteredModules: getFilteredModules(),
    selectedFamilyId: state.selectedFamilyId,
    selectedProfileId: state.selectedProfileId,
    selectedProfile: getSelectedProfile(),
    placements,
    runPlacements,
    selectedAutomationId: state.selectedAutomationId,
    selectedPlacement,
    selectedRunPlacement,
  };
}

function renderBody(model) {
  switch (state.activeView) {
    case VIEW_MODES.PLACEMENT:
      return renderPlacementView(model);
    case VIEW_MODES.RUNS:
      return renderRunsView(model);
    case VIEW_MODES.DRIFT:
      return renderPlaceholder("drift_reserved_title", "drift_reserved_copy", model.counts);
    case VIEW_MODES.ATLAS:
    default:
      return renderAtlasView(model);
  }
}

function bindEvents() {
  const host = document.getElementById("harnessApp");
  if (!host) return;

  host.querySelectorAll("[data-harness-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeView = button.getAttribute("data-harness-view") || VIEW_MODES.ATLAS;
      render();
    });
  });

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

  host.querySelectorAll("[data-automation-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedAutomationId = button.getAttribute("data-automation-id");
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
  const model = buildViewModel();
  host.innerHTML = `${renderViewTabs(state.activeView)}${renderBody(model)}`;
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
