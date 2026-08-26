// pages/manage/control-plane.js — Control Plane 子页（批3:operator 快照 + 变更集只读）。
// 数据源 GET /watchdog/operator-snapshot · GET /watchdog/admin-change-sets。
import { esc } from "../../core/html.js";

export function renderControlPlaneView({ snapshot, changeSets }, t) {
  let body = "";
  if (snapshot) {
    const s = snapshot.summary || {};
    const pairs = [
      ["state", s.state],
      ["attention", s.attentionCount],
      ["activeWorkItems", s.activeWorkItems],
      ["enabledAutomations", s.enabledAutomations],
      ["activeAutomations", s.activeAutomations],
      ["readyAgentJoins", s.readyAgentJoins],
      ["draftAgentJoins", s.draftAgentJoins],
      ["activeTrackingSessions", s.activeTrackingSessions],
    ];
    const cells = pairs.map(([k, v]) => `<div class="stat-item" data-cp="${esc(k)}">`
      + `<span class="stat-label">${esc(k)}</span>`
      + `<span class="stat-value${k === "state" ? (v === "idle" ? " is-done" : " is-active") : (Number(v) > 0 ? " is-active" : "")}">${esc(v ?? "-")}</span>`
      + `</div>`).join("");
    body += `<div class="stat-strip">${cells}</div>`;
  } else {
    body += `<div class="mg-state">${esc(t("state.empty"))}</div>`;
  }

  const drafts = Array.isArray(changeSets?.drafts) ? changeSets.drafts : [];
  const rows = drafts.map((d) => `<tr><td>${esc(d?.id || "-")}</td><td>${esc(d?.surface || "-")}</td>`
    + `<td>${esc(d?.status || "-")}</td><td>${esc(String(d?.createdAt || "").slice(0, 19))}</td></tr>`).join("");
  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.cp.change_sets"))}</span></div>`
    + (drafts.length ? `<table class="mg-table"><thead><tr><th>ID</th><th>Surface</th><th>${esc(t("manage.knowledge.status"))}</th><th>${esc(t("manage.knowledge.time"))}</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="mg-state">${esc(t("state.empty"))}</div>`)
    + `</div>`;
  return body;
}

export function mountControlPlanePage(host, { api, i18n }) {
  const t = i18n.t;
  host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.control-plane"))}</h1><div class="mg-state">${esc(t("state.loading"))}</div>`;
  let alive = true;
  Promise.all([
    api.getJson("/watchdog/operator-snapshot").catch(() => null),
    api.getJson("/watchdog/admin-change-sets").catch(() => null),
  ]).then(([snapshot, changeSets]) => {
    if (!alive) return;
    host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.control-plane"))}</h1>`
      + renderControlPlaneView({ snapshot, changeSets }, t);
  });
  return () => { alive = false; };
}
