// pages/manage/charts.js — Charts 子页（批3 定位:迁移重组,深化留后续）。
// 图表产出走 viz-master executor(在指挥台派 chart 任务即出图);
// 本页先落管理入口说明 + viz 动作端点清单,可视化编排器随后续批深化。
import { esc } from "../../core/html.js";

export function renderChartsView(t) {
  return `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.charts.title"))}</span></div>`
    + `<p class="mg-note">${esc(t("manage.charts.note"))}</p>`
    + `<pre class="mg-pre">${esc(t("manage.charts.endpoints"))}</pre>`
    + `</div>`;
}

export function mountChartsPage(host, { i18n }) {
  host.innerHTML = `<h1 class="mg-title">${esc(i18n.t("manage.sub.charts"))}</h1>` + renderChartsView(i18n.t);
  return () => {};
}
