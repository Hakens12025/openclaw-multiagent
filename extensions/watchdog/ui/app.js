// app.js — SPA 入口：壳接线。token 取自 location.search（沿用旧 getToken 语义），
// lang 存 localStorage；zone/lang 变化触发整页重渲染（无刷新切换）。
import { createStore } from "./core/store.js";
import { createApi } from "./core/api.js";
import { createI18n, DEFAULT_LANG, LANG_PACKS } from "./core/i18n.js";
import { startRouter } from "./core/router.js";
import { esc } from "./core/html.js";
import { mountCommandPage } from "./pages/command/index.js";
import { mountInspectPage } from "./pages/inspect/index.js";
import { mountManagePage } from "./pages/manage/index.js";

const LANG_STORAGE_KEY = "openclaw-ui-lang";

const token = new URLSearchParams(window.location.search).get("token") || "";
const lang = localStorage.getItem(LANG_STORAGE_KEY) || DEFAULT_LANG;

const store = createStore({
  lang,
  zone: "command",
  routeParams: {},
  graph: { nodes: [], edges: [] },
  runtime: {},
  workItems: [],
  runs: {},
  flows: [],
  events: [],
  // 信号采集是按键分桶的 map（refused/alerts/chainTips → 条目数组），不是数组
  sentinelSignals: {},
  connected: false,
  // 透视区（批2）
  inspectThreads: [],
  inspectRunDetails: {},
  inspectSelected: null,
  inspectJoin: null,
  inspectTab: "timeline",
  inspectMode: "snapshot",
  inspectLoading: false,
  inspectError: null,
  inspectPrompt: null,
  inspectTranscript: null,
  inspectSeal: null,
  inspectAgentId: null,
  inspectExpandedKey: null,
  inspectOpenLayer: null,
  inspectOpenFile: null,
  inspectTreeCollapsed: false,
  inspectExpandedThreads: [],
  inspectFocusAgentId: null,
});

const api = createApi({ token });
const i18n = createI18n({ lang, store });

const host = document.getElementById("app");
let unmountPage = null;
let clockTimer = null;

// 任务头带（三区导航上方）：徽章 + 大标题 + 等宽遥测时钟（每秒走字）
function renderHeader() {
  const header = document.createElement("header");
  header.className = "app-header";
  header.innerHTML = `<div class="hdr-badge">OC</div>`
    + `<div class="hdr-titles">`
    + `<div class="hdr-title">${esc(i18n.t("header.title"))}</div>`
    + `<div class="hdr-sub">${esc(i18n.t("header.subtitle"))}</div>`
    + `</div>`
    + `<div class="hdr-readout">`
    + `<span class="hdr-clock" id="hdr-clock">--:--:--</span>`
    + `<span class="hdr-clock-label">${esc(i18n.t("header.clock"))}</span>`
    + `</div>`;
  return header;
}

function ensureClock() {
  const tick = () => {
    const el = host.querySelector("#hdr-clock");
    if (el) el.textContent = new Date().toTimeString().slice(0, 8);
  };
  tick();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (!host.querySelector("#hdr-clock")) return;
    tick();
  }, 1000);
}

function renderNav(zone) {
  const nav = document.createElement("nav");
  nav.className = "zone-nav";
  for (const [z, hash] of [["command", "#/"], ["inspect", "#/inspect"], ["manage", "#/manage/agents"]]) {
    const a = document.createElement("a");
    a.href = hash;
    a.textContent = i18n.t(`nav.${z}`);
    a.className = z === zone ? "zone-link current" : "zone-link";
    nav.appendChild(a);
  }
  // 双语即时切换（设计文档 §5：无刷新；lang 是 store 状态，切换触发整页重渲染）
  const nextLang = i18n.getLang() === "zh-CN" ? "en-US" : "zh-CN";
  const langBtn = document.createElement("button");
  langBtn.type = "button";
  langBtn.className = "gb-btn lang-toggle";
  langBtn.dataset.action = "toggle-lang";
  langBtn.dataset.lang = nextLang;
  langBtn.textContent = nextLang.toUpperCase();
  nav.appendChild(langBtn);
  return nav;
}

function render() {
  const { zone, routeParams } = store.get();
  if (typeof unmountPage === "function") unmountPage();
  unmountPage = null;
  host.replaceChildren();
  host.appendChild(renderHeader());
  host.appendChild(renderNav(zone));
  ensureClock();
  const pageHost = document.createElement("main");
  host.appendChild(pageHost);
  if (zone === "command") {
    unmountPage = mountCommandPage(pageHost, { store, api, i18n, routeParams });
  } else if (zone === "inspect") {
    unmountPage = mountInspectPage(pageHost, { store, api, i18n, routeParams });
  } else {
    unmountPage = mountManagePage(pageHost, { store, api, i18n, routeParams });
  }
}

// 双语切换（data-action 委托，禁止 onclick 字符串桥——设计文档 §1 铁律）
document.addEventListener("click", (event) => {
  const btn = event.target.closest?.("[data-action='toggle-lang']");
  if (!btn) return;
  const next = btn.getAttribute("data-lang");
  if (LANG_PACKS[next]) i18n.setLang(next);
});

store.subscribe((state, changed) => {
  if (changed.includes("lang")) {
    localStorage.setItem(LANG_STORAGE_KEY, state.lang);
    render();
    return;
  }
  if (changed.includes("zone") || changed.includes("routeParams")) render();
});

startRouter(({ zone, params }) => store.patch({ zone, routeParams: params }));
