// dashboard-i18n.js — Internationalization: language packs, translation, date formatting

export const LANG_PACKS = {
  'en-US': {
    // Header
    'header.title': 'OpenClaw // Mission Control',
    'header.subtitle': 'Multi-Agent System Monitor v6.0',
    'header.connecting': 'CONNECTING...',
    'header.stream_active': 'STREAM ACTIVE',
    'header.reconnecting': 'RECONNECTING...',
    'header.port': 'PORT',

    // Stats bar
    'stats.active': 'ACTIVE',
    'stats.work_items': 'WORK ITEMS',
    'stats.completed': 'COMPLETED',
    'stats.queue': 'QUEUE',
    'stats.pool': 'POOL',
    'stats.events': 'EVENTS',
    'stats.uptime': 'UPTIME',

    // Nav
    'nav.home': 'HOME',
    'nav.agents': 'AGENTS',
    'nav.work_items': 'WORK ITEMS',
    'nav.harness': 'SHAPING SUITE',
    'nav.test_tools': 'TEST TOOLS',

    // Panels
    'panel.work_item_lifecycle': 'WORK ITEM LIFECYCLE',
    'panel.dispatch_pipeline': 'DISPATCH PIPELINE',
    'panel.event_stream': 'EVENT STREAM // LIVE',
    'panel.no_work_items': 'NO ACTIVE WORK ITEMS',
    'panel.awaiting': 'AWAITING DISPATCH...',

    // Edit mode
    'edit.mode': 'EDIT MODE',
    'edit.quit': 'QUIT EDIT MODE',
    'edit.add_agent': '+ AGENT',
    'edit.reset_layout': 'RESET LAYOUT',
    'edit.model': 'MODEL',

    // Tooltip
    'tip.model': 'MODEL',
    'tip.role': 'ROLE',
    'tip.state': 'STATE',
    'tip.signal': 'SIGNAL',
    'tip.last_seen': 'LAST SEEN',
    'tip.tools': 'TOOLS',
    'tip.status': 'STATUS',

    // States
    'state.running': 'RUNNING',
    'state.idle': 'IDLE',
    'state.error': 'ERROR',
    'state.delivering': 'DELIVERING',
    'state.dispatching': 'DISPATCHING',
    'state.unhealthy': 'UNHEALTHY',
    'state.offline': 'OFFLINE',
    'state.fresh': 'FRESH',
    'state.active': 'ACTIVE',
    'state.stale': 'STALE',
    'state.unseen': 'UNSEEN',

    // Toast
    'toast.edit_mode': 'EDIT MODE',
    'toast.view_mode': 'VIEW MODE',
    'toast.select_agent': 'SELECT AN AGENT NODE',
    'toast.link_canceled': 'LINK CANCELED',
    'toast.copied': 'Copied',
    'toast.no_models': 'No models loaded',
    'toast.model_failed': 'Model change failed',
    'toast.edit_first': 'Switch to Edit mode first',

    // Settings
    'settings.title': 'SETTINGS',
    'settings.runtime_operator': 'RUNTIME OPERATOR',
    'settings.test_tools': 'TEST TOOLS',

    // Dialog
    'dialog.new_agent': 'NEW AGENT',
    'dialog.create': 'CREATE',
    'dialog.cancel': 'CANCEL',
    'dialog.agent_id': 'ID',
    'dialog.confirm_reset': 'RESET: Clear all sessions, work items, and queue?',
    'dialog.confirm_delete': 'DELETE "{id}"?\nRemoves from openclaw.json.',

    // Graph
    'graph.click_hint': 'CLICK SOURCE \u00B7 CLICK TARGET',
    'graph.edge_exists': 'EDGE EXISTS',
    'graph.loop_detected': 'LOOP DETECTED',
    'graph.delete_edge': 'DELETE EDGE',

    // Loop states
    'loop.active': 'LOOP ACTIVE',
    'loop.broken': 'LOOP BROKEN',
    'loop.ready': 'LOOP READY',
    'loop.registered': 'LOOP REGISTERED',

    // Events
    'event.system': 'SYSTEM',
    'event.session_started': 'session started',

    // Placeholder pages
    'page.coming_soon': 'COMING SOON',
    'page.under_construction': 'This module is under construction.',
    'page.agents_title': 'OpenClaw // Agents',
    'page.agents_subtitle': 'Agent Overview & Configuration',
    'page.work_items_title': 'OpenClaw // Work Items',
    'page.work_items_subtitle': 'Lifecycle Work Item Management',
    'page.harness_title': 'OpenClaw // Shaping Suite',
    'page.harness_subtitle': 'Shaping Atlas & Execution Placement',
    'page.back_dashboard': 'BACK TO DASHBOARD',

    // Context menu
    'ctx.copy_id': 'COPY ID',
    'ctx.change_model': 'CHANGE MODEL',
    'ctx.delete': 'DELETE',

    // Devtools
    'devtools.title': 'OpenClaw // Test Tools',
    'devtools.subtitle': 'Isolated Tests, Change Sets & Platform Management Map',
  },

  'zh-CN': {
    // Header
    'header.title': 'OpenClaw // \u4EFB\u52A1\u63A7\u5236',
    'header.subtitle': '\u591A Agent \u7CFB\u7EDF\u76D1\u63A7 v6.0',
    'header.connecting': '\u8FDE\u63A5\u4E2D...',
    'header.stream_active': '\u6D41\u5DF2\u8FDE\u63A5',
    'header.reconnecting': '\u91CD\u8FDE\u4E2D...',
    'header.port': '\u7AEF\u53E3',

    // Stats bar
    'stats.active': '\u6D3B\u8DC3',
    'stats.work_items': '\u5DE5\u4F5C\u9879',
    'stats.completed': '\u5DF2\u5B8C\u6210',
    'stats.queue': '\u961F\u5217',
    'stats.pool': '\u6C60',
    'stats.events': '\u4E8B\u4EF6',
    'stats.uptime': '\u8FD0\u884C\u65F6\u95F4',

    // Nav
    'nav.home': '\u4E3B\u9875',
    'nav.agents': '\u4EE3\u7406',
    'nav.work_items': '\u5DE5\u4F5C\u9879',
    'nav.harness': '\u5851\u5F62\u5957\u4EF6',
    'nav.test_tools': '\u6D4B\u8BD5\u5DE5\u5177',

    // Panels
    'panel.work_item_lifecycle': '\u5DE5\u4F5C\u9879\u751F\u547D\u5468\u671F',
    'panel.dispatch_pipeline': '\u8C03\u5EA6\u7BA1\u7EBF',
    'panel.event_stream': '\u4E8B\u4EF6\u6D41 // \u5B9E\u65F6',
    'panel.no_work_items': '\u65E0\u6D3B\u8DC3\u5DE5\u4F5C\u9879',
    'panel.awaiting': '\u7B49\u5F85\u8C03\u5EA6...',

    // Edit mode
    'edit.mode': '\u7F16\u8F91\u6A21\u5F0F',
    'edit.quit': '\u9000\u51FA\u7F16\u8F91',
    'edit.add_agent': '+ \u4EE3\u7406',
    'edit.reset_layout': '\u91CD\u7F6E\u5E03\u5C40',
    'edit.model': '\u6A21\u578B',

    // Tooltip
    'tip.model': '\u6A21\u578B',
    'tip.role': '\u89D2\u8272',
    'tip.state': '\u72B6\u6001',
    'tip.signal': '\u4FE1\u53F7',
    'tip.last_seen': '\u6700\u540E\u89C1',
    'tip.tools': '\u5DE5\u5177',
    'tip.status': '\u72B6\u6001',

    // States
    'state.running': '\u8FD0\u884C\u4E2D',
    'state.idle': '\u7A7A\u95F2',
    'state.error': '\u9519\u8BEF',
    'state.delivering': '\u4EA4\u4ED8\u4E2D',
    'state.dispatching': '\u8C03\u5EA6\u4E2D',
    'state.unhealthy': '\u4E0D\u5065\u5EB7',
    'state.offline': '\u79BB\u7EBF',
    'state.fresh': '\u65B0\u9C9C',
    'state.active': '\u6D3B\u8DC3',
    'state.stale': '\u8FC7\u65F6',
    'state.unseen': '\u672A\u89C1',

    // Toast
    'toast.edit_mode': '\u7F16\u8F91\u6A21\u5F0F',
    'toast.view_mode': '\u67E5\u770B\u6A21\u5F0F',
    'toast.select_agent': '\u8BF7\u70B9\u51FB\u4E00\u4E2A Agent \u8282\u70B9',
    'toast.link_canceled': '\u8FDE\u63A5\u5DF2\u53D6\u6D88',
    'toast.copied': '\u5DF2\u590D\u5236',
    'toast.no_models': '\u672A\u52A0\u8F7D\u6A21\u578B',
    'toast.model_failed': '\u6A21\u578B\u5207\u6362\u5931\u8D25',
    'toast.edit_first': '\u8BF7\u5148\u5207\u6362\u5230\u7F16\u8F91\u6A21\u5F0F',

    // Settings
    'settings.title': '\u8BBE\u7F6E',
    'settings.runtime_operator': '\u8FD0\u884C\u65F6\u64CD\u4F5C',
    'settings.test_tools': '\u6D4B\u8BD5\u5DE5\u5177',

    // Dialog
    'dialog.new_agent': '\u65B0\u5EFA\u4EE3\u7406',
    'dialog.create': '\u521B\u5EFA',
    'dialog.cancel': '\u53D6\u6D88',
    'dialog.agent_id': 'ID',
    'dialog.confirm_reset': '\u91CD\u7F6E\uFF1A\u6E05\u9664\u6240\u6709\u4F1A\u8BDD\u3001\u5DE5\u4F5C\u9879\u548C\u961F\u5217\uFF1F',
    'dialog.confirm_delete': '\u5220\u9664 "{id}"\uFF1F\n\u5C06\u4ECE openclaw.json \u4E2D\u79FB\u9664\u3002',

    // Graph
    'graph.click_hint': '\u70B9\u51FB\u6E90\u8282\u70B9 \u00B7 \u70B9\u51FB\u76EE\u6807',
    'graph.edge_exists': '\u8FB9\u5DF2\u5B58\u5728',
    'graph.loop_detected': '\u68C0\u6D4B\u5230\u5FAA\u73AF',
    'graph.delete_edge': '\u5220\u9664\u8FB9',

    // Loop states
    'loop.active': '\u5FAA\u73AF\u6D3B\u8DC3',
    'loop.broken': '\u5FAA\u73AF\u4E2D\u65AD',
    'loop.ready': '\u5FAA\u73AF\u5C31\u7EEA',
    'loop.registered': '\u5FAA\u73AF\u5DF2\u6CE8\u518C',

    // Events
    'event.system': '\u7CFB\u7EDF',
    'event.session_started': '\u4F1A\u8BDD\u5DF2\u542F\u52A8',

    // Placeholder pages
    'page.coming_soon': '\u5373\u5C06\u5230\u6765',
    'page.under_construction': '\u8BE5\u6A21\u5757\u6B63\u5728\u5EFA\u8BBE\u4E2D\u3002',
    'page.agents_title': 'OpenClaw // \u4EE3\u7406\u603B\u89C8',
    'page.agents_subtitle': 'Agent \u6982\u89C8\u4E0E\u914D\u7F6E',
    'page.work_items_title': 'OpenClaw // \u5DE5\u4F5C\u9879\u7BA1\u7406',
    'page.work_items_subtitle': '\u5DE5\u4F5C\u9879\u751F\u547D\u5468\u671F\u7BA1\u7406',
    'page.harness_title': 'OpenClaw // \u5851\u5F62\u5957\u4EF6',
    'page.harness_subtitle': '\u5851\u5F62\u56FE\u8C31\u4E0E\u6267\u884C\u843D\u70B9\u89C6\u56FE',
    'page.back_dashboard': '\u8FD4\u56DE\u4E3B\u63A7\u9762',

    // Context menu
    'ctx.copy_id': '\u590D\u5236 ID',
    'ctx.change_model': '\u5207\u6362\u6A21\u578B',
    'ctx.delete': '\u5220\u9664',

    // Devtools
    'devtools.title': 'OpenClaw // \u6D4B\u8BD5\u5DE5\u5177',
    'devtools.subtitle': '\u72EC\u7ACB\u6D4B\u8BD5\u3001\u53D8\u66F4\u96C6\u4E0E\u5E73\u53F0\u7BA1\u7406',
  },
};

let _currentLang = null;

export function getCurrentLang() {
  if (_currentLang) return _currentLang;
  try { _currentLang = localStorage.getItem('openclaw-lang'); } catch {}
  if (!_currentLang || !LANG_PACKS[_currentLang]) _currentLang = 'zh-CN';
  return _currentLang;
}

export function setLang(lang) {
  if (!LANG_PACKS[lang]) return;
  _currentLang = lang;
  try { localStorage.setItem('openclaw-lang', lang); } catch {}
}

export function t(key, params) {
  const lang = getCurrentLang();
  let text = LANG_PACKS[lang]?.[key] ?? LANG_PACKS['en-US']?.[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, v);
    }
  }
  return text;
}

export function formatDateTime(ts) {
  if (!ts) return '--';
  const lang = getCurrentLang();
  const locale = lang === 'zh-CN' ? 'zh-CN' : 'en-US';
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString(locale);
  }
}

export function initI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
}
