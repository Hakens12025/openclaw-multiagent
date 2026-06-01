import { esc } from "./dashboard-common.js";
import {
  formatAssurance,
  formatCount,
  formatFamilyLabel,
  formatKind,
  formatKindClass,
  formatMode,
  formatModuleLabel,
  formatTrust,
  formatTrustClass,
  renderLaneMeter,
  renderSummaryCards,
  tx,
} from "./dashboard-harness-shared.js";

function renderProfileFocus(profile) {
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

export function renderAtlasView(model) {
  const {
    counts,
    families,
    allProfiles,
    filteredProfiles,
    filteredModules,
    selectedFamilyId,
    selectedProfileId,
    selectedProfile,
  } = model;
  const selectedProfileModules = new Set(Array.isArray(selectedProfile?.moduleRefs) ? selectedProfile.moduleRefs : []);

  return `
    ${renderSummaryCards(counts)}
    ${renderProfileFocus(selectedProfile)}
    <section class="harness-grid atlas">
      <div class="harness-box">
        <div class="harness-box-title">${esc(tx("family_atlas"))}</div>
        <div class="harness-list">
          <button class="harness-card is-clickable ${selectedFamilyId === "all" ? "active" : ""}" type="button" data-family-id="all">
            <div class="harness-card-head">
              <div>
                <div class="harness-card-title">${esc(tx("all_families"))}</div>
                <div class="harness-card-meta">${esc(tx("all_families_meta"))}</div>
              </div>
              <span class="harness-chip">${esc(tx("label_profiles"))} ${esc(formatCount(allProfiles.length))}</span>
            </div>
          </button>
          ${families.map((family) => `
            <button class="harness-card is-clickable ${selectedFamilyId === family.id ? "active" : ""}" type="button" data-family-id="${esc(family.id)}">
              <div class="harness-card-head">
                <div>
                  <div class="harness-card-title">${esc(formatFamilyLabel(family.id))}</div>
                  <div class="harness-card-meta">${esc(family.id)}</div>
                </div>
                <span class="harness-chip">${esc(tx("family_automations", { count: formatCount(family.automationCount) }))}</span>
              </div>
              <div class="harness-card-text">${esc(tx("family_card_meta", { profiles: formatCount(family.profileCount), modules: formatCount(family.moduleCount) }))}</div>
              <div class="harness-coverage-row">
                <span class="harness-chip trust-stable">${esc(formatTrust("stable"))} ${esc(formatCount(family.stableProfiles))}</span>
                <span class="harness-chip trust-provisional">${esc(formatTrust("provisional"))} ${esc(formatCount(family.provisionalProfiles))}</span>
                <span class="harness-chip trust-experimental">${esc(formatTrust("experimental"))} ${esc(formatCount(family.experimentalProfiles))}</span>
              </div>
            </button>
          `).join("")}
        </div>
      </div>

      <div class="harness-box">
        <div class="harness-box-title">${esc(tx("profile_library"))}</div>
        <div class="harness-list scroll">
          ${filteredProfiles.length ? filteredProfiles.map((profile) => `
            <button class="harness-card is-clickable ${selectedProfileId === profile.id ? "active" : ""}" type="button" data-profile-id="${esc(profile.id)}">
              <div class="harness-card-head">
                <div>
                  <div class="harness-card-title">${esc(profile.id)}</div>
                  <div class="harness-card-meta">${esc(tx("focus_meta", { family: formatFamilyLabel(profile.family), mode: formatMode(profile.defaultMode || "freeform") }))}</div>
                </div>
                <span class="harness-chip ${formatTrustClass(profile.trustLevel)}">${esc(formatTrust(profile.trustLevel))}</span>
              </div>
              <div class="harness-kv-grid">
                <div class="harness-kv"><span>${esc(tx("label_usage"))}</span><strong>${esc(formatCount(profile.usageCount))}</strong></div>
                <div class="harness-kv"><span>${esc(tx("label_modules"))}</span><strong>${esc(formatCount(profile.moduleRefs?.length || 0))}</strong></div>
                <div class="harness-kv"><span>${esc(tx("label_assurance"))}</span><strong>${esc(formatAssurance(profile.defaultAssuranceLevel || "low_assurance"))}</strong></div>
              </div>
              <div class="harness-coverage-row">
                <span class="harness-chip">${esc(tx("lane_hard"))} ${esc(formatCount(profile.coverageCounts?.hardShaped || 0))}</span>
                <span class="harness-chip">${esc(tx("lane_soft"))} ${esc(formatCount(profile.coverageCounts?.softGuided || 0))}</span>
                <span class="harness-chip">${esc(tx("lane_free"))} ${esc(formatCount(profile.coverageCounts?.freeform || 0))}</span>
              </div>
            </button>
          `).join("") : `<div class="harness-empty">${esc(tx("no_profiles_in_family"))}</div>`}
        </div>
      </div>

      <div class="harness-box">
        <div class="harness-box-title">${esc(tx("module_roster"))}</div>
        <div class="harness-list scroll">
          ${filteredModules.length ? filteredModules.map((module) => `
            <div class="harness-card ${selectedProfileModules.has(module.id) ? "active" : ""}">
              <div class="harness-card-head">
                <div>
                  <div class="harness-card-title">${esc(formatModuleLabel(module.id))}</div>
                  <div class="harness-card-meta">${esc(module.id)} // ${esc(formatKind(module.kind || "module"))}</div>
                </div>
                <span class="harness-chip ${formatKindClass(module.kind)}">${esc(formatKind(module.kind || "module"))}</span>
              </div>
              <div class="harness-kv-grid">
                <div class="harness-kv"><span>${esc(tx("label_usage"))}</span><strong>${esc(formatCount(module.usageCount))}</strong></div>
                <div class="harness-kv"><span>${esc(tx("label_families_count"))}</span><strong>${esc(formatCount(module.familyIds?.length || 0))}</strong></div>
                <div class="harness-kv"><span>${esc(tx("label_profiles_count"))}</span><strong>${esc(formatCount(module.profileIds?.length || 0))}</strong></div>
              </div>
              <div class="harness-coverage-row">
                ${(module.hardShaped || []).map((area) => `<span class="harness-chip">${esc(tx("lane_hard"))} ${esc(area)}</span>`).join("") || `<span class="harness-chip">${esc(tx("no_hard_shaped_area"))}</span>`}
              </div>
            </div>
          `).join("") : `<div class="harness-empty">${esc(tx("no_modules_in_family"))}</div>`}
        </div>
      </div>
    </section>
  `;
}
