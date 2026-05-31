// dashboard-runtime-graph.js — Runtime graph rendering and dispatch runtime panel
import { dynamicWorkers, eid, svgEl, nodePositions } from './dashboard-svg.js';
import { AgentCardView } from './dashboard-agent-card.js';
import { ContractCardView } from './dashboard-contract-card.js';
import { ContractFlowAnimator } from './dashboard-contract-flow-animator.js';
import { ContractLaneView } from './dashboard-contract-lane.js';
import { agentState, workItems, dispatchRuntimeState, WORKERS, focusWorkItem, getAgentVisualStatus, getRuntimeGraphAgentId, getRuntimeGraphAggregateAgentIds, updateActiveStat } from './dashboard.js';

export function truncLabel(label) {
  if (!label) return '';
  return label.length > 16 ? label.slice(0, 16) + '..' : label;
}

function getVisibleRuntimeGraphAgentIds() {
  if (Array.isArray(window._visibleRuntimeGraphAgentIds) && window._visibleRuntimeGraphAgentIds.length > 0) {
    return window._visibleRuntimeGraphAgentIds;
  }
  return Object.keys(nodePositions || {}).filter((agentId) => agentId && !String(agentId).startsWith('_'));
}

function getRuntimeGraphNodeState(agentId) {
  const aggregateIds = getRuntimeGraphAggregateAgentIds(agentId);
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

function getRuntimeGraphNodeRuntimeState(agentId) {
  const aggregateIds = getRuntimeGraphAggregateAgentIds(agentId);
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
    const currentContract = typeof runtime.currentContract === 'string'
      ? runtime.currentContract
      : (typeof runtime.currentContractId === 'string' ? runtime.currentContractId : null);
    if (!merged.currentContract && currentContract) merged.currentContract = currentContract;
    if (runtime.lastSeen) merged.lastSeen = Math.max(merged.lastSeen, runtime.lastSeen);
  }

  return merged;
}

function getIncomingContractsForAgent(agentId) {
  const items = [];
  for (const targetId of getRuntimeGraphAggregateAgentIds(agentId)) {
    const runtimeQueue = dispatchRuntimeState[targetId]?.queue;
    if (!Array.isArray(runtimeQueue)) continue;
    for (const entry of runtimeQueue) {
      const contractId = typeof entry === 'string' ? entry : entry?.contractId;
      if (!contractId) continue;
      items.push({
        contractId: String(contractId),
        fromAgent: entry?.fromAgent || null,
        targetAgent: entry?.targetAgent || targetId,
        sourceId: entry?.fromAgent || null,
        targetId,
        routeEdge: entry?.routeEdge || null,
      });
    }
  }
  return items;
}

function getOutgoingContractsForAgent(agentId) {
  const items = [];
  for (const sourceId of getRuntimeGraphAggregateAgentIds(agentId)) {
    const runtimeQueue = dispatchRuntimeState[sourceId]?.outgoingQueue;
    if (!Array.isArray(runtimeQueue)) continue;
    for (const entry of runtimeQueue) {
      const contractId = typeof entry === 'string' ? entry : entry?.contractId;
      if (!contractId) continue;
      items.push({
        contractId: String(contractId),
        sourceId,
        targetAgent: entry?.targetAgent || null,
        status: entry?.status || 'ready',
        routeEdge: entry?.routeEdge || null,
      });
    }
  }
  return items;
}

function getRunningContractsForAgent(agentId) {
  const items = [];
  for (const targetId of getRuntimeGraphAggregateAgentIds(agentId)) {
    const runtime = dispatchRuntimeState[targetId] || {};
    const contractId = typeof runtime.currentContract === 'string'
      ? runtime.currentContract
      : (typeof runtime.currentContractId === 'string' ? runtime.currentContractId : null);
    if (!contractId) continue;
    items.push({
      contractId: String(contractId),
      targetId,
      status: runtime.dispatching ? 'dispatching' : 'running',
    });
  }
  return items.slice(0, 1);
}

function countDispatchQueueContractsFromRuntimeTargets() {
  const visibleIds = getVisibleRuntimeGraphAgentIds();
  const candidateIds = visibleIds.length > 0 ? visibleIds : Object.keys(dispatchRuntimeState);
  const seen = new Set();
  let hasRuntimeTargets = false;

  for (const agentId of candidateIds) {
    for (const targetId of getRuntimeGraphAggregateAgentIds(agentId)) {
      const runtime = dispatchRuntimeState[targetId];
      if (!runtime || typeof runtime !== 'object') continue;
      hasRuntimeTargets = true;
      for (const laneName of ['queue', 'outgoingQueue']) {
        const lane = runtime[laneName];
        if (!Array.isArray(lane)) continue;
        for (const entry of lane) {
          const contractId = typeof entry === 'string' ? entry : entry?.contractId;
          if (contractId) seen.add(`${laneName}:${targetId}:${contractId}`);
        }
      }
    }
  }

  return hasRuntimeTargets ? seen.size : 0;
}

function anchorKey(anchor) {
  return [anchor?.side || 'center', anchor?.direction || 'left_to_right', Math.round(anchor?.x || 0), Math.round(anchor?.y || 0)].join(':');
}

function renderGroupedLane(contractLaneView, group, {
  lane,
  items,
  agentCard,
  resolveTargetAgent,
  laneWidth,
  activeLaneKeys = null,
}) {
  const grouped = new Map();
  for (const item of items) {
    const anchor = agentCard.laneAnchor(lane, resolveTargetAgent(item));
    const key = anchorKey(anchor);
    if (!grouped.has(key)) grouped.set(key, { anchor, items: [] });
    grouped.get(key).items.push(item);
  }
  for (const laneGroup of grouped.values()) {
    const laneModel = {
      lane,
      items: laneGroup.items,
      anchor: laneGroup.anchor,
      width: laneWidth,
    };
    activeLaneKeys?.add(contractLaneView.buildLaneKey(laneModel));
    contractLaneView.render(group, laneModel);
  }
}

function updateAgentContractLanes() {
  const contractCardView = new ContractCardView({ svgEl, workItems, focusWorkItem });
  const contractLaneView = new ContractLaneView({ contractCardView });

  for (const agentId of getVisibleRuntimeGraphAgentIds()) {
    const ids = eid(agentId);
    const group = document.getElementById(ids.qg);
    const pos = nodePositions[agentId];
    if (!group || !pos) continue;

    const graphEdges = window.__graphEdges || [];
    const agentCard = new AgentCardView({ agentId, position: pos, nodePositions, graphEdges });
    const laneWidth = Math.max(64, Math.min(112, Math.floor(pos.w * 0.45)));

    const incomingItems = getIncomingContractsForAgent(agentId).map((item) => ({ ...item, status: 'queued' }));
    const outgoingItems = getOutgoingContractsForAgent(agentId);
    const runningItems = getRunningContractsForAgent(agentId);
    const activeLaneKeys = new Set();

    renderGroupedLane(contractLaneView, group, {
      lane: 'incoming',
      items: incomingItems,
      agentCard,
      resolveTargetAgent: (item) => getRuntimeGraphAgentId(item?.fromAgent || null),
      laneWidth,
      activeLaneKeys,
    });
    renderGroupedLane(contractLaneView, group, {
      lane: 'outgoing',
      items: outgoingItems,
      agentCard,
      resolveTargetAgent: (item) => getRuntimeGraphAgentId(item?.targetAgent || null),
      laneWidth,
      activeLaneKeys,
    });
    const runningLaneModel = {
      lane: 'running',
      items: runningItems,
      anchor: agentCard.laneAnchor('running'),
      width: laneWidth,
    };
    activeLaneKeys.add(contractLaneView.buildLaneKey(runningLaneModel));
    contractLaneView.render(group, runningLaneModel);
    contractLaneView.removeInactiveLaneGroups(group, activeLaneKeys);
  }
}

// ── Generic node status updater ──
function updateNodeStatus(agentId, state) {
  const ids = eid(agentId);
  const nb = document.getElementById(ids.nb);
  const sd = document.getElementById(ids.sd);
  const st = document.getElementById(ids.st);
  if (!nb) return;

  const running = state.status === 'running';
  const delivering = state._delivering || false;
  const visualStatus = getAgentVisualStatus(agentId);
  const runtimeState = getRuntimeGraphNodeRuntimeState(agentId);

  // Node box
  nb.classList.toggle('active', running && !delivering);
  nb.classList.toggle('receiving', delivering);

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

export function updateRuntimeGraph() {
  // Update visible runtime graph nodes in the current projection.
  for (const agentId of getVisibleRuntimeGraphAgentIds()) {
    updateNodeStatus(agentId, getRuntimeGraphNodeState(agentId));
  }

  updatePoolPanel();
  updateAgentContractLanes();
  updateActiveStat();
}

export function pulseContractFlow(from, to, contractId = null) {
  new ContractFlowAnimator().pulseFlow(from, to, contractId);
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
  if (queueStat) queueStat.textContent = countDispatchQueueContractsFromRuntimeTargets();
}
