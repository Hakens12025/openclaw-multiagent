// pages/manage/index.js — 管理区壳（设计文档 §2.3：五子页统一子导航壳）。
// 批3 定位：迁移重组为主，逐页深化留后续——每页核心只读视图 + 关键动作。
import { mountAgentsPage } from "./agents.js";
import { mountKnowledgePage } from "./knowledge.js";
import { mountChartsPage } from "./charts.js";
import { mountControlPlanePage } from "./control-plane.js";
import { mountDevtoolsPage } from "./devtools.js";

const SUBS = ["agents", "knowledge", "charts", "control-plane", "devtools"];
const MOUNTERS = {
  agents: mountAgentsPage,
  knowledge: mountKnowledgePage,
  charts: mountChartsPage,
  "control-plane": mountControlPlanePage,
  devtools: mountDevtoolsPage,
};

export function mountManagePage(host, ctx) {
  const page = document.createElement("div");
  page.className = "manage-page";
  host.appendChild(page);

  const { i18n, routeParams } = ctx;
  const sub = SUBS.includes(routeParams?.sub) ? routeParams.sub : "agents";
  const nav = document.createElement("nav");
  nav.className = "manage-subnav";
  for (const s of SUBS) {
    const a = document.createElement("a");
    a.href = `#/manage/${s}`;
    a.textContent = i18n.t(`manage.sub.${s}`);
    a.className = s === sub ? "sub-link current" : "sub-link";
    nav.appendChild(a);
  }
  page.appendChild(nav);

  const subHost = document.createElement("section");
  subHost.className = "manage-sub";
  page.appendChild(subHost);
  const unmountSub = MOUNTERS[sub](subHost, ctx);

  return () => {
    if (typeof unmountSub === "function") unmountSub();
    page.remove();
  };
}
