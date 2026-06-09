// dashboard-knowledge.js — 本地知识库管理页(主页/工作流的同级页)。
//
// 左：知识库列表(按 scope 分组,前向兼容 per-agent);右：选中库详情(源条目 + 重建/增删)。
// 全部经 CLI-system apply 面:inspect.knowledge_bases(读)+ /watchdog/knowledge/{add,reindex,remove}。
// NASA-Punk 平面化,所有状态变化带 toast 反馈。

import { esc, getToken, toast } from "./dashboard-common.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";
import { getCurrentLang } from "./dashboard-i18n.js";

const state = {
  kbs: [], selectedId: "wiki", loading: false,
  evalKbId: null, evalSets: [], evalRuns: [], evalLoading: false, latestRun: null,
  searchKbId: null, searchQuery: "", searchAsOf: "", searchResults: [], searchConflicts: [], searchLoading: false, searchDone: false,
};

function L(zh, en) {
  return getCurrentLang() === "zh-CN" ? zh : en;
}

function buildApiUrl(path) {
  const token = getToken();
  if (!token) return path;
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

async function fetchJson(path) {
  const res = await fetch(buildApiUrl(path), { headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function postAction(path, payload) {
  const res = await fetch(buildApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || (data && data.ok === false)) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function loadKbs() {
  state.loading = true;
  render();
  try {
    const data = await fetchJson("/watchdog/inspect?surface=inspect.knowledge_bases");
    state.kbs = Array.isArray(data?.knowledgeBases) ? data.knowledgeBases : [];
    if (!state.kbs.some((k) => k.id === state.selectedId)) {
      state.selectedId = state.kbs[0]?.id || null;
    }
  } catch (err) {
    toast(`${L("加载失败", "Load failed")}: ${err.message}`, "error");
  } finally {
    state.loading = false;
    render();
  }
}

function selectedKb() {
  return state.kbs.find((k) => k.id === state.selectedId) || null;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function render() {
  const host = document.getElementById("knowledgeExperience");
  if (!host) return;
  if (state.selectedId) ensureEvalData(state.selectedId); // 懒加载选中库的评测集/历史(stale 才取)
  host.innerHTML = `
    <div class="kb-grid">
      <aside class="kb-left">${renderLeft()}</aside>
      <section class="kb-right">${renderRight()}</section>
    </div>
  `;
  wireEvents(host);
}

// 选中库的评测数据(评测集 + 历史运行)。stale(库切换)才取,取完重渲染;evalKbId 提前置位防重入循环。
function ensureEvalData(kbId) {
  if (!kbId || state.evalKbId === kbId || state.evalLoading) return;
  state.evalLoading = true;
  state.evalKbId = kbId;
  if (state.latestRun && state.latestRun.kbId !== kbId) state.latestRun = null; // 切库清上次结果
  Promise.all([
    fetchJson(`/watchdog/inspect?surface=inspect.knowledge_eval_sets&kbId=${encodeURIComponent(kbId)}`),
    fetchJson(`/watchdog/inspect?surface=inspect.knowledge_eval_runs&kbId=${encodeURIComponent(kbId)}&limit=10`),
  ]).then(([sets, runs]) => {
    state.evalSets = Array.isArray(sets?.evalSets) ? sets.evalSets : [];
    state.evalRuns = Array.isArray(runs) ? runs : [];
  }).catch(() => { state.evalSets = []; state.evalRuns = []; })
    .finally(() => { state.evalLoading = false; render(); });
}

// 改动评测集/跑评测后强制刷新(清 evalKbId → 下次 render 的 ensureEvalData 重取)。
function refreshEvalData() { state.evalKbId = null; render(); }

function badge(text, kind) {
  return `<span class="kb-badge kb-badge-${kind}">${esc(text)}</span>`;
}

function renderLeft() {
  const groups = new Map(); // scope → kbs
  for (const kb of state.kbs) {
    const scope = kb.scope === "agent" ? (kb.agentId || "agent") : "global";
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(kb);
  }
  let rows = "";
  if (state.kbs.length === 0) {
    rows = `<div class="kb-empty-mini">${state.loading ? L("加载中…", "Loading…") : L("暂无知识库", "No knowledge bases")}</div>`;
  }
  for (const [scope, kbs] of groups) {
    const label = scope === "global" ? L("全局", "Global") : `${L("代理", "Agent")} · ${scope}`;
    rows += `<div class="kb-group-label">${esc(label)}</div>`;
    for (const kb of kbs) {
      const active = kb.id === state.selectedId ? " active" : "";
      rows += `
        <button class="kb-item${active}" data-kb-select="${esc(kb.id)}">
          <span class="kb-item-name">${esc(kb.label || kb.id)}</span>
          <span class="kb-item-meta">${badge(kb.kind === "builtin" ? L("内置", "builtin") : L("用户", "user"), kb.kind)}<span class="kb-chunk-count">${kb.chunkCount} ${L("块", "chunks")}</span></span>
        </button>`;
    }
  }
  return `
    <div class="kb-left-head">
      <div class="kb-left-title">${L("知识库", "Knowledge Bases")}</div>
      <button class="kb-btn kb-btn-primary kb-btn-sm" data-kb-new>+ ${L("新建", "New")}</button>
    </div>
    <div class="kb-list">${rows}</div>
  `;
}

function renderRight() {
  const kb = selectedKb();
  if (!kb) {
    return `<div class="kb-empty">${L("选择左侧一个知识库查看详情,或新建一个本地库。", "Select a knowledge base, or create a local one.")}</div>`;
  }
  const isUser = kb.kind === "user";
  const sources = Array.isArray(kb.sources) ? kb.sources : [];
  const sourceRows = sources.length === 0
    ? `<div class="kb-empty-mini">${L("无源条目", "No source entries")}</div>`
    : sources.map((src) => `
        <div class="kb-source-row">
          <span class="kb-source-path" title="${esc(src)}">${esc(src)}</span>
          ${isUser ? `<button class="kb-btn kb-btn-danger kb-btn-xs" data-kb-rmsource="${esc(src)}">${L("移除", "Remove")}</button>` : `<span class="kb-source-locked">${L("内置", "builtin")}</span>`}
        </div>`).join("");

  return `
    <div class="kb-detail-head">
      <div>
        <div class="kb-detail-title">${esc(kb.label || kb.id)}</div>
        <div class="kb-detail-sub">
          ${badge(kb.kind === "builtin" ? L("内置", "builtin") : L("用户", "user"), kb.kind)}
          ${badge(kb.scope === "global" ? L("全局", "global") : `${L("代理", "agent")}:${kb.agentId || "?"}`, "scope")}
          ${kb.temporal ? badge(L("时态", "temporal"), "warn") : ""}
          <span class="kb-detail-id">id: ${esc(kb.id)}</span>
        </div>
      </div>
      <div class="kb-actions">
        <button class="kb-btn" data-kb-reindex>${L("重建索引", "Reindex")}</button>
        ${isUser ? `<button class="kb-btn kb-btn-primary" data-kb-addsource>+ ${L("添加条目", "Add Source")}</button>` : ""}
        ${isUser ? `<button class="kb-btn" data-kb-config>${L("时态/分歧", "Temporal/Conflict")}</button>` : ""}
        ${isUser ? `<button class="kb-btn kb-btn-danger" data-kb-removekb>${L("删除库", "Delete")}</button>` : ""}
      </div>
    </div>
    <div class="kb-stats">
      <div class="kb-stat"><span class="kb-stat-num">${kb.chunkCount}</span><span class="kb-stat-lbl">${L("语义块", "chunks")}</span></div>
      <div class="kb-stat"><span class="kb-stat-num">${sources.length}</span><span class="kb-stat-lbl">${L("源条目", "sources")}</span></div>
      <div class="kb-stat"><span class="kb-stat-num">${esc(kb.model || "-")}</span><span class="kb-stat-lbl">${L("嵌入模型", "embed model")}</span></div>
      <div class="kb-stat"><span class="kb-stat-num kb-stat-time">${kb.builtAt ? esc(kb.builtAt.slice(0, 19).replace("T", " ")) : "-"}</span><span class="kb-stat-lbl">${L("最近构建", "built at")}</span></div>
    </div>
    <div class="kb-section-label">${L("源条目", "Source Entries")}</div>
    <div class="kb-source-list">${sourceRows}</div>
    ${renderSearchSection(kb)}
    ${renderEvalSection(kb)}
  `;
}

// 检索 + 时序分歧:搜索框(+ asOf 点时)→ inspect.knowledge_kb_search → 结果带 source/time/fields 徽标 +
// 时态库的 conflictHints 离散度可视化(目标3 的浏览器呈现)。
function renderSearchSection(kb) {
  const sameKb = state.searchKbId === kb.id;
  const results = sameKb ? state.searchResults : [];
  const conflicts = sameKb ? state.searchConflicts : [];
  const resultRows = results.length === 0
    ? (sameKb && state.searchDone ? `<div class="kb-empty-mini">${L("无结果", "No results")}</div>` : "")
    : results.map((r) => `
        <div class="kb-result-row">
          <div class="kb-result-head">
            <span class="kb-result-path" title="${esc(r.sourcePath)}">${esc(r.heading || "")} · ${esc(r.sourcePath.split("/").pop())}</span>
            ${r.meta ? renderMetaBadges(r.meta) : ""}
          </div>
          <div class="kb-result-text">${esc((r.text || "").slice(0, 160))}</div>
        </div>`).join("");

  return `
    <div class="kb-section-label kb-search-head">${L("检索 / 时序分歧", "Search / Temporal Conflict")}</div>
    <div class="kb-search-bar">
      <input class="kb-input kb-search-q" data-kb-search-q placeholder="${L("查询(对时态库会算跨源分歧)", "query (temporal KB → cross-source dispersion)")}" value="${esc(state.searchQuery || "")}">
      <input class="kb-input kb-search-asof" data-kb-search-asof placeholder="asOf YYYY-MM-DD" value="${esc(state.searchAsOf || "")}" title="${L("点时过滤:只看该日期前发布的", "point-in-time: only reports before this date")}">
      <button class="kb-btn kb-btn-primary kb-btn-sm" data-kb-search>${state.searchLoading && sameKb ? "…" : L("检索", "Search")}</button>
    </div>
    ${conflicts.length ? renderConflictHints(conflicts) : ""}
    ${resultRows ? `<div class="kb-results">${resultRows}</div>` : ""}
  `;
}

function renderMetaBadges(meta) {
  const parts = [];
  if (meta.source) parts.push(`<span class="kb-meta-badge kb-meta-source">${esc(meta.source)}</span>`);
  if (meta.time) parts.push(`<span class="kb-meta-badge kb-meta-time">${esc(meta.time.slice(0, 10))}</span>`);
  for (const [k, v] of Object.entries(meta.fields || {})) parts.push(`<span class="kb-meta-badge">${esc(k)}=${esc(v)}</span>`);
  return parts.join("");
}

// 分歧可视化:每个 hint = 主题 + 各源(谁/何时/取值)+ 离散度(数值=区间条+cv;类别=值 chips)。
function renderConflictHints(hints) {
  return `<div class="kb-conflicts">${hints.map((h) => {
    const sourceRows = h.sources.map((s) => `
      <div class="kb-conflict-source">
        <span class="kb-cs-name">${esc(s.source)}</span>
        <span class="kb-cs-time">${esc((s.time || "").slice(0, 10))}</span>
        <span class="kb-cs-vals">${Object.entries(s.values || {}).map(([k, v]) => `${esc(k.replace("fields.", ""))}=<strong>${esc(v)}</strong>`).join(" · ")}</span>
      </div>`).join("");
    const disp = Object.entries(h.dispersion || {}).map(([field, d]) => {
      const name = field.replace("fields.", "");
      if (d.kind === "numeric") {
        return `<div class="kb-disp"><span class="kb-disp-field">${esc(name)}</span>
          <span class="kb-disp-range">${d.min} — <strong>${d.mean}</strong> — ${d.max}</span>
          <span class="kb-disp-cv" title="coefficient of variation = stdev/mean">cv ${d.cv ?? "-"} · σ${d.stdev}</span></div>`;
      }
      return `<div class="kb-disp"><span class="kb-disp-field">${esc(name)}</span>
        <span class="kb-disp-cats">${(d.distinctValues || []).map((v) => `<span class="kb-meta-badge">${esc(v)}</span>`).join("")}</span></div>`;
    }).join("");
    return `
      <div class="kb-conflict-card">
        <div class="kb-conflict-topic">⚠ ${L("跨源分歧", "Cross-source conflict")}: <strong>${esc(h.topic)}</strong>
          <span class="kb-conflict-span">${esc((h.timeSpan?.from || "").slice(0, 10))} → ${esc((h.timeSpan?.to || "").slice(0, 10))} · ${h.sources.length} ${L("源", "sources")}</span></div>
        <div class="kb-conflict-disp">${disp}</div>
        <div class="kb-conflict-sources">${sourceRows}</div>
      </div>`;
  }).join("")}</div>`;
}

// 评测面板:评测集列表(跑/编辑/删)+ 新建 + 最近一次结果(recall 网格/MRR/未命中)+ 历史。
function renderEvalSection(kb) {
  const sets = state.evalKbId === kb.id ? state.evalSets : [];
  const setRows = state.evalLoading && state.evalKbId === kb.id
    ? `<div class="kb-empty-mini">${L("加载中…", "Loading…")}</div>`
    : sets.length === 0
      ? `<div class="kb-empty-mini">${L("暂无评测集。新建一个来量化这个库的召回率。", "No eval sets. Create one to measure this KB's recall.")}</div>`
      : sets.map((s) => `
          <div class="kb-eval-set-row">
            <span class="kb-eval-set-name">${esc(s.label || s.evalSetId)}<span class="kb-eval-set-meta">${s.cases?.length || 0} ${L("例", "cases")} · top${s.topK}</span></span>
            <span class="kb-eval-set-actions">
              <button class="kb-btn kb-btn-primary kb-btn-xs" data-eval-run="${esc(s.evalSetId)}">${L("跑", "Run")}</button>
              <button class="kb-btn kb-btn-xs" data-eval-edit="${esc(s.evalSetId)}">${L("编辑", "Edit")}</button>
              <button class="kb-btn kb-btn-danger kb-btn-xs" data-eval-del="${esc(s.evalSetId)}">${L("删", "Del")}</button>
            </span>
          </div>`).join("");

  return `
    <div class="kb-section-label kb-eval-head">
      <span>${L("召回评测", "Recall Evaluation")}</span>
      <button class="kb-btn kb-btn-primary kb-btn-sm" data-eval-new>+ ${L("新建评测集", "New Eval Set")}</button>
    </div>
    <div class="kb-eval-sets">${setRows}</div>
    ${renderRunResult(kb)}
    ${renderEvalHistory(kb)}
  `;
}

function pct(v) { return `${(Number(v || 0) * 100).toFixed(1)}%`; }

function renderRunResult(kb) {
  const r = state.latestRun;
  if (!r || r.kbId !== kb.id) return "";
  const run = r.run || {};
  const recallCells = Object.entries(run.recallAt || {}).map(([k, v]) =>
    `<div class="kb-metric"><span class="kb-metric-num">${pct(v)}</span><span class="kb-metric-lbl">recall@${k}</span></div>`).join("");
  // v153:幽灵命中率(越低越好,红;recall@k 对幽灵结论失明,此指标补它)。
  const ghostCell = run.ghostHitRate != null
    ? `<div class="kb-metric kb-metric-ghost"><span class="kb-metric-num">${pct(run.ghostHitRate)}</span><span class="kb-metric-lbl">ghostHit↓ (${run.ghostEvaluated})</span></div>`
    : "";
  const misses = (r.misses || []).slice(0, 8).map((m) =>
    `<div class="kb-miss"><span class="kb-miss-q" title="${esc(m.query)}">${esc(m.query)}</span><span class="kb-miss-exp">→ ${esc(m.expected)}</span></div>`).join("");
  return `
    <div class="kb-run-result">
      <div class="kb-run-head">${L("最近运行", "Latest run")}: <strong>${esc(run.label || run.evalSetId)}</strong>
        ${run.degraded ? `<span class="kb-badge kb-badge-warn">${L("嵌入降级", "embed degraded")}</span>` : ""}
        <span class="kb-run-meta">n=${run.total}${run.abstained ? ` · ${L("弃权", "abstained")} ${run.abstained}` : ""} · MRR ${Number(run.mrr || 0).toFixed(3)}</span>
      </div>
      <div class="kb-metrics">${recallCells}<div class="kb-metric"><span class="kb-metric-num">${Number(run.mrr || 0).toFixed(3)}</span><span class="kb-metric-lbl">MRR</span></div>${ghostCell}</div>
      ${misses ? `<div class="kb-misses-label">${L("未命中", "Misses")} (${(r.misses || []).length})</div><div class="kb-misses">${misses}</div>` : `<div class="kb-empty-mini">${L("全部命中 🎯", "All hit 🎯")}</div>`}
    </div>`;
}

function renderEvalHistory(kb) {
  const runs = state.evalKbId === kb.id ? state.evalRuns : [];
  if (!runs.length) return "";
  const rows = runs.slice(0, 8).map((r) => {
    const top = Object.keys(r.recallAt || {}).sort((a, b) => b - a)[0];
    return `<div class="kb-hist-row">
      <span class="kb-hist-set">${esc(r.label || r.evalSetId)}</span>
      <span class="kb-hist-metric">recall@${top || "?"} ${pct(r.recallAt?.[top])}</span>
      <span class="kb-hist-metric">MRR ${Number(r.mrr || 0).toFixed(3)}</span>
      <span class="kb-hist-time">${esc((r.completedAt || "").slice(0, 16).replace("T", " "))}</span>
    </div>`;
  }).join("");
  return `<div class="kb-section-label kb-hist-label">${L("评测历史", "Eval History")}</div><div class="kb-hist">${rows}</div>`;
}

// ── 交互 ────────────────────────────────────────────────────────────────────
function wireEvents(host) {
  host.querySelectorAll("[data-kb-select]").forEach((el) => {
    el.addEventListener("click", () => { state.selectedId = el.getAttribute("data-kb-select"); render(); });
  });
  host.querySelector("[data-kb-new]")?.addEventListener("click", openNewKbModal);
  host.querySelector("[data-kb-reindex]")?.addEventListener("click", () => reindexKb(state.selectedId));
  host.querySelector("[data-kb-addsource]")?.addEventListener("click", () => openAddSourceModal(state.selectedId));
  host.querySelector("[data-kb-removekb]")?.addEventListener("click", () => removeKb(state.selectedId));
  host.querySelectorAll("[data-kb-rmsource]").forEach((el) => {
    el.addEventListener("click", () => removeSource(state.selectedId, el.getAttribute("data-kb-rmsource")));
  });
  // 检索 / 时序分歧
  const qEl = host.querySelector("[data-kb-search-q]");
  if (qEl) qEl.addEventListener("input", (e) => { state.searchQuery = e.target.value; }); // 不重渲染,保焦点
  const asofEl = host.querySelector("[data-kb-search-asof]");
  if (asofEl) asofEl.addEventListener("input", (e) => { state.searchAsOf = e.target.value; });
  host.querySelector("[data-kb-search]")?.addEventListener("click", () => runKbSearch(state.selectedId));
  if (qEl) qEl.addEventListener("keydown", (e) => { if (e.key === "Enter") runKbSearch(state.selectedId); });
  host.querySelector("[data-kb-config]")?.addEventListener("click", () => openConfigModal(state.selectedId));
  host.querySelector("[data-eval-new]")?.addEventListener("click", () => openEvalSetModal(state.selectedId, null));
  host.querySelectorAll("[data-eval-run]").forEach((el) => {
    el.addEventListener("click", () => runEval(state.selectedId, el.getAttribute("data-eval-run")));
  });
  host.querySelectorAll("[data-eval-edit]").forEach((el) => {
    el.addEventListener("click", () => openEvalSetModal(state.selectedId, el.getAttribute("data-eval-edit")));
  });
  host.querySelectorAll("[data-eval-del]").forEach((el) => {
    el.addEventListener("click", () => deleteEvalSet(state.selectedId, el.getAttribute("data-eval-del")));
  });
}

// 跑评测:POST eval-run → 存 latestRun(全 perCase/misses)→ 刷新历史。
async function runEval(kbId, evalSetId) {
  if (!kbId || !evalSetId) return;
  toast(`${L("评测中…", "Evaluating…")} ${evalSetId}`, "info");
  try {
    const r = await postAction("/watchdog/knowledge/eval-run", { kbId, evalSetId });
    if (r?.ran === false) { toast(`${L("评测集不存在或为空", "Eval set missing/empty")}: ${r.error || ""}`, "warn"); return; }
    state.latestRun = { kbId, run: r.run, misses: r.misses || [], perCase: r.perCase || [] };
    const top = Object.keys(r.run?.recallAt || {}).sort((a, b) => b - a)[0];
    toast(`${L("评测完成", "Done")}: recall@${top} ${pct(r.run?.recallAt?.[top])} · MRR ${Number(r.run?.mrr || 0).toFixed(3)}${r.run?.degraded ? L("(降级)", " (degraded)") : ""}`, "success");
    refreshEvalData();
  } catch (err) {
    toast(`${L("评测失败", "Eval failed")}: ${err.message}`, "error");
  }
}

async function deleteEvalSet(kbId, evalSetId) {
  if (!window.confirm(`${L("删除评测集", "Delete eval set")}: ${evalSetId}?`)) return;
  try {
    await postAction("/watchdog/knowledge/eval-set/remove", { kbId, evalSetId });
    toast(`${L("已删除评测集", "Eval set deleted")}: ${evalSetId}`, "success");
    if (state.latestRun?.run?.evalSetId === evalSetId) state.latestRun = null;
    refreshEvalData();
  } catch (err) {
    toast(`${L("删除失败", "Delete failed")}: ${err.message}`, "error");
  }
}

async function reindexKb(kbId) {
  if (!kbId) return;
  toast(`${L("重建索引中…", "Reindexing…")} ${kbId}`, "info");
  try {
    const r = await postAction("/watchdog/knowledge/reindex", { kbId, force: false });
    if (r?.reindexed === false) { toast(`${L("未知库", "Unknown KB")}: ${kbId}`, "warn"); return; }
    const chunks = r?.chunkCount ?? r?.index?.chunkCount;
    toast(`${L("索引已重建", "Reindexed")}: ${chunks ?? "?"} ${L("块", "chunks")}${r?.degraded || r?.index?.degraded ? L("(嵌入降级)", " (embed degraded)") : ""}`, "success");
    await loadKbs();
  } catch (err) {
    toast(`${L("重建失败", "Reindex failed")}: ${err.message}`, "error");
  }
}

async function removeSource(kbId, src) {
  if (!kbId || !src) return;
  if (!window.confirm(`${L("移除源条目", "Remove source")}?\n${src}`)) return;
  try {
    await postAction("/watchdog/knowledge/remove", { kbId, sourcePath: src, explicitConfirm: true });
    toast(L("已移除源,正在重建…", "Source removed, reindexing…"), "success");
    await reindexKb(kbId);
  } catch (err) {
    toast(`${L("移除失败", "Remove failed")}: ${err.message}`, "error");
  }
}

async function removeKb(kbId) {
  if (!kbId) return;
  if (!window.confirm(`${L("删除整个知识库", "Delete entire knowledge base")}: ${kbId}?`)) return;
  try {
    await postAction("/watchdog/knowledge/remove", { kbId, explicitConfirm: true });
    toast(`${L("已删除库", "Deleted")}: ${kbId}`, "success");
    state.selectedId = "wiki";
    await loadKbs();
  } catch (err) {
    toast(`${L("删除失败", "Delete failed")}: ${err.message}`, "error");
  }
}

// 检索任意 KB(inspect.knowledge_kb_search):结果带 meta,时态库带 conflictHints。
async function runKbSearch(kbId) {
  if (!kbId) return;
  const query = (state.searchQuery || "").trim();
  if (!query) { toast(L("请输入查询", "Enter a query"), "warn"); return; }
  state.searchKbId = kbId; state.searchLoading = true; state.searchDone = false; render();
  try {
    const asOf = (state.searchAsOf || "").trim();
    const url = `/watchdog/inspect?surface=inspect.knowledge_kb_search&kbId=${encodeURIComponent(kbId)}&query=${encodeURIComponent(query)}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ""}`;
    const r = await fetchJson(url);
    state.searchResults = Array.isArray(r?.results) ? r.results : [];
    state.searchConflicts = Array.isArray(r?.conflictHints) ? r.conflictHints : [];
    if (state.searchConflicts.length) toast(`${L("发现跨源分歧", "Found cross-source conflict")} × ${state.searchConflicts.length}`, "info");
  } catch (err) {
    state.searchResults = []; state.searchConflicts = [];
    toast(`${L("检索失败", "Search failed")}: ${err.message}`, "error");
  } finally {
    state.searchLoading = false; state.searchDone = true; render();
  }
}

// 配置时态/分歧(从 UI 开 temporal + 写 metadataRules/conflict),保存后自动重建索引生效。
function openConfigModal(kbId) {
  const kb = state.kbs.find((k) => k.id === kbId);
  if (!kb) return;
  openModal(`${L("配置时态/分歧", "Configure temporal/conflict")} · ${kbId}`, [
    { key: "temporal", label: L("时态库 (true/false)", "Temporal (true/false)"), value: String(kb.temporal === true), hint: L("开启后提取 source/time/fields + 启用跨源分歧", "extract source/time/fields + enable conflict") },
    { key: "metadataRules", label: "METADATA RULES (JSON)", type: "textarea", value: kb.metadataRules ? JSON.stringify(kb.metadataRules) : "", placeholder: '{"source":{"keys":["issuer"],"fallback":"folder"},"time":{"keys":["date"],"fallback":"mtime"},"fields":{"passthrough":["target_price","rating"]}}', hint: L("source/time 来自哪些 front-matter 键", "front-matter keys → source/time") },
    { key: "conflict", label: "CONFLICT RULES (JSON)", type: "textarea", value: kb.conflict ? JSON.stringify(kb.conflict) : "", placeholder: '{"groupBy":"fields.ticker","on":["fields.target_price","fields.rating"]}', hint: L("groupBy 同主题分组,on 要比的标量(检索时算分歧)", "groupBy = topic, on = scalars compared") },
  ], async (v) => {
    const payload = { kbId, temporal: v.temporal.trim().toLowerCase() === "true" };
    if (v.metadataRules.trim()) { try { payload.metadataRules = JSON.parse(v.metadataRules); } catch { toast(L("metadataRules JSON 非法", "metadataRules invalid JSON"), "warn"); return; } }
    if (v.conflict.trim()) { try { payload.conflict = JSON.parse(v.conflict); } catch { toast(L("conflict JSON 非法", "conflict invalid JSON"), "warn"); return; } }
    closeModal();
    toast(L("配置已保存,正在重建索引…", "Saved, reindexing…"), "info");
    try {
      await postAction("/watchdog/knowledge/configure", payload);
      await postAction("/watchdog/knowledge/reindex", { kbId, force: true }); // 元数据提取需重建生效
      toast(L("配置生效(已重建)", "Applied (reindexed)"), "success");
      await loadKbs();
    } catch (err) {
      toast(`${L("配置失败", "Configure failed")}: ${err.message}`, "error");
    }
  });
}

// ── Modal(NASA-Punk 平面)────────────────────────────────────────────────
function openModal(title, fields, onSubmit) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "kb-modal-overlay";
  overlay.id = "kbModalOverlay";
  const fieldHtml = fields.map((f) => {
    const control = f.type === "textarea"
      ? `<textarea class="kb-input kb-textarea" data-field="${esc(f.key)}" rows="${f.rows || 7}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`
      : `<input class="kb-input" data-field="${esc(f.key)}" type="text" placeholder="${esc(f.placeholder || "")}" value="${esc(f.value || "")}" ${f.readonly ? "readonly" : ""}>`;
    return `
    <label class="kb-field">
      <span class="kb-field-label">${esc(f.label)}${f.required ? ' <span class="kb-req">*</span>' : ""}</span>
      ${control}
      ${f.hint ? `<span class="kb-field-hint">${esc(f.hint)}</span>` : ""}
    </label>`;
  }).join("");
  overlay.innerHTML = `
    <div class="kb-modal">
      <div class="kb-modal-title">${esc(title)}</div>
      <div class="kb-modal-body">${fieldHtml}</div>
      <div class="kb-modal-actions">
        <button class="kb-btn" data-modal-cancel>${L("取消", "Cancel")}</button>
        <button class="kb-btn kb-btn-primary" data-modal-submit>${L("确定", "Confirm")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));
  overlay.querySelector("[data-modal-cancel]").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector("[data-modal-submit]").addEventListener("click", async () => {
    const values = {};
    overlay.querySelectorAll("[data-field]").forEach((el) => { values[el.getAttribute("data-field")] = el.value.trim(); });
    const missing = fields.filter((f) => f.required && !values[f.key]);
    if (missing.length) { toast(`${L("缺必填项", "Missing")}: ${missing.map((m) => m.label).join(", ")}`, "warn"); return; }
    await onSubmit(values);
  });
}

function closeModal() {
  const o = document.getElementById("kbModalOverlay");
  if (o) { o.classList.remove("show"); setTimeout(() => o.remove(), 200); }
}

function openNewKbModal() {
  openModal(L("新建本地知识库", "New Local Knowledge Base"), [
    { key: "kbId", label: "KB ID", required: true, placeholder: "my-docs", hint: L("小写字母/数字/-/_", "lowercase a-z0-9-_") },
    { key: "label", label: L("名称", "Label"), placeholder: L("我的文档库", "My Docs") },
    { key: "sourcePath", label: L("源(文件或文件夹)", "Source (file or folder)"), required: true, placeholder: "docs/ 或 docs/notes.md", hint: L("相对 ~/.openclaw 或绝对路径;文件夹递归,二进制自动跳过", "relative to ~/.openclaw or absolute; folders recurse, binaries skipped") },
  ], async (v) => {
    closeModal();
    toast(`${L("新建并建索引中…", "Creating & indexing…")} ${v.kbId}`, "info");
    try {
      await postAction("/watchdog/knowledge/add", { kbId: v.kbId, sourcePath: v.sourcePath, label: v.label || undefined });
      toast(`${L("已创建", "Created")}: ${v.kbId}`, "success");
      state.selectedId = v.kbId;
      await loadKbs();
    } catch (err) {
      toast(`${L("创建失败", "Create failed")}: ${err.message}`, "error");
    }
  });
}

function openAddSourceModal(kbId) {
  if (!kbId) return;
  openModal(`${L("添加条目到", "Add source to")} ${kbId}`, [
    { key: "sourcePath", label: L("源(文件或文件夹)", "Source (file or folder)"), required: true, placeholder: "docs/ 或 docs/notes.md", hint: L("文件夹递归,不可读/二进制自动跳过", "folders recurse, unreadable/binary skipped") },
  ], async (v) => {
    closeModal();
    toast(`${L("添加并建索引中…", "Adding & indexing…")}`, "info");
    try {
      await postAction("/watchdog/knowledge/add", { kbId, sourcePath: v.sourcePath });
      toast(L("条目已添加", "Source added"), "success");
      await loadKbs();
    } catch (err) {
      toast(`${L("添加失败", "Add failed")}: ${err.message}`, "error");
    }
  });
}

// 评测集编辑器:cases 用「查询 | 期望路径 | 分类?」每行一条(简单、可粘贴)。
function openEvalSetModal(kbId, evalSetId) {
  if (!kbId) return;
  const existing = evalSetId ? state.evalSets.find((s) => s.evalSetId === evalSetId) : null;
  const casesText = (existing?.cases || [])
    .map((c) => [c.query, c.expectedSourcePath, c.category].filter(Boolean).join(" | "))
    .join("\n");
  openModal(existing ? `${L("编辑评测集", "Edit eval set")}: ${evalSetId}` : `${L("新建评测集", "New eval set")} · ${kbId}`, [
    { key: "evalSetId", label: "EVAL SET ID", required: true, placeholder: "baseline", value: existing?.evalSetId || "", readonly: !!existing, hint: L("小写字母/数字/-/_", "lowercase a-z0-9-_") },
    { key: "label", label: L("名称", "Label"), placeholder: L("基线召回集", "Baseline"), value: existing?.label || "" },
    {
      key: "cases", label: L("标注(每行:查询 | 期望路径 | 分类)", "Cases (per line: query | expectedPath | category)"),
      type: "textarea", required: true, rows: 8,
      value: casesText,
      placeholder: "如何重启网关 | deploy.md | ops\n端口是多少 | deploy.md | ops",
      hint: L("期望路径=该查询应命中的 chunk 的 sourcePath(见检索结果)。分类可选。", "expectedPath = sourcePath the query should hit (see search results). category optional."),
    },
  ], async (v) => {
    const cases = v.cases.split("\n").map((line) => {
      const [query, expectedSourcePath, category] = line.split("|").map((x) => x.trim());
      return query && expectedSourcePath ? { query, expectedSourcePath, category: category || null } : null;
    }).filter(Boolean);
    if (cases.length === 0) { toast(L("至少一条有效标注(查询|路径)", "Need ≥1 valid case (query|path)"), "warn"); return; }
    closeModal();
    try {
      await postAction("/watchdog/knowledge/eval-set/save", { kbId, evalSetId: v.evalSetId, label: v.label || undefined, cases });
      toast(`${L("评测集已保存", "Eval set saved")}: ${v.evalSetId} (${cases.length} ${L("例", "cases")})`, "success");
      refreshEvalData();
    } catch (err) {
      toast(`${L("保存失败", "Save failed")}: ${err.message}`, "error");
    }
  });
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function init() {
  initDashboardSubpage({ page: "knowledge" });
  const params = new URLSearchParams(window.location.search);
  const wanted = params.get("kb");
  if (wanted) state.selectedId = wanted; // 深链:?kb=<id> 直接选中(loadKbs 校验存在性)
  const q = params.get("q"); const asOf = params.get("asOf");
  if (q) state.searchQuery = q;          // 深链:?q=&asOf= 自动检索(可分享/可截图)
  if (asOf) state.searchAsOf = asOf;
  await loadKbs();
  if (q && state.selectedId) runKbSearch(state.selectedId);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
