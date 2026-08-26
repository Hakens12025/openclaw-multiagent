// components/graph-board.js — 编排图（纯渲染：model + t + ui → SVG 字符串）。
// 设计文档 2026-08-24 §1 铁律：components 零副作用、零 fetch——拖动/连线编辑的
// 接线在 pages/command/graph-board-controller.js（页面层）。
// 布局几何（calcEdgePath 五种）移植自旧 dashboard-svg.js；布局支持外部注入
// （ui.layout，拖动态位置由页面层持有）；ui = { editMode, selectedId, layout }。
// 动效语义纪律（§2.1）：动=有事在传，静=无事。
import { esc } from "../core/html.js";

const SVG_MIN_W = 680;
const NODE_W = 160, NODE_H = 78;
const SLOT_H = NODE_H + 28;
const COL_LEFT = 20, COL_CENTER = 270;
const TOP_Y = 28;
const GRID_SNAP = 10;

// ── 边路径计算（React Flow 式端口连接，五种几何，移植自 dashboard-svg.js）──
export function calcEdgePath(pFrom, pTo) {
  const isLoopBack = pFrom.y > pTo.y && Math.abs(pFrom.x - pTo.x) < pFrom.w + 60;
  const isSameCol = Math.abs(pFrom.x - pTo.x) < 30;
  const isLR = pFrom.x + pFrom.w <= pTo.x;
  const isRL = pTo.x + pTo.w <= pFrom.x;

  let x1, y1, x2, y2, pathD, labelX, labelY;

  if (isLoopBack) {
    x1 = pFrom.x; y1 = pFrom.y + pFrom.h / 2;
    x2 = pTo.x; y2 = pTo.y + pTo.h / 2;
    const loopOffset = Math.max(70, Math.abs(y1 - y2) * 0.35);
    const cx = Math.min(x1, x2) - loopOffset;
    pathD = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
    labelX = cx - 4; labelY = (y1 + y2) / 2;
  } else if (isSameCol) {
    const goingDown = pFrom.y < pTo.y;
    x1 = pFrom.x + pFrom.w / 2; y1 = goingDown ? pFrom.y + pFrom.h : pFrom.y;
    x2 = pTo.x + pTo.w / 2; y2 = goingDown ? pTo.y : pTo.y + pTo.h;
    const dist = Math.abs(y2 - y1);
    const tension = Math.max(dist * 0.3, 20);
    const offsetX = 12;
    pathD = `M${x1},${y1} C${x1 + offsetX},${y1 + (goingDown ? tension : -tension)} ${x2 - offsetX},${y2 + (goingDown ? -tension : tension)} ${x2},${y2}`;
    labelX = (x1 + x2) / 2 + offsetX; labelY = (y1 + y2) / 2;
  } else if (isLR) {
    x1 = pFrom.x + pFrom.w; y1 = pFrom.y + pFrom.h / 2;
    x2 = pTo.x; y2 = pTo.y + pTo.h / 2;
    const dist = Math.abs(x2 - x1);
    const tension = Math.max(dist * 0.4, 50);
    pathD = `M${x1},${y1} C${x1 + tension},${y1} ${x2 - tension},${y2} ${x2},${y2}`;
    labelX = (x1 + x2) / 2; labelY = (y1 + y2) / 2 - 6;
  } else if (isRL) {
    const sameRow = Math.abs(pFrom.y - pTo.y) < pFrom.h * 0.6;
    if (sameRow) {
      x1 = pFrom.x + pFrom.w / 2; y1 = pFrom.y;
      x2 = pTo.x + pTo.w / 2; y2 = pTo.y;
      const dist = Math.abs(x1 - x2);
      const arcHeight = Math.max(dist * 0.12, 30);
      const cy = Math.min(y1, y2) - arcHeight;
      pathD = `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`;
      labelX = (x1 + x2) / 2; labelY = cy - 6;
    } else {
      x1 = pFrom.x; y1 = pFrom.y + pFrom.h / 2;
      x2 = pTo.x + pTo.w; y2 = pTo.y + pTo.h / 2;
      const dist = Math.abs(x1 - x2);
      const tension = Math.max(dist * 0.4, 50);
      pathD = `M${x1},${y1} C${x1 - tension},${y1} ${x2 + tension},${y2} ${x2},${y2}`;
      labelX = (x1 + x2) / 2; labelY = (y1 + y2) / 2 - 6;
    }
  } else {
    const goingDown = pFrom.y < pTo.y;
    x1 = pFrom.x + pFrom.w / 2; y1 = goingDown ? pFrom.y + pFrom.h : pFrom.y;
    x2 = pTo.x + pTo.w / 2; y2 = goingDown ? pTo.y : pTo.y + pTo.h;
    const tension = Math.max(Math.abs(y2 - y1) * 0.3, 30);
    pathD = `M${x1},${y1} C${x1},${y1 + (goingDown ? tension : -tension)} ${x2},${y2 + (goingDown ? -tension : tension)} ${x2},${y2}`;
    labelX = (x1 + x2) / 2; labelY = (y1 + y2) / 2;
  }

  return { pathD, x1, y1, x2, y2, labelX, labelY };
}

export const graphSnap = (v) => Math.round(v / GRID_SNAP) * GRID_SNAP;
const edgeKey = (from, to) => `${from}|${to}`;

// 环 → 高亮边集合：cycles = [[a,b,c,a], ...]（GET graph / edge 响应自带）。
function cycleEdgeSet(cycles) {
  const set = new Set();
  for (const cycle of Array.isArray(cycles) ? cycles : []) {
    for (let i = 0; i < cycle.length - 1; i += 1) set.add(edgeKey(cycle[i], cycle[i + 1]));
  }
  return set;
}

function overlaps(a, b) {
  return a.x < b.x + b.w + 16 && b.x < a.x + a.w + 16
    && a.y < b.y + b.h + 16 && b.y < a.y + a.h + 16;
}

// 自动布局：bridge/planner 左列、其余中列；已保存位置为锚，未保存节点避开锚落位。
// saved 条目 {x,y} 即可（老页 openclaw-node-layout 布局可直接继承）。
export function autoLayout(nodes, saved = {}) {
  const positions = {};
  const placed = [];
  for (const node of nodes) {
    const s = saved[node.id];
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
      positions[node.id] = { x: graphSnap(s.x), y: graphSnap(s.y), w: NODE_W, h: NODE_H };
      placed.push(positions[node.id]);
    }
  }
  const left = [], center = [];
  for (const node of nodes) {
    if (positions[node.id]) continue;
    (node.role === "bridge" || node.role === "planner" ? left : center).push(node);
  }
  const place = (node, colX, i) => {
    const rect = { x: colX, y: TOP_Y + i * SLOT_H, w: NODE_W, h: NODE_H };
    // 锚点占位则逐档下移，直到无碰撞（saved 布局优先，自动位让路）
    while (placed.some((p) => overlaps(rect, p))) rect.y += SLOT_H;
    positions[node.id] = { x: rect.x, y: graphSnap(rect.y), w: NODE_W, h: NODE_H };
    placed.push(positions[node.id]);
  };
  left.forEach((node, i) => place(node, COL_LEFT, i));
  center.forEach((node, i) => place(node, COL_CENTER, i));
  return positions;
}

// 角标记（仪器卡四角刻线，NASA-punk 细节语言；柔化三色内）
function cornerTicks(pos) {
  const { x, y, w, h } = pos;
  return `<path class="gb-ticks" d="M${x - 4},${y} h8 M${x},${y - 4} v8`
    + ` M${x + w - 4},${y + h} h8 M${x + w},${y + h - 4} v8"/>`;
}

function renderNode(node, pos, receiving, ui, t) {
  const status = node.status === "active" ? "active" : "idle";
  const cx = pos.x + pos.w / 2;
  const classes = ["gb-node-box"];
  if (status === "active") classes.push("is-active");
  if (receiving) classes.push("is-receiving");
  if (ui.editMode) classes.push("is-edit");
  if (ui.selectedId === node.id) classes.push("is-source");
  return `<g class="gb-node" data-agent="${esc(node.id)}">`
    + `<rect class="${classes.join(" ")}" x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}"/>`
    + cornerTicks(pos)
    + `<rect class="gb-status-sq is-${status}" x="${pos.x + 8}" y="${pos.y + 8}" width="8" height="8"/>`
    + `<text class="gb-node-name" x="${cx}" y="${pos.y + 24}">${esc(node.id).toUpperCase()}</text>`
    + `<text class="gb-node-role" x="${cx}" y="${pos.y + 37}">${esc(node.role || "agent").toUpperCase()}</text>`
    + `<text class="gb-node-status" x="${cx}" y="${pos.y + 65}">${esc(t(`graph.status.${status}`))}</text>`
    + `</g>`;
}

function renderQueueStack(nodeId, pos, count, t) {
  const capped = Math.min(count, 5);
  let out = "";
  for (let i = 0; i < capped; i += 1) {
    // 排队动画语义（§2.1）：合约卡在目标入口左侧堆叠，每张错开 4px。
    out += `<rect class="gb-queue-card" data-target="${esc(nodeId)}" x="${pos.x - 16 - i * 4}" y="${pos.y + pos.h / 2 - 6 - i * 4}" width="12" height="12"/>`;
  }
  if (count > 0) {
    out += `<text class="gb-queue-count" x="${pos.x - 20}" y="${pos.y + pos.h / 2 + 16}">${esc(t("graph.queue", { n: count }))}</text>`;
  }
  return out;
}

export function renderGraphBoard(model, t, ui = {}) {
  const { nodes = [], edges = [], flows = [], queues = {}, cycles = [] } = model || {};
  if (!nodes.length) {
    return `<svg class="graph-board gb-empty" width="${SVG_MIN_W}" height="120"><text x="20" y="60" class="gb-empty-text">${esc(t("graph.empty"))}</text></svg>`;
  }
  const positions = ui.layout || autoLayout(nodes);
  const flowTargets = new Set(flows.map((f) => f.to));
  const cyclic = cycleEdgeSet(cycles);
  const width = Math.max(SVG_MIN_W, ...Object.values(positions).map((p) => p.x + p.w + 60));

  const defs = `<defs>`
    + `<pattern id="gb-dots" width="20" height="20" patternUnits="userSpaceOnUse">`
    + `<circle cx="1" cy="1" r="1" fill="var(--line-soft)"/></pattern>`
    + `<marker id="gb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
    + `<path d="M0,0 L10,5 L0,10 z" fill="var(--line-soft)"/></marker></defs>`;

  let body = `<rect class="gb-grid-bg" width="${width}" height="100%" fill="url(#gb-dots)"/>`;
  for (const edge of edges) {
    const pFrom = positions[edge.from];
    const pTo = positions[edge.to];
    if (!pFrom || !pTo) continue;
    const { pathD, labelX, labelY } = calcEdgePath(pFrom, pTo);
    body += `<path class="gb-edge" d="${pathD}" marker-end="url(#gb-arrow)"/>`;
    if (cyclic.has(edgeKey(edge.from, edge.to))) {
      body += `<path class="gb-cycle" d="${pathD}" marker-end="url(#gb-arrow)"/>`;
    }
    // 命中区：宽透明描边 + 中点圆钮（真实几何点，右键/点选+Delete 的落点）
    const key = edgeKey(edge.from, edge.to);
    const hitClass = ui.selectedEdge === key ? "gb-edge-hit is-selected" : "gb-edge-hit";
    const knobClass = ui.selectedEdge === key ? "gb-edge-knob is-selected" : "gb-edge-knob";
    body += `<path class="${hitClass}" data-edge="${esc(edge.from)}|${esc(edge.to)}" d="${pathD}"/>`
      + `<circle class="${knobClass}" data-edge="${esc(edge.from)}|${esc(edge.to)}" cx="${labelX}" cy="${labelY + 10}" r="9"/>`;
  }
  for (const flow of flows) {
    const pFrom = positions[flow.from];
    const pTo = positions[flow.to];
    if (!pFrom || !pTo) continue;
    const { pathD, labelX, labelY } = calcEdgePath(pFrom, pTo);
    // 交接动画（§2.1 裁决5）：合约卡实体沿边滑行（offset-path），CSS @keyframes gb-slide 驱动。
    body += `<path class="gb-flow-lane" d="${pathD}"/>`
      + `<g class="contract-card" style="offset-path: path('${pathD}')"><rect width="14" height="10" x="-7" y="-5"/></g>`;
    if (flow.label) {
      body += `<text class="gb-flow-label" x="${labelX}" y="${labelY - 6}">${esc(flow.label)}</text>`;
    }
  }
  for (const [nodeId, count] of Object.entries(queues)) {
    const pos = positions[nodeId];
    if (!pos || !(count > 0)) continue;
    body += renderQueueStack(nodeId, pos, count, t);
  }
  for (const node of nodes) {
    body += renderNode(node, positions[node.id], flowTargets.has(node.id), ui, t);
  }

  const bottomY = Math.max(...nodes.map((n) => positions[n.id].y + NODE_H));
  const height = bottomY + 40;
  return `<svg class="graph-board" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}${body}</svg>`;
}
