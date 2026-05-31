import { esc } from "./dashboard-common.js";
import {
  formatCount,
  formatDecision,
  formatRoundLabel,
  formatRunSource,
  formatScore,
  formatStatus,
  formatStatusClass,
  formatTimestamp,
  formatValue,
  tx,
} from "./dashboard-harness-shared.js";

export function renderRunCard(run) {
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
        <div class="harness-kv"><span>${esc(tx("label_loop"))}</span><strong>${esc(formatValue(run?.loopId || run?.pipelineId || "--"))}</strong></div>
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
