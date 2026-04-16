// dashboard-svg.js — Layout constants, SVG generation, node drawing, flow lines
import { shortModel } from './dashboard-common.js';
import { emit } from './dashboard-bus.js';
import { activeFlows, shouldDisplayDashboardAgentRecord } from './dashboard.js';
import { baseViewBox, viewBox, zoomLevel, clampViewBox, applyViewBox, initDrag } from './dashboard-drag.js';
import { resolveFlowVisualClasses } from './dashboard-flow-visuals.js';

// Late-bound imports (circular — only used inside event handlers, not at eval time)
import { hideTooltip, showTooltip, showContextMenu, openModelPicker, exitModelSelectMode, activeTooltipAgent } from './dashboard-ux.js';
import { handleGraphNodePrimaryAction } from './dashboard-graph.js';

// ── Layout constants ──
export const SVG_W = 680;
export const NODE_W = 160, NODE_H = 78;
export const SLOT_GAP = 28, SLOT_H = NODE_H + SLOT_GAP;
export const COL_LEFT = 20, COL_CENTER = 270;
export const RESULT_X = 500, RESULT_W = 120;
export const TOP_Y = 10;
export const GRID_SNAP = 10;

// ── SVG element state ──
export let nodePositions = {};
export let savedPositions = {};
export let dynamicWorkers = [];

try {
  const saved = localStorage.getItem('openclaw-node-layout');
  if (saved) savedPositions = JSON.parse(saved);
} catch {}

// ── SVG helper ──
const NS = 'http://www.w3.org/2000/svg';
export function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'textContent') el.textContent = v;
    else if (k === 'className') el.setAttribute('class', v);
    else el.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(el);
  return el;
}

// ── Element ID mapping — generic, no hardcoded aliases ──
export function eid(agentId) {
  const safe = agentId.replace(/[^a-zA-Z0-9-]/g, '_');
  return { nb:`nb-${safe}`, sd:`sd-${safe}`, nm:`nm-${safe}`, model:`model-${safe}`, st:`st-${safe}`, qg:`qg-${safe}` };
}

export function snap(v) { return Math.round(v / GRID_SNAP) * GRID_SNAP; }

function placeNode(id, x, y, w = NODE_W, h = NODE_H) {
  nodePositions[id] = { x: snap(x), y: snap(y), w, h };
}

// ══════════════════════════════════════════════════════════════════════════════
// BUILD PIPELINE SVG
// ══════════════════════════════════════════════════════════════════════════════

export function buildPipelineSVG(agents) {
  const svg = document.getElementById('pipelineSvg');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  nodePositions = {};
  window._visiblePipelineAgentIds = [];
  const visibleAgents = (Array.isArray(agents) ? agents : []).filter((agent) => shouldDisplayDashboardAgentRecord(agent));

  // Role-based classification
  const bridgeNodes = [];
  const plannerNodes = [];
  const pipelineNodes = [];
  for (const a of visibleAgents) {
    const role = a.role || 'agent';
    if (role === 'bridge') {
      bridgeNodes.push(a);
      continue;
    }
    if (role === 'planner') {
      plannerNodes.push(a);
      continue;
    }
    pipelineNodes.push(a);
  }
  bridgeNodes.sort((left, right) => left.id.localeCompare(right.id));
  plannerNodes.sort((left, right) => left.id.localeCompare(right.id));
  pipelineNodes.sort((left, right) => {
    const order = (agent) => {
      if (agent.role === 'researcher') return 10;
      if (agent.role === 'executor' && agent.specialized) return 20;
      if (agent.role === 'executor') return 30;
      if (agent.role === 'reviewer') return 40;
      return 50;
    };
    const leftOrder = order(left);
    const rightOrder = order(right);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
  });
  dynamicWorkers = pipelineNodes.filter((agent) => agent.role === 'executor' && !agent.specialized).map((agent) => agent.id);
  for (let i = 0; i < pipelineNodes.length; i += 1) {
    placeNode(pipelineNodes[i].id, COL_CENTER, TOP_Y + i * SLOT_H);
  }
  let leftColumnY = TOP_Y;
  for (const agent of bridgeNodes) {
    placeNode(agent.id, COL_LEFT, leftColumnY);
    leftColumnY += SLOT_H;
  }
  if (bridgeNodes.length > 0 && plannerNodes.length > 0) {
    leftColumnY += 20;
  }
  for (const agent of plannerNodes) {
    placeNode(agent.id, COL_LEFT, leftColumnY);
    leftColumnY += SLOT_H;
  }

  const resultAnchorNode = pipelineNodes[Math.floor((pipelineNodes.length - 1) / 2)]
    || plannerNodes[Math.floor((plannerNodes.length - 1) / 2)]
    || bridgeNodes[Math.floor((bridgeNodes.length - 1) / 2)]
    || null;
  const resultY = resultAnchorNode ? nodePositions[resultAnchorNode.id].y : TOP_Y;
  nodePositions['_result'] = { x: snap(RESULT_X), y: snap(resultY), w: RESULT_W, h: NODE_H };

  // Apply saved drag positions
  for (const [id, saved] of Object.entries(savedPositions)) {
    if (nodePositions[id]) { nodePositions[id].x = snap(saved.x); nodePositions[id].y = snap(saved.y); }
  }

  const laidOutNodeIds = [
    ...bridgeNodes.map((agent) => agent.id),
    ...plannerNodes.map((agent) => agent.id),
    ...pipelineNodes.map((agent) => agent.id),
  ];
  const bottomY = laidOutNodeIds.length > 0
    ? Math.max(
        ...laidOutNodeIds.map((agentId) => nodePositions[agentId].y + NODE_H),
        nodePositions['_result'].y + NODE_H,
      )
    : nodePositions['_result'].y + NODE_H;
  const viewH = snap(bottomY + 40);
  baseViewBox.w = SVG_W; baseViewBox.h = viewH;
  viewBox.w = SVG_W / zoomLevel; viewBox.h = viewH / zoomLevel;
  clampViewBox();
  applyViewBox(svg);

  // Flow lines are now data-driven (dynamic), no static drawFlowLines() call

  const laidOutAgents = [];
  for (const a of visibleAgents) {
    if (!nodePositions[a.id]) continue;
    laidOutAgents.push(a);
    drawNode(svg, a, nodePositions[a.id]);
  }
  window._visiblePipelineAgentIds = laidOutAgents.map((agent) => agent.id);

  const rp = nodePositions['_result'];
  const rg = svgEl('g', { 'data-agent':'_result', className:'pipeline-node result-node' }, svg);
  svgEl('rect', { x:rp.x, y:rp.y, width:rp.w, height:rp.h, className:'svg-node-box node-result' }, rg);
  svgEl('text', { x:rp.x+rp.w/2, y:rp.y+30, textContent:'RESULT', className:'svg-node-name' }, rg);
  svgEl('text', { x:rp.x+rp.w/2, y:rp.y+46, textContent:'OUTPUT', className:'svg-node-role' }, rg);
  let rlTimer = null;
  rg.addEventListener('mouseenter', () => { rlTimer = setTimeout(() => highlightConnections('_result', true), 400); });
  rg.addEventListener('mouseleave', () => { clearTimeout(rlTimer); highlightConnections('_result', false); });

  const wrap = document.querySelector('.pipeline-wrap');
  if (wrap) wrap.style.minHeight = `${viewH+20}px`;
  initDrag(svg);

  emit('pipeline:rebuilt');
}

// ── Draw node with hover/context listeners ──
function drawNode(svg, agent, pos) {
  const ids = eid(agent.id);
  const isSpecialist = agent.role === 'researcher' || agent.role === 'reviewer';
  const g = svgEl('g', { 'data-agent':agent.id, className:'pipeline-node' }, svg);

  svgEl('rect', { x:pos.x, y:pos.y, width:pos.w, height:pos.h,
    className:'svg-node-box' + (isSpecialist ? ' node-specialist' : ''), id:ids.nb }, g);

  svgEl('rect', { x:pos.x+8, y:pos.y+8, width:8, height:8, className:'svg-status-dot', id:ids.sd }, g);
  svgEl('text', { x:pos.x+pos.w/2, y:pos.y+24, textContent:agent.id.toUpperCase(), className:'svg-node-name', id:ids.nm }, g);
  svgEl('text', { x:pos.x+pos.w/2, y:pos.y+37, textContent:(agent.role||'agent').toUpperCase(), className:'svg-node-role' }, g);

  svgEl('text', { x:pos.x+pos.w/2, y:pos.y+50,
    textContent:shortModel(agent.model)||'-', className:'svg-node-model', id:ids.model }, g);

  svgEl('text', { x:pos.x+pos.w/2, y:pos.y+65, textContent:'IDLE', className:'svg-node-status', id:ids.st }, g);
  svgEl('g', { id: ids.qg, className: 'svg-queue-badges' }, g);

  let hlTimer = null;
  g.addEventListener('mouseenter', () => { hlTimer = setTimeout(() => highlightConnections(agent.id, true), 400); });
  g.addEventListener('mouseleave', () => { clearTimeout(hlTimer); highlightConnections(agent.id, false); });

  g.addEventListener('click', (e) => {
    if ((window.__openclawSuppressNodeClickUntil || 0) > Date.now()) return;
    e.stopPropagation();
    if (OC.ux.editMode) {
      hideTooltip();
      if (window._modelSwitchPending) {
        window._modelSwitchPending = false;
        const modelEl = document.getElementById(ids.model);
        if (modelEl) openModelPicker(agent.id, modelEl);
        exitModelSelectMode();
        return;
      }
      handleGraphNodePrimaryAction(agent.id);
      return;
    }
    if (activeTooltipAgent === agent.id) hideTooltip();
    else { hideTooltip(); showTooltip(agent.id); }
  });

  g.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, agent.id); });
}

// ══════════════════════════════════════════════════════════════════════════════
// SHARED EDGE PATH CALCULATOR — port-based connection (React Flow style)
// ══════════════════════════════════════════════════════════════════════════════

export function calcEdgePath(pFrom, pTo) {
  const isLoopBack = pFrom.y > pTo.y && Math.abs(pFrom.x - pTo.x) < pFrom.w + 60;
  const isSameCol = Math.abs(pFrom.x - pTo.x) < 30;
  const isLR = pFrom.x + pFrom.w <= pTo.x;
  const isRL = pTo.x + pTo.w <= pFrom.x;

  let x1, y1, x2, y2, pathD, labelX, labelY;

  if (isLoopBack) {
    x1 = pFrom.x;           y1 = pFrom.y + pFrom.h / 2;
    x2 = pTo.x;             y2 = pTo.y + pTo.h / 2;
    const loopOffset = Math.max(70, Math.abs(y1 - y2) * 0.35);
    const cx = Math.min(x1, x2) - loopOffset;
    pathD = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
    labelX = cx - 4;
    labelY = (y1 + y2) / 2;
  } else if (isSameCol) {
    const goingDown = pFrom.y < pTo.y;
    x1 = pFrom.x + pFrom.w / 2; y1 = goingDown ? pFrom.y + pFrom.h : pFrom.y;
    x2 = pTo.x + pTo.w / 2;     y2 = goingDown ? pTo.y : pTo.y + pTo.h;
    const dist = Math.abs(y2 - y1);
    const tension = Math.max(dist * 0.3, 20);
    const offsetX = 12;
    pathD = `M${x1},${y1} C${x1 + offsetX},${y1 + (goingDown ? tension : -tension)} ${x2 - offsetX},${y2 + (goingDown ? -tension : tension)} ${x2},${y2}`;
    labelX = (x1 + x2) / 2 + offsetX;
    labelY = (y1 + y2) / 2;
  } else if (isLR) {
    x1 = pFrom.x + pFrom.w; y1 = pFrom.y + pFrom.h / 2;
    x2 = pTo.x;             y2 = pTo.y + pTo.h / 2;
    const dist = Math.abs(x2 - x1);
    const tension = Math.max(dist * 0.4, 50);
    pathD = `M${x1},${y1} C${x1 + tension},${y1} ${x2 - tension},${y2} ${x2},${y2}`;
    labelX = (x1 + x2) / 2;
    labelY = (y1 + y2) / 2 - 6;
  } else if (isRL) {
    const sameRow = Math.abs(pFrom.y - pTo.y) < pFrom.h * 0.6;
    if (sameRow) {
      x1 = pFrom.x + pFrom.w / 2; y1 = pFrom.y;
      x2 = pTo.x + pTo.w / 2;     y2 = pTo.y;
      const dist = Math.abs(x1 - x2);
      const arcHeight = Math.max(dist * 0.12, 30);
      const cy = Math.min(y1, y2) - arcHeight;
      pathD = `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = cy - 6;
    } else {
      x1 = pFrom.x;           y1 = pFrom.y + pFrom.h / 2;
      x2 = pTo.x + pTo.w;     y2 = pTo.y + pTo.h / 2;
      const dist = Math.abs(x1 - x2);
      const tension = Math.max(dist * 0.4, 50);
      pathD = `M${x1},${y1} C${x1 - tension},${y1} ${x2 + tension},${y2} ${x2},${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = (y1 + y2) / 2 - 6;
    }
  } else {
    const goingDown = pFrom.y < pTo.y;
    x1 = pFrom.x + pFrom.w / 2; y1 = goingDown ? pFrom.y + pFrom.h : pFrom.y;
    x2 = pTo.x + pTo.w / 2;     y2 = goingDown ? pTo.y : pTo.y + pTo.h;
    const tension = Math.max(Math.abs(y2 - y1) * 0.3, 30);
    pathD = `M${x1},${y1} C${x1},${y1 + (goingDown ? tension : -tension)} ${x2},${y2 + (goingDown ? -tension : tension)} ${x2},${y2}`;
    labelX = (x1 + x2) / 2;
    labelY = (y1 + y2) / 2;
  }

  return { pathD, x1, y1, x2, y2, labelX, labelY };
}

// ══════════════════════════════════════════════════════════════════════════════
// DYNAMIC FLOW LINES — data-driven, created/removed at runtime
// ══════════════════════════════════════════════════════════════════════════════

export function createFlowLine(from, to, label, type) {
  const svg = document.getElementById('pipelineSvg');
  if (!svg) return null;
  const pFrom = nodePositions[from], pTo = nodePositions[to];
  if (!pFrom || !pTo) return null;

  const g = svgEl('g', { className: 'flow-dynamic-group', 'data-flow': `${from}\u2192${to}`, 'data-agents': `${from},${to}` }, svg);

  const edge = calcEdgePath(pFrom, pTo);
  const normalizedType = type === 'standard' ? 'graph-route' : (type || 'graph-route');
  const typeClass = resolveFlowVisualClasses(normalizedType);

  svgEl('path', { d: edge.pathD, className: `flow-dynamic${typeClass}` }, g);

  if (label) {
    svgEl('text', { x: edge.labelX, y: edge.labelY - 6, textContent: label, className: `flow-dynamic-label${typeClass}` }, g);
  }

  // Animate in
  requestAnimationFrame(() => g.classList.add('flow-active'));
  return g;
}

export function removeFlowLine(element) {
  if (!element) return;
  element.classList.add('flow-fading');
  element.classList.remove('flow-active');
  element.addEventListener('transitionend', () => element.remove(), { once: true });
  // Fallback: remove after 2s if transitionend doesn't fire
  setTimeout(() => { if (element.parentNode) element.remove(); }, 2000);
}

export function rebuildActiveFlowElements() {
  for (const [key, flow] of activeFlows) {
    if (flow.element && flow.element.parentNode) flow.element.remove();
    const el = createFlowLine(flow.from, flow.to, flow.label, flow.type || 'standard');
    if (el) {
      flow.element = el;
    } else {
      activeFlows.delete(key);
    }
  }
}

// ── Hover highlight connections ──
export function highlightConnections(agentId, on) {
  const svg = document.getElementById('pipelineSvg');
  if (!svg) return;
  svg.querySelectorAll('.pipeline-node').forEach(g => {
    const id = g.getAttribute('data-agent');
    if (id !== agentId) g.classList.toggle('dimmed', on);
  });
  svg.querySelectorAll('[data-agents]').forEach(el => {
    if (el.getAttribute('data-agents').split(',').includes(agentId)) {
      el.classList.toggle('highlight', on);
    }
  });
}
