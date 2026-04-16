// dashboard-drag.js — Drag nodes (edit mode), pan viewport, scroll-wheel zoom, localStorage
import { SVG_W, NODE_W, nodePositions, savedPositions, snap, buildPipelineSVG, rebuildActiveFlowElements } from './dashboard-svg.js';
import { updatePipeline } from './dashboard-pipeline.js';
import { toast } from './dashboard-common.js';

// ── Zoom / Pan state ──
// Note: SVG_W (680) is a const from svg.js; use literal here to avoid circular-dep TDZ
export let baseViewBox = { w: 680, h: 400 };
export let viewBox = { x: 0, y: 0, w: 680, h: 400 };
export let zoomLevel = 1;
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;

try {
  const zp = localStorage.getItem('openclaw-zoom-pan');
  if (zp) { const d = JSON.parse(zp); zoomLevel = d.zoom || 1; viewBox.x = d.x || 0; viewBox.y = d.y || 0; }
} catch {}

export function applyViewBox(svg) {
  svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
}

export function clampViewBox() {
  const pad = NODE_W * 1.5;
  viewBox.x = Math.max(-pad, Math.min(baseViewBox.w - viewBox.w + pad, viewBox.x));
  viewBox.y = Math.max(-pad, Math.min(baseViewBox.h - viewBox.h + pad, viewBox.y));
}

function saveZoomPan() {
  try { localStorage.setItem('openclaw-zoom-pan', JSON.stringify({ zoom: zoomLevel, x: viewBox.x, y: viewBox.y })); } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// DRAG NODES + PAN + ZOOM
// ══════════════════════════════════════════════════════════════════════════════

function getPipelineInteractionState() {
  if (!window.__openclawPipelineInteractionState) {
    window.__openclawPipelineInteractionState = { mode: null };
  }
  return window.__openclawPipelineInteractionState;
}

export function initDrag(svg) {
  if (svg.__openclawDragInitialized) return;
  svg.__openclawDragInitialized = true;

  let dragging = null, offset = null;
  let panning = null;
  const interaction = getPipelineInteractionState();

  function pt(e) {
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }

  svg.addEventListener('mousedown', (e) => {
    const g = e.target.closest('.pipeline-node');

    // Drag: edit mode + on a node (not result)
    if (OC.ux.editMode && g && !e.target.closest('.clickable')) {
      const id = g.getAttribute('data-agent');
      if (id && id !== '_result' && nodePositions[id]) {
        const p = pt(e), pos = nodePositions[id];
        if (interaction.mode) return;
        dragging = { id, g, origX: pos.x, origY: pos.y, moved: false };
        offset = { x: p.x - pos.x, y: p.y - pos.y };
        interaction.mode = 'drag';
        g.classList.add('dragging');
        e.preventDefault();
        return;
      }
    }

    // Pan: on empty space
    if (!g && !interaction.mode) {
      panning = { lastX: e.clientX, lastY: e.clientY };
      interaction.mode = 'pan';
      svg.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  svg.addEventListener('mousemove', (e) => {
    if (dragging) {
      dragging.moved = true;
      const p = pt(e);
      dragging.g.setAttribute('transform', `translate(${p.x - offset.x - dragging.origX},${p.y - offset.y - dragging.origY})`);
      nodePositions[dragging.id].x = p.x - offset.x;
      nodePositions[dragging.id].y = p.y - offset.y;
      e.preventDefault();
    } else if (panning) {
      const dx = e.clientX - panning.lastX;
      const dy = e.clientY - panning.lastY;
      panning.lastX = e.clientX;
      panning.lastY = e.clientY;
      const r = svg.getBoundingClientRect();
      viewBox.x -= dx * (viewBox.w / r.width);
      viewBox.y -= dy * (viewBox.h / r.height);
      clampViewBox();
      applyViewBox(svg);
      e.preventDefault();
    }
  });

  function endInteraction() {
    if (dragging) {
      const didMove = dragging.moved;
      dragging.g.classList.remove('dragging');
      dragging.g.removeAttribute('transform');
      if (didMove) {
        const pos = nodePositions[dragging.id];
        pos.x = snap(pos.x); pos.y = snap(pos.y);
        savedPositions[dragging.id] = { x: pos.x, y: pos.y };
        try { localStorage.setItem('openclaw-node-layout', JSON.stringify(savedPositions)); } catch {}
      }
      dragging = null;
      interaction.mode = null;
      if (didMove) {
        window.__openclawSuppressNodeClickUntil = Date.now() + 250;
        if (window._lastAgentData) buildPipelineSVG(window._lastAgentData);
        rebuildActiveFlowElements();
        updatePipeline();
      }
    }
    if (panning) {
      panning = null;
      svg.style.cursor = '';
      saveZoomPan();
      interaction.mode = null;
    }
  }

  svg.addEventListener('mouseup', endInteraction);
  svg.addEventListener('mouseleave', endInteraction);

  // Wheel zoom (centered on cursor)
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.08 : 0.93;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel * factor));
    if (newZoom === zoomLevel) return;
    const m = pt(e);
    const ratio = zoomLevel / newZoom;
    viewBox.x = m.x - (m.x - viewBox.x) * ratio;
    viewBox.y = m.y - (m.y - viewBox.y) * ratio;
    viewBox.w = baseViewBox.w / newZoom;
    viewBox.h = baseViewBox.h / newZoom;
    zoomLevel = newZoom;
    clampViewBox();
    applyViewBox(svg);
    saveZoomPan();
  }, { passive: false });
}

export function resetLayout() {
  Object.keys(savedPositions).forEach(k => delete savedPositions[k]);
  zoomLevel = 1;
  viewBox.x = 0; viewBox.y = 0;
  try { localStorage.removeItem('openclaw-node-layout'); } catch {}
  try { localStorage.removeItem('openclaw-zoom-pan'); } catch {}
  if (window._lastAgentData) buildPipelineSVG(window._lastAgentData);
  rebuildActiveFlowElements();
  updatePipeline();
  toast('Layout reset', 'info');
}
