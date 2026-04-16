// dashboard-pipeline.js — Pipeline SVG rendering and dispatch runtime panel
import { eid, svgEl, nodePositions } from './dashboard-svg.js';
import { agentState, workItems, dispatchRuntimeState, dispatchQueueState, WORKERS, getAgentVisualStatus, getPipelineAgentId, getPipelineAggregateAgentIds, updateActiveStat } from './dashboard.js';
import { dynamicWorkers } from './dashboard-svg.js';

export function svgToggle(id, active) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('active', active);
}

export function truncLabel(label) {
  if (!label) return '';
  return label.length > 16 ? label.slice(0, 16) + '..' : label;
}

function getVisiblePipelineAgentIds() {
  if (Array.isArray(window._visiblePipelineAgentIds) && window._visiblePipelineAgentIds.length > 0) {
    return window._visiblePipelineAgentIds;
  }
  return Object.keys(nodePositions || {}).filter((agentId) => agentId && agentId !== '_result');
}

function getPipelineNodeState(agentId) {
  const aggregateIds = getPipelineAggregateAgentIds(agentId);
  const merged = {
    status: 'idle',
    _delivering: false,
    lastLabel: null,
  };

  for (const id of aggregateIds) {
    const state = agentState[id] || {};
    if (state.status === 'running') merged.status = 'running';
    else if (state.status === 'error' && merged.status !== 'running') merged.status = 'error';
    if (state._delivering) merged._delivering = true;
    if (!merged.lastLabel && state.lastLabel) merged.lastLabel = state.lastLabel;
  }

  return merged;
}

function getPipelineNodeRuntimeState(agentId) {
  const aggregateIds = getPipelineAggregateAgentIds(agentId);
  const merged = {
    busy: false,
    dispatching: false,
    healthy: true,
    currentContract: null,
    lastSeen: 0,
  };

  for (const id of aggregateIds) {
    const runtime = dispatchRuntimeState[id] || {};
    if (runtime.busy) merged.busy = true;
    if (runtime.dispatching) merged.dispatching = true;
    if (runtime.healthy === false) merged.healthy = false;
    if (!merged.currentContract && runtime.currentContract) merged.currentContract = runtime.currentContract;
    if (runtime.lastSeen) merged.lastSeen = Math.max(merged.lastSeen, runtime.lastSeen);
  }

  return merged;
}

function getQueuedContractsForAgent(agentId) {
  const items = [];
  for (const contractId of Array.isArray(dispatchQueueState) ? dispatchQueueState : []) {
    const contract = workItems[contractId] || null;
    const assignee = contract?.assignee || null;
    if (!assignee || assignee === 'worker') continue;
    const targetId = getPipelineAgentId(assignee);
    if (targetId !== agentId) continue;
    items.push({ contractId, contract });
  }
  return items;
}

function updateAgentQueueBadges() {
  for (const agentId of getVisiblePipelineAgentIds()) {
    const ids = eid(agentId);
    const group = document.getElementById(ids.qg);
    const pos = nodePositions[agentId];
    if (!group || !pos) continue;
    while (group.firstChild) group.removeChild(group.firstChild);

    const queueItems = getQueuedContractsForAgent(agentId);
    if (queueItems.length === 0) continue;

    const badgeX = pos.x + pos.w + 6;
    const badgeY = pos.y + 6;
    const title = svgEl('title', {
      textContent: queueItems.map((item, index) => `${index + 1}. ${item.contractId}`).join('\n'),
    }, group);
    if (!title) continue;

    const visibleCount = Math.min(queueItems.length, 2);
    for (let index = 0; index < visibleCount; index += 1) {
      svgEl('rect', {
        x: badgeX,
        y: badgeY + index * 11,
        width: 9,
        height: 20,
        rx: 1,
        className: index === 0 ? 'queue-bookmark primary' : 'queue-bookmark',
      }, group);
    }

    if (queueItems.length > 2) {
      svgEl('text', {
        x: badgeX + 14,
        y: badgeY + 18,
        textContent: `x${queueItems.length}`,
        className: 'queue-bookmark-count',
      }, group);
    }
  }
}

// ── Generic node status updater ──
function updateNodeStatus(agentId, state, extraClasses) {
  const ids = eid(agentId);
  const nb = document.getElementById(ids.nb);
  const sd = document.getElementById(ids.sd);
  const st = document.getElementById(ids.st);
  if (!nb) return;

  const running = state.status === 'running';
  const delivering = state._delivering || false;
  const visualStatus = getAgentVisualStatus(agentId);
  const runtimeState = getPipelineNodeRuntimeState(agentId);

  // Node box
  nb.classList.toggle('active', running && !delivering);
  nb.classList.toggle('receiving', delivering);
  if (extraClasses) {
    for (const [cls, cond] of Object.entries(extraClasses)) nb.classList.toggle(cls, cond);
  }

  // Status dot — only rewrite className when changed to avoid retriggering CSS transitions
  if (sd) {
    const dotClass = `svg-status-dot ${visualStatus}`;
    if (sd.className.baseVal !== dotClass) sd.className.baseVal = dotClass;
  }

  // Status text — only rewrite when changed
  if (st) {
    let nextText, nextFill;
    if (visualStatus === 'error') {
      nextText = runtimeState.healthy === false ? 'UNHEALTHY' : 'OFFLINE';
      nextFill = 'var(--accent-red)';
    } else if (delivering) {
      nextText = 'DELIVERING'; nextFill = 'var(--accent-green)';
    } else if (running) {
      nextText = runtimeState.currentContract ? `RUN:${runtimeState.currentContract.slice(-8)}`
        : truncLabel(state.lastLabel) || 'RUNNING';
      nextFill = 'var(--accent-green)';
    } else if (runtimeState.dispatching) {
      nextText = 'DISPATCHING'; nextFill = 'var(--accent-green)';
    } else {
      nextText = 'IDLE'; nextFill = 'var(--accent-amber)';
    }
    if (st.textContent !== nextText) st.textContent = nextText;
    if (st.style.fill !== nextFill) st.style.fill = nextFill;
  }
}

export function updatePipeline() {
  // Update visible pipeline nodes in the current projection.
  for (const agentId of getVisiblePipelineAgentIds()) {
    updateNodeStatus(agentId, getPipelineNodeState(agentId));
  }

  updatePoolPanel();
  updateAgentQueueBadges();
  updateActiveStat();
}

function updatePoolPanel() {
  const poolMembers = (dynamicWorkers.length > 0) ? dynamicWorkers : WORKERS;

  // Pool stat includes specialized executors
  const specializedIds = (typeof window._lastAgentData !== 'undefined')
    ? window._lastAgentData.filter(a => a.role === 'executor' && a.specialized).map(a => a.id)
    : [];
  const allPool = [...new Set([...poolMembers, ...specializedIds])];
  const busyCount = allPool.filter(wId =>
    agentState[wId]?.status === 'running' || dispatchRuntimeState[wId]?.dispatching
  ).length;
  const poolStat = document.getElementById('statPool');
  if (poolStat) poolStat.textContent = `${busyCount}/${allPool.length}`;
  const queueStat = document.getElementById('statQueue');
  if (queueStat) queueStat.textContent = dispatchQueueState.length;
}
