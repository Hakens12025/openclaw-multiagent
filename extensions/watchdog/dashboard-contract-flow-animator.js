// dashboard-contract-flow-animator.js — Visible contract dispatch animation hooks.

import { calcEdgePath, nodePositions, svgEl } from './dashboard-svg.js';

const GHOST_SIZE = 18;
const GHOST_DURATION_MS = 1200;
const GHOST_REMOVE_GRACE_MS = 180;
const GHOST_DEDUP_MS = GHOST_DURATION_MS + GHOST_REMOVE_GRACE_MS;
const recentGhostKeys = new Map();

export class ContractFlowAnimator {
  pulseFlow(from, to, contractId = null) {
    if (!from || !to) return;
    const key = `${from}\u2192${to}`;
    const flow = document.querySelector(`[data-flow="${key}"]`);
    if (flow) {
      flow.classList.add('contract-flow-pulse');
      setTimeout(() => flow.classList.remove('contract-flow-pulse'), 1400);
    }
    this.animateGhost(from, to, contractId);
  }

  animateGhost(from, to, contractId = null) {
    const svg = document.getElementById('runtimeGraphSvg');
    const pFrom = nodePositions[from];
    const pTo = nodePositions[to];
    if (!svg || !pFrom || !pTo) return null;

    const key = `${from}\u2192${to}:${contractId || ''}`;
    const now = Date.now();
    const previous = recentGhostKeys.get(key) || 0;
    if (now - previous < GHOST_DEDUP_MS) return null;
    recentGhostKeys.set(key, now);
    setTimeout(() => {
      if (recentGhostKeys.get(key) === now) recentGhostKeys.delete(key);
    }, GHOST_DEDUP_MS + 50);

    const edge = calcEdgePath(pFrom, pTo);
    const ghost = svgEl('g', {
      className: 'contract-flow-ghost',
      'data-contract-id': contractId || '',
    }, svg);

    svgEl('rect', {
      x: -GHOST_SIZE / 2,
      y: -GHOST_SIZE / 2,
      width: GHOST_SIZE,
      height: GHOST_SIZE,
      rx: 2,
      className: 'contract-flow-ghost-box',
    }, ghost);

    if (contractId) {
      svgEl('title', { textContent: String(contractId) }, ghost);
    }

    const motion = svgEl('animateMotion', {
      dur: `${(GHOST_DURATION_MS / 1000).toFixed(1)}s`,
      path: edge.pathD,
      begin: '0s',
      fill: 'freeze',
      calcMode: 'spline',
      keySplines: '0.2 0 0.15 1',
      keyTimes: '0;1',
    }, ghost);
    motion.beginElement?.();

    setTimeout(() => ghost.remove(), GHOST_DURATION_MS + GHOST_REMOVE_GRACE_MS);
    return ghost;
  }
}
