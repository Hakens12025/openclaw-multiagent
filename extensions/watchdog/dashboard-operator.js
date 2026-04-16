// dashboard-operator.js — Runtime Operator window
import { on } from './dashboard-bus.js';
import { esc, toast } from './dashboard-common.js';
import {
  closeSettingsMenu,
  describePipelineProgression,
  humanizePipelineProgressReason,
  loadAgentMeta,
} from './dashboard.js';
import { loadGraph } from './dashboard-graph.js';

const operatorState = {
  open: false,
  planning: false,
  executing: false,
  interruptingLoop: false,
  canExecute: false,
  plan: null,
  messages: [],
  snapshot: null,
  graph: null,
};
let operatorSnapshotRefreshTimer = null;
let operatorPlanAbortController = null;

function operatorToken() {
  return new URLSearchParams(window.location.search).get('token') || '';
}

function ensureOperatorShell() {
  let shell = document.getElementById('operatorShell');
  if (shell) return shell;

  shell = document.createElement('div');
  shell.id = 'operatorShell';
  shell.className = 'operator-shell';
  shell.innerHTML = `
    <div class="operator-window" role="dialog" aria-modal="true" aria-label="Runtime Operator">
      <div class="operator-head">
        <div>
          <div class="operator-kicker">RUNTIME OPERATOR</div>
          <div class="operator-title">Platform Steward // O2 Slice</div>
        </div>
        <button class="operator-close" type="button" aria-label="Close" onclick="toggleOperatorWindow(false)">\u00D7</button>
      </div>
      <div class="operator-summary">
        <div class="operator-summary-card">
          <span class="operator-summary-label">STATE</span>
          <strong id="operatorStateText">--</strong>
        </div>
        <div class="operator-summary-card">
          <span class="operator-summary-label">AGENTS</span>
          <strong id="operatorAgentsCount">--</strong>
        </div>
        <div class="operator-summary-card">
          <span class="operator-summary-label">ACTIVE</span>
          <strong id="operatorWorkItemsCount">--</strong>
        </div>
        <div class="operator-summary-card">
          <span class="operator-summary-label">GRAPH</span>
          <strong id="operatorGraphCount">--</strong>
        </div>
        <div class="operator-summary-card">
          <span class="operator-summary-label">LOOPS</span>
          <strong id="operatorLoopsText">--</strong>
        </div>
        <div class="operator-summary-card">
          <span class="operator-summary-label">ACTIONS</span>
          <strong id="operatorActionsCount">--</strong>
        </div>
      </div>
      <div class="operator-runtime-strip">
        <div class="operator-runtime-card">
          <span class="operator-summary-label">ACTIVE LOOP</span>
          <strong id="operatorLoopRuntimeText">--</strong>
          <div class="operator-runtime-detail" id="operatorLoopRuntimeDetail">No active loop session.</div>
          <div class="operator-runtime-actions">
            <button class="operator-loop-btn" id="operatorInterruptLoopBtn" type="button" onclick="interruptOperatorLoopFromUI()">INTERRUPT LOOP</button>
          </div>
        </div>
        <div class="operator-runtime-card">
          <span class="operator-summary-label">LATEST PROGRESSION</span>
          <strong id="operatorProgressText">--</strong>
          <div class="operator-runtime-detail" id="operatorProgressDetail">No recent runtime-owned pipeline progression.</div>
        </div>
      </div>
      <div class="operator-body">
        <div class="operator-conversation" id="operatorConversation"></div>
        <div class="operator-plan-panel">
          <div class="operator-plan-head">
            <div class="operator-plan-title">CURRENT PLAN</div>
            <div class="operator-plan-actions">
              <button class="operator-cancel-btn" id="operatorCancelPlanBtn" type="button" onclick="cancelOperatorPlanFromUI()">CANCEL PLAN</button>
              <button class="operator-exec-btn" id="operatorExecuteBtn" type="button" onclick="executeOperatorPlanFromUI()">EXECUTE</button>
            </div>
          </div>
          <div class="operator-plan-content" id="operatorPlanContent">
            <div class="operator-empty">Describe a system change and ask operator to plan it.</div>
          </div>
        </div>
      </div>
      <div class="operator-compose">
        <textarea id="operatorInput" class="operator-input" rows="4" placeholder="\u4F8B\u5982\uFF1A\u7ED9 worker \u914D browser-automation\uFF1B\u6216\u8005\u628A planner \u8FDE\u5230 worker2\uFF1B\u6216\u8005\u95EE\u5B83\u4E3A\u4EC0\u4E48\u67D0\u6761\u94FE\u8DEF\u5361\u4F4F"></textarea>
        <div class="operator-compose-actions">
          <div class="operator-hint">\u5F53\u524D\u4F1A\u5148\u7528 operator brain \u7406\u89E3\u8BF7\u6C42\uFF1A\u6709 typed surface \u5C31\u51FA\u53EF\u6267\u884C plan\uFF0C\u6CA1\u6709\u5C31\u7ED9\u53D7\u7EA6\u675F\u5EFA\u8BAE\uFF1Bexecute \u4ECD\u53EA\u8D70\u5E73\u53F0\u786C\u8DEF\u5F84\u3002</div>
          <button class="operator-plan-btn" id="operatorPlanBtn" type="button" onclick="submitOperatorPlan()">PLAN</button>
        </div>
      </div>
    </div>
  `;
  shell.addEventListener('click', (event) => {
    if (event.target === shell) toggleOperatorWindow(false);
  });
  document.body.appendChild(shell);
  return shell;
}

function operatorToast(message, type = 'info') {
  toast(message, type);
}

function pushOperatorMessage(role, text, meta = {}) {
  const body = String(text || '').trim();
  if (!body) return;
  operatorState.messages.push({
    role,
    text: body,
    ts: Date.now(),
    warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
    limitations: Array.isArray(meta.limitations) ? meta.limitations : [],
    assumptions: Array.isArray(meta.assumptions) ? meta.assumptions : [],
  });
  if (operatorState.messages.length > 24) {
    operatorState.messages = operatorState.messages.slice(-24);
  }
}

function buildOperatorPlannerHistory(limit = 8) {
  return operatorState.messages.slice(-Math.max(1, limit)).map((entry) => ({
    role: entry.role,
    text: entry.text,
    ts: entry.ts,
  }));
}

function buildOperatorPlannerCurrentPlan() {
  const plan = operatorState.plan;
  if (!plan || typeof plan !== 'object') return null;
  return {
    intent: plan.intent || null,
    summary: plan.summary || null,
    derived: plan.derived || null,
    steps: Array.isArray(plan.steps)
      ? plan.steps.slice(0, 8).map((step) => ({
        surfaceId: step?.surfaceId || null,
        title: step?.title || null,
        summary: step?.summary || null,
        payload: step?.payload || {},
      }))
      : [],
  };
}

function clearCurrentOperatorPlan() {
  operatorState.plan = null;
  operatorState.canExecute = false;
}

function getActiveLoopSession() {
  return operatorState.graph?.activeLoopSession || operatorState.snapshot?.loops?.activeSession || null;
}

function renderOperatorConversation() {
  const host = document.getElementById('operatorConversation');
  if (!host) return;
  if (!operatorState.messages.length) {
    host.innerHTML = '<div class="operator-empty">Operator stays outside the agent graph and only manipulates platform/admin truth.</div>';
    return;
  }

  host.innerHTML = operatorState.messages.map((entry) => {
    const roleLabel = entry.role === 'user' ? 'YOU' : 'OPERATOR';
    const notes = [
      ...(entry.warnings || []).map((item) => `<div class="operator-note warning">${esc(item)}</div>`),
      ...(entry.limitations || []).map((item) => `<div class="operator-note limit">${esc(item)}</div>`),
      ...(entry.assumptions || []).map((item) => `<div class="operator-note">${esc(item)}</div>`),
    ].join('');

    return `<div class="operator-msg ${entry.role}">
      <div class="operator-msg-head">
        <span>${esc(roleLabel)}</span>
        <span>${esc(new Date(entry.ts).toLocaleTimeString('zh-CN'))}</span>
      </div>
      <div class="operator-msg-body">${esc(entry.text)}</div>
      ${notes}
    </div>`;
  }).join('');
  host.scrollTop = host.scrollHeight;
}

function formatLoopRuntimeDetail(activeLoopSession) {
  if (!activeLoopSession) {
    return {
      title: '--',
      detail: 'No active loop session.',
    };
  }

  const stage = activeLoopSession.currentStage ? String(activeLoopSession.currentStage).toUpperCase() : 'ACTIVE';
  const round = Number.isFinite(activeLoopSession.round) ? `R${activeLoopSession.round}` : 'R?';
  const runtimeStatus = String(activeLoopSession.runtimeStatus || activeLoopSession.status || 'active').toUpperCase();
  return {
    title: `${stage} // ${round}`,
    detail: `${activeLoopSession.loopId || 'unknown loop'} // ${runtimeStatus}`,
  };
}

function formatLatestProgressionDetail(snapshot) {
  const progression = snapshot?.loops?.latestProgression || null;
  const ui = describePipelineProgression(progression);
  if (!progression || !ui) {
    return {
      title: '--',
      detail: 'No recent runtime-owned pipeline progression.',
      tone: 'idle',
    };
  }

  const detailParts = [
    progression.contractId ? `contract ${progression.contractId}` : null,
    progression.pipelineId ? `pipeline ${progression.pipelineId}` : null,
    progression.loopId ? `loop ${progression.loopId}` : null,
    progression.reason ? humanizePipelineProgressReason(progression.reason) : null,
    progression.error || null,
  ].filter(Boolean);

  return {
    title: ui.text,
    detail: detailParts.join(' // ') || ui.title || 'Runtime progression visible.',
    tone: ui.tone || 'idle',
  };
}

function renderOperatorSummary() {
  const snapshot = operatorState.snapshot;
  const graph = operatorState.graph;
  const stateText = snapshot?.summary?.state || '--';
  const agentCount = snapshot?.agents?.counts?.total;
  const workItemCount = snapshot?.summary?.activeWorkItems;
  const edgeCount = Array.isArray(graph?.edges) ? graph.edges.length : null;
  const cycleCount = Array.isArray(graph?.cycles) ? graph.cycles.length : null;
  const activeLoopSession = getActiveLoopSession();
  const registeredLoopCount = Array.isArray(graph?.loops)
    ? graph.loops.length
    : snapshot?.loops?.counts?.registered;
  const activeLoopCount = Array.isArray(graph?.loops)
    ? graph.loops.filter((loop) => loop?.active === true).length
    : snapshot?.loops?.counts?.active;
  const operatorActionCount = snapshot?.surfaces?.counts?.operatorExecutable;

  const stateEl = document.getElementById('operatorStateText');
  const agentsEl = document.getElementById('operatorAgentsCount');
  const workItemsEl = document.getElementById('operatorWorkItemsCount');
  const graphEl = document.getElementById('operatorGraphCount');
  const loopsEl = document.getElementById('operatorLoopsText');
  const actionsEl = document.getElementById('operatorActionsCount');
  const loopRuntimeEl = document.getElementById('operatorLoopRuntimeText');
  const loopRuntimeDetailEl = document.getElementById('operatorLoopRuntimeDetail');
  const progressEl = document.getElementById('operatorProgressText');
  const progressDetailEl = document.getElementById('operatorProgressDetail');
  const interruptLoopBtn = document.getElementById('operatorInterruptLoopBtn');
  if (stateEl) stateEl.textContent = String(stateText).toUpperCase();
  if (agentsEl) agentsEl.textContent = agentCount == null ? '--' : String(agentCount);
  if (workItemsEl) workItemsEl.textContent = workItemCount == null ? '--' : String(workItemCount);
  if (graphEl) {
    graphEl.textContent = edgeCount == null
      ? '--'
      : `${edgeCount} EDGE${edgeCount === 1 ? '' : 'S'}${cycleCount ? ` / ${cycleCount} LOOP` : ''}`;
  }
  if (loopsEl) {
    if (activeLoopSession) {
      const stage = activeLoopSession.currentStage ? String(activeLoopSession.currentStage).toUpperCase() : 'ACTIVE';
      const round = Number.isFinite(activeLoopSession.round) ? ` R${activeLoopSession.round}` : '';
      const runtimeStatus = activeLoopSession.runtimeStatus === 'broken' ? 'BROKEN ' : '';
      loopsEl.textContent = `${runtimeStatus}${stage}${round}`;
    } else if (registeredLoopCount) {
      loopsEl.textContent = `${registeredLoopCount} REG / ${activeLoopCount || 0} ACTIVE`;
    } else {
      loopsEl.textContent = '--';
    }
  }
  if (actionsEl) actionsEl.textContent = operatorActionCount == null ? '--' : String(operatorActionCount);
  if (loopRuntimeEl || loopRuntimeDetailEl) {
    const loopRuntime = formatLoopRuntimeDetail(activeLoopSession);
    if (loopRuntimeEl) loopRuntimeEl.textContent = loopRuntime.title;
    if (loopRuntimeDetailEl) loopRuntimeDetailEl.textContent = loopRuntime.detail;
  }
  if (progressEl || progressDetailEl) {
    const latestProgress = formatLatestProgressionDetail(snapshot);
    if (progressEl) {
      progressEl.textContent = latestProgress.title;
      progressEl.className = `operator-runtime-status ${latestProgress.tone || 'idle'}`;
    }
    if (progressDetailEl) progressDetailEl.textContent = latestProgress.detail;
  }
  if (interruptLoopBtn) {
    interruptLoopBtn.disabled = operatorState.interruptingLoop || !activeLoopSession;
    interruptLoopBtn.textContent = operatorState.interruptingLoop ? 'INTERRUPTING...' : 'INTERRUPT LOOP';
  }
}

function buildOperatorAvailableActionsHtml() {
  const totalActions = operatorState.snapshot?.surfaces?.counts?.operatorExecutable ?? 0;
  const actions = Array.isArray(operatorState.snapshot?.surfaces?.actions)
    ? operatorState.snapshot.surfaces.actions.filter((surface) => surface?.operatorExecutable === true)
    : [];
  if (!actions.length && totalActions === 0) {
    return '<div class="operator-empty">No operator actions are currently registered.</div>';
  }
  if (!actions.length) {
    return '<div class="operator-empty">Operator actions exist, but this snapshot did not include them. Reload the snapshot.</div>';
  }

  return `
    <div class="operator-plan-text">Showing ${esc(String(actions.length))} of ${esc(String(totalActions))} registered operator actions.</div>
    <div class="operator-step-list">
      ${actions.map((surface) => `
        <div class="operator-step-card">
          <div class="operator-step-head">
            <span>${esc(surface.id || '--')}</span>
            <span>${esc(surface.risk || surface.stage || '--')}</span>
          </div>
          <div class="operator-step-body">${esc(surface.summary || '--')}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function buildOperatorPlanSummaryRows(plan, derived) {
  if (plan.intent === 'advice_only' || plan.intent === 'unsupported') {
    return [
      ['INTENT', plan.intent || '--'],
      ['MODE', 'advice'],
      ['EXECUTE', 'disabled'],
      ['ACTIONS', String(operatorState.snapshot?.surfaces?.counts?.operatorExecutable ?? '--')],
      ['PLANNER', derived.plannerModel || derived.plannerSource || '--'],
    ];
  }

  if (plan.intent === 'connect_agents' || plan.intent === 'disconnect_agents') {
    return [
      ['INTENT', plan.intent || '--'],
      ['FROM', derived.fromAgentId || '--'],
      ['TO', derived.toAgentId || '--'],
      ['MODE', derived.bidirectional ? 'bidirectional' : 'directed'],
    ];
  }

  if (plan.intent !== 'create_agent') {
    return [
      ['INTENT', plan.intent || '--'],
      ['PLANNER', derived.plannerModel || derived.plannerSource || '--'],
      ['STEPS', String(Array.isArray(plan.steps) ? plan.steps.length : 0)],
      ['ACTIONS', String(operatorState.snapshot?.surfaces?.counts?.operatorExecutable ?? '--')],
      ['EXECUTE', operatorState.canExecute === true ? 'enabled' : 'disabled'],
    ];
  }

  return [
    ['INTENT', plan.intent || '--'],
    ['ROLE', derived.role || '--'],
    ['AGENT ID', derived.agentId || '--'],
    ['ACTIONS', String(operatorState.snapshot?.surfaces?.counts?.operatorExecutable ?? '--')],
    ['MODEL', derived.model || 'default'],
  ];
}

function buildOperatorPlanDetails(plan, derived) {
  if (plan.intent === 'advice_only' || plan.intent === 'unsupported') {
    return [
      derived.reason ? `<div class="operator-plan-detail"><span>REASON</span>${esc(derived.reason)}</div>` : '',
      derived.requestText ? `<div class="operator-plan-detail"><span>REQUEST</span>${esc(derived.requestText)}</div>` : '',
    ].join('');
  }

  if (plan.intent === 'connect_agents' || plan.intent === 'disconnect_agents') {
    return [
      derived.fromAgentName && derived.fromAgentName !== derived.fromAgentId
        ? `<div class="operator-plan-detail"><span>FROM NAME</span>${esc(derived.fromAgentName)}</div>`
        : '',
      derived.toAgentName && derived.toAgentName !== derived.toAgentId
        ? `<div class="operator-plan-detail"><span>TO NAME</span>${esc(derived.toAgentName)}</div>`
        : '',
      Array.isArray(derived.edgeStates) && derived.edgeStates.length
        ? `<div class="operator-plan-detail"><span>EDGE STATE</span>${esc(derived.edgeStates.map((edge) => `${edge.from} -> ${edge.to}: ${edge.exists ? 'present' : 'missing'}`).join(' | '))}</div>`
        : '',
    ].join('');
  }

  if (plan.intent !== 'create_agent') {
    return [
      derived.requestText ? `<div class="operator-plan-detail"><span>REQUEST</span>${esc(derived.requestText)}</div>` : '',
      derived.agentId ? `<div class="operator-plan-detail"><span>AGENT</span>${esc(derived.agentId)}</div>` : '',
      derived.plannerModel ? `<div class="operator-plan-detail"><span>PLANNER MODEL</span>${esc(derived.plannerModel)}</div>` : '',
      operatorState.snapshot?.surfaces?.counts?.operatorExecutable != null
        ? `<div class="operator-plan-detail"><span>REGISTERED ACTIONS</span>${esc(String(operatorState.snapshot.surfaces.counts.operatorExecutable))}</div>`
        : '',
    ].join('');
  }

  return [
    derived.displayName ? `<div class="operator-plan-detail"><span>DISPLAY NAME</span>${esc(derived.displayName)}</div>` : '',
    derived.description ? `<div class="operator-plan-detail"><span>DESCRIPTION</span>${esc(derived.description)}</div>` : '',
    operatorState.snapshot?.surfaces?.counts?.operatorExecutable != null
      ? `<div class="operator-plan-detail"><span>REGISTERED ACTIONS</span>${esc(String(operatorState.snapshot.surfaces.counts.operatorExecutable))}</div>`
      : '',
    Array.isArray(derived.requestedSkills) && derived.requestedSkills.length
      ? `<div class="operator-plan-detail"><span>SKILLS</span>${esc(derived.requestedSkills.join(', '))}</div>`
      : '',
  ].join('');
}

function renderOperatorPlan() {
  const host = document.getElementById('operatorPlanContent');
  const planBtn = document.getElementById('operatorPlanBtn');
  const cancelBtn = document.getElementById('operatorCancelPlanBtn');
  const executeBtn = document.getElementById('operatorExecuteBtn');
  if (planBtn) {
    planBtn.disabled = operatorState.planning || operatorState.executing;
    planBtn.textContent = operatorState.planning ? 'PLANNING...' : 'PLAN';
  }
  if (cancelBtn) {
    cancelBtn.disabled = operatorState.executing || (!operatorState.planning && !operatorState.plan);
    cancelBtn.textContent = operatorState.planning
      ? 'CANCEL REQUEST'
      : operatorState.plan
        ? 'CLEAR PLAN'
        : 'CANCEL PLAN';
  }
  if (executeBtn) {
    executeBtn.disabled = operatorState.executing || operatorState.planning || !operatorState.plan || operatorState.canExecute !== true;
    executeBtn.textContent = operatorState.executing ? 'EXECUTING...' : 'EXECUTE';
  }
  if (!host) return;

  const plan = operatorState.plan;
  if (!plan) {
    host.innerHTML = buildOperatorAvailableActionsHtml();
    return;
  }

  const derived = plan.derived || {};
  const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  const limitations = Array.isArray(plan.limitations) ? plan.limitations : [];
  const assumptions = Array.isArray(plan.assumptions) ? plan.assumptions : [];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const summaryRows = buildOperatorPlanSummaryRows(plan, derived);
  const detailHtml = buildOperatorPlanDetails(plan, derived);

  host.innerHTML = `
    <div class="operator-plan-summary">
      ${summaryRows.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value || '--')}</strong></div>`).join('')}
    </div>
    <div class="operator-plan-text">${esc(plan.summary || '--')}</div>
    ${detailHtml}
    ${warnings.map((item) => `<div class="operator-note warning">${esc(item)}</div>`).join('')}
    ${limitations.map((item) => `<div class="operator-note limit">${esc(item)}</div>`).join('')}
    ${assumptions.map((item) => `<div class="operator-note">${esc(item)}</div>`).join('')}
    <div class="operator-step-list">
      ${steps.map((step, index) => `
        <div class="operator-step-card">
          <div class="operator-step-head">
            <span>${index + 1}. ${esc(step.title || step.surfaceId || 'step')}</span>
            <span>${esc(step.surfaceId || '--')}</span>
          </div>
          <div class="operator-step-body">${esc(step.summary || '--')}</div>
          <pre class="operator-step-payload">${esc(JSON.stringify(step.payload || {}, null, 2))}</pre>
        </div>
      `).join('')}
    </div>
  `;
}

async function loadOperatorSnapshot() {
  try {
    const token = operatorToken();
    const [snapshotRes, graphRes] = await Promise.all([
      fetch(`/watchdog/operator-snapshot?token=${encodeURIComponent(token)}&limit=20`),
      fetch(`/watchdog/graph?token=${encodeURIComponent(token)}`),
    ]);
    if (snapshotRes.ok) operatorState.snapshot = await snapshotRes.json();
    if (graphRes.ok) operatorState.graph = await graphRes.json();
    renderOperatorSummary();
    renderOperatorPlan();
  } catch (error) {
    console.warn('[operator] snapshot load failed:', error);
  }
}

function scheduleOperatorSnapshotRefresh(delayMs = 500) {
  if (!operatorState.open) return;
  if (operatorSnapshotRefreshTimer) clearTimeout(operatorSnapshotRefreshTimer);
  operatorSnapshotRefreshTimer = setTimeout(() => {
    operatorSnapshotRefreshTimer = null;
    loadOperatorSnapshot();
  }, delayMs);
}

export async function submitOperatorPlan() {
  ensureOperatorShell();
  if (operatorState.planning || operatorState.executing) return;
  const input = document.getElementById('operatorInput');
  const message = input?.value?.trim();
  if (!message) {
    operatorToast('Operator message required', 'error');
    return;
  }

  const currentPlan = buildOperatorPlannerCurrentPlan();
  operatorState.planning = true;
  clearCurrentOperatorPlan();
  pushOperatorMessage('user', message);
  renderOperatorConversation();
  renderOperatorPlan();
  operatorPlanAbortController = new AbortController();

  try {
    const token = operatorToken();
    const response = await fetch(`/watchdog/operator/plan?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: operatorPlanAbortController.signal,
      body: JSON.stringify({
        message,
        history: buildOperatorPlannerHistory(),
        currentPlan,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    operatorState.plan = payload.plan || null;
    operatorState.canExecute = payload.canExecute === true;
    pushOperatorMessage('assistant', payload.reply || 'Plan ready.', {
      warnings: payload.plan?.warnings,
      limitations: payload.plan?.limitations,
      assumptions: payload.plan?.assumptions,
    });
    renderOperatorConversation();
    renderOperatorPlan();
    await loadOperatorSnapshot();
    if (input) input.value = '';
  } catch (error) {
    if (error?.name === 'AbortError') {
      pushOperatorMessage('assistant', 'Operator planning request cancelled.');
      renderOperatorConversation();
      operatorToast('Operator planning cancelled', 'info');
    } else {
      operatorToast(`Operator planning failed: ${error.message}`, 'error');
    }
  } finally {
    operatorState.planning = false;
    operatorPlanAbortController = null;
    renderOperatorPlan();
  }
}

export function cancelOperatorPlanFromUI() {
  if (operatorState.executing) return;
  if (operatorState.planning) {
    operatorPlanAbortController?.abort();
    return;
  }
  if (!operatorState.plan) return;

  clearCurrentOperatorPlan();
  pushOperatorMessage('assistant', 'Current operator plan cleared.');
  renderOperatorConversation();
  renderOperatorPlan();
  operatorToast('Operator plan cleared', 'info');
}

export async function executeOperatorPlanFromUI() {
  if (!operatorState.plan || operatorState.canExecute !== true || operatorState.executing) return;
  operatorState.executing = true;
  renderOperatorPlan();
  try {
    const token = operatorToken();
    const response = await fetch(`/watchdog/operator/execute?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: operatorState.plan }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const stepText = Array.isArray(payload.results)
      ? payload.results.map((entry) => {
        const suffix = entry?.result?.skipped ? ' (skipped)' : '';
        return `${entry.surfaceId}${suffix}`;
      }).join(', ')
      : '';
    pushOperatorMessage('assistant', `\u6267\u884C\u5B8C\u6210\uFF1A${payload.summary || 'operator plan applied'}\u3002${stepText ? ` surfaces: ${stepText}.` : ''}`);
    operatorState.plan = payload.plan || null;
    operatorState.canExecute = false;
    renderOperatorConversation();
    renderOperatorPlan();
    await loadOperatorSnapshot();
    await loadAgentMeta();
    await loadGraph();
    operatorToast('Operator plan executed', 'success');
  } catch (error) {
    operatorToast(`Operator execute failed: ${error.message}`, 'error');
  } finally {
    operatorState.executing = false;
    renderOperatorPlan();
  }
}

export async function interruptOperatorLoopFromUI() {
  const activeLoopSession = getActiveLoopSession();
  if (!activeLoopSession) {
    operatorToast('No active loop session to interrupt', 'info');
    return;
  }
  if (operatorState.interruptingLoop) return;

  operatorState.interruptingLoop = true;
  renderOperatorSummary();
  try {
    const token = operatorToken();
    const payload = {
      reason: 'operator_manual_interrupt',
    };
    if (activeLoopSession.loopId) {
      payload.loopId = activeLoopSession.loopId;
    }

    const response = await fetch(`/watchdog/runtime/loop/interrupt?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    if (result.action !== 'interrupted') {
      throw new Error(result.error || result.action || 'interrupt rejected');
    }

    pushOperatorMessage(
      'assistant',
      `Loop interrupted: ${result.loopId || activeLoopSession.loopId || 'active loop'} @ ${result.interruptedStage || activeLoopSession.currentStage || 'current stage'}.`,
    );
    renderOperatorConversation();
    await loadOperatorSnapshot();
    await loadGraph();
    operatorToast('Active loop interrupted', 'success');
  } catch (error) {
    operatorToast(`Loop interrupt failed: ${error.message}`, 'error');
  } finally {
    operatorState.interruptingLoop = false;
    renderOperatorSummary();
  }
}

export function toggleOperatorWindow(forceOpen) {
  ensureOperatorShell();
  closeSettingsMenu();
  operatorState.open = typeof forceOpen === 'boolean' ? forceOpen : !operatorState.open;
  const shell = document.getElementById('operatorShell');
  if (shell) shell.classList.toggle('open', operatorState.open);
  document.body.classList.toggle('operator-open', operatorState.open);
  if (operatorState.open) {
    renderOperatorConversation();
    renderOperatorPlan();
    loadOperatorSnapshot();
    setTimeout(() => document.getElementById('operatorInput')?.focus(), 20);
  } else if (operatorSnapshotRefreshTimer) {
    clearTimeout(operatorSnapshotRefreshTimer);
    operatorSnapshotRefreshTimer = null;
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && operatorState.open) {
    toggleOperatorWindow(false);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    toggleOperatorWindow();
  }
  if (event.key === 'Enter' && !event.shiftKey && operatorState.open && document.activeElement?.id === 'operatorInput') {
    event.preventDefault();
    submitOperatorPlan();
  }
});

setTimeout(() => {
  ensureOperatorShell();
  renderOperatorConversation();
  renderOperatorPlan();
}, 0);

on('event:added', ({ type, data }) => {
  if (!operatorState.open) return;
  if (type === 'track_start' || type === 'track_end') {
    scheduleOperatorSnapshotRefresh();
    return;
  }
  if (type === 'alert' && [
    'graph_updated',
    'loop_started',
    'loop_advanced',
    'loop_concluded',
    'loop_interrupted',
    'loop_resumed',
    'system_reset',
    'dispatch_runtime_state',
  ].includes(data?.type)) {
    scheduleOperatorSnapshotRefresh();
  }
});
