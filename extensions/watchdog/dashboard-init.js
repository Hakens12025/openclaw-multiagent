// dashboard-init.js — Entry module: imports all modules, runs init chain, bridges window.* for HTML onclick
import { on, off, emit } from './dashboard-bus.js';
import { esc, shortModel, getToken, toast } from './dashboard-common.js';
import { t, getCurrentLang, setLang, initI18n, formatDateTime } from './dashboard-i18n.js';
import { renderNav } from './dashboard-nav.js';
import {
  agentState, workItems, agentMeta, dispatchRuntimeState, dispatchQueueState,
  renderWorkItems, renderEventStream, connectSSE, loadWorkItems, loadAgentMeta,
  systemReset, toggleSettingsMenu, closeSettingsMenu, openDevtools, addEvent, toggleBlock,
} from './dashboard.js';
import {
  nodePositions, svgEl, eid, buildPipelineSVG, calcEdgePath, dynamicWorkers,
} from './dashboard-svg.js';
import { resetLayout } from './dashboard-drag.js';
import {
  toggleEditMode, showAddAgentDialog, startModelSwitch, showTooltip, openModelPicker,
  hideTooltip, createAgent,
} from './dashboard-ux.js';
import { updatePipeline } from './dashboard-pipeline.js';
import { graphEdges, loadGraph, clearGraphSelection } from './dashboard-graph.js';
import {
  toggleOperatorWindow,
  submitOperatorPlan,
  cancelOperatorPlanFromUI,
  executeOperatorPlanFromUI,
  interruptOperatorLoopFromUI,
} from './dashboard-operator.js';

// ── OC namespace (set up by inline script in HTML, fill it here) ──
window.OC = window.OC || { on, off, emit, state: {}, svg: {}, ux: {}, graph: {} };
Object.assign(OC, { on, off, emit });
OC.ux.editMode = false;
Object.assign(OC.state, { agentState, workItems, agentMeta, dispatchRuntimeState, dispatchQueueState });
Object.assign(OC.svg, { nodePositions, svgEl, eid, buildPipelineSVG, calcEdgePath });
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
window.closeSettingsMenu = closeSettingsMenu;
window.openDevtools = openDevtools;
window.setLang = setLang;
window.toggleBlock = toggleBlock;
window.createAgent = createAgent;

// ── Init chain (runs after all scripts loaded via module resolution) ──
console.log('[oc:init] dashboard modules loaded, starting init chain...');
try {
  renderNav();
  initI18n();
  renderWorkItems();
  renderEventStream();
  updatePipeline();
  connectSSE();
  loadWorkItems();
  loadAgentMeta();
  setInterval(loadWorkItems, 30000);
  console.log('[oc:init] init chain complete');
} catch (e) {
  console.error('[oc:init] FATAL:', e);
  document.body.style.background = '#1a1a2e';
  document.body.style.color = '#e94560';
  document.body.innerHTML = '<pre style="padding:2em;font-size:14px">[DASHBOARD INIT FAILED]\n' + e.stack + '</pre>';
}
