// components/stat-strip.js — 统计读数带（纯渲染：stats + t → HTML 字符串）。
// 2026-08-25 用户裁决重设计（参考老页 stats-bar 画风）:
//   单条带不再独立成框 · 行内「LABEL 值」 · 每项固定语义色（全谱上色）·
//   去掉 agents(节点数,图上自见) · uptime 用方灯+文字表达在线态。
import { esc } from "../core/html.js";

const STAT_ORDER = ["active", "queue", "done", "alert", "events", "uptime"];
const NUM_CLASS = {
  active: "is-active",   // 橙:进行中
  queue: "is-queue",     // 琥珀:排队
  done: "is-done",       // 绿:完成
  alert: "is-alertable", // 红:告警(>0 才红)
  events: "is-events",   // 蓝:事件量
};

export function renderStatStrip(stats, t) {
  const source = stats && typeof stats === "object" ? stats : {};
  const items = STAT_ORDER.filter((key) => key in source).map((key) => {
    const value = source[key];
    if (key === "uptime") {
      const on = value === "ON" || value === true;
      return `<div class="stat-item" data-stat="uptime">`
        + `<span class="stat-label">${esc(t("stat.uptime"))}</span>`
        + `<span class="stat-lamp${on ? " is-on" : ""}"></span>`
        + `<span class="stat-value${on ? " is-done" : " is-alert"}">${esc(on ? "ON" : "OFF")}</span>`
        + `</div>`;
    }
    const num = Number(value);
    let cls = NUM_CLASS[key] || "";
    if (key === "alert" && !(num > 0)) cls = "is-muted"; // 无告警不染红
    return `<div class="stat-item" data-stat="${esc(key)}">`
      + `<span class="stat-label">${esc(t(`stat.${key}`))}</span>`
      + `<span class="stat-value ${cls}">${esc(value)}</span>`
      + `</div>`;
  }).join("");
  return `<div class="stat-strip">${items}</div>`;
}
