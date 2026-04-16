// dashboard-ux.js — Edit mode, toast, tooltip, context menu, model picker, agent CRUD
import { esc, shortModel, toast } from './dashboard-common.js';
import { emit } from './dashboard-bus.js';
import { agentMeta, agentState, addEvent, loadAgentMeta, getAgentAvailability, getAgentVisualStatus, formatLastSeen } from './dashboard.js';
import { eid, savedPositions, nodePositions } from './dashboard-svg.js';
import { ROLE_SUGGESTIONS } from './dashboard-agent-role-input.js';
import { buildAgentDeleteConfirmation, resolveAgentRemovalAction } from './dashboard-agent-management-actions.js';

// ── UX state ──
export let allModels = [];
export let activeModelPicker = null;
export let activeContextMenu = null;
export let activeTooltip = null;
export let activeTooltipAgent = null;

// ── Close tooltip on outside click ──
document.addEventListener('click', (e) => {
  if (OC.ux.editMode) return;
  if (activeTooltip && !e.target.closest('.node-tooltip') && !e.target.closest('.pipeline-node')) {
    hideTooltip();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EDIT MODE
// ══════════════════════════════════════════════════════════════════════════════

export function toggleEditMode() {
  OC.ux.editMode = !OC.ux.editMode;
  document.body.classList.toggle('edit-mode', OC.ux.editMode);
  const btn = document.getElementById('editModeBtn');
  if (btn) { btn.textContent = OC.ux.editMode ? 'QUIT EDIT MODE' : 'EDIT MODE'; btn.classList.toggle('active', OC.ux.editMode); }
  hideTooltip();
  closeContextMenu();
  closeModelPicker();
  if (!OC.ux.editMode) {
    if (typeof OC.graph.clearGraphSelection === 'function') OC.graph.clearGraphSelection({ silent: true });
    exitModelSelectMode();
  }
  toast(OC.ux.editMode ? 'EDIT MODE' : 'VIEW MODE', OC.ux.editMode ? 'warn' : 'success');
  emit('editmode:toggled', { editMode: OC.ux.editMode });
}

// ══════════════════════════════════════════════════════════════════════════════
// MODEL SWITCH (toolbar button)
// ══════════════════════════════════════════════════════════════════════════════

export function startModelSwitch() {
  if (!OC.ux.editMode) { toast('Switch to Edit mode first', 'info'); return; }
  window._modelSwitchPending = true;
  document.body.classList.add('model-select-mode');
  const banner = document.getElementById('modelSelectBanner');
  if (banner) banner.style.display = 'inline-block';
  toast('CLICK A NODE TO CHANGE ITS MODEL', 'info');
}

export function exitModelSelectMode() {
  window._modelSwitchPending = false;
  document.body.classList.remove('model-select-mode');
  const banner = document.getElementById('modelSelectBanner');
  if (banner) banner.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOLTIP
// ══════════════════════════════════════════════════════════════════════════════

export function showTooltip(agentId) {
  hideTooltip();
  const meta = agentMeta[agentId];
  if (!meta) return;
  const pos = nodePositions[agentId];
  if (!pos) return;
  const state = agentState[agentId];
  const svg = document.getElementById('pipelineSvg');
  const ctm = svg.getScreenCTM();
  const svgRect = svg.getBoundingClientRect();

  const tip = document.createElement('div');
  tip.className = 'node-tooltip';
  const availability = getAgentAvailability(agentId);
  const visualStatus = getAgentVisualStatus(agentId);
  const stateLabel = visualStatus === 'running'
    ? 'RUNNING'
    : visualStatus === 'error'
      ? 'ERROR'
      : 'IDLE';
  const freshnessLabel = availability === 'offline'
    ? 'STALE'
    : availability === 'standby'
      ? 'UNSEEN'
      : availability === 'busy'
        ? 'ACTIVE'
        : 'FRESH';

  let h = `<div class="tip-header">${esc(agentId.toUpperCase())}</div>`;
  h += `<div class="tip-row"><span class="tip-label">MODEL</span>${esc(meta.model || '-')}</div>`;
  h += `<div class="tip-row"><span class="tip-label">ROLE</span>${esc(meta.role || '-')}</div>`;
  h += `<div class="tip-row"><span class="tip-label">STATE</span>${esc(stateLabel)}</div>`;
  h += `<div class="tip-row"><span class="tip-label">SIGNAL</span>${esc(freshnessLabel)}</div>`;
  h += `<div class="tip-row"><span class="tip-label">LAST SEEN</span>${esc(formatLastSeen(agentId))}</div>`;
  if (meta.description) h += `<div class="tip-desc">${esc(meta.description)}</div>`;
  if (meta.capabilities?.tools) h += `<div class="tip-row"><span class="tip-label">TOOLS</span>${esc(meta.capabilities.tools.join(', '))}</div>`;
  if (state?.status === 'running') {
    h += `<div class="tip-row tip-active"><span class="tip-label">STATUS</span>RUNNING`;
    if (state.toolCallCount) h += ` (#${state.toolCallCount})`;
    h += `</div>`;
  }
  tip.innerHTML = h;

  // Position right of node
  let left = ctm.e + (pos.x + pos.w + 8) * ctm.a - svgRect.left;
  let top = ctm.f + pos.y * ctm.d - svgRect.top;

  const wrap = document.querySelector('.pipeline-wrap');
  wrap.style.position = 'relative';
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  wrap.appendChild(tip);
  activeTooltip = tip;
  activeTooltipAgent = agentId;

  // Adjust if off-screen (all edges)
  requestAnimationFrame(() => {
    const r = tip.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) tip.style.left = (left - pos.w - r.width - 16) + 'px';
    if (r.bottom > window.innerHeight - 8) tip.style.top = (top - (r.bottom - window.innerHeight) - 12) + 'px';
    if (r.left < 8) tip.style.left = '8px';
    if (r.top < 8) tip.style.top = '8px';
    tip.classList.add('show');
  });
}

export function hideTooltip() {
  if (!activeTooltip) return;
  const tip = activeTooltip;
  activeTooltip = null;
  activeTooltipAgent = null;
  tip.classList.remove('show');
  tip.addEventListener('transitionend', () => tip.remove(), { once: true });
  setTimeout(() => { if (tip.parentNode) tip.remove(); }, 300);
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT MENU (right-click)
// ══════════════════════════════════════════════════════════════════════════════

export function showContextMenu(e, agentId) {
  closeContextMenu(); closeModelPicker(); hideTooltip();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const items = [
    { label:'COPY ID', action: () => { navigator.clipboard.writeText(agentId); toast('Copied: ' + agentId); } },
  ];
  if (OC.ux.editMode) {
    items.push(
      { label:'CHANGE MODEL', action: () => { const el = document.getElementById(eid(agentId).model); if (el) openModelPicker(agentId, el); } },
      { sep: true },
      { label:'DELETE', danger: true, action: () => removeAgent(agentId, 'delete') },
      { label:'HARD DELETE', danger: true, action: () => removeAgent(agentId, 'hard_delete') },
    );
  }

  for (const item of items) {
    if (item.sep) { const s = document.createElement('div'); s.className = 'context-menu-sep'; menu.appendChild(s); continue; }
    const el = document.createElement('div');
    el.className = 'context-menu-item' + (item.danger ? ' danger' : '');
    el.textContent = item.label;
    el.addEventListener('click', () => { closeContextMenu(); item.action(); });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  });

  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

export function closeContextMenu() {
  if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// MODEL HOT-SWAP
// ══════════════════════════════════════════════════════════════════════════════

export async function loadModels() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try { const r = await fetch(`/watchdog/models?token=${encodeURIComponent(token)}`); if (r.ok) allModels = await r.json(); } catch {}
}

export function openModelPicker(agentId, anchorEl) {
  if (!OC.ux.editMode) { toast('Switch to Edit mode first', 'info'); return; }
  closeModelPicker();
  if (!allModels.length) { toast('No models loaded', 'error'); return; }

  const svg = document.getElementById('pipelineSvg');
  const svgRect = svg.getBoundingClientRect();
  const bbox = anchorEl.getBBox();
  const ctm = anchorEl.getScreenCTM();

  const picker = document.createElement('div');
  picker.className = 'model-picker';
  picker.style.left = (ctm.e + bbox.x * ctm.a - svgRect.left) + 'px';
  picker.style.top = (ctm.f + bbox.y * ctm.d + bbox.height * ctm.d - svgRect.top + 4) + 'px';

  for (const m of allModels) {
    const opt = document.createElement('div');
    opt.className = 'model-picker-item';
    opt.textContent = m.name || m.id;
    opt.addEventListener('click', () => changeModel(agentId, `${m.provider}/${m.id}`, anchorEl));
    picker.appendChild(opt);
  }

  const wrap = document.querySelector('.pipeline-wrap');
  wrap.style.position = 'relative';
  wrap.appendChild(picker);
  activeModelPicker = picker;
  setTimeout(() => document.addEventListener('click', closeModelPicker, { once: true }), 0);
}

export function closeModelPicker() {
  if (activeModelPicker) { activeModelPicker.remove(); activeModelPicker = null; }
  exitModelSelectMode();
}

async function changeModel(agentId, model, textEl) {
  if (!OC.ux.editMode) { toast('Switch to Edit mode first', 'info'); return; }
  closeModelPicker();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const r = await fetch(`/watchdog/agents/model?token=${encodeURIComponent(token)}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ agentId, model }),
    });
    if (r.ok) {
      textEl.textContent = shortModel(model);
      toast(`${agentId} -> ${shortModel(model)}`, 'success');
      addEvent('alert', { type:'model_changed', agentId, model });
    } else { toast('Model change failed', 'error'); }
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADD / DELETE AGENTS (edit-mode only)
// ══════════════════════════════════════════════════════════════════════════════

export function showAddAgentDialog() {
  if (!OC.ux.editMode) { toast('Switch to Edit mode first', 'info'); return; }
  closeModelPicker(); closeContextMenu();
  const old = document.getElementById('addAgentDialog');
  if (old) { old.remove(); return; }

  const d = document.createElement('div');
  d.id = 'addAgentDialog';
  d.className = 'agent-dialog';
  const roleOptions = ROLE_SUGGESTIONS.map((role) => {
    const selected = role === 'executor' ? ' selected' : '';
    return `<option value="${role}"${selected}>${role.toUpperCase()}</option>`;
  }).join('');
  d.innerHTML = `
    <div class="agent-dialog-title">NEW AGENT</div>
    <label>ID <input id="newAgentId" placeholder="worker-e" /></label>
    <label>MODEL <select id="newAgentModel">${allModels.map(m =>
      `<option value="${m.provider}/${m.id}">${m.name||m.id}</option>`).join('')}</select></label>
    <label>ROLE <select id="newAgentRole">${roleOptions}</select></label>
    <div class="agent-dialog-actions">
      <button onclick="createAgent()">CREATE</button>
      <button onclick="document.getElementById('addAgentDialog').remove()">CANCEL</button>
    </div>`;
  document.body.appendChild(d);
  document.getElementById('newAgentId').focus();
}

export async function createAgent() {
  const id = document.getElementById('newAgentId').value.trim();
  const model = document.getElementById('newAgentModel').value;
  const role = document.getElementById('newAgentRole').value;
  if (!id) { toast('Agent ID required', 'error'); return; }
  document.getElementById('addAgentDialog')?.remove();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const r = await fetch(`/watchdog/agents/create?token=${encodeURIComponent(token)}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id, model, role }),
    });
    if (r.ok) { toast(`Agent "${id}" created`, 'success'); addEvent('alert',{type:'agent_created',agentId:id}); loadAgentMeta(); }
    else { const e = await r.json(); toast('Failed: '+(e.error||'unknown'), 'error'); }
  } catch (e) { toast('Failed: '+e.message, 'error'); }
}

async function removeAgent(agentId, mode = 'delete') {
  const action = resolveAgentRemovalAction(mode, agentId);
  if (!confirm(buildAgentDeleteConfirmation(agentId, action.mode))) return;
  const token = new URLSearchParams(window.location.search).get('token') || '';
  try {
    const r = await fetch(`${action.path}?token=${encodeURIComponent(token)}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ agentId, explicitConfirm:true }),
    });
    if (r.ok) {
      toast(action.successToast, 'success');
      addEvent('alert',{type:action.eventType,agentId});
      delete savedPositions[agentId];
      try { localStorage.setItem('openclaw-node-layout', JSON.stringify(savedPositions)); } catch {}
      loadAgentMeta();
    } else { const e = await r.json(); toast('Failed: '+(e.error||'unknown'), 'error'); }
  } catch (e) { toast('Failed: '+e.message, 'error'); }
}
