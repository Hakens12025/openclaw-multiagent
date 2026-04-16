import { getToken } from "./dashboard-common.js";
import { initI18n, t } from "./dashboard-i18n.js";
import { DASHBOARD_NAV_ITEMS, renderNav } from "./dashboard-nav.js";

let clockTimer = null;

function buildTokenHref(path) {
  const token = getToken();
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById("headerTime");
  const dateEl = document.getElementById("headerDate");
  if (timeEl) timeEl.textContent = now.toTimeString().slice(0, 8);
  if (dateEl) dateEl.textContent = now.toISOString().slice(0, 10).replace(/-/g, ".");
}

function resolvePageLabel(page) {
  const item = DASHBOARD_NAV_ITEMS.find((entry) => entry.page === page) || null;
  return item ? t(item.key) : t("nav.home");
}

export function renderPageChrome({
  page = "home",
  backHref = "/watchdog/progress",
  backLabelKey = "page.back_dashboard",
} = {}) {
  const host = document.getElementById("pageChrome");
  if (!host) return;

  const pageLabel = resolvePageLabel(page);
  host.className = "subpage-chrome";
  host.innerHTML = `
    <div class="subpage-shell">
      <div class="subpage-breadcrumb">
        <span>${t("nav.home")}</span>
        <span class="subpage-breadcrumb-sep">/</span>
        <strong>${pageLabel}</strong>
      </div>
      <div class="subpage-toolbar">
        <a class="subpage-back" href="${buildTokenHref(backHref)}">${t(backLabelKey)}</a>
        <div class="subpage-meta">${pageLabel}</div>
      </div>
    </div>
  `;
}

export function initDashboardSubpage(options = {}) {
  initI18n();
  renderNav();
  renderPageChrome(options);
  updateClock();
  if (!clockTimer) {
    clockTimer = window.setInterval(updateClock, 1000);
  }
}
