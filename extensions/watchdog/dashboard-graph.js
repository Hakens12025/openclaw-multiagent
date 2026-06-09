// dashboard-graph.js — Agent topology graph: persistent edges, cycle detection, visual editor
import { on } from './dashboard-bus.js';
import { eid, svgEl, nodePositions, calcEdgePath } from './dashboard-svg.js';
import { toast } from './dashboard-common.js';
import {
  workItems,
  describeGraphRouteProgression,
  getWorkItemGraphRouteProgression,
  getRuntimeGraphAgentId,
  isVisibleRuntimeGraphAgentId,
} from './dashboard.js';
import { closeContextMenu } from './dashboard-ux.js';

// ── Graph state ──
export let graphEdges = [];
let graphCycles = [];
let graphLoops = [];
let graphLoopSessions = [];
let activeGraphLoopSession = null;
let graphEdgeElements = new Map();
let pendingGraphEdgeOps = new Set();
let selectedGraphSourceAgent = null;
// Group-compose marquee state (#46): box-select agents in edit mode → AgentGroup.
let groupDrawMode = false;
let groupMarquee = null; // { x0, y0, rect } while a box is being dragged

function graphEdgeKey(edge) {
  return `${edge.from}\u2192${edge.to}`;
}

function publishGraphEdges(edges) {
  graphEdges = Array.isArray(edges) ? edges : [];
  window.__graphEdges = graphEdges.slice();
  const oc = window.OC || globalThis.OC || null;
  if (oc?.graph) {
    oc.graph.graphEdges = window.__graphEdges;
  }
}

function getGraphDisplayAgentId(agentId) {
  return getRuntimeGraphAgentId(agentId);
}

function normalizeGraphEdgeList(edges) {
  const uniqueEdges = [];
  const seen = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = getGraphDisplayAgentId(edge?.from);
    const to = getGraphDisplayAgentId(edge?.to);
    if (!from || !to || from === to) continue;
    const nextEdge = { ...edge, from, to };
    const key = graphEdgeKey(nextEdge);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEdges.push(nextEdge);
  }
  return uniqueEdges;
}

function visibleGraphEdgeList(edges) {
  return normalizeGraphEdgeList(edges).filter((edge) => (
    isVisibleRuntimeGraphAgentId(edge.from) && isVisibleRuntimeGraphAgentId(edge.to)
  ));
}

function normalizeGraphCycles(cycles) {
  const normalized = [];
  const seen = new Set();
  for (const cycle of Array.isArray(cycles) ? cycles : []) {
    const nodes = cycle
      .map((agentId) => getGraphDisplayAgentId(agentId))
      .filter(Boolean)
      .filter((agentId, index, list) => index === 0 || agentId !== list[index - 1]);
    if (nodes.length < 2) continue;
    const key = nodes.join('\u2192');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(nodes);
  }
  return normalized;
}

function renderGraphSourceSelection() {
  // Clear previous armed/candidate states
  document.querySelectorAll('.runtime-graph-node .svg-node-box.link-armed').forEach((el) => {
    el.classList.remove('link-armed');
  });
  document.querySelectorAll('.runtime-graph-node .svg-node-box.link-target-candidate').forEach((el) => {
    el.classList.remove('link-target-candidate');
  });
  document.body.classList.remove('link-armed-mode');

  // Remove old preview line
  const oldPreview = document.getElementById('graphEdgePreview');
  if (oldPreview) oldPreview.remove();

  if (!selectedGraphSourceAgent) return;

  // Mark source
  const box = document.getElementById(eid(selectedGraphSourceAgent).nb);
  if (box) box.classList.add('link-armed');

  // Mark all other visible nodes as target candidates
  const visibleIds = window._visibleRuntimeGraphAgentIds || [];
  for (const id of visibleIds) {
    if (id === selectedGraphSourceAgent) continue;
    const candidateBox = document.getElementById(eid(id).nb);
    if (candidateBox) candidateBox.classList.add('link-target-candidate');
  }

  // Body class for cursor
  document.body.classList.add('link-armed-mode');

  // Create preview line element
  const svg = document.getElementById('runtimeGraphSvg');
  if (svg) {
    svgEl('path', { id: 'graphEdgePreview', className: 'graph-edge-preview', d: 'M0,0' }, svg);
  }
}

function updateGraphEditHint() {
  const hint = document.getElementById('graphEditHint');
  if (!hint) return;
  hint.style.display = OC.ux.editMode ? 'inline-block' : 'none';
  if (!OC.ux.editMode) {
    hint.textContent = 'CLICK SOURCE \u00B7 CLICK TARGET';
    return;
  }
  if (groupDrawMode) {
    hint.textContent = '\u62D6\u6846\u9009\u62E9 \u22652 \u4E2A AGENT \u6210\u7EC4 \u00B7 \u518D\u70B9 COMPOSE GROUP \u53D6\u6D88';
    return;
  }
  hint.textContent = selectedGraphSourceAgent
    ? `SOURCE: ${selectedGraphSourceAgent.toUpperCase()} // CLICK TARGET OR SOURCE AGAIN`
    : 'CLICK SOURCE \u00B7 CLICK TARGET';
}

export function clearGraphSelection({ silent = false } = {}) {
  selectedGraphSourceAgent = null;
  renderGraphSourceSelection();
  updateGraphEditHint();
  // Clean up preview line
  const preview = document.getElementById('graphEdgePreview');
  if (preview) preview.remove();
  document.body.classList.remove('link-armed-mode');
  if (!silent) toast('LINK CANCELED', 'info');
}

export async function handleGraphNodePrimaryAction(agentId) {
  if (!OC.ux.editMode || !agentId) return false;
  if (!selectedGraphSourceAgent) {
    selectedGraphSourceAgent = agentId;
    renderGraphSourceSelection();
    updateGraphEditHint();
    return true;
  }
  if (selectedGraphSourceAgent === agentId) {
    clearGraphSelection({ silent: true });
    return true;
  }

  const from = getGraphDisplayAgentId(selectedGraphSourceAgent);
  const to = getGraphDisplayAgentId(agentId);
  clearGraphSelection({ silent: true });
  if (!from || !to || from === to) return true;

  const exists = graphEdges.some((edge) => edge.from === from && edge.to === to);
  if (exists) await deleteGraphEdge(from, to);
  else await addGraphEdge(from, to);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// LOAD GRAPH FROM API
// ══════════════════════════════════════════════════════════════════════════════

export async function loadGraph() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const r = await fetch(`/watchdog/graph?token=${encodeURIComponent(token)}`);
    if (!r.ok) return;
    const data = await r.json();
    publishGraphEdges(normalizeGraphEdgeList(data.edges));
    graphCycles = normalizeGraphCycles(data.cycles);
    graphLoops = data.loops || [];
    graphLoopSessions = data.loopSessions || [];
    activeGraphLoopSession = data.activeLoopSession || null;
    renderGraphEdges();
    highlightCycles();
    renderGraphSourceSelection();
    renderLoopState();
  } catch (e) {
    console.warn('[graph] load failed:', e);
  }
}

function renderLoopState() {
  const el = document.getElementById('runtimeGraphLoopState');
  if (!el) return;

  el.className = 'runtime-graph-loop-state';
  const activeRegisteredLoops = Array.isArray(graphLoops)
    ? graphLoops.filter(loop => loop?.active === true)
    : [];

  if (activeGraphLoopSession) {
    const runtimeStatus = String(activeGraphLoopSession.runtimeStatus || activeGraphLoopSession.status || 'active').toLowerCase();
    const stage = activeGraphLoopSession.currentStage ? String(activeGraphLoopSession.currentStage).toUpperCase() : 'ACTIVE';
    const round = Number.isFinite(activeGraphLoopSession.round) ? ` // R${activeGraphLoopSession.round}` : '';
    el.textContent = runtimeStatus === 'broken'
      ? `LOOP BROKEN // ${stage}${round}`
      : `LOOP ACTIVE // ${stage}${round}`;
    el.classList.add('visible', runtimeStatus === 'broken' ? 'broken' : 'active');
    el.title = activeGraphLoopSession.loopId
      ? `${activeGraphLoopSession.loopId} @ ${stage}`
      : `Active loop session @ ${stage}`;
    renderRuntimeGraphProgressState();
    return;
  }

  if (activeRegisteredLoops.length > 0) {
    el.textContent = `LOOP READY // ${activeRegisteredLoops.length}`;
    el.classList.add('visible', 'ready');
    el.title = activeRegisteredLoops.map(loop => loop.id).join(', ');
    renderRuntimeGraphProgressState();
    return;
  }

  if (Array.isArray(graphLoops) && graphLoops.length > 0) {
    el.textContent = `LOOP REGISTERED // ${graphLoops.length}`;
    el.classList.add('visible', 'idle');
    el.title = graphLoops.map(loop => loop.id).join(', ');
  }

  renderRuntimeGraphProgressState();
}

function progressionSortValue(contract, progression) {
  return Number(progression?.ts) || Number(contract?.updatedAt) || Number(contract?.createdAt) || 0;
}

function progressionMatchesActiveSession(progression) {
  if (!progression || !activeGraphLoopSession) return true;
  if (progression.loopSessionId && activeGraphLoopSession.id) {
    return progression.loopSessionId === activeGraphLoopSession.id;
  }
  if (progression.pipelineId && activeGraphLoopSession.pipelineId) {
    return progression.pipelineId === activeGraphLoopSession.pipelineId;
  }
  return false;
}

function selectLatestGraphRouteProgression() {
  const candidates = Object.values(workItems)
    .map((contract) => ({
      contract,
      progression: getWorkItemGraphRouteProgression(contract),
    }))
    .filter(({ progression }) => progression)
    .sort((left, right) => progressionSortValue(right.contract, right.progression) - progressionSortValue(left.contract, left.progression));

  if (!candidates.length) return null;
  const matching = candidates.filter(({ progression }) => progressionMatchesActiveSession(progression));
  return matching[0] || candidates[0] || null;
}

function renderRuntimeGraphProgressState() {
  const el = document.getElementById('runtimeGraphProgressState');
  if (!el) return;

  el.className = 'runtime-graph-progress-state';
  el.textContent = '';
  el.title = '';

  const latest = selectLatestGraphRouteProgression();
  if (!latest) return;

  const ui = describeGraphRouteProgression(latest.progression);
  if (!ui) return;

  el.textContent = ui.text;
  el.classList.add('visible', ui.tone || 'idle');
  el.title = [
    latest.contract?.id ? `contract: ${latest.contract.id}` : null,
    ui.title || null,
    latest.progression?.reason ? `reason: ${latest.progression.reason}` : null,
    latest.progression?.error ? `error: ${latest.progression.error}` : null,
  ].filter(Boolean).join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// RENDER PERSISTENT GRAPH EDGES
// ══════════════════════════════════════════════════════════════════════════════

export function renderGraphEdges() {
  const svg = document.getElementById('runtimeGraphSvg');
  if (!svg) return;

  ensureGraphDefs(svg);

  const visibleEdges = visibleGraphEdgeList(graphEdges);
  const hasMissingGeometry = visibleEdges.some((edge) => !canRenderGraphEdge(edge));
  if (
    hasMissingGeometry
    && visibleEdges.every((edge) => graphEdgeElements.get(graphEdgeKey(edge))?.parentNode)
  ) {
    for (const edge of visibleEdges) {
      const el = graphEdgeElements.get(graphEdgeKey(edge));
      if (el?.style) el.style.opacity = '1';
    }
    return;
  }

  const nextElements = new Map();
  let skippedForGeometry = false;
  for (const edge of visibleEdges) {
    const key = graphEdgeKey(edge);
    const existing = graphEdgeElements.get(key);
    if (hasMissingGeometry && existing?.parentNode) {
      nextElements.set(key, existing);
      continue;
    }
    const el = createGraphEdge(svg, edge);
    if (el) {
      nextElements.set(key, el);
      continue;
    }
    skippedForGeometry = true;
    if (existing?.parentNode) {
      nextElements.set(key, existing);
    }
  }

  if (skippedForGeometry && nextElements.size === graphEdgeElements.size) {
    for (const [key, el] of nextElements) {
      if (!graphEdgeElements.has(key) && el?.parentNode) el.remove();
    }
    for (const el of nextElements.values()) {
      if (el?.style) {
        el.style.opacity = '1';
      }
    }
    return;
  }

  for (const [key, el] of graphEdgeElements) {
    const nextEl = nextElements.get(key) || null;
    if (el !== nextEl && el.parentNode) el.remove();
  }
  graphEdgeElements = nextElements;
}

// ══════════════════════════════════════════════════════════════════════════════
// CREATE A SINGLE PERSISTENT GRAPH EDGE (SVG)
// ══════════════════════════════════════════════════════════════════════════════

function createGraphEdge(svg, edge) {
  if (!canRenderGraphEdge(edge)) return null;
  const pFrom = nodePositions[edge.from];
  const pTo = nodePositions[edge.to];

  // Check if this edge is part of a cycle
  const inCycle = graphCycles.some(cycle => {
    const idx = cycle.indexOf(edge.from);
    return idx >= 0 && cycle[(idx + 1) % cycle.length] === edge.to;
  });

  const g = svgEl('g', {
    className: 'graph-edge-group',
    'data-graph-edge': `${edge.from}\u2192${edge.to}`,
    'data-agents': `${edge.from},${edge.to}`,
  }, svg);

  const markerRef = inCycle ? 'url(#graph-arrowhead-cycle)' : 'url(#graph-arrowhead)';

  // Use shared port-based path calculator
  const ep = calcEdgePath(pFrom, pTo);

  svgEl('path', {
    d: ep.pathD,
    className: `graph-edge-persistent${inCycle ? ' in-cycle' : ''}`,
    'marker-end': markerRef,
  }, g);

  // Port dots at start and end
  svgEl('circle', { cx: ep.x1, cy: ep.y1, r: 3, className: 'graph-edge-port' }, g);
  svgEl('circle', { cx: ep.x2, cy: ep.y2, r: 3, className: 'graph-edge-port' }, g);

  // Label
  if (edge.label) {
    svgEl('text', {
      x: ep.labelX, y: ep.labelY,
      textContent: edge.label.toUpperCase(),
      className: `graph-edge-label${inCycle ? ' in-cycle' : ''}`,
    }, g);
  }

  // Right-click to delete (edit mode only)
  g.addEventListener('contextmenu', (e) => {
    if (!OC.ux.editMode) return;
    e.preventDefault();
    e.stopPropagation();
    showEdgeContextMenu(e, edge);
  });

  // Animate in
  g.style.opacity = '0';
  requestAnimationFrame(() => {
    g.style.transition = 'opacity 0.5s ease-in';
    g.style.opacity = '1';
  });

  return g;
}

function canRenderGraphEdge(edge) {
  return Boolean(edge?.from && edge?.to && nodePositions[edge.from] && nodePositions[edge.to]);
}

// ══════════════════════════════════════════════════════════════════════════════
// SVG DEFS: ARROWHEAD MARKERS
// ══════════════════════════════════════════════════════════════════════════════

function ensureGraphDefs(svg) {
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = svgEl('defs', {}, svg);
  }
  if (!svg.querySelector('#graph-arrowhead')) {
    const marker = svgEl('marker', {
      id: 'graph-arrowhead',
      viewBox: '0 0 10 10',
      refX: '8', refY: '5',
      markerWidth: '6', markerHeight: '6',
      orient: 'auto-start-reverse',
    }, defs);
    svgEl('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      className: 'graph-arrowhead-fill',
    }, marker);
  }
  if (!svg.querySelector('#graph-arrowhead-cycle')) {
    const marker = svgEl('marker', {
      id: 'graph-arrowhead-cycle',
      viewBox: '0 0 10 10',
      refX: '8', refY: '5',
      markerWidth: '5', markerHeight: '5',
      orient: 'auto-start-reverse',
    }, defs);
    svgEl('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      className: 'graph-arrowhead-cycle-fill',
    }, marker);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EDGE LINKING INTERACTION (EDIT MODE: CLICK SOURCE → CLICK TARGET)
// ══════════════════════════════════════════════════════════════════════════════

function initGraphEdgeDrawing(svg) {
  if (svg.__openclawGraphEdgeDrawingInitialized) return;
  svg.__openclawGraphEdgeDrawingInitialized = true;

  svg.addEventListener('click', (e) => {
    if (!OC.ux.editMode) return;
    if (e.target.closest('.runtime-graph-node')) return;
    if (selectedGraphSourceAgent) clearGraphSelection({ silent: true });
  });

  // Mouse-follow preview line
  svg.addEventListener('mousemove', (e) => {
    const preview = document.getElementById('graphEdgePreview');
    if (!preview || !selectedGraphSourceAgent) return;
    const pFrom = nodePositions[selectedGraphSourceAgent];
    if (!pFrom) return;

    // Convert mouse to SVG coordinates
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
    const mx = svgPt.x, my = svgPt.y;

    // Source exit point: right side center
    const x1 = pFrom.x + pFrom.w, y1 = pFrom.y + pFrom.h / 2;
    const dx = Math.max(Math.abs(mx - x1) * 0.5, 50);
    const pathD = `M${x1},${y1} C${x1 + dx},${y1} ${mx - dx},${my} ${mx},${my}`;
    preview.setAttribute('d', pathD);
  });

  // ── Group-compose marquee (active only in groupDrawMode) ──
  svg.addEventListener('mousedown', (e) => {
    if (!groupDrawMode) return;
    if (e.target.closest('.runtime-graph-node')) return; // box starts on empty canvas only
    const p = svgPointFromEvent(svg, e);
    const rect = svgEl('rect', { className: 'graph-group-marquee', x: p.x, y: p.y, width: 0, height: 0 }, svg);
    groupMarquee = { x0: p.x, y0: p.y, rect };
    e.preventDefault();
  });
  svg.addEventListener('mousemove', (e) => {
    if (!groupMarquee) return;
    const p = svgPointFromEvent(svg, e);
    const x = Math.min(p.x, groupMarquee.x0), y = Math.min(p.y, groupMarquee.y0);
    const w = Math.abs(p.x - groupMarquee.x0), h = Math.abs(p.y - groupMarquee.y0);
    groupMarquee.rect.setAttribute('x', x);
    groupMarquee.rect.setAttribute('y', y);
    groupMarquee.rect.setAttribute('width', w);
    groupMarquee.rect.setAttribute('height', h);
    highlightAgentsInBox(x, y, w, h);
    e.preventDefault();
  });
  const finishGroupMarquee = () => {
    if (!groupMarquee) return;
    const r = groupMarquee.rect;
    const x = +r.getAttribute('x'), y = +r.getAttribute('y');
    const w = +r.getAttribute('width'), h = +r.getAttribute('height');
    const members = agentsInBox(x, y, w, h);
    exitGroupDrawMode(); // also cleans up the marquee rect + highlights
    if (members.length < 2) { toast('框选至少 2 个 agent 才能成组', 'warn'); return; }
    openGroupComposeModal(members);
  };
  svg.addEventListener('mouseup', finishGroupMarquee);
  svg.addEventListener('mouseleave', finishGroupMarquee);
}

// ══════════════════════════════════════════════════════════════════════════════
// ADD / DELETE GRAPH EDGES VIA API
// ══════════════════════════════════════════════════════════════════════════════

async function addGraphEdge(from, to) {
  const key = graphEdgeKey({ from, to });
  if (pendingGraphEdgeOps.has(`add:${key}`)) return;
  if (graphEdges.some((edge) => edge.from === from && edge.to === to)) {
    toast(`EDGE EXISTS: ${from} \u2192 ${to}`, 'info');
    return;
  }

  const token = new URLSearchParams(window.location.search).get('token') || '';
  pendingGraphEdgeOps.add(`add:${key}`);
  try {
    const r = await fetch(`/watchdog/graph/edge/add?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (r.ok) {
      const data = await r.json();
      publishGraphEdges(normalizeGraphEdgeList(data.graph.edges));
      graphCycles = normalizeGraphCycles(data.cycles);
      graphLoops = data.loops || graphLoops;
      renderGraphEdges();
      highlightCycles();
      renderGraphSourceSelection();
      renderLoopState();

      if (graphCycles.length > 0) {
        const cycleStr = graphCycles.map(c => c.join(' \u2192 ')).join('; ');
        toast(`LOOP DETECTED: ${cycleStr}`, 'warn');
      } else {
        toast(`EDGE: ${from} \u2192 ${to}`, 'success');
      }
    } else {
      const err = await r.json();
      toast('Failed: ' + (err.error || 'unknown'), 'error');
    }
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  } finally {
    pendingGraphEdgeOps.delete(`add:${key}`);
  }
}

async function deleteGraphEdge(from, to) {
  const key = graphEdgeKey({ from, to });
  if (pendingGraphEdgeOps.has(`delete:${key}`)) return;

  const token = new URLSearchParams(window.location.search).get('token') || '';
  pendingGraphEdgeOps.add(`delete:${key}`);
  try {
    const r = await fetch(`/watchdog/graph/edge/delete?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (r.ok) {
      const data = await r.json();
      publishGraphEdges(normalizeGraphEdgeList(data.graph.edges));
      graphCycles = normalizeGraphCycles(data.cycles);
      graphLoops = data.loops || graphLoops;
      renderGraphEdges();
      highlightCycles();
      renderGraphSourceSelection();
      renderLoopState();
      toast(`REMOVED: ${from} \u2192 ${to}`, 'success');
    }
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  } finally {
    pendingGraphEdgeOps.delete(`delete:${key}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EDGE CONTEXT MENU (RIGHT-CLICK TO DELETE)
// ══════════════════════════════════════════════════════════════════════════════

function showEdgeContextMenu(e, edge) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const info = document.createElement('div');
  info.className = 'context-menu-item';
  info.style.color = 'var(--text-muted)';
  info.style.cursor = 'default';
  info.textContent = `${edge.from} \u2192 ${edge.to}`;
  menu.appendChild(info);

  const sep = document.createElement('div');
  sep.className = 'context-menu-sep';
  menu.appendChild(sep);

  const del = document.createElement('div');
  del.className = 'context-menu-item danger';
  del.textContent = 'DELETE EDGE';
  del.addEventListener('click', async () => {
    menu.remove();
    await deleteGraphEdge(edge.from, edge.to);
  });
  menu.appendChild(del);

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ══════════════════════════════════════════════════════════════════════════════
// CYCLE HIGHLIGHTING
// ══════════════════════════════════════════════════════════════════════════════

function highlightCycles() {
  renderGroupComposeButton();

  document.querySelectorAll('.runtime-graph-node .svg-node-box.in-cycle').forEach(el => {
    el.classList.remove('in-cycle');
  });

  if (!graphCycles.length) return;

  const cycleNodes = new Set(graphCycles.flat());
  for (const nodeId of cycleNodes) {
    const ids = eid(nodeId);
    const box = document.getElementById(ids.nb);
    if (box) box.classList.add('in-cycle');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPOSE AGENT GROUP (#46) — AgentGroup 是宏：展开成带 groupId 的内部边 + GroupSession +
// outputMode 聚合策略。与 loop 注册分离的独立 modal（多字段 members/entry/outputMode/内部边）。
// 经 graph.group.compose（apply surface），dispatcher 不感知 group。
// ══════════════════════════════════════════════════════════════════════════════

function renderGroupComposeButton() {
  const existing = document.getElementById('graphGroupComposeBtn');
  // Group-compose is an EDIT-MODE tool (sits with the +agent / edit affordances). Hide it otherwise.
  if (!OC?.ux?.editMode) { if (existing) existing.remove(); return; }
  if (existing) return;
  const toolbar = document.querySelector('.runtime-graph-toolbar');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.id = 'graphGroupComposeBtn';
  btn.className = 'graph-cycle-register-btn';
  btn.textContent = 'COMPOSE GROUP';
  btn.title = '点击后在画布上拖框选择 ≥2 个 agent 成组（再点一次取消）';
  btn.addEventListener('click', toggleGroupDrawMode);
  toolbar.appendChild(btn);
}

// ── Box-select (marquee) to compose a group ──────────────────────────────────
// The COMPOSE GROUP tool enters a draw mode; dragging a box on empty canvas selects every agent whose
// CENTER falls inside it (live orange highlight + translucent orange box). Release with ≥2 → the compose
// modal opens prefilled with those members (outputMode preset / internal edges still confirmed there).
// While in draw mode we hold the shared interaction.mode at 'group' so pan + node-drag bail and this
// handler owns the canvas.
function graphInteractionState() {
  if (!window.__openclawRuntimeGraphInteractionState) window.__openclawRuntimeGraphInteractionState = { mode: null };
  return window.__openclawRuntimeGraphInteractionState;
}

function toggleGroupDrawMode() {
  if (groupDrawMode) { exitGroupDrawMode(); return; }
  enterGroupDrawMode();
}

function enterGroupDrawMode() {
  if (!OC?.ux?.editMode) return;
  groupDrawMode = true;
  graphInteractionState().mode = 'group'; // suppress pan/node-drag for the duration
  document.getElementById('graphGroupComposeBtn')?.classList.add('active');
  const svg = document.getElementById('runtimeGraphSvg');
  if (svg) svg.style.cursor = 'crosshair';
  updateGraphEditHint();
}

function exitGroupDrawMode() {
  groupDrawMode = false;
  const st = graphInteractionState();
  if (st.mode === 'group') st.mode = null;
  document.getElementById('graphGroupComposeBtn')?.classList.remove('active');
  const svg = document.getElementById('runtimeGraphSvg');
  if (svg) svg.style.cursor = '';
  cleanupGroupMarquee();
  updateGraphEditHint();
}

function svgPointFromEvent(svg, e) {
  const p = svg.createSVGPoint();
  p.x = e.clientX; p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

function agentsInBox(x, y, w, h) {
  const ids = [];
  for (const [id, pos] of Object.entries(nodePositions)) {
    if (!pos) continue;
    const cx = pos.x + pos.w / 2, cy = pos.y + pos.h / 2;
    if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) ids.push(id);
  }
  return ids;
}

function highlightAgentsInBox(x, y, w, h) {
  const inBox = new Set(agentsInBox(x, y, w, h));
  document.querySelectorAll('.svg-node-box.group-selected').forEach((el) => el.classList.remove('group-selected'));
  inBox.forEach((id) => {
    const box = document.getElementById(eid(id).nb);
    if (box) box.classList.add('group-selected');
  });
}

function cleanupGroupMarquee() {
  if (groupMarquee?.rect) groupMarquee.rect.remove();
  groupMarquee = null;
  document.querySelectorAll('.svg-node-box.group-selected').forEach((el) => el.classList.remove('group-selected'));
}

function openGroupComposeModal(prefillMembers = []) {
  closeContextMenu();
  document.getElementById('graphGroupComposeModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'graphGroupComposeModal';
  overlay.className = 'graph-loop-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'graph-loop-modal';

  const title = document.createElement('div');
  title.className = 'graph-loop-modal-title';
  title.textContent = 'COMPOSE AGENT GROUP';
  modal.appendChild(title);

  const addField = (labelText, inputEl) => {
    const label = document.createElement('label');
    label.className = 'graph-loop-modal-label';
    label.textContent = labelText;
    modal.appendChild(label);
    inputEl.classList.add('graph-loop-modal-input');
    modal.appendChild(inputEl);
  };

  const membersInput = document.createElement('textarea');
  membersInput.rows = 2;
  membersInput.placeholder = 'planner, worker, worker2（逗号或换行分隔，≥2）';
  if (Array.isArray(prefillMembers) && prefillMembers.length) {
    membersInput.value = prefillMembers.join(', '); // prefilled from the marquee box-select
  }
  addField('MEMBERS (≥2)', membersInput);

  const entryInput = document.createElement('input');
  entryInput.type = 'text';
  entryInput.placeholder = 'default：第一个成员';
  addField('ENTRY (optional · 聚合收口点)', entryInput);

  const outputModeSelect = document.createElement('select');
  for (const mode of ['aggregate', 'passthrough', 'race']) {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = mode;
    outputModeSelect.appendChild(opt);
  }
  addField('OUTPUT MODE', outputModeSelect);

  const edgesInput = document.createElement('textarea');
  edgesInput.rows = 3;
  edgesInput.placeholder = '每行一条组内边：planner -> worker（端点须为成员；可空）';
  addField('INTERNAL EDGES (optional)', edgesInput);

  const groupIdInput = document.createElement('input');
  groupIdInput.type = 'text';
  groupIdInput.placeholder = 'default：group-<成员拼接>';
  addField('GROUP ID (optional)', groupIdInput);

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'review_group';
  addField('LABEL (optional)', labelInput);

  const actions = document.createElement('div');
  actions.className = 'graph-loop-modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'graph-loop-modal-btn';
  cancelBtn.textContent = 'CANCEL';
  cancelBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(cancelBtn);
  const submitBtn = document.createElement('button');
  submitBtn.className = 'graph-loop-modal-btn primary';
  submitBtn.textContent = 'COMPOSE';
  submitBtn.addEventListener('click', () => submitGroupCompose({
    membersInput, entryInput, outputModeSelect, edgesInput, groupIdInput, labelInput, overlay, submitBtn,
  }));
  actions.appendChild(submitBtn);

  modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function parseGroupInternalEdges(raw) {
  return String(raw || '')
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.split(/\s*-+>\s*/);
      if (m.length !== 2) return null;
      const from = m[0].trim();
      const to = m[1].trim();
      return from && to ? { from, to } : null;
    })
    .filter(Boolean);
}

async function submitGroupCompose({ membersInput, entryInput, outputModeSelect, edgesInput, groupIdInput, labelInput, overlay, submitBtn }) {
  const members = String(membersInput.value || '')
    .split(/[\n,]+/g).map((s) => s.trim()).filter(Boolean);
  if (members.length < 2) {
    toast('GROUP 需要至少 2 个成员', 'warn');
    return;
  }
  const entry = entryInput.value.trim();
  const internalEdges = parseGroupInternalEdges(edgesInput.value);
  const groupId = groupIdInput.value.trim();
  const label = labelInput.value.trim();
  const body = {
    members,
    outputMode: outputModeSelect.value,
    ...(entry ? { entry } : {}),
    ...(internalEdges.length ? { internalEdges } : {}),
    ...(groupId ? { groupId } : {}),
    ...(label ? { label } : {}),
  };

  submitBtn.disabled = true;
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const r = await fetch(`/watchdog/graph/group/compose?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      toast(`GROUP COMPOSED: ${data.groupId || groupId || members.join('+')}`, 'success');
      overlay.remove();
      await loadGraph();
    } else {
      toast('COMPOSE FAILED: ' + (data.error || 'unknown'), 'warn');
      submitBtn.disabled = false;
    }
  } catch (e) {
    toast('COMPOSE FAILED: ' + e.message, 'error');
    submitBtn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STRUCTURE PREVIEW OVERLAY (#57): 在主图上叠加 operator 计划的结构改动预览。
// diff = inspect.structure_preview / control-plane/preview 返回的
//   { structural, edgeDiff:{added[],removed[]}, agentDiff:{added[],removed[],modified[]} }。
// 删除 agent→顶层叉+白底边; 修改 agent→右上扳手气泡+白底边; 新增 agent→半透明(有位置时,否则 banner chip);
// 删除边→画叉(红虚线); 新增边→半透明(两端有位置时); 改变区→白色底边分区(.preview-changed)。
// ══════════════════════════════════════════════════════════════════════════════

export function clearStructurePreviewOverlay() {
  document.querySelectorAll('.preview-changed').forEach((el) => {
    el.classList.remove('preview-changed', 'preview-removed', 'preview-modified', 'preview-added');
  });
  document.querySelectorAll('.preview-edge-removed').forEach((el) => el.classList.remove('preview-edge-removed'));
  document.getElementById('previewOverlayLayer')?.remove(); // 绘制的 SVG 记号(叉/扳手/新增边)
  document.getElementById('graphPreviewBanner')?.remove();
}

export function renderStructurePreviewOverlay(diff) {
  clearStructurePreviewOverlay();
  if (!diff || diff.structural === false) return;
  const edgeDiff = diff.edgeDiff || { added: [], removed: [] };
  const agentDiff = diff.agentDiff || { added: [], removed: [], modified: [] };
  const svg = document.getElementById('runtimeGraphSvg');
  // 专用叠层 <g>(置顶)→ 退出时一次性 remove。SVG rect 支持 CSS stroke/opacity,
  // 但叉/扳手是伪元素无法在 SVG 渲染 → 必须画成真 SVG 元素进此层。
  const layer = svg ? svgEl('g', { id: 'previewOverlayLayer', className: 'preview-overlay-layer' }, svg) : null;

  const markNode = (agentId, cls, draw) => {
    const box = document.getElementById(eid(agentId).nb);
    if (box) box.classList.add('preview-changed', cls); // 白底边分区 + 半透明(CSS, SVG rect 支持)
    const pos = nodePositions[agentId];
    if (pos && layer && draw) draw(pos);
  };
  (agentDiff.removed || []).forEach((id) => markNode(id, 'preview-removed', (pos) => drawNodeX(layer, pos)));
  (agentDiff.modified || []).forEach((id) => markNode(id, 'preview-modified', (pos) => drawWrenchBubble(layer, pos)));
  (agentDiff.added || []).forEach((id) => markNode(id, 'preview-added', null)); // 已在图上→半透明; 未定位→banner chip

  (edgeDiff.removed || []).forEach((key) => {
    const el = graphEdgeElements.get(key);
    if (el) el.classList.add('preview-edge-removed'); // 红虚线
    if (layer) drawEdgeX(layer, key); // 叉在边中点
  });
  (edgeDiff.added || []).forEach((key) => {
    const [from, to] = splitEdgeKey(key);
    if (layer && nodePositions[from] && nodePositions[to]) {
      svgEl('path', { className: 'graph-edge preview-edge-added', d: calcEdgePath(nodePositions[from], nodePositions[to]) }, layer);
    }
  });

  renderPreviewBanner(edgeDiff, agentDiff);
}

function splitEdgeKey(key) {
  const sep = key.includes('→') ? '→' : '->';
  return key.split(sep).map((s) => s.trim());
}

// 删除 agent → 节点 bbox 上画红叉(两条对角线)。
function drawNodeX(layer, pos) {
  svgEl('line', { className: 'preview-x-line', x1: pos.x + 6, y1: pos.y + 6, x2: pos.x + pos.w - 6, y2: pos.y + pos.h - 6 }, layer);
  svgEl('line', { className: 'preview-x-line', x1: pos.x + pos.w - 6, y1: pos.y + 6, x2: pos.x + 6, y2: pos.y + pos.h - 6 }, layer);
}

// 修改 agent → 右上角扳手气泡(圆 + 🔧)。
function drawWrenchBubble(layer, pos) {
  const cx = pos.x + pos.w - 8, cy = pos.y + 8;
  svgEl('circle', { className: 'preview-wrench-bubble', cx, cy, r: 9 }, layer);
  svgEl('text', { className: 'preview-wrench-icon', x: cx, y: cy + 4, textContent: '🔧' }, layer);
}

// 删除边 → 边中点画小叉。
function drawEdgeX(layer, key) {
  const [from, to] = splitEdgeKey(key);
  const pf = nodePositions[from], pt = nodePositions[to];
  if (!pf || !pt) return;
  const mx = (pf.x + pf.w / 2 + pt.x + pt.w / 2) / 2;
  const my = (pf.y + pf.h / 2 + pt.y + pt.h / 2) / 2;
  const s = 7;
  svgEl('line', { className: 'preview-edge-x', x1: mx - s, y1: my - s, x2: mx + s, y2: my + s }, layer);
  svgEl('line', { className: 'preview-edge-x', x1: mx + s, y1: my - s, x2: mx - s, y2: my + s }, layer);
}

function renderPreviewBanner(edgeDiff, agentDiff) {
  document.getElementById('graphPreviewBanner')?.remove();
  const toolbar = document.querySelector('.runtime-graph-toolbar');
  const host = toolbar?.parentNode || document.body;
  const banner = document.createElement('div');
  banner.id = 'graphPreviewBanner';
  banner.className = 'graph-preview-banner';
  const na = (agentDiff.added || []).length;
  const nr = (agentDiff.removed || []).length;
  const nm = (agentDiff.modified || []).length;
  const ea = (edgeDiff.added || []).length;
  const er = (edgeDiff.removed || []).length;
  const positioned = new Set(Object.keys(nodePositions || {}));
  const floatingAdds = (agentDiff.added || []).filter((id) => !positioned.has(id));
  const chips = floatingAdds.map((id) => `<span class="preview-chip preview-chip-added">+${id}</span>`).join('');
  banner.innerHTML = `
    <span class="preview-title">结构预览</span>
    <span class="preview-stat">agent +${na} / -${nr} / &#9998;${nm}</span>
    <span class="preview-stat">边 +${ea} / -${er}</span>
    ${chips ? `<span class="preview-newagents">新增: ${chips}</span>` : ''}
    <button class="graph-preview-exit" type="button">退出预览</button>`;
  banner.querySelector('.graph-preview-exit')?.addEventListener('click', clearStructurePreviewOverlay);
  host.insertBefore(banner, host.firstChild);
}

// ══════════════════════════════════════════════════════════════════════════════
// INIT VIA EVENT BUS (replaces monkey patches)
// ══════════════════════════════════════════════════════════════════════════════

on('runtime-graph:rebuilt', () => {
  const svg = document.getElementById('runtimeGraphSvg');
  if (svg) {
    initGraphEdgeDrawing(svg);
    renderGraphEdges();
    highlightCycles();
    renderGraphSourceSelection();
    updateGraphEditHint();
  }
});

on('editmode:toggled', ({ editMode: mode }) => {
  let hint = document.getElementById('graphEditHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'graphEditHint';
    hint.className = 'graph-edit-hint';
    hint.textContent = 'CLICK SOURCE \u00B7 CLICK TARGET';
    const toolbar = document.querySelector('.runtime-graph-toolbar');
    if (toolbar) toolbar.appendChild(hint);
  }
  if (!mode && selectedGraphSourceAgent) clearGraphSelection({ silent: true });
  if (!mode && groupDrawMode) exitGroupDrawMode(); // leaving edit mode cancels an in-progress box-select
  updateGraphEditHint();
  renderGroupComposeButton(); // edit-mode-gated tool: show on enter, remove on exit
});

on('event:added', ({ type, data }) => {
  if (type === 'alert' && ['graph_updated', 'loop_started', 'loop_advanced', 'loop_concluded', 'loop_interrupted', 'loop_resumed', 'system_reset'].includes(data?.type)) {
    loadGraph();
  }
});

on('work-items:updated', () => {
  renderRuntimeGraphProgressState();
});

// Auto-init fallback: if runtime-graph:rebuilt fires before this module loads (unlikely), retry a few times
let _tryInitCount = 0;
function tryInit() {
  const svg = document.getElementById('runtimeGraphSvg');
  if (svg && svg.childNodes.length > 0) {
    initGraphEdgeDrawing(svg);
    loadGraph();
  } else if (_tryInitCount++ < 10) {
    setTimeout(tryInit, 500);
  }
}
tryInit();
