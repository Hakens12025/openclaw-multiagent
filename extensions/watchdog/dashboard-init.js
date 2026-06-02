// dashboard-init.js — Entry module: imports all modules, runs init chain, bridges window.* for HTML onclick
import { on, off, emit } from './dashboard-bus.js';
import { setLang, initI18n } from './dashboard-i18n.js';
import { renderNav } from './dashboard-nav.js';
import {
  agentState, workItems, agentMeta, dispatchRuntimeState,
  renderWorkItems, renderEventStream, connectSSE, loadWorkItems, loadAgentMeta, loadDispatchRuntimeState,
  systemReset, toggleSettingsMenu, closeSettingsMenu, openDevtools, toggleBlock,
} from './dashboard.js';
import {
  nodePositions, svgEl, eid, buildRuntimeGraphSVG, calcEdgePath,
} from './dashboard-svg.js';
import { resetLayout } from './dashboard-drag.js';
import {
  toggleEditMode, showAddAgentDialog, startModelSwitch, showTooltip, openModelPicker,
  createAgent,
} from './dashboard-ux.js';
import { updateRuntimeGraph } from './dashboard-runtime-graph.js';
import { graphEdges, loadGraph, clearGraphSelection } from './dashboard-graph.js';
import {
  toggleOperatorWindow,
  submitOperatorPlan,
  cancelOperatorPlanFromUI,
  executeOperatorPlanFromUI,
  interruptOperatorLoopFromUI,
  switchOperatorSessionFromUI,
  newOperatorSessionFromUI,
} from './dashboard-operator.js';

// ── OC namespace (set up by inline script in HTML, fill it here) ──
window.OC = window.OC || { on, off, emit, state: {}, svg: {}, ux: {}, graph: {} };
Object.assign(OC, { on, off, emit });
OC.ux.editMode = false;
Object.assign(OC.state, { agentState, workItems, agentMeta, dispatchRuntimeState });
Object.assign(OC.svg, { nodePositions, svgEl, eid, buildRuntimeGraphSVG, calcEdgePath });
Object.assign(OC.ux, { toggleEditMode, showTooltip, openModelPicker });
Object.assign(OC.graph, { graphEdges, loadGraph, clearGraphSelection });

// ── HTML onclick bridge ──
window.toggleEditMode = toggleEditMode;
window.showAddAgentDialog = showAddAgentDialog;
window.startModelSwitch = startModelSwitch;
window.resetLayout = resetLayout;
window.systemReset = systemReset;
window.toggleSettingsMenu = toggleSettingsMenu;
window.toggleOperatorWindow = toggleOperatorWindow;
window.submitOperatorPlan = submitOperatorPlan;
window.cancelOperatorPlanFromUI = cancelOperatorPlanFromUI;
window.executeOperatorPlanFromUI = executeOperatorPlanFromUI;
window.interruptOperatorLoopFromUI = interruptOperatorLoopFromUI;
window.switchOperatorSessionFromUI = switchOperatorSessionFromUI;
window.newOperatorSessionFromUI = newOperatorSessionFromUI;
window.closeSettingsMenu = closeSettingsMenu;
window.openDevtools = openDevtools;
window.setLang = setLang;
window.toggleBlock = toggleBlock;
window.createAgent = createAgent;

// ── Init chain (runs after all scripts loaded via module resolution) ──
console.log('[oc:init] dashboard modules loaded, starting init chain...');
function reportDashboardInitError(error) {
  const detail = error?.stack || error?.message || String(error || 'unknown error');
  let panel = document.getElementById('dashboardInitError');
  if (!panel) {
    panel = document.createElement('pre');
    panel.id = 'dashboardInitError';
    panel.setAttribute('role', 'alert');
    panel.style.cssText = [
      'position:fixed',
      'left:16px',
      'right:16px',
      'bottom:16px',
      'z-index:99999',
      'max-height:34vh',
      'overflow:auto',
      'padding:14px 16px',
      'border-radius:10px',
      'background:rgba(26,26,46,0.96)',
      'color:#ff6b81',
      'font-size:12px',
      'line-height:1.45',
      'box-shadow:0 18px 48px rgba(0,0,0,0.35)',
    ].join(';');
    document.body.appendChild(panel);
  }
  panel.textContent = `[DASHBOARD INIT FAILED]\n${detail}`;
}

try {
  renderNav();
  initI18n();
  renderWorkItems();
  renderEventStream();
  updateRuntimeGraph();
  connectSSE();
  loadWorkItems();
  loadAgentMeta();
  loadDispatchRuntimeState();
  setInterval(loadWorkItems, 30000);
  console.log('[oc:init] init chain complete');
} catch (e) {
  console.error('[oc:init] FATAL:', e);
  reportDashboardInitError(e);
}
