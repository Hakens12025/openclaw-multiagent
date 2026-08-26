// pages/manage/knowledge.js — Knowledge 子页（批3：库选择 + 评测集/历史 + 维护动作）。
// 契约对齐老页:inspect.knowledge_bases / knowledge_eval_sets / knowledge_eval_runs /
// knowledge_kb_search;动作 eval-run {kbId,evalSetId} · reindex {kbId,force} ·
// add {kbId,sourcePath,label}。remove 类破坏性动作深化留后续。
import { esc } from "../../core/html.js";

export function renderKnowledgeView(state, t) {
  const { kbs = [], kbId = "", evalSets = [], evalRuns = [], search, searchResult, busy, notice } = state;
  const opts = kbs.map((kb) => {
    const id = kb.id || kb.kbId || kb;
    return `<option value="${esc(id)}"${id === kbId ? " selected" : ""}>${esc(id)}</option>`;
  }).join("");
  let body = `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.knowledge.title"))}</span>`
    + `<select class="mg-input" data-mg-act="kb">${opts}</select></div>`
    + `<p class="mg-note">${esc(t("manage.knowledge.note"))}</p>`
    + `</div>`;

  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.knowledge.search_title"))}</span></div>`
    + `<form data-mg-form="search" class="mg-row"><input class="mg-input mg-grow" name="query" placeholder="${esc(t("manage.knowledge.query_ph"))}" required value="${esc(search || "")}">`
    + `<button class="mg-btn" type="submit" ${busy ? "disabled" : ""}>${esc(t("manage.knowledge.search_run"))}</button></form>`
    + (searchResult ? `<pre class="mg-pre">${esc(JSON.stringify(searchResult, null, 2).slice(0, 2400))}</pre>` : "")
    + `</div>`;

  const setRows = evalSets.map((s) => {
    const id = s.id || s.evalSetId || "";
    return `<tr><td>${esc(id)}</td><td>${Array.isArray(s.cases) ? s.cases.length : "-"}</td>`
      + `<td><button class="mg-btn" data-mg-act="eval-run" data-set="${esc(id)}" ${busy ? "disabled" : ""}>${esc(t("manage.knowledge.eval_run"))}</button></td></tr>`;
  }).join("");
  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.knowledge.eval_sets"))}</span></div>`
    + (evalSets.length ? `<table class="mg-table"><thead><tr><th>ID</th><th>${esc(t("manage.knowledge.cases"))}</th><th></th></tr></thead><tbody>${setRows}</tbody></table>`
      : `<div class="mg-state">${esc(t("state.empty"))}</div>`)
    + `</div>`;

  const runRows = evalRuns.slice(0, 10).map((r) => {
    const at = r?.startedAt || r?.ts || "";
    return `<tr><td>${esc(r?.id || r?.runId || "-")}</td><td>${esc(String(at).slice(0, 19))}</td>`
      + `<td>${esc(r?.status ?? "-")}</td><td>${esc(r?.metrics ? JSON.stringify(r.metrics).slice(0, 80) : "-")}</td></tr>`;
  }).join("");
  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.knowledge.eval_runs"))}</span></div>`
    + (evalRuns.length ? `<table class="mg-table"><thead><tr><th>ID</th><th>${esc(t("manage.knowledge.time"))}</th><th>${esc(t("manage.knowledge.status"))}</th><th>${esc(t("manage.knowledge.metrics"))}</th></tr></thead><tbody>${runRows}</tbody></table>`
      : `<div class="mg-state">${esc(t("state.empty"))}</div>`)
    + `</div>`;

  body += `<div class="mg-card">`
    + `<div class="mg-card-head"><span class="mg-card-title">${esc(t("manage.knowledge.maintain_title"))}</span></div>`
    + `<form data-mg-form="add" class="mg-row"><input class="mg-input mg-grow" name="sourcePath" placeholder="${esc(t("manage.knowledge.add_ph"))}" required>`
    + `<button class="mg-btn" type="submit" ${busy ? "disabled" : ""}>${esc(t("manage.knowledge.add"))}</button></form>`
    + `<form data-mg-form="reindex"><button class="mg-btn" type="submit" ${busy ? "disabled" : ""}>${esc(t("manage.knowledge.reindex"))}</button></form>`
    + (notice ? `<pre class="mg-pre">${esc(String(notice).slice(0, 800))}</pre>` : "")
    + `</div>`;
  return body;
}

export function mountKnowledgePage(host, { api, i18n }) {
  const t = i18n.t;
  const state = { kbs: [], kbId: "", evalSets: [], evalRuns: [], busy: false, notice: null };

  function render() {
    host.innerHTML = `<h1 class="mg-title">${esc(t("manage.sub.knowledge"))}</h1>` + renderKnowledgeView(state, t);
  }

  async function loadEval(kbId) {
    state.kbId = kbId;
    state.busy = true; render();
    try {
      const [sets, runs] = await Promise.all([
        api.inspect("inspect.knowledge_eval_sets", { kbId }),
        api.inspect("inspect.knowledge_eval_runs", { kbId, limit: 10 }),
      ]);
      state.evalSets = Array.isArray(sets?.evalSets) ? sets.evalSets : [];
      state.evalRuns = Array.isArray(runs) ? runs : [];
    } catch { state.evalSets = []; state.evalRuns = []; }
    finally { state.busy = false; render(); }
  }

  api.inspect("inspect.knowledge_bases", {})
    .then((res) => {
      const kbs = Array.isArray(res) ? res : (Array.isArray(res?.bases) ? res.bases : []);
      state.kbs = kbs;
      render();
      const first = kbs[0]?.id || kbs[0]?.kbId || kbs[0];
      if (first) void loadEval(first);
    })
    .catch(() => render());
  render();

  async function onSubmit(event) {
    const form = event.target.closest("[data-mg-form]");
    if (!form || !host.contains(form)) return;
    event.preventDefault();
    if (state.busy || !state.kbId) return;
    const kind = form.getAttribute("data-mg-form");
    const fd = new FormData(form);
    // 搜索词回写 state:busy 重渲会用 state.search 重填输入框,不回写=提交即清空。
    if (kind === "search") state.search = String(fd.get("query") || "");
    state.busy = true; state.notice = null; render();
    try {
      if (kind === "search") {
        state.searchResult = await api.inspect("inspect.knowledge_kb_search", { kbId: state.kbId, query: String(fd.get("query") || "") });
      } else if (kind === "add") {
        state.notice = await api.postJson("/watchdog/knowledge/add", { kbId: state.kbId, sourcePath: String(fd.get("sourcePath") || "") });
        await loadEval(state.kbId);
        return;
      } else if (kind === "reindex") {
        state.notice = await api.postJson("/watchdog/knowledge/reindex", { kbId: state.kbId, force: false });
      }
    } catch (e) {
      state.notice = `error: ${e.message}`;
    } finally {
      state.busy = false; render();
    }
  }

  function onClick(event) {
    const kbSel = event.target.closest("[data-mg-act='kb']");
    if (kbSel && kbSel.value && kbSel.value !== state.kbId) {
      void loadEval(kbSel.value);
      return;
    }
    const runBtn = event.target.closest("[data-mg-act='eval-run']");
    if (runBtn && !state.busy && state.kbId) {
      const evalSetId = runBtn.getAttribute("data-set");
      state.busy = true; state.notice = null; render();
      api.postJson("/watchdog/knowledge/eval-run", { kbId: state.kbId, evalSetId })
        .then((r) => { state.notice = r; })
        .catch((e) => { state.notice = `error: ${e.message}`; })
        .finally(() => { state.busy = false; return loadEval(state.kbId); });
    }
  }

  host.addEventListener("submit", onSubmit);
  host.addEventListener("change", onClick);
  host.addEventListener("click", onClick);
  return () => {
    host.removeEventListener("submit", onSubmit);
    host.removeEventListener("change", onClick);
    host.removeEventListener("click", onClick);
  };
}
