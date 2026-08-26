// components/work-item-list.js — 工作项生命周期列表（纯渲染）。
// 状态分组：running→进行中；pending/draft→排队；completed/failed→已完成。
// 交互走 data-action，宿主页事件委托。
import { esc } from "../core/html.js";

const GROUPS = [
  ["running", new Set(["running"])],
  ["queued", new Set(["pending", "draft"])],
  ["done", new Set(["completed", "failed"])],
];

function groupOf(status) {
  for (const [group, statuses] of GROUPS) {
    if (statuses.has(status)) return group;
  }
  return "queued";
}

function renderCard(item) {
  const status = item.status || "pending";
  const pct = Number.isFinite(item.pct) ? `<span class="wi-pct">${item.pct}%</span>` : "";
  return `<div class="wi-card status-${esc(status)}" data-action="open-work-item" data-work-item-id="${esc(item.id)}">`
    + `<span class="wi-id">${esc(item.id)}</span>${pct}`
    + `<div class="wi-task">${esc(item.task || "--")}</div>`
    + `</div>`;
}

export function renderWorkItemList(items, t) {
  const list = Array.isArray(items) ? items : [];
  let body = `<div class="wi-title">${esc(t("workitems.title"))}</div>`;
  if (!list.length) {
    return `<div class="work-item-list">${body}<div class="wi-empty">${esc(t("workitems.empty"))}</div></div>`;
  }
  for (const [group] of GROUPS) {
    const members = list.filter((item) => groupOf(item.status || "pending") === group);
    if (!members.length) continue;
    body += `<div class="wi-group wi-group-${group}">`
      + `<div class="wi-group-head">${esc(t(`workitems.${group}`))} (${members.length})</div>`
      + members.map(renderCard).join("")
      + `</div>`;
  }
  return `<div class="work-item-list">${body}</div>`;
}
