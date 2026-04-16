// dashboard-graph.js — Agent topology graph: persistent edges, cycle detection, visual editor
import { on } from './dashboard-bus.js';
import { eid, svgEl, nodePositions, calcEdgePath } from './dashboard-svg.js';
import { toast } from './dashboard-common.js';
import {
  workItems,
  describePipelineProgression,
  getWorkItemPipelineProgression,
  getPipelineAgentId,
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

function graphEdgeKey(edge) {
  return `${edge.from}\u2192${edge.to}`;
}

function getGraphDisplayAgentId(agentId) {
  return getPipelineAgentId(agentId);
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
  document.querySelectorAll('.pipeline-node .svg-node-box.link-armed').forEach((el) => {
    el.classList.remove('link-armed');
  });
  document.querySelectorAll('.pipeline-node .svg-node-box.link-target-candidate').forEach((el) => {
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
  const visibleIds = window._visiblePipelineAgentIds || [];
  for (const id of visibleIds) {
    if (id === selectedGraphSourceAgent) continue;
    const candidateBox = document.getElementById(eid(id).nb);
    if (candidateBox) candidateBox.classList.add('link-target-candidate');
  }

  // Body class for cursor
  document.body.classList.add('link-armed-mode');

  // Create preview line element
  const svg = document.getElementById('pipelineSvg');
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
  if (!OC.ux.editMode || !agentId || agentId === '_result') return false;
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
    graphEdges = normalizeGraphEdgeList(data.edges);
    window.__graphEdges = (data.edges || []).slice();
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
  const el = document.getElementById('pipelineLoopState');
  if (!el) return;

  el.className = 'pipeline-loop-state';
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
    renderPipelineProgressState();
    return;
  }

  if (activeRegisteredLoops.length > 0) {
    el.textContent = `LOOP READY // ${activeRegisteredLoops.length}`;
    el.classList.add('visible', 'ready');
    el.title = activeRegisteredLoops.map(loop => loop.id).join(', ');
    renderPipelineProgressState();
    return;
  }

  if (Array.isArray(graphLoops) && graphLoops.length > 0) {
    el.textContent = `LOOP REGISTERED // ${graphLoops.length}`;
    el.classList.add('visible', 'idle');
    el.title = graphLoops.map(loop => loop.id).join(', ');
  }

  renderPipelineProgressState();
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

function selectLatestPipelineProgression() {
  const candidates = Object.values(workItems)
    .map((contract) => ({
      contract,
      progression: getWorkItemPipelineProgression(contract),
    }))
    .filter(({ progression }) => progression)
    .sort((left, right) => progressionSortValue(right.contract, right.progression) - progressionSortValue(left.contract, left.progression));

  if (!candidates.length) return null;
  const matching = candidates.filter(({ progression }) => progressionMatchesActiveSession(progression));
  return matching[0] || candidates[0] || null;
}

function renderPipelineProgressState() {
  const el = document.getElementById('pipelineProgressState');
  if (!el) return;

  el.className = 'pipeline-progress-state';
  el.textContent = '';
  el.title = '';

  const latest = selectLatestPipelineProgression();
  if (!latest) return;

  const ui = describePipelineProgression(latest.progression);
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

function renderGraphEdges() {
  // Clear old persistent edges
  for (const [key, el] of graphEdgeElements) {
    if (el.parentNode) el.remove();
  }
  graphEdgeElements.clear();

  const svg = document.getElementById('pipelineSvg');
  if (!svg) return;

  ensureGraphDefs(svg);

  for (const edge of normalizeGraphEdgeList(graphEdges)) {
    const el = createGraphEdge(svg, edge);
    if (el) graphEdgeElements.set(graphEdgeKey(edge), el);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CREATE A SINGLE PERSISTENT GRAPH EDGE (SVG)
// ══════════════════════════════════════════════════════════════════════════════

function createGraphEdge(svg, edge) {
  const pFrom = nodePositions[edge.from];
  const pTo = nodePositions[edge.to];
  if (!pFrom || !pTo) return null;

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
    if (e.target.closest('.pipeline-node')) return;
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
    const r = await fetch(`/watchdog/graph/edge?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (r.ok) {
      const data = await r.json();
      graphEdges = normalizeGraphEdgeList(data.graph.edges);
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
    const r = await fetch(`/watchdog/graph/edge?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (r.ok) {
      const data = await r.json();
      graphEdges = normalizeGraphEdgeList(data.graph.edges);
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
  document.querySelectorAll('.pipeline-node .svg-node-box.in-cycle').forEach(el => {
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
// INIT VIA EVENT BUS (replaces monkey patches)
// ══════════════════════════════════════════════════════════════════════════════

on('pipeline:rebuilt', () => {
  const svg = document.getElementById('pipelineSvg');
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
    const toolbar = document.querySelector('.pipeline-toolbar');
    if (toolbar) toolbar.appendChild(hint);
  }
  if (!mode && selectedGraphSourceAgent) clearGraphSelection({ silent: true });
  updateGraphEditHint();
});

on('event:added', ({ type, data }) => {
  if (type === 'alert' && ['graph_updated', 'loop_started', 'loop_advanced', 'loop_concluded', 'loop_interrupted', 'loop_resumed', 'system_reset'].includes(data?.type)) {
    loadGraph();
  }
});

on('work-items:updated', () => {
  renderPipelineProgressState();
});

// Auto-init fallback: if pipeline:rebuilt fires before this module loads (unlikely), retry a few times
let _tryInitCount = 0;
function tryInit() {
  const svg = document.getElementById('pipelineSvg');
  if (svg && svg.childNodes.length > 0) {
    initGraphEdgeDrawing(svg);
    loadGraph();
  } else if (_tryInitCount++ < 10) {
    setTimeout(tryInit, 500);
  }
}
tryInit();
