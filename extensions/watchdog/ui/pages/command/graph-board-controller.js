// pages/command/graph-board-controller.js — 编排图接线（页面层）。
// 设计文档 §1 铁律：components 纯渲染——fetch/store 订阅/DOM 事件全在本层。
// 交互移植老页图编辑器的三件套（设计文档 §0-2 裁决「拓扑编辑并入指挥台」）：
//   · 节点拖动（任意时刻），位置存 localStorage「openclaw-node-layout」——
//     与老页同键同格式，老页拖好的布局在新页直接继承
//   · 连线模式：点源 → 点目标 = 建立逻辑投递（POST /watchdog/graph/edge/add）
//   · 右键连线删除（POST /watchdog/graph/edge/delete）；环检测响应 → 红色高亮
import { autoLayout, graphSnap, renderGraphBoard } from "../../components/graph-board.js";
import { esc } from "../../core/html.js";

const LAYOUT_KEY = "openclaw-node-layout"; // 老页同键：布局跨页继承

export function createGraphBoard({ container, api, store, i18n, buildModel }) {
  const t = i18n.t;
  const ui = { editMode: false, selectedId: null, selectedEdge: null, status: null, statusTimer: null };
  let positions = null; // 惰性：首渲染按需从 localStorage + autoLayout 合成
  let drag = null;      // { id, k, startX, startY, orig, moved, raf }
  let edgePending = false;

  const loadSaved = () => {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") || {}; } catch { return {}; }
  };
  const persist = () => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(positions)); } catch { /* 私隐模式等 */ }
  };
  const layout = (nodes) => {
    // 惰性合成：首帧空态不能把 positions 冻结成空表——有节点缺位时重排，
    // 已有位置(含拖动中的)作锚,新节点避开落位。
    if (!positions || nodes.some((n) => !positions[n.id])) {
      positions = autoLayout(nodes, { ...loadSaved(), ...positions });
    }
    return positions;
  };

  function flash(text, kind = "info") {
    if (ui.statusTimer) clearTimeout(ui.statusTimer);
    ui.status = { text, kind };
    render();
    ui.statusTimer = setTimeout(() => { ui.status = null; render(); }, 3200);
  }

  function render() {
    const model = buildModel(store.get());
    const svg = renderGraphBoard(model, t, {
      editMode: ui.editMode,
      selectedId: ui.selectedId,
      selectedEdge: ui.selectedEdge,
      layout: layout(model.nodes),
    });
    const hint = ui.status
      ? `<span class="gb-status is-${ui.status.kind}">${esc(ui.status.text)}</span>`
      : ui.editMode
        ? `<span class="gb-hint">${esc(ui.selectedId ? t("graph.edit.from", { id: ui.selectedId }) : t("graph.edit.hint"))}</span>`
        : "";
    const html = `<div class="gb-wrap${ui.editMode ? " is-edit" : ""}">`
      + `<div class="gb-head">`
      + `<span class="gb-title">▸ ${esc(t("graph.title"))}</span>`
      + `<div class="gb-tools">`
      + `<button type="button" class="gb-btn${ui.editMode ? " is-on" : ""}" data-gb-act="edit">${esc(t("graph.edit"))}</button>`
      + `<button type="button" class="gb-btn" data-gb-act="reset">${esc(t("graph.reset"))}</button>`
      + `</div></div>`
      + `<div class="gb-hintbar">${hint}</div>`
      + svg
      + `</div>`;
    // 脏检查:内容未变不重建 SVG(与 command/index.js paint() 同一套治闪动逻辑)——
    // 订阅的是整个 store,SSE 高频写会把交接/呼吸动画反复重启。
    if (container._html !== html) {
      container.innerHTML = html;
      container._html = html;
    }
  }

  function applyGraphResponse(data, okText) {
    const graph = store.get().graph || {};
    store.patch({
      graph: {
        nodes: graph.nodes || [],
        edges: Array.isArray(data?.graph?.edges) ? data.graph.edges : graph.edges || [],
        cycles: Array.isArray(data?.cycles) ? data.cycles : [],
      },
    });
    const cycles = Array.isArray(data?.cycles) ? data.cycles : [];
    if (cycles.length > 0) {
      const cycleText = cycles.map((c) => c.join(" → ")).join("; ");
      flash(`${okText} · ${t("graph.cycle", { cycle: cycleText })}`, "warn");
    } else {
      flash(okText, "ok");
    }
  }

  async function connect(from, to) {
    if (edgePending) return;
    if (from === to) { flash(t("graph.edge.self"), "warn"); return; }
    const exists = (store.get().graph?.edges || []).some((e) => e.from === from && e.to === to);
    if (exists) { flash(t("graph.edge.exists", { from, to }), "warn"); return; }
    edgePending = true;
    try {
      const data = await api.graphEdgeAdd(from, to);
      applyGraphResponse(data, t("graph.edge.added", { from, to }));
    } catch (e) {
      flash(t("graph.edge.failed", { msg: e.message }), "error");
    } finally {
      edgePending = false;
      ui.selectedId = null;
      render();
    }
  }

  async function removeEdge(from, to) {
    if (edgePending) return;
    edgePending = true;
    try {
      const data = await api.graphEdgeDelete(from, to);
      applyGraphResponse(data, t("graph.edge.removed", { from, to }));
    } catch (e) {
      flash(t("graph.edge.failed", { msg: e.message }), "error");
    } finally {
      edgePending = false;
    }
  }

  // ── 事件（委托在稳定容器上；重渲染不重挂） ──
  function onToolClick(event) {
    const btn = event.target.closest("[data-gb-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-gb-act");
    if (act === "edit") {
      ui.editMode = !ui.editMode;
      ui.selectedId = null;
      render();
    } else if (act === "reset") {
      try { localStorage.removeItem(LAYOUT_KEY); } catch { /* 同上 */ }
      positions = null;
      render();
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const nodeEl = event.target.closest(".gb-node");
    if (!nodeEl) return;
    const id = nodeEl.getAttribute("data-agent");
    const svg = container.querySelector("svg.graph-board");
    if (!id || !svg) return;
    const rect = svg.getBoundingClientRect();
    const k = rect.width / Number(svg.getAttribute("width") || rect.width || 1) || 1;
    drag = {
      id, k,
      startX: event.clientX, startY: event.clientY,
      orig: { ...positions[id] }, moved: false, raf: 0,
    };
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / drag.k;
    const dy = (event.clientY - drag.startY) / drag.k;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    positions[drag.id] = {
      x: Math.max(0, drag.orig.x + dx),
      y: Math.max(0, drag.orig.y + dy),
      w: drag.orig.w, h: drag.orig.h,
    };
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => { drag.raf = 0; render(); });
    }
  }

  function onPointerUp() {
    if (!drag) return;
    const { id, moved } = drag;
    if (moved) {
      const p = positions[id];
      positions[id] = { x: graphSnap(p.x), y: graphSnap(p.y), w: p.w, h: p.h };
      persist();
      render();
    } else if (ui.editMode) {
      // 连线模式的点选：首次=选源，再次=连（点自己=取消）
      if (ui.selectedId === null) {
        ui.selectedId = id;
      } else if (ui.selectedId === id) {
        ui.selectedId = null;
      } else {
        const from = ui.selectedId;
        ui.selectedId = null;
        void connect(from, id);
      }
      render();
    }
    drag = null;
  }

  function onEdgeContext(event) {
    const hit = event.target.closest(".gb-edge-hit, .gb-edge-knob");
    if (!hit) return;
    event.preventDefault();
    const [from, to] = String(hit.getAttribute("data-edge") || "").split("|");
    if (from && to) void removeEdge(from, to);
  }

  // 编辑模式下点选边 → 选中态;Delete/Backspace 删除(右键之外的显式路径)
  function onEdgeClick(event) {
    if (!ui.editMode) return;
    const hit = event.target.closest(".gb-edge-hit, .gb-edge-knob");
    if (!hit) return;
    const key = String(hit.getAttribute("data-edge") || "");
    if (!key) return;
    ui.selectedEdge = ui.selectedEdge === key ? null : key;
    ui.selectedId = null;
    render();
  }

  function onKey(event) {
    if (event.key === "Escape") {
      if (ui.selectedId !== null || ui.selectedEdge !== null) {
        ui.selectedId = null;
        ui.selectedEdge = null;
        render();
      }
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && ui.selectedEdge) {
      const [from, to] = ui.selectedEdge.split("|");
      ui.selectedEdge = null;
      if (from && to) void removeEdge(from, to);
    }
  }

  function onStoreChange() { render(); }

  container.addEventListener("click", onToolClick);
  container.addEventListener("click", onEdgeClick);
  container.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  container.addEventListener("contextmenu", onEdgeContext);
  window.addEventListener("keydown", onKey);
  const unsubscribe = store.subscribe(onStoreChange);

  render();
  return {
    render,
    destroy() {
      if (ui.statusTimer) clearTimeout(ui.statusTimer);
      if (drag && drag.raf) cancelAnimationFrame(drag.raf);
      container.removeEventListener("click", onToolClick);
      container.removeEventListener("click", onEdgeClick);
      container.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("contextmenu", onEdgeContext);
      window.removeEventListener("keydown", onKey);
      unsubscribe();
    },
  };
}
