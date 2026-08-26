// pages/manage/devtools.js — Devtools 子页（批3:模型注册表 + 测试预设/历史只读）。
// 数据源 GET /watchdog/models · GET /watchdog/test-runs;发起测试跑属深化留后续。
import { esc } from "../../core/html.js";

export function renderDevtoolsView({ models, presets, runs }, t) {
  let body = "";
  const modelRows = (Array.isArray(models) ? models : []).map((m) => `<tr>`
    + `<td>${esc(m.provider || "-")}</td><td>${esc(m.id || "-")}</td>`
    + `<td>${esc(m.name || "-")}</td><td>${esc(m.api || "-")}</td></tr>`).join("");
  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.dev.models"))} (${(Array.isArray(models) ? models : []).length})</span></div>`
    + (modelRows ? `<table class="mg-table"><thead><tr><th>PROVIDER</th><th>ID</th><th>${esc(t("manage.dev.model_name"))}</th><th>API</th></tr></thead><tbody>${modelRows}</tbody></table>`
      : `<div class="mg-state">${esc(t("state.empty"))}</div>`)
    + `</div>`;

  const presetItems = (Array.isArray(presets) ? presets : []).map((p) => `<div class="mg-card dev-preset">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(p.id)}</span>`
    + `<span class="mg-tag">${esc(p.runtimeMode || "")}</span></div>`
    + `<div class="agent-desc">${esc(p.description || "")}</div></div>`).join("");
  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.dev.presets"))}</span></div>`
    + (presetItems ? `<div class="mg-grid">${presetItems}</div>` : `<div class="mg-state">${esc(t("state.empty"))}</div>`)
    + `</div>`;

  const runRows = (Array.isArray(runs) ? runs.slice(0, 10) : []).map((r) => `<tr>`
    + `<td>${esc(r?.id || r?.presetId || "-")}</td><td>${esc(r?.status ?? "-")}</td>`
    + `<td>${esc(r?.verdict ?? "-")}</td><td>${esc(String(r?.startedAt || r?.ts || "").slice(0, 19))}</td></tr>`).join("");
  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.dev.runs"))}</span></div>`
    + (runRows ? `<table class="mg-table"><thead><tr><th>ID</th><th>${esc(t("manage.knowledge.status"))}</th><th>VERDICT</th><th>${esc(t("manage.knowledge.time"))}</th></tr></thead><tbody>${runRows}</tbody></table>`
      : `<div class="mg-state">${esc(t("state.empty"))}</div>`)
    + `</div>`;
  return body;
}

export function mountDevtoolsPage(host, { api, i18n }) {
  const t = i18n.t;
  host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.devtools"))}</h1><div class="mg-state">${esc(t("state.loading"))}</div>`;
  let alive = true;
  Promise.all([
    api.getJson("/watchdog/models").catch(() => null),
    api.getJson("/watchdog/test-runs").catch(() => null),
  ]).then(([models, testRuns]) => {
    if (!alive) return;
    host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.devtools"))}</h1>`
      + renderDevtoolsView({
        models,
        presets: testRuns?.presets || [],
        runs: testRuns?.runs || [],
      }, t);
  });
  return () => { alive = false; };
}
