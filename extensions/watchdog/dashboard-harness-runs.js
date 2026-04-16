import { esc } from "./dashboard-common.js";
import {
  formatAssurance,
  formatCount,
  formatDecision,
  formatMode,
  formatRoundLabel,
  formatRunSource,
  formatScore,
  formatStatus,
  formatStatusClass,
  formatTimestamp,
  formatTrust,
  formatTrustClass,
  formatValue,
  renderLaneMeter,
  renderSummaryCards,
  tx,
} from "./dashboard-harness-shared.js";

function renderRunCard(run) {
  const sourceTags = Array.isArray(run?.sourceTags) ? run.sourceTags : [];
  const failedModuleIds = Array.isArray(run?.gateSummary?.failedModuleIds) ? run.gateSummary.failedModuleIds : [];
  const pendingModuleIds = Array.isArray(run?.gateSummary?.pendingModuleIds) ? run.gateSummary.pendingModuleIds : [];

  return `
    <article class="harness-run-card status-${esc(formatStatusClass(run?.status, "none"))}">
      <div class="harness-run-card-head">
        <div>
          <div class="harness-run-card-title">${esc(formatRoundLabel(run?.round))}</div>
          <div class="harness-card-meta">${esc(run?.id || "--")}</div>
        </div>
        <div class="harness-run-chip-row">
          ${sourceTags.map((tag) => `<span class="harness-chip">${esc(formatRunSource(tag))}</span>`).join("")}
          <span class="status-${esc(formatStatusClass(run?.status, "none"))}">${esc(formatStatus(run?.status, run?.status || "none"))}</span>
          <span class="status-${esc(formatStatusClass(run?.gateSummary?.verdict, "none"))}">${esc(tx("label_gate"))} ${esc(formatStatus(run?.gateSummary?.verdict, run?.gateSummary?.verdict || "none"))}</span>
        </div>
      </div>

      <div class="harness-kv-grid harness-run-kv-grid">
        <div class="harness-kv"><span>${esc(tx("label_started"))}</span><strong>${esc(formatTimestamp(run?.startedAt))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_finalized"))}</span><strong>${esc(formatTimestamp(run?.finalizedAt))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_decision"))}</span><strong>${esc(formatDecision(run?.decision))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_score"))}</span><strong>${esc(formatScore(run?.score))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_profile"))}</span><strong>${esc(formatValue(run?.profileId || "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_runtime"))}</span><strong>${esc(formatStatus(run?.runtimeStatus, run?.runtimeStatus || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_contract"))}</span><strong>${esc(formatValue(run?.contractId || "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_pipeline"))}</span><strong>${esc(formatValue(run?.pipelineId || run?.loopId || "--"))}</strong></div>
      </div>

      <div class="harness-run-chip-row metrics">
        <span class="harness-chip">${esc(tx("label_modules_total"))} ${esc(formatCount(run?.moduleCounts?.total || 0))}</span>
        <span class="harness-chip">${esc(tx("label_modules_pending"))} ${esc(formatCount(run?.moduleCounts?.pending || 0))}</span>
        <span class="harness-chip">${esc(tx("label_modules_passed"))} ${esc(formatCount(run?.moduleCounts?.passed || 0))}</span>
        <span class="harness-chip">${esc(tx("label_modules_failed"))} ${esc(formatCount(run?.moduleCounts?.failed || 0))}</span>
        <span class="harness-chip">${esc(tx("label_modules_skipped"))} ${esc(formatCount(run?.moduleCounts?.skipped || 0))}</span>
      </div>

      ${(run?.summary || run?.artifact || failedModuleIds.length || pendingModuleIds.length)
        ? `
          <div class="harness-run-stack">
            ${run?.summary
              ? `<div class="harness-run-block"><span>${esc(tx("label_summary_text"))}</span><strong>${esc(run.summary)}</strong></div>`
              : ""}
            ${run?.artifact
              ? `<div class="harness-run-block"><span>${esc(tx("label_artifact"))}</span><strong>${esc(run.artifact)}</strong></div>`
              : ""}
            ${failedModuleIds.length
              ? `<div class="harness-run-block"><span>${esc(tx("label_failed_modules"))}</span><div class="harness-coverage-row">${failedModuleIds.map((moduleId) => `<span class="harness-chip">${esc(moduleId)}</span>`).join("")}</div></div>`
              : ""}
            ${pendingModuleIds.length
              ? `<div class="harness-run-block"><span>${esc(tx("label_pending_modules"))}</span><div class="harness-coverage-row">${pendingModuleIds.map((moduleId) => `<span class="harness-chip">${esc(moduleId)}</span>`).join("")}</div></div>`
              : ""}
          </div>
        `
        : ""}
    </article>
  `;
}

function renderRunsDetail(placement) {
  if (!placement) {
    return `
      <div class="harness-box">
        <div class="harness-box-title">${esc(tx("runs_detail"))}</div>
        <div class="harness-empty">${esc(tx("runs_only_empty"))}</div>
      </div>
    `;
  }

  const runs = Array.isArray(placement.recentRuns) ? placement.recentRuns : [];

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
          <span class="harness-chip">${esc(tx("label_recent_runs"))} ${esc(formatCount(runs.length))}</span>
          <span class="harness-chip ${formatTrustClass(placement.harnessProfileTrustLevel)}">${esc(formatTrust(placement.harnessProfileTrustLevel || "stable"))}</span>
        </div>
      </div>
      <div class="harness-focus-grid">
        <div class="harness-kv"><span>${esc(tx("label_runtime"))}</span><strong>${esc(formatStatus(placement.runtimeStatus, placement.runtimeStatus || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_profile"))}</span><strong>${esc(formatValue(placement.harnessProfileId || "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_target_agent"))}</span><strong>${esc(formatValue(placement.targetAgent || "--"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_current_round"))}</span><strong>${esc(formatValue(placement.currentRound))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_gate"))}</span><strong>${esc(formatStatus(placement.gateVerdict, placement.gateVerdict || "none"))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("label_best_score_short"))}</span><strong>${esc(formatValue(placement.bestScore ?? "--"))}</strong></div>
      </div>
      ${renderLaneMeter(placement.coverageCounts || placement.coverage || {}, { subtitle: tx("distribution_run_subtitle") })}
    </div>

    <div class="harness-focus-card">
      <div class="harness-focus-head">
        <div>
          <div class="harness-focus-title">${esc(tx("runs_track_title"))}</div>
          <div class="harness-focus-subtitle">${esc(tx("runs_track_subtitle"))}</div>
        </div>
      </div>
      ${runs.length
        ? `<div class="harness-runs-track">${runs.map((run) => renderRunCard(run)).join("")}</div>`
        : `<div class="harness-empty">${esc(tx("runs_track_empty"))}</div>`}
    </div>
  `;
}

export function renderRunsView(model) {
  const { counts, runPlacements, selectedAutomationId, selectedRunPlacement } = model;

  return `
    ${renderSummaryCards(counts)}
    <section class="harness-grid runs">
      <div class="harness-box">
        <div class="harness-box-title">${esc(tx("runs_list"))}</div>
        <div class="harness-list scroll">
          ${runPlacements.length ? runPlacements.map((placement) => {
            const latestRun = Array.isArray(placement.recentRuns) ? placement.recentRuns[0] : null;
            return `
              <button class="harness-card is-clickable ${selectedAutomationId === placement.id ? "active" : ""}" type="button" data-automation-id="${esc(placement.id)}">
                <div class="harness-card-head">
                  <div>
                    <div class="harness-card-title">${esc(placement.objectiveSummary || placement.label || placement.id)}</div>
                    <div class="harness-card-meta">${esc(tx("placement_card_meta", {
                      id: placement.id,
                      agent: placement.targetAgent || "--",
                    }))}</div>
                  </div>
                  <span class="status-${esc(formatStatusClass(latestRun?.status || placement.runtimeStatus, "none"))}">${esc(formatStatus(latestRun?.status || placement.runtimeStatus, latestRun?.status || placement.runtimeStatus || "none"))}</span>
                </div>
                <div class="harness-card-text">${esc(formatMode(placement.executionMode))} // ${esc(formatValue(placement.harnessProfileId || tx("lane_free")))}</div>
                <div class="harness-kv-grid">
                  <div class="harness-kv"><span>${esc(tx("label_current_round"))}</span><strong>${esc(formatValue(latestRun?.round ?? placement.currentRound))}</strong></div>
                  <div class="harness-kv"><span>${esc(tx("label_recent_runs"))}</span><strong>${esc(formatCount(placement.recentRuns?.length || 0))}</strong></div>
                  <div class="harness-kv"><span>${esc(tx("label_gate"))}</span><strong>${esc(formatStatus(latestRun?.gateSummary?.verdict || placement.gateVerdict, latestRun?.gateSummary?.verdict || placement.gateVerdict || "none"))}</strong></div>
                </div>
              </button>
            `;
          }).join("") : `<div class="harness-empty">${esc(tx("runs_only_empty"))}</div>`}
        </div>
      </div>
      <div class="harness-placement-detail">
        ${renderRunsDetail(selectedRunPlacement)}
      </div>
    </section>
  `;
}
