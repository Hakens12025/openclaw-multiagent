// dashboard-nav.js — Shared navigation bar for all dashboard pages
import { getToken } from "./dashboard-common.js";
import { t, getCurrentLang, setLang } from "./dashboard-i18n.js";

export const DASHBOARD_NAV_ITEMS = Object.freeze([
  { key: "nav.home", path: "/watchdog/progress", page: "home", paths: ["/watchdog/progress"] },
  { key: "nav.agents", path: "/watchdog/agents-view", page: "agents", paths: ["/watchdog/agents-view"] },
  { key: "nav.work_items", path: "/watchdog/work-items-view", page: "work-items", paths: ["/watchdog/work-items-view"] },
  { key: "nav.harness", path: "/watchdog/harness-view", page: "harness", paths: ["/watchdog/harness-view"] },
  { key: "nav.test_tools", path: "/watchdog/devtools", page: "devtools", paths: ["/watchdog/devtools"] },
]);

function buildTokenHref(path) {
  const token = getToken();
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

function resolveActivePage(items) {
  const pathname = window.location.pathname;
  const urlPage = new URLSearchParams(window.location.search).get("page");
  for (const item of items) {
    if (urlPage === item.page || item.paths.some((path) => pathname === path)) {
      return item.page;
    }
  }
  return "home";
}

export function renderNav() {
  const navBar = document.getElementById("navBar");
  if (!navBar) return;

  const activePage = resolveActivePage(DASHBOARD_NAV_ITEMS);
  const lang = getCurrentLang();
  const otherLang = lang === "zh-CN" ? "en-US" : "zh-CN";
  const langLabel = lang === "zh-CN" ? "EN" : "\u4E2D";

  let html = '<div class="nav-items">';
  for (const item of DASHBOARD_NAV_ITEMS) {
    const isActive = item.page === activePage;
    html += `<a class="nav-item${isActive ? " active" : ""}" href="${buildTokenHref(item.path)}">${t(item.key)}</a>`;
  }
  html += "</div>";
  html += '<div class="nav-actions">';
  html += `<button class="nav-lang-btn" type="button" data-lang-target="${otherLang}">${langLabel}</button>`;
  html += "</div>";

  navBar.innerHTML = html;
  const langButton = navBar.querySelector("[data-lang-target]");
  if (langButton) {
    langButton.addEventListener("click", () => {
      const nextLang = langButton.getAttribute("data-lang-target");
      setLang(nextLang);
      window.location.reload();
    });
  }
}
