import { esc } from "./dashboard-common.js";
import {
  formatAssurance,
  formatCount,
  formatFamilyLabel,
  formatMode,
  formatModuleLabel,
  formatTrust,
  formatTrustClass,
  renderLaneMeter,
  tx,
} from "./dashboard-harness-shared.js";

export function renderProfileFocus(profile) {
  if (!profile) return "";
  const familyLabel = formatFamilyLabel(profile.family);
  return `
    <section class="harness-focus-card">
      <div class="harness-focus-head">
        <div>
          <div class="harness-focus-title">${esc(profile.id)}</div>
          <div class="harness-focus-subtitle">${esc(tx("profile_focus_subtitle", { family: familyLabel }))}</div>
        </div>
        <div class="harness-tag-row">
          <span class="harness-chip ${formatTrustClass(profile.trustLevel)}">${esc(formatTrust(profile.trustLevel))}</span>
          <span class="harness-chip">${esc(tx("tag_mode", { value: formatMode(profile.defaultMode || "freeform") }))}</span>
          <span class="harness-chip">${esc(tx("tag_assurance", { value: formatAssurance(profile.defaultAssuranceLevel || "low_assurance") }))}</span>
          <span class="harness-chip">${esc(tx("tag_usage", { count: formatCount(profile.usageCount) }))}</span>
        </div>
      </div>
      <div class="harness-focus-grid">
        <div class="harness-kv"><span>${esc(tx("label_modules"))}</span><strong>${esc(formatCount(profile.moduleRefs?.length || 0))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("lane_hard"))}</span><strong>${esc(formatCount(profile.coverageCounts?.hardShaped || 0))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("lane_soft"))}</span><strong>${esc(formatCount(profile.coverageCounts?.softGuided || 0))}</strong></div>
        <div class="harness-kv"><span>${esc(tx("lane_free"))}</span><strong>${esc(formatCount(profile.coverageCounts?.freeform || 0))}</strong></div>
      </div>
      ${renderLaneMeter(profile.coverageCounts, { subtitle: tx("distribution_profile_subtitle") })}
      <div class="harness-section-title">${esc(tx("section_modules"))}</div>
      <div class="harness-tag-row">
        ${(profile.moduleRefs || []).map((moduleId) => `<span class="harness-chip" title="${esc(moduleId)}">${esc(formatModuleLabel(moduleId))}</span>`).join("") || `<span class="harness-chip">${esc(tx("no_modules"))}</span>`}
      </div>
      <div class="harness-section-title">${esc(tx("section_coverage"))}</div>
      <div class="harness-tag-row">
        ${(profile.hardShaped || []).map((area) => `<span class="harness-chip">${esc(tx("lane_hard"))} ${esc(area)}</span>`).join("")}
        ${(profile.softGuided || []).map((area) => `<span class="harness-chip">${esc(tx("lane_soft"))} ${esc(area)}</span>`).join("")}
        ${(profile.freeform || []).map((area) => `<span class="harness-chip">${esc(tx("lane_free"))} ${esc(area)}</span>`).join("")}
      </div>
    </section>
  `;
}
