// dashboard-harness.js — 「塑形套件 / 调试工作台」控制器（B 重设计）
//
// 以「一个 harness」为中心调试：左 harness 列表 → 右 动作条 + 模块流水线 + 选中模块明细 + 运行历史。
// 数据：GET /watchdog/harness（placements）+ GET /watchdog/inspect?surface=inspect.harness_runs（HarnessRun 明细）。
// 动作：POST /watchdog/automations/run（触发一次调试 run）。verify/edit 为后续增量。

import { esc, getToken } from "./dashboard-common.js";
import { tx } from "./dashboard-harness-shared.js";
import { renderWorkstation } from "./dashboard-harness-workstation.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";

const KIND_ORDER = ["guard", "collector", "gate", "normalizer"];

const state = {
  loading: true,
  error: null,
  summary: null,        // GET /watchdog/harness
  runs: [],             // inspect.harness_runs（全量近期 HarnessRun）
  selectedAutomationId: null,
  selectedRound: null,
  selectedModuleId: null,
  actionMsg: null,
  catalog: null,         // inspect.harness_catalog（编辑模态/校验用 module→kind）
  editing: null,         // 正在编辑的 automationId（改 模态）
  draftModuleRefs: [],   // 编辑草稿
  showComposition: false, // 校验(结构) composition 条是否显示
};

function tokenParam() {
  return encodeURIComponent(getToken() || "");
}

async function requestJson(path, { method = "GET", body = null } = {}) {
  const opts = { method };
  if (body != null) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const response = await fetch(path, opts);
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function getPlacements() {
  return Array.isArray(state.summary?.placements) ? state.summary.placements : [];
}

function countModules(run) {
  const mr = Array.isArray(run?.moduleRuns) ? run.moduleRuns : [];
  return {
    passed: mr.filter((m) => m.status === "passed").length,
    failed: mr.filter((m) => m.status === "failed").length,
    pending: mr.filter((m) => m.status === "pending").length,
  };
}

// 可调试 harness 列表 = 已配置 placements ∪ harness_runs 里出现过的 automationId（含 loop_session）。
// 后者无 placement 但有真实运行记录，合成一个可调试条目，状态/计数取最近一轮。
function getHarnessList() {
  // 真 placement(已配置 automation)→ editable(可经 automations.update 改 moduleRefs)。
  const byId = new Map(getPlacements().map((p) => [p.id, { ...p, editable: true }]));
  for (const run of state.runs) {
    const id = run?.automationId;
    if (!id || byId.has(id)) continue;
    const latest = runsForAutomation(id)[0];
    const c = countModules(latest);
    // run-derived(loop_session 等)无 automation spec → 不可编辑。
    byId.set(id, {
      id,
      harnessProfileId: latest?.harnessProfileId || latest?.profileId || null,
      runtimeStatus: latest?.status || "completed",
      executionMode: latest?.executionMode || null,
      gateVerdict: latest?.gateSummary?.verdict || null,
      passedModuleCount: c.passed,
      failedModuleCount: c.failed,
      pendingModuleCount: c.pending,
      editable: false,
    });
  }
  return [...byId.values()];
}

function runsForAutomation(automationId) {
  if (!automationId) return [];
  return state.runs
    .filter((run) => run && run.automationId === automationId)
    .sort((a, b) => (Number(b.round) || 0) - (Number(a.round) || 0));
}

function orderedModules(run) {
  if (!run || !Array.isArray(run.moduleRuns)) return [];
  return [...run.moduleRuns].sort((a, b) => {
    const ra = KIND_ORDER.indexOf(String(a.kind || "").toLowerCase());
    const rb = KIND_ORDER.indexOf(String(b.kind || "").toLowerCase());
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
}

function ensureSelection() {
  const placements = getHarnessList();
  if (!placements.some((p) => p.id === state.selectedAutomationId)) {
    // 默认优先选「最近一轮有模块流水线」的 harness，让流水线默认可见（freeform 无模块的排后）。
    const withModules = placements.find((p) => {
      const latest = runsForAutomation(p.id)[0];
      return Array.isArray(latest?.moduleRuns) && latest.moduleRuns.length > 0;
    });
    state.selectedAutomationId = (withModules || placements[0])?.id || null;
    state.selectedRound = null;
    state.selectedModuleId = null;
  }
  const runs = runsForAutomation(state.selectedAutomationId);
  if (!runs.some((r) => Number(r.round) === Number(state.selectedRound))) {
    state.selectedRound = runs[0]?.round ?? null;
    state.selectedModuleId = null;
  }
  const selectedRun = runs.find((r) => Number(r.round) === Number(state.selectedRound)) || runs[0] || null;
  const modules = orderedModules(selectedRun);
  if (!modules.some((m) => m.moduleId === state.selectedModuleId)) {
    state.selectedModuleId = modules[0]?.moduleId || null;
  }
}

function buildModel() {
  const runsForSelected = runsForAutomation(state.selectedAutomationId);
  const selectedRun = runsForSelected.find((r) => Number(r.round) === Number(state.selectedRound))
    || runsForSelected[0] || null;
  return {
    placements: getHarnessList(),
    selectedAutomationId: state.selectedAutomationId,
    selectedRun,
    runsForSelected,
    selectedModuleId: state.selectedModuleId,
    catalog: state.catalog,
    editing: state.editing,
    draftModuleRefs: state.draftModuleRefs,
    showComposition: state.showComposition,
  };
}

function bindEvents() {
  const host = document.getElementById("harnessApp");
  if (!host) return;

  host.querySelectorAll("[data-automation-id]").forEach((el) => {
    if (el.hasAttribute("data-ws-action")) return; // 动作按钮单独绑
    el.addEventListener("click", () => {
      state.selectedAutomationId = el.getAttribute("data-automation-id");
      state.selectedRound = null;
      state.selectedModuleId = null;
      state.actionMsg = null;
      render();
    });
  });

  host.querySelectorAll("[data-module-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedModuleId = el.getAttribute("data-module-id");
      render();
    });
  });

  host.querySelectorAll("[data-run-round]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedRound = Number(el.getAttribute("data-run-round"));
      state.selectedModuleId = null;
      render();
    });
  });

  host.querySelectorAll('[data-ws-action="trigger"]').forEach((el) => {
    el.addEventListener("click", () => triggerDebugRun(el.getAttribute("data-automation-id")));
  });

  // 校验(结构):切换 composition 条显示。
  host.querySelectorAll('[data-ws-action="verify"]').forEach((el) => {
    el.addEventListener("click", () => { state.showComposition = !state.showComposition; render(); });
  });

  // 改:打开编辑模态,草稿预填当前 placement.moduleRefs。
  host.querySelectorAll('[data-ws-action="edit"]').forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-automation-id");
      const placement = getHarnessList().find((p) => p.id === id);
      state.editing = id;
      state.draftModuleRefs = Array.isArray(placement?.moduleRefs) ? [...placement.moduleRefs] : [];
      state.actionMsg = null;
      render();
    });
  });

  // 模态:切换模块 / 取消 / 保存 / 点背板关闭。
  host.querySelectorAll("[data-ws-toggle-module]").forEach((el) => {
    el.addEventListener("click", () => {
      const mid = el.getAttribute("data-ws-toggle-module");
      const set = new Set(state.draftModuleRefs);
      if (set.has(mid)) set.delete(mid); else set.add(mid);
      state.draftModuleRefs = [...set];
      render();
    });
  });
  host.querySelectorAll('[data-ws-action="cancel-edit"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      // 背板点击才关；模态内部点击(冒泡到背板)被 data-ws-modal-stop 拦下。
      if (el.classList.contains("ws-modal-backdrop") && e.target !== el) return;
      state.editing = null;
      state.draftModuleRefs = [];
      render();
    });
  });
  host.querySelectorAll('[data-ws-modal-stop]').forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
  });
  host.querySelectorAll('[data-ws-action="save-edit"]').forEach((el) => {
    el.addEventListener("click", () => saveHarnessEdit());
  });
}

async function saveHarnessEdit() {
  const automationId = state.editing;
  if (!automationId) return;
  const moduleRefs = [...state.draftModuleRefs];
  state.actionMsg = tx("ws_saving");
  render();
  try {
    const res = await requestJson(`/watchdog/automations/update?token=${tokenParam()}`, {
      method: "POST",
      body: { automationId, harness: { moduleRefs } },
    });
    // 服务端权威 composition.problems(若有)回显。
    const problems = res?.automation?.harness?.composition?.problems || [];
    const warnCount = problems.filter((p) => p.severity === "warn").length;
    state.actionMsg = warnCount > 0
      ? `${tx("ws_saved")}（${tx("ws_comp_warn_count", { n: warnCount })}）`
      : tx("ws_saved");
    state.editing = null;
    state.draftModuleRefs = [];
    await loadDashboard({ preserveLoading: true });
  } catch (error) {
    state.actionMsg = `${tx("ws_save_failed")}: ${error.message}`;
    render();
  }
}

async function triggerDebugRun(automationId) {
  if (!automationId) return;
  if (!window.confirm(tx("ws_confirm_trigger", { id: automationId }))) return;
  state.actionMsg = tx("ws_triggering");
  render();
  try {
    await requestJson(`/watchdog/automations/run?token=${tokenParam()}`, {
      method: "POST",
      body: { automationId },
    });
    state.actionMsg = tx("ws_triggered");
    await loadDashboard({ preserveLoading: true });
  } catch (error) {
    state.actionMsg = `${tx("ws_trigger_failed")}: ${error.message}`;
    render();
  }
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
  if (!getHarnessList().length) {
    host.innerHTML = `<div class="harness-placeholder"><div class="harness-placeholder-title">${esc(tx("ws_harness_list"))}</div><div class="harness-placeholder-copy">${esc(tx("load_empty"))}</div></div>`;
    return;
  }

  ensureSelection();
  const banner = state.actionMsg
    ? `<div class="ws-banner">${esc(state.actionMsg)}</div>`
    : "";
  host.innerHTML = `${banner}${renderWorkstation(buildModel())}`;
  bindEvents();
}

async function loadDashboard({ preserveLoading = false } = {}) {
  if (!preserveLoading) state.loading = true;
  state.error = null;
  render();
  try {
    const [summary, runsData, catalogData] = await Promise.all([
      requestJson(`/watchdog/harness?token=${tokenParam()}`),
      requestJson(`/watchdog/inspect?surface=inspect.harness_runs&limit=60&token=${tokenParam()}`)
        .catch(() => []),
      requestJson(`/watchdog/inspect?surface=inspect.harness_catalog&token=${tokenParam()}`)
        .catch(() => null),
    ]);
    state.summary = summary;
    state.runs = Array.isArray(runsData) ? runsData : (Array.isArray(runsData?.runs) ? runsData.runs : []);
    state.catalog = catalogData && Array.isArray(catalogData.modules) ? catalogData : state.catalog;
    ensureSelection();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

initDashboardSubpage({ page: "harness" });
void loadDashboard();
window.setInterval(() => { void loadDashboard({ preserveLoading: true }); }, 30000);
