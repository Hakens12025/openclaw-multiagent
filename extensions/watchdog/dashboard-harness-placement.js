import { esc } from "./dashboard-common.js";
import {
  formatAssurance,
  formatCount,
  formatKind,
  formatModuleLabel,
  formatRunSource,
  formatStageLabel,
  formatStatus,
  formatStatusClass,
  formatTrust,
  formatTrustClass,
  formatValue,
  formatMode,
  renderLaneMeter,
  renderSummaryCards,
  tx,
} from "./dashboard-harness-shared.js";

function renderPlacementLegend() {
  return `
    <div class="harness-legend">
      <div class="harness-legend-item">
        <div class="harness-legend-swatch hardShaped"></div>
        <div class="harness-legend-copy">
          <strong>${esc(tx("lane_hard"))}</strong>
          <span>${esc(tx("lane_hard_desc"))}</span>
        </div>
      </div>
      <div class="harness-legend-item">
        <div class="harness-legend-swatch softGuided"></div>
        <div class="harness-legend-copy">
          <strong>${esc(tx("lane_soft"))}</strong>
          <span>${esc(tx("lane_soft_desc"))}</span>
        </div>
      </div>
      <div class="harness-legend-item">
        <div class="harness-legend-swatch freeform"></div>
        <div class="harness-legend-copy">
          <strong>${esc(tx("lane_free"))}</strong>
          <span>${esc(tx("lane_free_desc"))}</span>
        </div>
      </div>
    </div>
  `;
}

function renderStageLane(laneId, items) {
  const entries = Array.isArray(items) ? items : [];
  const laneKey = laneId === "hardShaped" ? "hard" : laneId === "softGuided" ? "soft" : "free";

  if (!entries.length) {
    return `
      <div class="harness-stage-lane">
        <div class="harness-stage-lane-label">${esc(tx(`lane_${laneKey}`))}</div>
        <div class="harness-empty">${esc(tx("no_lane_items"))}</div>
      </div>
    `;
  }

  return `
    <div class="harness-stage-lane">
      <div class="harness-stage-lane-label">${esc(tx(`lane_${laneKey}`))}</div>
      <div class="harness-stage-items">
        ${entries.map((item) => `
          <div class="harness-stage-item lane-${laneId} status-${esc(formatStatusClass(item.status, "configured"))}">
            <div class="harness-stage-item-head">
              <div>
                <div class="harness-stage-item-title">${esc(item.label || item.id)}</div>
                <div class="harness-card-meta">${esc(item.rawLabel || item.id)} // ${esc(formatKind(item.kind || item.source || "module"))}</div>
              </div>
              <span class="status-${esc(formatStatusClass(item.status, "configured"))}">${esc(formatStatus(item.status, "configured"))}</span>
            </div>
            ${(item.summary || item.reason)
              ? `<div class="harness-stage-item-summary">${esc(item.summary || item.reason)}</div>`
              : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderPlacementDetail(placement) {
  if (!placement) {
    return `
      <div class="harness-box">
        <div class="harness-box-title">${esc(tx("placement_detail"))}</div>
        <div class="harness-empty">${esc(tx("no_placement"))}</div>
      </div>
    `;
  }

  return `
    <div class="harness-focus-card">
      <div class="harness-focus-head">
        <div>
          <div class="harness-focus-title">${esc(placement.objectiveSummary || placement.label || placement.id)}</div>
          <div class="harness-focus-subtitle">${esc(tx("objective_meta", {
            id: placement.id,
            agent: placement.targetAgent || "--",
            domain: placement.objectiveDomain || "--",
          }))}</div>
        </div>
        <div class="harness-tag-row">
          <span class="harness-chip">${esc(formatMode(placement.executionMode))}</span>
          <span class="harness-chip">${esc(formatAssurance(placement.assuranceLevel))}</span>
          <span class="harness-chip ${formatTrustClass(placement.harnessProfileTrustLevel)}">${esc(formatTrust(placement.harnessProfileTrustLevel || "stable"))}</span>
          <span class="harness-chip">${esc(tx("tag_round", { value: formatValue(placement.currentRound) }))}</span>
        </div>
      </div>
      <div class="harness-focus-grid">
        <div class="harness-kv"><span>${esc(tx("label_runtime"))}</span><strong>${esc(formatStatus(placement.runtimeStatus, placement.runtimeStatus || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_profile"))}</span><strong>${esc(formatValue(placement.harnessProfileId || "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_gate"))}</span><strong>${esc(formatStatus(placement.gateVerdict, placement.gateVerdict || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_run_source"))}</span><strong>${esc(formatRunSource(placement.selectedRunMode || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_pending"))}</span><strong>${esc(formatCount(placement.pendingModuleCount || 0))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_failing"))}</span><strong>${esc(formatCount(placement.failedModuleCount || 0))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_best_score"))}</span><strong>${esc(formatValue(placement.bestScore ?? "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_recent_runs"))}</span><strong>${esc(formatCount(placement.recentHarnessRunCount || 0))}</strong></div>
      </div>
      ${renderLaneMeter(placement.coverageCounts || placement.coverage || {}, { subtitle: tx("distribution_run_subtitle") })}
      <div class="harness-section-title">${esc(tx("section_modules"))}</div>
      <div class="harness-tag-row">
        ${(placement.moduleRefs || []).map((moduleId) => `<span class="harness-chip" title="${esc(moduleId)}">${esc(formatModuleLabel(moduleId))}</span>`).join("") || `<span class="harness-chip">${esc(tx("no_modules"))}</span>`}
      </div>
    </div>

    ${renderPlacementLegend()}

    <div class="harness-focus-card">
      <div class="harness-focus-head">
        <div>
          <div class="harness-focus-title">${esc(tx("run_snapshot"))}</div>
          <div class="harness-focus-subtitle">${esc(tx("distribution_run_subtitle"))}</div>
        </div>
      </div>
      <div class="harness-kv-grid">
        <div class="harness-kv"><span>${esc(tx("label_active_run"))}</span><strong>${esc(formatValue(placement.activeRun?.id || "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_active_status"))}</span><strong>${esc(formatStatus(placement.activeRun?.status, placement.activeRun?.status || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_active_gate"))}</span><strong>${esc(formatStatus(placement.activeRun?.gateVerdict, placement.activeRun?.gateVerdict || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_last_run"))}</span><strong>${esc(formatValue(placement.lastRun?.id || "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_last_status"))}</span><strong>${esc(formatStatus(placement.lastRun?.status, placement.lastRun?.status || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_last_decision"))}</span><strong>${esc(formatValue(placement.lastRun?.decision || "--"))}</strong></div>
      </div>
      <div class="harness-stage-board">
        ${(placement.stages || []).map((stage) => {
          const total = (stage.counts?.hardShaped || 0) + (stage.counts?.softGuided || 0) + (stage.counts?.freeform || 0);
          return `
            <section class="harness-stage">
              <div class="harness-stage-head">
                <span>${esc(formatStageLabel(stage.id, stage.label || stage.id))}</span>
                <strong>${esc(formatCount(total))}</strong>
              </div>
              ${renderStageLane("hardShaped", stage.lanes?.hardShaped)}
              ${renderStageLane("softGuided", stage.lanes?.softGuided)}
              ${renderStageLane("freeform", stage.lanes?.freeform)}
            </section>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

export function renderPlacementView(model) {
  const { counts, placements, selectedAutomationId, selectedPlacement } = model;

  return `
    ${renderSummaryCards(counts)}
    <section class="harness-grid placement">
      <div class="harness-box">
        <div class="harness-box-title">${esc(tx("placement_list"))}</div>
        <div class="harness-list scroll">
          ${placements.length ? placements.map((placement) => `
            <button class="harness-card is-clickable ${selectedAutomationId === placement.id ? "active" : ""}" type="button" data-automation-id="${esc(placement.id)}">
              <div class="harness-card-head">
                <div>
                  <div class="harness-card-title">${esc(placement.objectiveSummary || placement.label || placement.id)}</div>
                  <div class="harness-card-meta">${esc(tx("placement_card_meta", {
                    id: placement.id,
                    agent: placement.targetAgent || "--",
                  }))}</div>
                </div>
                <span class="status-${esc(formatStatusClass(placement.gateVerdict, "none"))}">${esc(formatStatus(placement.gateVerdict, placement.gateVerdict || "none"))}</span>
              </div>
              <div class="harness-card-text">${esc(formatMode(placement.executionMode))} // ${esc(formatValue(placement.harnessProfileId || tx("lane_free")))}</div>
              <div class="harness-kv-grid">
                <div class="harness-kv"><span>${esc(tx("label_run"))}</span><strong>${esc(formatStatus(placement.runtimeStatus, placement.runtimeStatus || "none"))}</strong></div>
                <div class="harness-kv"><span>${esc(tx("label_pending"))}</span><strong>${esc(formatCount(placement.pendingModuleCount || 0))}</strong></div>
                <div class="harness-kv"><span>${esc(tx("label_failing"))}</span><strong>${esc(formatCount(placement.failedModuleCount || 0))}</strong></div>
              </div>
            </button>
          `).join("") : `<div class="harness-empty">${esc(tx("no_placement"))}</div>`}
        </div>
      </div>
      <div class="harness-placement-detail">
        ${renderPlacementDetail(selectedPlacement)}
      </div>
    </section>
  `;
}
