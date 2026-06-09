// dashboard-harness-workstation.js — 「调试工作台」渲染（B 重设计）
//
// 以「一个 harness」为中心：左侧 harness 列表，右侧动作条 + 模块流水线 + 选中模块明细 + 运行历史。
// 数据全来自现成后端面：GET /watchdog/harness（placements）+ inspect.harness_runs（HarnessRun 明细）。
// 复用 dashboard-harness-shared 的 i18n/格式化助手，不重造。

import { esc } from "./dashboard-common.js";
import {
  tx,
  formatModuleLabel,
  formatKind,
  formatStatus,
  formatStatusClass,
  formatScore,
  formatRoundLabel,
  formatTimestamp,
  formatMode,
} from "./dashboard-harness-shared.js";

// 流水线按模块类别固定顺序排列（与 harness 两阶段一致：守卫→采集→闸门→归一）。
const KIND_ORDER = ["guard", "collector", "gate", "normalizer"];

function kindRank(kind) {
  const idx = KIND_ORDER.indexOf(String(kind || "").toLowerCase());
  return idx === -1 ? KIND_ORDER.length : idx;
}

function statusGlyph(status) {
  switch (String(status || "").toLowerCase()) {
    case "passed": return "✓";
    case "failed": return "✗";
    case "pending": return "…";
    case "skipped": return "–";
    default: return "•";
  }
}

// ── 左侧：harness 列表 ────────────────────────────────────────────────────────

function renderHarnessList(placements, selectedId) {
  if (!placements.length) {
    return `<div class="ws-list-empty">${esc(tx("load_empty"))}</div>`;
  }
  const items = placements.map((p) => {
    const selected = p.id === selectedId ? " is-selected" : "";
    const statusCls = formatStatusClass(p.runtimeStatus, "configured");
    const counts = [
      p.passedModuleCount ? `${p.passedModuleCount}✓` : null,
      p.failedModuleCount ? `${p.failedModuleCount}✗` : null,
      p.pendingModuleCount ? `${p.pendingModuleCount}…` : null,
    ].filter(Boolean).join(" ");
    return `
      <button class="ws-list-item${selected}" data-automation-id="${esc(p.id)}">
        <div class="ws-list-row">
          <span class="ws-list-name">${esc(p.id)}</span>
          <span class="ws-pill ws-pill-${esc(statusCls)}">${esc(formatStatus(p.runtimeStatus))}</span>
        </div>
        <div class="ws-list-meta">
          <span class="ws-list-profile">${esc(p.harnessProfileId || tx("label_no_profile"))}</span>
          <span class="ws-list-counts">${esc(counts || "—")}</span>
        </div>
      </button>`;
  }).join("");
  return `<div class="ws-list-scroll">${items}</div>`;
}

// ── 右上：动作条 ──────────────────────────────────────────────────────────────

function renderActionBar(placement) {
  if (!placement) {
    return `<div class="ws-actionbar"><span class="ws-actionbar-title">${esc(tx("ws_pick_harness"))}</span></div>`;
  }
  const statusCls = formatStatusClass(placement.runtimeStatus, "configured");
  return `
    <div class="ws-actionbar">
      <div class="ws-actionbar-id">
        <span class="ws-actionbar-title">${esc(placement.id)}</span>
        <span class="ws-pill ws-pill-${esc(statusCls)}">${esc(formatStatus(placement.runtimeStatus))}</span>
        ${placement.executionMode ? `<span class="ws-actionbar-mode">${esc(formatMode(placement.executionMode))}</span>` : ""}
      </div>
      <div class="ws-actionbar-buttons">
        <button class="ws-btn ws-btn-primary" data-ws-action="trigger" data-automation-id="${esc(placement.id)}">▶ ${esc(tx("ws_action_trigger"))}</button>
        <button class="ws-btn" data-ws-action="verify" data-automation-id="${esc(placement.id)}">✓ ${esc(tx("ws_action_verify"))}</button>
        ${placement.editable
          ? `<button class="ws-btn" data-ws-action="edit" data-automation-id="${esc(placement.id)}">✎ ${esc(tx("ws_action_edit"))}</button>`
          : `<button class="ws-btn" disabled title="${esc(tx("ws_edit_unavailable"))}">✎ ${esc(tx("ws_action_edit"))}</button>`}
      </div>
    </div>`;
}

// 客户端组装校验:端口 lib/harness/harness-composition.js 的规则(实时反馈;权威校验仍在服务端
// normalizeHarnessSelection 落 spec.composition）。kindMap: { moduleId: kind }（来自 inspect.harness_catalog）。
export function validateCompositionClient(moduleRefs, kindMap = {}) {
  const ids = [...new Set((Array.isArray(moduleRefs) ? moduleRefs : []).filter((id) => kindMap[id]))];
  const problems = [];
  if (ids.length === 0) return problems;
  const kinds = new Set(ids.map((id) => kindMap[id]));
  const has = (id) => ids.includes(id);
  if (!kinds.has("gate")) problems.push({ severity: "warn", reason: tx("ws_comp_no_gate") });
  if (!kinds.has("guard")) problems.push({ severity: "warn", reason: tx("ws_comp_no_guard") });
  if (kinds.has("gate") && !kinds.has("collector")) problems.push({ severity: "info", reason: tx("ws_comp_gate_no_collector") });
  if (has("harness:normalizer.eval_input") && !has("harness:collector.artifact")) {
    problems.push({ severity: "info", reason: tx("ws_comp_eval_no_artifact") });
  }
  return problems;
}

function renderCompositionAdvisories(problems) {
  if (!problems || !problems.length) {
    return `<div class="ws-comp ws-comp-ok">✓ ${esc(tx("ws_comp_ok"))}</div>`;
  }
  const rows = problems.map((p) =>
    `<div class="ws-comp-row ws-comp-${esc(p.severity)}">${esc(p.severity === "warn" ? "⚠" : "ℹ")} ${esc(p.reason)}</div>`,
  ).join("");
  return `<div class="ws-comp">${rows}</div>`;
}

// 编辑模态:catalog 模块按 kind 分组可勾选,实时 composition,保存→automations.update。
function renderEditModal({ editing, draftModuleRefs, catalog }) {
  if (!editing) return "";
  const modules = Array.isArray(catalog?.modules) ? catalog.modules : [];
  const kindMap = Object.fromEntries(modules.map((m) => [m.id, m.kind]));
  const draft = new Set(draftModuleRefs || []);
  const groups = ["guard", "collector", "gate", "normalizer"].map((kind) => {
    const inKind = modules.filter((m) => m.kind === kind);
    if (!inKind.length) return "";
    const chips = inKind.map((m) => {
      const on = draft.has(m.id) ? " is-on" : "";
      return `<button class="ws-mod-chip${on}" data-ws-toggle-module="${esc(m.id)}">${esc(formatModuleLabel(m.id))}</button>`;
    }).join("");
    return `<div class="ws-mod-group"><div class="ws-mod-kind ws-kind-${esc(kind)}">${esc(formatKind(kind))}</div><div class="ws-mod-chips">${chips}</div></div>`;
  }).join("");
  const problems = validateCompositionClient([...draft], kindMap);
  return `
    <div class="ws-modal-backdrop" data-ws-action="cancel-edit">
      <div class="ws-modal" data-ws-modal-stop="1">
        <div class="ws-modal-head">
          <span class="ws-modal-title">${esc(tx("ws_edit_title"))}: ${esc(editing)}</span>
          <button class="ws-btn ws-modal-x" data-ws-action="cancel-edit">✕</button>
        </div>
        <div class="ws-modal-body">${groups}</div>
        ${renderCompositionAdvisories(problems)}
        <div class="ws-modal-foot">
          <button class="ws-btn" data-ws-action="cancel-edit">${esc(tx("ws_cancel"))}</button>
          <button class="ws-btn ws-btn-primary" data-ws-action="save-edit">${esc(tx("ws_save"))}（${draft.size}）</button>
        </div>
      </div>
    </div>`;
}

// ── 右中：模块流水线 ──────────────────────────────────────────────────────────

function renderPipeline(run, selectedModuleId) {
  if (!run || !Array.isArray(run.moduleRuns) || run.moduleRuns.length === 0) {
    return `<div class="ws-pipeline ws-pipeline-empty">${esc(tx("ws_no_run"))}</div>`;
  }
  const ordered = [...run.moduleRuns].sort((a, b) => {
    const r = kindRank(a.kind) - kindRank(b.kind);
    return r !== 0 ? r : String(a.moduleId || "").localeCompare(String(b.moduleId || ""));
  });
  const nodes = ordered.map((m, idx) => {
    const statusCls = formatStatusClass(m.status, "pending");
    const selected = m.moduleId === selectedModuleId ? " is-selected" : "";
    const arrow = idx > 0 ? `<span class="ws-pipe-arrow">→</span>` : "";
    return `${arrow}<button class="ws-node ws-node-${esc(statusCls)}${selected}" data-module-id="${esc(m.moduleId)}">
        <span class="ws-node-glyph">${esc(statusGlyph(m.status))}</span>
        <span class="ws-node-label">${esc(formatModuleLabel(m.moduleId))}</span>
        <span class="ws-node-kind ws-kind-${esc(String(m.kind||"").toLowerCase())}">${esc(formatKind(m.kind))}</span>
      </button>`;
  }).join("");
  return `<div class="ws-pipeline">${nodes}</div>`;
}

// ── 右中下：选中模块明细 ──────────────────────────────────────────────────────

function renderModuleDetail(run, selectedModuleId) {
  if (!run || !Array.isArray(run.moduleRuns)) {
    return "";
  }
  const m = run.moduleRuns.find((entry) => entry.moduleId === selectedModuleId);
  if (!m) {
    return `<div class="ws-detail ws-detail-empty">${esc(tx("ws_pick_module"))}</div>`;
  }
  const statusCls = formatStatusClass(m.status, "pending");
  const evidenceRows = m.evidence && typeof m.evidence === "object"
    ? Object.entries(m.evidence)
        .map(([k, v]) => `<div class="ws-ev-row"><span class="ws-ev-key">${esc(k)}</span><span class="ws-ev-val">${esc(formatEvidenceValue(v))}</span></div>`)
        .join("")
    : `<div class="ws-detail-empty">${esc(tx("ws_no_evidence"))}</div>`;
  const hardShaped = Array.isArray(m.hardShaped) && m.hardShaped.length
    ? m.hardShaped.map((h) => `<span class="ws-tag">${esc(h)}</span>`).join("")
    : "";
  return `
    <div class="ws-detail">
      <div class="ws-detail-head">
        <span class="ws-detail-title">${esc(formatModuleLabel(m.moduleId))}</span>
        <span class="ws-pill ws-pill-${esc(statusCls)}">${esc(formatStatus(m.status))}</span>
        <span class="ws-detail-kind ws-kind-${esc(String(m.kind||"").toLowerCase())}">${esc(formatKind(m.kind))}</span>
      </div>
      ${m.summary ? `<div class="ws-detail-summary">${esc(m.summary)}</div>` : ""}
      ${m.reason ? `<div class="ws-detail-reason"><span class="ws-ev-key">reason</span> ${esc(m.reason)}</div>` : ""}
      ${hardShaped ? `<div class="ws-detail-tags">${hardShaped}</div>` : ""}
      <div class="ws-detail-evidence">${evidenceRows}</div>
    </div>`;
}

function formatEvidenceValue(v) {
  if (v == null) return "—";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// ── 右下：运行历史（可点切换查看哪一轮的流水线 / 对比）────────────────────────

function renderRunHistory(runs, selectedRound) {
  if (!runs.length) {
    return `<div class="ws-history ws-history-empty">${esc(tx("ws_no_history"))}</div>`;
  }
  const chips = runs.map((r) => {
    const selected = Number(r.round) === Number(selectedRound) ? " is-selected" : "";
    const statusCls = formatStatusClass(r.status, "pending");
    const gate = r.gateSummary?.verdict || r.gateVerdict || null;
    return `
      <button class="ws-run-chip ws-run-${esc(statusCls)}${selected}" data-run-round="${esc(String(r.round))}">
        <span class="ws-run-round">${esc(formatRoundLabel(r.round))}</span>
        <span class="ws-run-glyph">${esc(statusGlyph(r.status))}</span>
        ${gate ? `<span class="ws-run-gate">${esc(formatStatus(gate))}</span>` : ""}
        ${r.score != null ? `<span class="ws-run-score">${esc(formatScore(r.score))}</span>` : ""}
        <span class="ws-run-ts">${esc(formatTimestamp(r.finalizedAt || r.startedAt))}</span>
      </button>`;
  }).join("");
  return `<div class="ws-history"><div class="ws-history-label">${esc(tx("ws_history"))}</div><div class="ws-history-scroll">${chips}</div></div>`;
}

// ── 顶层组装 ──────────────────────────────────────────────────────────────────

export function renderWorkstation(model) {
  const {
    placements = [],
    selectedAutomationId = null,
    selectedRun = null,
    runsForSelected = [],
    selectedModuleId = null,
    catalog = null,
    editing = null,
    draftModuleRefs = [],
    showComposition = false,
  } = model || {};
  const selectedPlacement = placements.find((p) => p.id === selectedAutomationId) || null;
  const selectedRound = selectedRun?.round ?? null;

  // 校验(结构):当前 harness 的有效 moduleRefs = placement.moduleRefs（配置）或 run 的 moduleRuns 派生。
  let compositionStrip = "";
  if (showComposition && selectedPlacement) {
    const kindMap = Object.fromEntries((catalog?.modules || []).map((m) => [m.id, m.kind]));
    const effectiveRefs = Array.isArray(selectedPlacement.moduleRefs) && selectedPlacement.moduleRefs.length
      ? selectedPlacement.moduleRefs
      : (selectedRun?.moduleRuns || []).map((m) => m.moduleId);
    compositionStrip = `<div class="ws-comp-strip"><div class="ws-comp-label">${esc(tx("ws_action_verify"))}（${esc(tx("ws_comp_structural"))}）</div>${renderCompositionAdvisories(validateCompositionClient(effectiveRefs, kindMap))}</div>`;
  }

  return `
    <div class="ws-root">
      <aside class="ws-list">
        <div class="ws-list-head">${esc(tx("ws_harness_list"))} <span class="ws-list-count">${placements.length}</span></div>
        ${renderHarnessList(placements, selectedAutomationId)}
      </aside>
      <section class="ws-main">
        ${renderActionBar(selectedPlacement)}
        ${compositionStrip}
        ${renderPipeline(selectedRun, selectedModuleId)}
        ${renderModuleDetail(selectedRun, selectedModuleId)}
        ${renderRunHistory(runsForSelected, selectedRound)}
      </section>
      ${renderEditModal({ editing, draftModuleRefs, catalog })}
    </div>`;
}
