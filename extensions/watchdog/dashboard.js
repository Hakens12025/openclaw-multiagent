// dashboard.js — Core: globals, clock, metadata, work items, events, SSE
import { esc, shortModel, getToken, toast } from './dashboard-common.js';
import { emit } from './dashboard-bus.js';
import {
  normalizeFlowToken,
  resolveFlowVisualLabel,
  resolveFlowVisualType,
  resolveSystemActionDeliveryAlertFlow,
} from './dashboard-flow-visuals.js';
import { PROTOCOL_ID } from './protocol-registry.js';

// Late-bound imports (circular deps — safe because only used inside functions)
import { buildPipelineSVG, createFlowLine, removeFlowLine, dynamicWorkers } from './dashboard-svg.js';
import { updatePipeline, truncLabel } from './dashboard-pipeline.js';
import { loadModels } from './dashboard-ux.js';

// Static seed for executor ids before the live agent roster arrives from /watchdog/agents.
export const WORKERS = (typeof window._lastAgentData !== 'undefined')
  ? window._lastAgentData.filter(a => a.role === 'executor' && !a.specialized).map(a => a.id)
  : [];

export const agentState = {};
export const workItems = {};
export const agentMeta = {};
export const agentEvents = {};
export const dispatchRuntimeState = {};
export let dispatchQueueState = [];
export let eventCount = 0;
export let connectedAt = null;
export let currentFastTrack = null;
export const DEFAULT_OFFLINE_MS = 30 * 60 * 1000;
export const PRIMARY_DASHBOARD_BRIDGE_AGENT_ID = 'controller';

// ── Active Flows — data-driven flow line tracking ──
export const activeFlows = new Map(); // flowKey → { from, to, label, type, workItemId, ts, element }

function getDashboardAgentRecord(agentId) {
  if (!agentId || String(agentId).startsWith('_')) return null;
  if (agentMeta[agentId] && typeof agentMeta[agentId] === 'object') {
    return { id: agentId, ...agentMeta[agentId] };
  }
  return (window._lastAgentData || []).find((agent) => agent?.id === agentId) || null;
}

function isFoldedGatewayBridgeRecord(agent) {
  if (!agent || typeof agent !== 'object') return false;
  const agentId = typeof agent.id === 'string' ? agent.id : null;
  if (!agentId || agentId === PRIMARY_DASHBOARD_BRIDGE_AGENT_ID) return false;
  if (agentId === 'agent-for-kksl') return true;
  return agent.role === 'bridge' && agent.gateway === true;
}

export function isFoldedDashboardAgent(agentId) {
  if (!agentId || String(agentId).startsWith('_')) return false;
  return isFoldedGatewayBridgeRecord(getDashboardAgentRecord(agentId));
}

export function shouldDisplayDashboardAgentRecord(agent) {
  return !isFoldedGatewayBridgeRecord(agent);
}

export function isBridgeAgent(agentId) {
  if (!agentId) return false;
  if (agentId === 'controller' || agentId === 'agent-for-kksl') return true;
  if (agentMeta[agentId]?.role === 'bridge') return true;
  return (window._lastAgentData || []).some((agent) => agent?.id === agentId && agent?.role === 'bridge');
}

export function getPipelineAgentId(agentId) {
  if (!agentId || String(agentId).startsWith('_')) return agentId;
  return isFoldedDashboardAgent(agentId) ? PRIMARY_DASHBOARD_BRIDGE_AGENT_ID : agentId;
}

export function getBridgeAggregateAgentIds() {
  return [...new Set(
    [
      ...Object.keys(agentMeta),
      ...Object.keys(agentState),
      ...((window._lastAgentData || []).map((agent) => agent?.id).filter(Boolean)),
    ]
      .filter((id) => isBridgeAgent(id))
      .map((id) => getPipelineAgentId(id))
      .filter(Boolean),
  )];
}

export function getPipelineAggregateAgentIds(agentId) {
  const pipelineAgentId = getPipelineAgentId(agentId);
  if (!pipelineAgentId) return [];
  const candidateIds = new Set([
    pipelineAgentId,
    ...Object.keys(agentMeta),
    ...Object.keys(agentState),
    ...((window._lastAgentData || []).map((agent) => agent?.id).filter(Boolean)),
  ]);
  return [...candidateIds].filter((candidateId) => getPipelineAgentId(candidateId) === pipelineAgentId);
}

export function normalizeDashboardAgentKey(agentId) {
  if (!agentId || String(agentId).startsWith('_')) return agentId || '_system';
  return getPipelineAgentId(agentId);
}

export function normalizeDashboardText(value) {
  return String(value ?? '');
}

export function displayAgentRef(value) {
  if (value && typeof value === 'object') {
    if (typeof value.agentId === 'string') return normalizeDashboardAgentKey(value.agentId);
    return '';
  }
  if (typeof value === 'string') return normalizeDashboardAgentKey(value);
  return value == null ? '' : String(value);
}

function progressDisplayToken(value) {
  const normalized = displayAgentRef(value);
  return normalized ? String(normalized).toUpperCase() : null;
}

export function getWorkItemPipelineProgression(workItem) {
  const progression = workItem?.runtimeDiagnostics?.pipelineProgression;
  return progression && typeof progression === 'object' ? progression : null;
}

export function humanizePipelineProgressReason(reason) {
  const normalized = String(reason || '').trim();
  if (!normalized) return null;
  const labels = {
    system_action_owned: 'explicit system action owns progression',
    missing_structured_outbox_signal: 'no structured outbox signal',
    no_active_pipeline: 'no active pipeline',
    no_allowed_transition: 'no legal next stage',
    ambiguous_runtime_transition: 'multiple legal next stages',
  };
  return labels[normalized] || normalized.replaceAll('_', ' ');
}

export function describePipelineProgression(progression) {
  if (!progression || typeof progression !== 'object') return null;

  const from = progressDisplayToken(progression.from || progression.stage);
  const to = progressDisplayToken(progression.to || progression.targetAgent);
  const round = Number.isFinite(progression.round) ? ` // R${progression.round}` : '';
  const reason = humanizePipelineProgressReason(progression.reason);

  if (progression.reason === 'system_action_owned') {
    return {
      tone: 'agent',
      text: `AGENT OWNED${from ? ` // ${from}` : ''}`,
      title: `Pipeline progression stayed agent-owned${from ? ` at ${from}` : ''}.`,
    };
  }

  if (progression.error) {
    return {
      tone: 'error',
      text: `AUTO FAIL${from ? ` // ${from}` : ''}`,
      title: `${progression.error}${reason ? ` (${reason})` : ''}`,
    };
  }

  if (progression.attempted === true && progression.action === 'advanced' && from && to) {
    return {
      tone: 'active',
      text: `AUTO ${from}\u2192${to}${round}`,
      title: `Runtime advanced pipeline ${from} -> ${to}${round}`,
    };
  }

  if (progression.attempted === true && progression.action === 'concluded') {
    return {
      tone: 'done',
      text: `AUTO CONCLUDE${round}`,
      title: `Runtime concluded pipeline${round}`,
    };
  }

  if (progression.attempted === true) {
    return {
      tone: 'active',
      text: `AUTO ${String(progression.action || 'ADVANCE').toUpperCase()}${round}`,
      title: `Runtime progression action: ${progression.action || 'advance'}`,
    };
  }

  if (progression.skipped === true) {
    return {
      tone: 'hold',
      text: `AUTO HOLD${from ? ` // ${from}` : ''}`,
      title: `Runtime progression skipped${reason ? `: ${reason}` : ''}`,
    };
  }

  return null;
}

function getLatestRecentToolEvent(data) {
  if (!Array.isArray(data?.recentToolEvents) || data.recentToolEvents.length === 0) {
    return null;
  }
  return data.recentToolEvents[data.recentToolEvents.length - 1] || null;
}

function getRecentToolSummary(data) {
  const latestEvent = getLatestRecentToolEvent(data);
  return latestEvent?.summary || latestEvent?.label || null;
}

export function mergeAgentEventBlocks(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey || !agentEvents[fromKey]?.length) return;
  agentEvents[toKey] = [...(agentEvents[toKey] || []), ...agentEvents[fromKey]]
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
    .slice(0, 30);
  delete agentEvents[fromKey];
}

export function getDashboardTrackedAgentIds() {
  if (Array.isArray(window._visiblePipelineAgentIds) && window._visiblePipelineAgentIds.length > 0) {
    return window._visiblePipelineAgentIds;
  }
  return [...new Set(
    Object.keys(agentState)
      .filter((agentId) => agentId && !String(agentId).startsWith('_'))
      .map((agentId) => getPipelineAgentId(agentId)),
  )];
}

export function getActiveDashboardAgentCount() {
  return getDashboardTrackedAgentIds().filter((agentId) => getAgentVisualStatus(agentId) === 'running').length;
}

export function updateActiveStat() {
  const el = document.getElementById('statActive');
  if (el) el.textContent = String(getActiveDashboardAgentCount());
}

export function addActiveFlow(from, to, label, opts = {}) {
  const sourceId = getPipelineAgentId(from);
  const targetId = getPipelineAgentId(to);
  if (!sourceId || !targetId || sourceId === targetId) return;
  const key = `${sourceId}\u2192${targetId}`;
  if (activeFlows.has(key)) return;
  const el = createFlowLine(sourceId, targetId, label, opts.type || 'route');
  if (!el) return; // node not on screen
  activeFlows.set(key, { from: sourceId, to: targetId, label, ...opts, element: el, ts: Date.now() });
}

export function removeActiveFlowsFor(agentId) {
  const targetId = getPipelineAgentId(agentId);
  for (const [key, flow] of activeFlows) {
    if (flow.to === targetId) {
      removeFlowLine(flow.element);
      activeFlows.delete(key);
    }
  }
}

export function clearAllFlows() {
  for (const [, flow] of activeFlows) {
    removeFlowLine(flow.element);
  }
  activeFlows.clear();
}

export function hasMeaningfulValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function resolveTerminalDeliveryDiagnostic(data, workItemId = null) {
  const eventDiagnostic = data?.runtimeDiagnostics?.completionEgress;
  if (eventDiagnostic && typeof eventDiagnostic === 'object') return eventDiagnostic;
  const workItemDiagnostic = workItemId ? workItems[workItemId]?.runtimeDiagnostics?.completionEgress : null;
  return workItemDiagnostic && typeof workItemDiagnostic === 'object' ? workItemDiagnostic : null;
}

function hasVisibleTerminalDeliveryActivity(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return false;
  const deliveryType = normalizeFlowToken(diagnostic.deliveryType);
  const workflow = normalizeFlowToken(diagnostic.workflow);
  const channel = normalizeFlowToken(diagnostic.channel);
  const fanout = Array.isArray(diagnostic.fanout) ? diagnostic.fanout : [];
  const hasFanoutActivity = fanout.some((entry) => entry && typeof entry === 'object');

  if (deliveryType && deliveryType !== 'terminal') return false;
  if (workflow && workflow !== PROTOCOL_ID.DELIVERY.TERMINAL) return false;
  if (diagnostic.skipped === true) return false;

  return hasFanoutActivity || (channel && channel !== 'none');
}

export function resolveDashboardWorkItemId(data) {
  if (!data || typeof data !== 'object') return null;
  return data.workItemId || data.contractId || data.sessionKey || null;
}

export function isCanonicalDashboardWorkItem(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.hasContract === true) return true;
  if (hasMeaningfulValue(data.workItemKind)) return true;
  if (hasMeaningfulValue(data.contractId)) return true;
  if (hasMeaningfulValue(data.task)) return true;
  return typeof data.id === 'string' && data.id.startsWith('TC-');
}

export function mergeWorkItemState(workItemId, patch) {
  if (!workItemId || !patch || typeof patch !== 'object') return null;
  const existing = workItems[workItemId] || { id: workItemId };
  const next = { ...existing, id: workItemId };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (['task', 'assignee', 'taskType', 'protocolEnvelope'].includes(key) && !hasMeaningfulValue(value)) continue;
    if (key === 'replyTo' && !hasMeaningfulValue(value)) continue;
    if (key === 'createdAt' && !Number.isFinite(value)) continue;
    next[key] = value;
  }

  workItems[workItemId] = next;
  return next;
}

export function buildLifecyclePatchFromAlert(data) {
  const workItemId = resolveDashboardWorkItemId(data);
  if (!workItemId || !data?.type) return null;

  const identityPatch = {
    hasContract: data.hasContract,
    workItemKind: data.workItemKind,
  };

  if (data.type === 'inbox_dispatch') {
    return {
      ...identityPatch,
      task: data.task,
      assignee: data.assignee,
      replyTo: data.replyTo || (data.from ? { agentId: data.from } : undefined),
      status: data.fastTrack === true ? 'pending' : 'draft',
      createdAt: data.ts,
      updatedAt: data.ts,
      taskType: data.taskType,
      protocolEnvelope: data.protocolEnvelope,
      fastTrack: data.fastTrack,
      stagePlan: data.stagePlan,
      stageRuntime: data.stageRuntime,
      phases: data.phases,
      total: data.total,
    };
  }

  if (data.type === 'contract_stage_plan_updated') {
    return {
      ...identityPatch,
      stagePlan: data.stagePlan,
      stageRuntime: data.stageRuntime,
      phases: data.phases,
      updatedAt: data.ts,
    };
  }

  return null;
}

// ── Clock ──
export function updateClock() {
  const now = new Date();
  document.getElementById('headerTime').textContent = now.toTimeString().slice(0, 8);
  document.getElementById('headerDate').textContent = now.toISOString().slice(0, 10).replace(/-/g, '.');
  if (connectedAt) {
    const diff = Math.floor((now - connectedAt) / 1000);
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    document.getElementById('statUptime').textContent = `${h}:${m}:${s}`;
  }
}
setInterval(updateClock, 1000);
updateClock();

// ── Agent metadata ──
export async function loadAgentMeta() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const res = await fetch(`/watchdog/agents?token=${encodeURIComponent(token)}`);
    if (res.ok) {
      const list = await res.json();
      const freshIds = new Set(list.map(a => a.id));
      for (const id of Object.keys(agentMeta)) {
        if (!freshIds.has(id)) {
          delete agentMeta[id];
        }
      }
      for (const id of Object.keys(agentState)) {
        if (!freshIds.has(id)) {
          delete agentState[id];
        }
      }
      list.forEach(a => {
        agentMeta[a.id] = a;
        agentState[a.id] = agentState[a.id] || {};
        if (a.heartbeatEvery) agentState[a.id]._heartbeatEvery = a.heartbeatEvery;
      });

      // Build SVG dynamically from agent data
      window._lastAgentData = list;
      buildPipelineSVG(list);

      // Load available models for hot-swap
      loadModels();
    }
  } catch {}
}

export function setModelText(elId, model) {
  const el = document.getElementById(elId);
  if (el) el.textContent = shortModel(model);
}

export function parseIntervalMs(text) {
  const raw = String(text || '').trim().toLowerCase();
  const m = raw.match(/^(\d+)\s*([smhd])$/);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2];
  const unitMs = unit === 's' ? 1000
    : unit === 'm' ? 60 * 1000
    : unit === 'h' ? 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;
  return value * unitMs;
}

export function getOfflineWindowMs(agentId) {
  const configured = parseIntervalMs(agentMeta[agentId]?.heartbeatEvery || agentState[agentId]?._heartbeatEvery);
  return configured ? Math.max(configured * 2, 10 * 60 * 1000) : DEFAULT_OFFLINE_MS;
}

export function getAgentLastSeen(agentId) {
  return getPipelineAggregateAgentIds(agentId).reduce((maxTs, id) => {
    const stateTs = agentState[id]?._lastSeen || 0;
    const runtimeTs = dispatchRuntimeState[id]?.lastSeen || 0;
    return Math.max(maxTs, stateTs, runtimeTs);
  }, 0);
}

export function getAgentAvailability(agentId) {
  const aggregateIds = getPipelineAggregateAgentIds(agentId);
  if (aggregateIds.some((id) => {
    const state = agentState[id] || {};
    const runtime = dispatchRuntimeState[id] || {};
    return state.status === 'running' || state._delivering || runtime.busy || runtime.dispatching;
  })) return 'busy';
  const lastSeen = getAgentLastSeen(agentId);
  if (!lastSeen) return 'standby';
  return (Date.now() - lastSeen) > getOfflineWindowMs(agentId) ? 'offline' : 'available';
}

export function getAgentVisualStatus(agentId) {
  const aggregateIds = getPipelineAggregateAgentIds(agentId);
  if (aggregateIds.some((id) => {
    const state = agentState[id] || {};
    const runtime = dispatchRuntimeState[id] || {};
    return state.status === 'error' || runtime.healthy === false;
  })) return 'error';
  if (aggregateIds.some((id) => {
    const state = agentState[id] || {};
    const runtime = dispatchRuntimeState[id] || {};
    return state.status === 'running' || state._delivering || runtime.busy || runtime.dispatching;
  })) return 'running';
  return 'idle';
}

export function formatLastSeen(agentId) {
  const ts = getAgentLastSeen(agentId);
  if (!ts) return 'never';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// ── Work Items ──
let _lastWorkItemsHash = '';

function getLoopSessionId(contract) {
  const prog = contract?.runtimeDiagnostics?.pipelineProgression;
  return prog?.loopSessionId || null;
}

function getLoopId(contract) {
  const prog = contract?.runtimeDiagnostics?.pipelineProgression;
  return prog?.loopId || null;
}

function parseCursorDone(cursor) {
  if (typeof cursor === 'number' && Number.isFinite(cursor)) return cursor;
  if (typeof cursor !== 'string') return 0;
  const match = cursor.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return 0;
  return Number(match[1]) || 0;
}

function getWorkItemStageLabels(workItem) {
  if (Array.isArray(workItem?.phases) && workItem.phases.length > 0) {
    return workItem.phases;
  }

  return (Array.isArray(workItem?.stagePlan?.stages) ? workItem.stagePlan.stages : [])
    .map((entry) => typeof entry === 'string'
      ? entry
      : entry?.semanticLabel || entry?.label || entry?.name || entry?.objective || entry?.goal || entry?.title || null)
    .filter((label) => typeof label === 'string' && label.trim() !== '');
}

function hasCanonicalStagePlan(contract) {
  return Array.isArray(contract?.stagePlan?.stages) && contract.stagePlan.stages.length > 0;
}

function getStageConfidence(contract) {
  if (contract?.stageProjection?.confidence) return contract.stageProjection.confidence;
  if (!contract?.stagePlan && !contract?.phases?.length) return 'none';
  if (contract?.status === 'draft') return 'planner_guess';
  return 'planner';
}

function shouldRenderWorkItemStages(contract) {
  const stageLabels = getWorkItemStageLabels(contract);
  if (stageLabels.length === 0) return false;
  const confidence = getStageConfidence(contract);
  return confidence === 'planner' || confidence === 'pipeline' || confidence === 'protocol';
}

function getWorkItemStageRenderSignature(contract) {
  return JSON.stringify({
    phases: getWorkItemStageLabels(contract),
    cursor: contract?.cursor ?? null,
    total: contract?.total ?? null,
    stageProjection: contract?.stageProjection
      ? {
          source: contract.stageProjection.source || null,
          confidence: contract.stageProjection.confidence || null,
          currentStage: contract.stageProjection.currentStage || null,
          currentStageLabel: contract.stageProjection.currentStageLabel || null,
          completedStages: contract.stageProjection.completedStages || null,
        }
      : null,
    stageRuntime: contract?.stageRuntime
      ? {
          version: contract.stageRuntime.version ?? null,
          currentStageId: contract.stageRuntime.currentStageId ?? null,
          completedStageIds: contract.stageRuntime.completedStageIds || null,
          revisionCount: contract.stageRuntime.revisionCount ?? null,
          lastRevisionReason: contract.stageRuntime.lastRevisionReason ?? null,
        }
      : null,
    stagePlan: contract?.stagePlan
      ? {
          version: contract.stagePlan.version ?? null,
          stages: (Array.isArray(contract.stagePlan.stages) ? contract.stagePlan.stages : []).map((entry) => ({
            id: entry?.id || null,
            label: entry?.semanticLabel || entry?.label || entry?.name || entry?.objective || entry?.goal || entry?.title || null,
            status: entry?.status || null,
          })),
        }
      : null,
  });
}

function renderWorkItemCard(c, { nested = false } = {}) {
  const status = c.status || 'pending';
  const pct = Number.isFinite(c.pct) ? c.pct : (status === 'completed' ? 100 : null);
  const barClass = status === 'completed' ? 'done' : status === 'failed' ? 'fail' : '';
  const created = c.createdAt ? new Date(c.createdAt).toLocaleString('zh-CN') : '--';
  const elapsed = c.elapsedMs ? (c.elapsedMs / 1000).toFixed(0) + 's'
    : c.updatedAt && c.createdAt ? ((c.updatedAt - c.createdAt) / 1000).toFixed(0) + 's' : '--';
  const tt = c.taskType;
  const envelope = c.protocolEnvelope || c.protocol?.envelope || null;
  const pathTag = (tt === 'research_experiment' || tt === 'research_analysis')
    ? '<span style="color:var(--accent-amber);font-size:10px;letter-spacing:0.05em"> EXPERIMENT</span>'
    : tt === 'research_coding'
      ? '<span style="color:var(--accent-blue);font-size:10px;letter-spacing:0.05em"> CODING</span>'
    : tt === 'research_coding_fix'
      ? '<span style="color:var(--accent-red);font-size:10px;letter-spacing:0.05em"> CODE-FIX</span>'
    : tt === 'research_coding_revise'
      ? '<span style="color:var(--accent-orange);font-size:10px;letter-spacing:0.05em"> CODE-REVISE</span>'
    : tt === 'request_review' || envelope === 'code_review'
      ? '<span style="color:var(--accent-red);font-size:10px;letter-spacing:0.05em"> REVIEW</span>'
    : envelope === 'direct_request'
      ? '<span style="color:var(--accent-green);font-size:10px;letter-spacing:0.05em"> DIRECT</span>'
    : envelope === 'workflow_signal'
      ? '<span style="color:var(--accent-red);font-size:10px;letter-spacing:0.05em"> SIGNAL</span>'
    : c.fastTrack === true ? '<span style="color:var(--accent-orange);font-size:10px;letter-spacing:0.05em"> FAST-TRACK</span>'
    : c.fastTrack === false ? '<span style="color:var(--accent-blue);font-size:10px;letter-spacing:0.05em"> FULL-PATH</span>' : '';
  const progression = describePipelineProgression(getWorkItemPipelineProgression(c));
  const progressionHtml = progression
    ? `<div class="contract-meta-row">
        <dt>PIPELINE</dt>
        <dd><div class="contract-progress-chip-wrapper visible"><span class="contract-progress-chip ${progression.tone}" title="${esc(progression.title)}">${esc(progression.text)}</span></div></dd>
      </div>`
    : '';

  const harnessRunId = c.runtimeDiagnostics?.harnessRunId;
  const harnessHtml = harnessRunId
    ? `<div class="contract-meta-row">
        <dt>HARNESS</dt>
        <dd><span class="contract-harness-chip" title="HarnessRun: ${esc(harnessRunId)}">HARNESS</span></dd>
      </div>`
    : '';
  const activityLabel = getRecentToolSummary(c) || c.activityCursor?.label || c.lastLabel || null;
  const activityHtml = activityLabel
    ? `<div class="contract-meta-row">
        <dt>ACTIVITY</dt>
        <dd title="${esc(activityLabel)}">${esc(activityLabel)}</dd>
      </div>`
    : '';

  let phasesHtml = '';
  const confidence = getStageConfidence(c);
  const stageLabels = getWorkItemStageLabels(c);
  if (shouldRenderWorkItemStages(c)) {
    // Mode C — real stages from planner/pipeline, fade-in
    const cursor = parseCursorDone(c.cursor);
    phasesHtml = '<div class="contract-phases contract-phases-fadein">' +
      stageLabels.map((p, i) => {
        const dotClass = status === 'completed' ? 'done' : i < cursor ? 'done' : i === cursor && status === 'running' ? 'active' : '';
        const pLabel = typeof p === 'string' ? p : (p?.name || (typeof p === 'object' ? JSON.stringify(p) : String(p)));
        return `<div class="phase-item"><div class="phase-dot ${dotClass}"></div><span style="color:var(--text-muted);font-size:11px;margin-right:4px">${i+1}.</span>${esc(pLabel)}</div>`;
      }).join('') + '</div>';
  } else if (confidence === 'none' || c.fastTrack === true) {
    // Mode A — simple task, compact status indicator
    const dotMap = { pending: 'pending', running: 'running', completed: 'done', failed: 'failed', draft: 'pending' };
    const labelMap = { pending: '排队中', running: '处理中', completed: '已完成', failed: '失败', draft: '排队中' };
    const dotClass = dotMap[status] || 'pending';
    const label = labelMap[status] || status;
    phasesHtml = `<div class="contract-simple-status"><span class="contract-simple-dot ${dotClass}"></span><span class="contract-simple-label">${esc(label)}</span></div>`;
  } else if (status === 'draft' && confidence === 'planner_guess') {
    // Mode B — complex task planning, breathing placeholder
    phasesHtml = '<div class="contract-planning-placeholder"><span class="contract-planning-dot"></span><span class="contract-planning-label">规划中...</span></div>';
  }

  const nestedClass = nested ? ' contract-loop-stage' : '';
  const stageClass = nested && status === 'completed' ? ' contract-loop-stage-completed' : nested && (status === 'running' || status === 'pending') ? ' contract-loop-stage-active' : '';

  return `<div class="contract-card status-${status}${nestedClass}${stageClass}">
    <div class="contract-header">
      <span class="contract-id">${esc(c.id)}${pathTag}</span>
      <span class="contract-status-badge ${status}">${esc(status)}</span>
    </div>
    <div class="contract-task" onclick="this.classList.toggle('expanded')" title="Click to expand/collapse">${esc(c.task || '--')}</div>
    <div class="contract-meta-grid">
      <div class="contract-meta-row"><dt>ASSIGNEE</dt><dd>${esc(displayAgentRef(c.assignee) || '--')}</dd></div>
      <div class="contract-meta-row"><dt>REPLY-TO</dt><dd>${esc(displayAgentRef(c.replyTo) || '--')}</dd></div>
      <div class="contract-meta-row"><dt>CREATED</dt><dd>${esc(created)}</dd></div>
      <div class="contract-meta-row"><dt>ELAPSED</dt><dd>${esc(elapsed)}</dd></div>
      <div class="contract-meta-row"><dt>TOOLS</dt><dd>${c.toolCallCount ?? '--'}</dd></div>
      <div class="contract-meta-row"><dt>RETRY</dt><dd>${c.retryCount ?? 0}</dd></div>
      ${activityHtml}
      ${progressionHtml}
      ${harnessHtml}
    </div>
    ${pct == null ? '' : `<div class="progress-bar-container">
      <div class="progress-bar-bg"><div class="progress-bar-fill ${barClass}" style="width:${pct}%"></div></div>
      <span class="progress-pct">${pct}%</span>
    </div>`}
    ${phasesHtml}
  </div>`;
}

function renderLoopGroupCard(loopSessionId, loopWorkItems) {
  const sorted = loopWorkItems.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const loopId = getLoopId(sorted[0]) || 'unknown';
  const latestProg = sorted[sorted.length - 1]?.runtimeDiagnostics?.pipelineProgression;
  const currentRound = latestProg?.round || 1;
  const currentStage = latestProg?.to || latestProg?.from || latestProg?.stage || '--';
  const completedCount = sorted.filter(c => c.status === 'completed').length;
  const totalCount = sorted.length;
  const hasActive = sorted.some(c => c.status === 'running' || c.status === 'pending');
  const hasFailed = sorted.some(c => c.status === 'failed');
  const harnessCount = sorted.filter(c => c.runtimeDiagnostics?.harnessRunId).length;
  const groupStatus = hasFailed ? 'failed' : hasActive ? 'running' : 'completed';
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const harnessInfo = harnessCount > 0
    ? `<span class="contract-harness-chip" title="${harnessCount} of ${totalCount} stages have harness coverage">HARNESS ${harnessCount}/${totalCount}</span>`
    : '';

  const stageCardsHtml = sorted.map(c => renderWorkItemCard(c, { nested: true })).join('');

  return `<div class="contract-loop-group status-${groupStatus}">
    <div class="contract-loop-group-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="contract-loop-group-title">
        <span class="contract-loop-group-icon">&#x21BB;</span>
        <span class="contract-id">${esc(loopId)}</span>
        <span class="contract-loop-round-badge">R${currentRound}</span>
        ${harnessInfo}
      </div>
      <div class="contract-loop-group-meta">
        <span class="contract-loop-group-stage" title="Current stage">${esc(String(currentStage).toUpperCase())}</span>
        <span class="contract-loop-group-progress">${completedCount}/${totalCount}</span>
        <span class="contract-status-badge ${groupStatus}">${esc(groupStatus)}</span>
      </div>
    </div>
    <div class="contract-loop-group-progress-bar">
      <div class="progress-bar-bg"><div class="progress-bar-fill ${groupStatus === 'completed' ? 'done' : groupStatus === 'failed' ? 'fail' : ''}" style="width:${progressPct}%"></div></div>
    </div>
    <div class="contract-loop-group-body">
      ${stageCardsHtml}
    </div>
  </div>`;
}

export function renderWorkItems() {
  const el = document.getElementById('workItemList');
  const list = Object.values(workItems)
    .filter((item) => isCanonicalDashboardWorkItem(item))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // Quick hash: skip rebuild if work item set unchanged
  const hash = list.map((c) => {
    const progression = getWorkItemPipelineProgression(c);
    return [
      c.id,
      c.status,
      c.pct,
      c.toolCallCount,
      c.updatedAt,
      progression?.action || '',
      progression?.reason || '',
      progression?.from || progression?.stage || '',
      progression?.to || '',
      progression?.error || '',
      progression?.ts || '',
      c.runtimeDiagnostics?.harnessRunId || '',
      c.fastTrack ?? '',
      getWorkItemStageRenderSignature(c),
    ].join(':');
  }).join('|');
  if (hash === _lastWorkItemsHash) return;
  _lastWorkItemsHash = hash;
  if (list.length === 0) {
    el.innerHTML = '<div class="empty-state">NO ACTIVE WORK ITEMS<br>AWAITING DISPATCH...</div>';
    document.getElementById('statWorkItems').textContent = '0';
    document.getElementById('statCompleted').textContent = '0';
    emit('work-items:updated', { workItems: list });
    return;
  }

  // Group work items: loop sessions vs standalone
  const loopGroups = new Map(); // loopSessionId → [workItems]
  const standalone = [];
  for (const c of list) {
    const sessionId = getLoopSessionId(c);
    if (sessionId) {
      if (!loopGroups.has(sessionId)) loopGroups.set(sessionId, []);
      loopGroups.get(sessionId).push(c);
    } else {
      standalone.push(c);
    }
  }

  // Render: loop groups first (sorted by latest activity), then standalone cards
  const loopGroupEntries = [...loopGroups.entries()].sort((a, b) => {
    const latestA = Math.max(...a[1].map(c => c.updatedAt || c.createdAt || 0));
    const latestB = Math.max(...b[1].map(c => c.updatedAt || c.createdAt || 0));
    return latestB - latestA;
  });

  const htmlParts = [];
  for (const [sessionId, groupWorkItems] of loopGroupEntries) {
    htmlParts.push(renderLoopGroupCard(sessionId, groupWorkItems));
  }
  for (const c of standalone) {
    htmlParts.push(renderWorkItemCard(c));
  }

  el.innerHTML = htmlParts.join('');

  document.getElementById('statWorkItems').textContent = list.length;
  document.getElementById('statCompleted').textContent = list.filter(c => c.status === 'completed').length;
  emit('work-items:updated', { workItems: list });
}

// ── Event Stream ──
function getAgentBlock(agentId) {
  const key = normalizeDashboardAgentKey(agentId);
  if (!agentEvents[key]) agentEvents[key] = [];
  return key;
}

export function addEvent(type, data) {
  eventCount++;
  document.getElementById('statEvents').textContent = eventCount;
  const rawAgentId = data.agentId || '_system';
  const agentId = normalizeDashboardAgentKey(rawAgentId);
  if (agentId !== rawAgentId) mergeAgentEventBlocks(rawAgentId, agentId);
  const key = getAgentBlock(agentId);
  const now = new Date().toTimeString().slice(0, 8);
  const eventLabel = type === 'alert' ? (data.type || 'alert') : type;
  let body = '';
  if (type === 'track_start') body = 'session started';
  else if (type === 'track_progress') body = `#${data.toolCallCount} ${esc(normalizeDashboardText(getRecentToolSummary(data) || data.lastLabel || ''))}`;
  else if (type === 'track_end') body = `ended (${esc(normalizeDashboardText(data.status || 'ok'))}) ${data.elapsedMs ? (data.elapsedMs/1000).toFixed(0)+'s' : ''}`;
  else if (type === 'graph_dispatch') body = `${esc(normalizeDashboardText(data.from || '?'))} -> ${esc(normalizeDashboardText(data.to || '?'))} ${esc(normalizeDashboardText(data.contractId || ''))}`.trim();
  else if (type === 'alert' && data.type === 'survival_check') body = `[survival_check] ${esc(normalizeDashboardText(data.availability || 'available'))} ${esc(normalizeDashboardText(data.detail || ''))}`;
  else if (type === 'alert') body = `[${esc(normalizeDashboardText(data.type))}] ${esc(normalizeDashboardText(resolveDashboardWorkItemId(data) || data.task || JSON.stringify(data).slice(0, 60)))}`;
  else body = normalizeDashboardText(JSON.stringify(data).slice(0, 80));

  agentEvents[key].unshift({
    type,
    eventLabel,
    body,
    time: now,
  });
  if (agentEvents[key].length > 30) agentEvents[key].length = 30;
  renderEventStream();
  emit('event:added', { type, data });
}

let _lastEventStreamHash = '';
export function renderEventStream() {
  const container = document.getElementById('eventStream');
  const keys = Object.keys(agentEvents).sort((a, b) => {
    if (a === '_system') return 1;
    if (b === '_system') return -1;
    return (agentEvents[b][0]?.time || '').localeCompare(agentEvents[a][0]?.time || '');
  });
  const html = keys.map(key => {
    const events = agentEvents[key];
    if (!events.length) return '';
    const displayName = key === '_system' ? 'SYSTEM' : key.toUpperCase();
    const visualStatus = key.startsWith('_') ? 'idle' : getAgentVisualStatus(key);
    return `<div class="agent-event-block ${key === '_system' ? 'system-event-block' : ''}">
      <div class="agent-event-header" onclick="toggleBlock(this)">
        <span><span class="agent-event-dot ${visualStatus}"></span><span class="agent-event-name">${esc(displayName)}</span></span>
        <span class="agent-event-count">${events.length}</span>
      </div>
      <div class="agent-event-list">
        ${events.map(e => `<div class="event-item">
          <div class="event-time">${esc(e.time)}</div>
          <div class="event-type">${esc(e.eventLabel)}</div>
          <div class="event-body">${e.body}</div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
  // Skip DOM rebuild if content unchanged — prevents animation replay flicker
  const hash = `${eventCount}:${keys.map((key) => `${key}:${key.startsWith('_') ? 'idle' : getAgentVisualStatus(key)}:${agentEvents[key].length}`).join('|')}`;
  if (hash === _lastEventStreamHash) return;
  _lastEventStreamHash = hash;
  container.innerHTML = html;
}

export function toggleBlock(header) {
  const list = header.nextElementSibling;
  list.style.display = list.style.display === 'none' ? '' : 'none';
}

// ── Process SSE ──
export function processEvent(type, data) {
  if (type === 'heartbeat') {
    if (data.agentId) {
      agentState[data.agentId] = agentState[data.agentId] || {};
      agentState[data.agentId]._lastSeen = data.ts || Date.now();
      if (data.kind === 'survival_check') {
        agentState[data.agentId]._survival = data.availability || 'available';
      }
      updatePipeline();
      renderEventStream();
    }
    return;
  }
  if (type === 'connected') {
    connectedAt = new Date();
    document.getElementById('connDot').classList.add('connected');
    document.getElementById('connText').textContent = 'STREAM ACTIVE';
    return;
  }

  if (type === 'graph_dispatch') {
    if (data.from && data.to) {
      const flowType = resolveFlowVisualType('graph_dispatch', data);
      addActiveFlow(
        data.from,
        data.to,
        resolveFlowVisualLabel('graph_dispatch', data),
        { workItemId: resolveDashboardWorkItemId(data) || data.contractId || null, type: flowType },
      );
      updatePipeline();
    }
    addEvent(type, data);
    return;
  }

  if (type === 'track_start' || type === 'track_progress') {
    agentState[data.agentId] = agentState[data.agentId] || {};
    Object.assign(agentState[data.agentId], {
      status: data.status || 'running',
      lastLabel: data.lastLabel,
      toolCallCount: data.toolCallCount,
      elapsedMs: data.elapsedMs,
      _lastSeen: data.ts || Date.now(),
    });
    if (data.agentId === 'planner') currentFastTrack = false;
    if (data.agentId?.startsWith('worker-')) {
      if (currentFastTrack === null) currentFastTrack = true;
      agentState[data.agentId]._fastTrack = currentFastTrack;
    }
    const workItemId = resolveDashboardWorkItemId(data);
    if (workItemId && !isCanonicalDashboardWorkItem(data)) {
      delete workItems[workItemId];
    } else if (workItemId && data.task) {
      const cid = workItemId;
      // Preserve planner-extracted phases: only upgrade, never downgrade to null
      const existingPhases = workItems[cid]?.phases;
      const incomingPhases = Array.isArray(data.phases) && data.phases.length > 0 ? data.phases : undefined;
      const existingStagePlan = workItems[cid]?.stagePlan;
      const incomingStagePlan = data.stagePlan?.stages?.length > 0 ? data.stagePlan : undefined;
      mergeWorkItemState(cid, {
        task: data.task,
        status: data.status || 'running',
        hasContract: data.hasContract,
        workItemKind: data.workItemKind,
        assignee: data.assignee || data.agentId,
        replyTo: data.replyTo,
        stageProjection: data.stageProjection,
        lastLabel: data.lastLabel,
        recentToolEvents: data.recentToolEvents,
        activityCursor: data.activityCursor,
        runtimeObservation: data.runtimeObservation,
        phases: incomingPhases,
        stagePlan: incomingStagePlan,
        stageRuntime: data.stageRuntime,
        cursor: data.cursor,
        pct: data.pct,
        total: data.total,
        toolCallCount: data.toolCallCount,
        elapsedMs: data.elapsedMs,
        taskType: data.taskType,
        protocolEnvelope: data.protocolEnvelope,
        followUp: data.followUp,
        systemActionDelivery: data.systemActionDelivery,
        systemActionDeliveryTicket: data.systemActionDeliveryTicket,
        semanticOutcome: data.semanticOutcome,
        systemAction: data.systemAction,
        runtimeDiagnostics: data.runtimeDiagnostics,
        fastTrack: agentState[data.agentId]?._fastTrack ?? workItems[cid]?.fastTrack,
        createdAt: data.createdAt || workItems[cid]?.createdAt || (data.ts - (data.elapsedMs || 0)),
        updatedAt: data.updatedAt || data.ts,
      });
    }
    renderWorkItems();
    updatePipeline();
    updateActiveStat();

    // Dynamic flow: track_start creates flow lines based on graph edges
    if (type === 'track_start') {
      // Use graph edges to determine flow direction — who has an edge pointing to this agent?
      const graphEdges = window.__graphEdges || [];
      const incomingEdges = graphEdges.filter(e => e.to === data.agentId);
      const flowType = resolveFlowVisualType('activity', data);
      if (incomingEdges.length > 0) {
        for (const edge of incomingEdges) {
          addActiveFlow(edge.from, data.agentId, truncLabel(data.task), { workItemId: workItemId || null, type: flowType });
        }
      } else if (data.replyTo?.agentId) {
        // Fallback: no graph edge info → use replyTo
        addActiveFlow(data.replyTo.agentId, data.agentId, truncLabel(data.task), { workItemId: workItemId || null, type: flowType });
      }
    }
  }

  if (type === 'track_end') {
    const workItemId = resolveDashboardWorkItemId(data);
    const deliveryTargetAgentId = data.replyTo?.agentId || workItems[workItemId]?.replyTo?.agentId || null;
    if (agentState[data.agentId]) {
      agentState[data.agentId].status = data.status === 'failed' ? 'error' : 'idle';
      agentState[data.agentId].lastLabel = null;
      agentState[data.agentId]._lastSeen = data.ts || Date.now();
      if (data.agentId?.startsWith('worker-') && data.status !== 'failed') {
        agentState[data.agentId]._justCompleted = true;
        if (deliveryTargetAgentId) {
          agentState[deliveryTargetAgentId] = agentState[deliveryTargetAgentId] || {};
          agentState[deliveryTargetAgentId]._delivering = true;
        }
        const endedAgent = data.agentId;
        setTimeout(() => {
          if (agentState[endedAgent]) {
            agentState[endedAgent]._justCompleted = false;
            agentState[endedAgent]._fastTrack = undefined;
          }
          if (deliveryTargetAgentId && agentState[deliveryTargetAgentId]) {
            agentState[deliveryTargetAgentId]._delivering = false;
          }
          const allWorkers = [...((dynamicWorkers.length > 0) ? dynamicWorkers : WORKERS),
        ...((window._lastAgentData || []).filter(a => a.role === 'executor' && a.specialized).map(a => a.id))
      ];
          const stillRunning = allWorkers.some(w => agentState[w]?.status === 'running');
          if (!stillRunning) currentFastTrack = null;
          updatePipeline();
        }, 5000);
      }
    }
    if (workItemId && !isCanonicalDashboardWorkItem(data)) {
      delete workItems[workItemId];
    } else if (workItemId) {
      mergeWorkItemState(workItemId, {
        task: data.task,
        status: data.status || 'completed',
        pct: data.status === 'completed' ? 100 : workItems[workItemId]?.pct,
        elapsedMs: data.elapsedMs,
        hasContract: data.hasContract,
        workItemKind: data.workItemKind,
        assignee: data.assignee || data.agentId,
        replyTo: data.replyTo,
        stageProjection: data.stageProjection,
        lastLabel: data.lastLabel,
        recentToolEvents: data.recentToolEvents,
        activityCursor: data.activityCursor,
        runtimeObservation: data.runtimeObservation,
        taskType: data.taskType,
        protocolEnvelope: data.protocolEnvelope,
        followUp: data.followUp,
        systemActionDelivery: data.systemActionDelivery,
        systemActionDeliveryTicket: data.systemActionDeliveryTicket,
        semanticOutcome: data.semanticOutcome,
        systemAction: data.systemAction,
        runtimeDiagnostics: data.runtimeDiagnostics,
        createdAt: data.createdAt || workItems[workItemId]?.createdAt || (data.ts - (data.elapsedMs || 0)),
        updatedAt: data.updatedAt || data.ts,
      });
    }
    renderWorkItems();
    updatePipeline();
    updateActiveStat();

    // Dynamic flow: track_end removes incoming flows, optionally shows delivery
    removeActiveFlowsFor(data.agentId);
    // Check graph: if this agent has no out-edges, it's a terminal node → show delivery
    const graphEdges = window.__graphEdges || [];
    const hasOutEdge = graphEdges.some(e => e.from === data.agentId);
    const terminalDeliveryDiagnostic = resolveTerminalDeliveryDiagnostic(data, workItemId);
    if (!hasOutEdge && data.status !== 'failed' && hasVisibleTerminalDeliveryActivity(terminalDeliveryDiagnostic)) {
      // Terminal node — show delivery return flow
      const replyTo = data.replyTo?.agentId || null;
      if (replyTo) {
        addActiveFlow(
          data.agentId,
          replyTo,
          resolveFlowVisualLabel('reply', data),
          { type: resolveFlowVisualType('reply', data) },
        );
        setTimeout(() => removeActiveFlowsFor(replyTo), 5000);  // 5 seconds visibility
      }
    }
  }

  if (type === 'alert') {
    if (data.type === 'dispatch_runtime_state') {
      if (data.targets) Object.keys(data.targets).forEach(wId => {
        dispatchRuntimeState[wId] = data.targets[wId];
        agentState[wId] = agentState[wId] || {};
        if (data.targets[wId]?.lastSeen) agentState[wId]._lastSeen = data.targets[wId].lastSeen;
      });
      if (data.queue !== undefined) dispatchQueueState = Array.isArray(data.queue) ? data.queue : [];
      updatePipeline();
    }
    if (data.type === 'survival_check' && data.agentId) {
      agentState[data.agentId] = agentState[data.agentId] || {};
      agentState[data.agentId]._lastSeen = data.ts || Date.now();
      agentState[data.agentId]._survival = data.availability || 'available';
      updatePipeline();
      return;
    }
    if (data.type === 'system_reset') {
      loadAgentMeta(); loadWorkItems();
      Object.keys(agentState).forEach(k => delete agentState[k]);
      Object.keys(dispatchRuntimeState).forEach(k => delete dispatchRuntimeState[k]);
      dispatchQueueState = []; currentFastTrack = null;
      clearAllFlows();
      updatePipeline();
    }
    if (data.type === 'agent_created' || data.type === 'agent_deleted' || data.type === 'agent_hard_deleted' || data.type === 'model_changed') {
      loadAgentMeta();
    }
    const workItemId = resolveDashboardWorkItemId(data);
    if (workItemId) {
      const patch = buildLifecyclePatchFromAlert(data);
      if (patch) {
        mergeWorkItemState(workItemId, patch);
        if (data.fastTrack === true) currentFastTrack = true;
        else if (data.fastTrack === false) currentFastTrack = false;
        renderWorkItems();
      }
      // Dynamic flow: dispatch creates a brief flow line
      if (data.type === 'inbox_dispatch') {
        const from = data.from || data.replyTo?.agentId || null;
        const to = data.assignee;
        if (from && to) {
          addActiveFlow(from, to, resolveFlowVisualLabel('dispatch_alert', data), {
            workItemId,
            type: resolveFlowVisualType('dispatch_alert', data),
          });
        }
      }
      // Loop pipeline flow: stage advance/start creates a loop flow line
      if (data.type === 'loop_advanced' || data.type === 'loop_started') {
        const from = data.from || data.targetAgent;
        const to = data.to || data.targetAgent;
        if (from && to && from !== to) {
          const label = `R${data.round || 1} ${(data.to || '').toUpperCase()}`;
          addActiveFlow(from, to, label, { type: resolveFlowVisualType('pipeline', data), workItemId });
        }
      }
      const systemActionDeliveryFlow = resolveSystemActionDeliveryAlertFlow(data);
      if (systemActionDeliveryFlow) {
        addActiveFlow(
          systemActionDeliveryFlow.from,
          systemActionDeliveryFlow.to,
          systemActionDeliveryFlow.label,
          { type: systemActionDeliveryFlow.type, workItemId },
        );
      }
      if (data.type === 'loop_concluded') {
        renderWorkItems();
      }
    }
  }
  addEvent(type, data);
}

// ── SSE ──
export function connectSSE() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const es = new EventSource(`/watchdog/stream?token=${encodeURIComponent(token)}`);
  ['connected', 'track_start', 'track_progress', 'track_end', 'alert', 'heartbeat', 'graph_dispatch'].forEach(t => {
    es.addEventListener(t, e => { try { processEvent(t, JSON.parse(e.data)); } catch {} });
  });
  es.onerror = () => {
    document.getElementById('connDot').classList.remove('connected');
    document.getElementById('connText').textContent = 'RECONNECTING...';
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

setInterval(() => {
  updatePipeline();
  renderEventStream();
}, 10000);

// ── Load work items ──
export async function loadWorkItems() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const res = await fetch(`/watchdog/work-items?token=${encodeURIComponent(token)}`);
    if (res.ok) {
      const list = (await res.json()).filter((item) => isCanonicalDashboardWorkItem(item));
      const nextIds = new Set();
      list.forEach(c => {
        if (!c?.id) return;
        nextIds.add(c.id);
        workItems[c.id] = Object.assign(workItems[c.id] || {}, c);
      });
      Object.keys(workItems).forEach((id) => {
        if (!nextIds.has(id)) delete workItems[id];
      });
      renderWorkItems();
    }
  } catch {}
}

// ── System Reset ──
export async function systemReset() {
  if (!confirm('RESET: Clear all sessions, work items, and queue?')) return;
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const res = await fetch(`/watchdog/reset?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ explicitConfirm: true }),
    });
    if (res.ok) {
      const result = await res.json();
      Object.keys(workItems).forEach(k => delete workItems[k]);
      Object.keys(agentState).forEach(k => delete agentState[k]);
      Object.keys(dispatchRuntimeState).forEach(k => delete dispatchRuntimeState[k]);
      dispatchQueueState = []; currentFastTrack = null; eventCount = 0;
      renderWorkItems();
      updatePipeline();
      renderEventStream();
      updateActiveStat();
      document.getElementById('statEvents').textContent = '0';
      addEvent('alert', { type: 'system_reset', ...result });
    } else {
      const error = await res.json().catch(() => ({}));
      alert('Reset failed: ' + (error.error || `HTTP ${res.status}`));
    }
  } catch (e) {
    alert('Reset failed: ' + e.message);
  }
}

// ── Settings Menu ──
export function toggleSettingsMenu() {
  const menu = document.getElementById('settingsMenu');
  if (menu) menu.classList.toggle('open');
}
export function closeSettingsMenu() {
  const menu = document.getElementById('settingsMenu');
  if (menu) menu.classList.remove('open');
}
export function openDevtools() {
  closeSettingsMenu();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  window.open(`/watchdog/devtools?token=${encodeURIComponent(token)}`, '_blank');
}
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('settingsWrap');
  if (wrap && !wrap.contains(e.target)) closeSettingsMenu();
});
