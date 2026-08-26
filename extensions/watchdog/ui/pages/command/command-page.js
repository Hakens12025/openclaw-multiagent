// pages/command/command-page.js — 指挥台布局：读数带 + 三栏 grid + 日志抽屉槽位。
// renderCommandLayout 纯渲染（字符串）；renderCommandPage 负责落 DOM。
import { esc } from "../../core/html.js";

export function renderCommandLayout(t) {
  return `<h1 class="command-title">${esc(t("command.title"))}</h1>`
    + `<div class="stat-strip-host" data-slot="stat-strip"></div>`
    + `<div class="command-grid">`
    + `<section class="col-workitems" data-slot="work-items"></section>`
    + `<section class="col-graph" data-slot="graph"></section>`
    + `<section class="col-pulse" data-slot="pulse"></section>`
    + `</div>`
    + `<div class="log-drawer-host" data-slot="log-drawer"></div>`;
}

export function renderCommandPage({ i18n }) {
  const page = document.createElement("div");
  page.className = "command-page";
  page.innerHTML = renderCommandLayout(i18n.t);
  return page;
}
