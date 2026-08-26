// pages/manage/agents.js — Agents 子页（批3：核心只读;写操作深化留后续）。
// 数据源 GET /watchdog/agents(装配真值);渲染纯函数 + 挂载接线分层。
import { esc } from "../../core/html.js";

export function renderAgentsView(agents, t) {
  const list = Array.isArray(agents) ? agents : [];
  if (!list.length) return `<div class="mg-state">${esc(t("state.empty"))}</div>`;
  const cards = list.map((a) => {
    const skills = Array.isArray(a.effectiveSkills) ? a.effectiveSkills.length : 0;
    const tools = Array.isArray(a.capabilities?.tools) ? a.capabilities.tools.length : 0;
    const plane = a.plane === "control" ? "CONTROL" : "EXECUTION";
    return `<div class="mg-card agent-card" data-agent="${esc(a.id)}">`
      + `<div class="mg-card-head"><span class="mg-card-title">${esc(a.id).toUpperCase()}</span>`
      + `<span class="mg-tag is-plane-${a.plane === "control" ? "control" : "exec"}">${plane}</span></div>`
      + `<div class="agent-role">${esc(t("manage.agents.role"))}: ${esc(a.role || "-")}</div>`
      + `<div class="agent-model">${esc(a.model || "-")}</div>`
      + `<div class="agent-desc">${esc(a.description || "")}</div>`
      + `<div class="agent-meta">`
      + `<span>${esc(t("manage.agents.skills"))}: <b>${skills}</b></span>`
      + `<span>${esc(t("manage.agents.tools"))}: <b>${tools}</b></span>`
      + `<span>${esc(t("manage.agents.heartbeat"))}: <b>${esc(a.effectiveHeartbeatEvery || "-")}</b></span>`
      + `</div></div>`;
  }).join("");
  return `<div class="mg-grid">${cards}</div>`;
}

export function mountAgentsPage(host, { api, i18n }) {
  const t = i18n.t;
  host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.agents"))}</h1><div class="mg-state">${esc(t("state.loading"))}</div>`;
  let alive = true;
  api.getJson("/watchdog/agents")
    .then((agents) => { if (alive) host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.agents"))}</h1>` + renderAgentsView(agents, t); })
    .catch((e) => { if (alive) host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.agents"))}</h1><div class="mg-state is-error">${esc(t("state.error", { msg: e.message }))}</div>`; });
  return () => { alive = false; };
}
