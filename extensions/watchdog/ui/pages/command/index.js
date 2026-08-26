// pages/command/index.js — 指挥台组装：三栏 + 读数带 + 日志抽屉，store 单向数据流接线。
// 数据节拍沿用旧主页语义（dashboard.js:411-423, 706-712）：
// work-items 快照轮询 15s（隐藏页暂停），SSE 事件（track_start/track_end/派工/泵终局）即时刷；
// graph+runtime 同节拍轮询，graph_dispatch/track_progress 驱动 flows 与脉搏卡。
import { renderCommandPage } from "./command-page.js";
import { renderStatStrip } from "../../components/stat-strip.js";
import { renderWorkItemList } from "../../components/work-item-list.js";
import { createGraphBoard } from "./graph-board-controller.js";
import { renderPulseColumn, renderLogDrawer, evaluateSentinels } from "../../components/pulse-column.js";
import { createEventStream } from "../../core/api.js";

const POLL_MS = 15000;
const FLOW_TTL_MS = 5000;
const EVENT_CAP = 200;
const SIGNAL_CAP = 100;

function resolveRunKey(data) {
  return data?.runId || data?.contractId || data?.sessionKey || null;
}

function summarizeEvent(type, data) {
  const parts = [type];
  const id = resolveRunKey(data) || data?.agentId || data?.type || "";
  if (id) parts.push(String(id));
  return parts.join(" ");
}

// 实时对账修剪（纯函数，导出供单测）：SSE 是增量（断线窗口错过的 track_end 永不重发），
// /watchdog/runtime 的 trackingSessions 是活跃真值——runs 里不在活跃集的条目滞留即修剪。
// 键形对齐（实测 lib/store/tracker-store.js snapshotTrackingSessions + sse.js buildProgressPayload）：
//   runs 键 = resolveRunKey(track payload) = contractId | sessionKey（payload 无 runId 字段）；
//   trackingSessions 键 = sessionKey，值.workItemId = 合约 id —— 两族并入活跃集。
// protectSinceTs 竞态护栏：poll 取样后才被 SSE upsert 过的条目（lastSeen 更新）本轮豁免，下轮再对账。
export function pruneRunsAgainstTracking(runs = {}, trackingSessions = {}, { protectSinceTs = Infinity } = {}) {
  const active = new Set(Object.keys(trackingSessions));
  for (const session of Object.values(trackingSessions)) {
    if (session?.workItemId) active.add(session.workItemId);
  }
  const next = {};
  let changed = false;
  for (const [key, run] of Object.entries(runs)) {
    if (active.has(key) || (run?.lastSeen ?? 0) > protectSinceTs) next[key] = run;
    else changed = true;
  }
  return changed ? next : runs;
}

export function mountCommandPage(host, { store, api, i18n }) {
  const page = renderCommandPage({ i18n });
  host.appendChild(page);

  const slots = {
    stats: page.querySelector('[data-slot="stat-strip"]'),
    workItems: page.querySelector('[data-slot="work-items"]'),
    graph: page.querySelector('[data-slot="graph"]'),
    pulse: page.querySelector('[data-slot="pulse"]'),
    drawer: page.querySelector('[data-slot="log-drawer"]'),
  };

  // 编排图：拖动/连线编辑自管（订阅 store 自渲染），页面 render 不再碰 graph 槽。
  const board = createGraphBoard({ container: slots.graph, api, store, i18n, buildModel: buildGraphModel });

  // ── 派生模型 ──
  function buildGraphModel(state) {
    const targets = state.runtime?.dispatchRuntime?.targets || {};
    const outgoing = state.runtime?.dispatchRuntime?.outgoingBySource || {};
    const busyAgents = new Set(
      Object.values(state.runs || {}).map((r) => r.agentId).filter(Boolean),
    );
    for (const [id, rt] of Object.entries(targets)) {
      if (rt?.busy || rt?.dispatching) busyAgents.add(id);
    }
    const queues = {};
    for (const entries of Object.values(outgoing)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const target = entry?.targetAgent;
        if (target) queues[target] = (queues[target] || 0) + 1;
      }
    }
    const now = Date.now();
    return {
      nodes: (state.graph?.nodes || []).map((n) => ({
        id: n.id,
        role: n.role,
        status: busyAgents.has(n.id) ? "active" : "idle",
      })),
      edges: state.graph?.edges || [],
      flows: (state.flows || []).filter((f) => now - f.ts <= FLOW_TTL_MS),
      queues,
      cycles: state.graph?.cycles || [],
    };
  }

  function buildSentinels(state) {
    const dismissed = new Set(state.dismissedSentinels || []);
    const queueDepth = (state.workItems || []).filter(
      (item) => item.status === "pending" || item.status === "draft",
    ).length;
    return evaluateSentinels({ ...(state.sentinelSignals || {}), queueDepth })
      .filter((s) => !dismissed.has(s.id));
  }

  // 脏检查:内容未变则不重建 DOM。SSE/轮询高频写 store,不加这层会每次全量重刷 4 个槽
  // (即使内容一样)→ 重排闪动 + 丢交互态。与透视页同一套治闪动逻辑(2026-08-26)。
  function paint(slot, html) {
    if (slot._html !== html) {
      slot.innerHTML = html;
      slot._html = html;
    }
  }

  function render() {
    const state = store.get();
    const sentinels = buildSentinels(state);
    const items = state.workItems || [];
    paint(slots.stats, renderStatStrip({
      active: Object.keys(state.runs || {}).length,
      queue: items.filter((i) => i.status === "pending" || i.status === "draft").length,
      done: items.filter((i) => i.status === "completed").length,
      alert: sentinels.length,
      events: (state.events || []).length,
      uptime: state.connected ? "ON" : "OFF",
    }, i18n.t));
    paint(slots.workItems, renderWorkItemList(items, i18n.t));
    // 编排图由 board 控制器自渲染（订阅 store），此处不碰 graph 槽
    paint(slots.pulse, renderPulseColumn({ runs: Object.values(state.runs || {}), sentinels }, i18n.t));
    paint(slots.drawer, renderLogDrawer({ events: state.events || [], open: state.drawerOpen === true }, i18n.t));
  }

  // ── store 变更驱动重渲染（单向：SSE/轮询只写 store）──
  const unsubscribe = store.subscribe(render);

  // ── 轮询（快照即真相，全量替换；隐藏页暂停）──
  async function pollAll() {
    if (typeof document !== "undefined" && document.hidden) return;
    const pollStartTs = Date.now();
    try {
      const [workItems, graph, runtime] = await Promise.all([
        api.getJson("/watchdog/work-items").catch(() => null),
        api.getJson("/watchdog/graph").catch(() => null),
        api.getJson("/watchdog/runtime").catch(() => null),
      ]);
      const patch = {};
      if (Array.isArray(workItems)) patch.workItems = workItems;
      if (graph && typeof graph === "object") patch.graph = { nodes: graph.nodes || [], edges: graph.edges || [] };
      if (runtime && typeof runtime === "object") {
        patch.runtime = runtime;
        // runs 对账：SSE 只做增量，轮询真值（trackingSessions）修剪滞留脉搏卡
        // （断线窗口错过 track_end 的卡不再永久挂运行区）。
        const runsNow = store.get().runs || {};
        const pruned = pruneRunsAgainstTracking(runsNow, runtime.trackingSessions || {}, { protectSinceTs: pollStartTs });
        if (pruned !== runsNow) patch.runs = pruned;
      }
      if (Object.keys(patch).length) store.patch(patch);
    } catch { /* 单帧失败下轮重试 */ }
  }
  const pollTimer = setInterval(pollAll, POLL_MS);
  pollAll();

  // 回页即对账：隐藏页暂停轮询，切回可见立即补一轮（否则最长干等 15s 才见真相）。
  function onVisibility() {
    if (!document.hidden) pollAll();
  }
  document.addEventListener("visibilitychange", onVisibility);

  // ── flows TTL 到期主动剪枝重渲 ──
  // TTL 只在渲染时过滤的话,最后一次交接动画会滞留到下个 SSE/轮询才消失;
  // 到期把过期 flow 从 store 剪掉(patch 触发重渲),剩余的再排下一枪。
  let flowPruneTimer = null;
  function scheduleFlowPrune() {
    clearTimeout(flowPruneTimer);
    const flows = store.get().flows || [];
    if (!flows.length) { flowPruneTimer = null; return; }
    const nextExpiry = Math.min(...flows.map((f) => f.ts + FLOW_TTL_MS));
    flowPruneTimer = setTimeout(() => {
      const now = Date.now();
      store.patch({ flows: (store.get().flows || []).filter((f) => now - f.ts <= FLOW_TTL_MS) });
      scheduleFlowPrune();
    }, Math.max(0, nextExpiry - Date.now()) + 20);
  }

  // ── SSE 接线 ──
  function pushEvent(type, data) {
    const events = [{ type, text: summarizeEvent(type, data), ts: Date.now() }, ...(store.get().events || [])];
    store.patch({ events: events.slice(0, EVENT_CAP) });
  }

  function upsertRun(data) {
    const runId = resolveRunKey(data);
    if (!runId) return;
    const runs = { ...(store.get().runs || {}) };
    const prev = runs[runId] || {};
    runs[runId] = {
      runId,
      agentId: data.agentId || prev.agentId || "",
      lastTool: data.lastLabel ?? prev.lastTool ?? "",
      progress: Number.isFinite(data.pct) ? data.pct : prev.progress ?? 0,
      elapsedMs: data.elapsedMs ?? prev.elapsedMs ?? 0,
      lastSeen: Date.now(), // 对账竞态护栏：poll 取样后仍有心跳的条目本轮不剪
    };
    store.patch({ runs });
  }

  function dropRun(data) {
    const runId = resolveRunKey(data);
    if (!runId) return;
    const runs = { ...(store.get().runs || {}) };
    delete runs[runId];
    store.patch({ runs });
  }

  // SSE 重连补课：断线窗口错过的事件不重发，重连成功即整轮对账（增量靠 SSE，真值靠轮询）。
  let sseWasDown = false;
  const stream = createEventStream({
    token: apiToken(api),
    handlers: {
      connected: () => store.patch({ connected: true }),
      heartbeat: () => {},
      track_start: (data) => { upsertRun(data); pushEvent("track_start", data); pollAll(); },
      track_progress: (data) => upsertRun(data),
      track_end: (data) => { dropRun(data); pushEvent("track_end", data); pollAll(); },
      graph_dispatch: (data) => {
        if (data?.from && data?.to) {
          const flows = [...(store.get().flows || []), {
            from: data.from, to: data.to,
            label: data.contractId || resolveRunKey(data) || "",
            ts: Date.now(),
          }];
          store.patch({ flows: flows.filter((f) => Date.now() - f.ts <= FLOW_TTL_MS) });
          scheduleFlowPrune();
        }
        pushEvent("graph_dispatch", data);
      },
      run_event: (data) => pushEvent("run_event", data),
      alert: (data) => {
        pushEvent("alert", data);
        // 哨兵信号采集（refused 尖峰 / error 族 / 链尖报警）；窗口裁剪在 evaluateSentinels。
        // 深链上下文一并保留：runId/sessionKey/contractId——哨兵「查看证据」靠它定位 #/inspect。
        // SSE 发端缺列即 null（实测多数 alert 带 contractId，role_policy_rejected 只有 source），不造假。
        const signals = { ...(store.get().sentinelSignals || {}) };
        const entry = {
          ts: Date.now(),
          type: data?.type || "unknown",
          runId: data?.runId ?? null,
          sessionKey: data?.sessionKey ?? null,
          contractId: data?.contractId ?? null,
        };
        const append = (key) => {
          signals[key] = [...(signals[key] || []), entry].slice(-SIGNAL_CAP);
        };
        if (data?.type === "system_action_role_policy_rejected" || data?.refused === true) {
          append("refused");
        }
        append("alerts");
        if (data?.type === "execution_hard_stop_warning") {
          append("chainTips");
        }
        store.patch({ sentinelSignals: signals });
        // 派工/阶段计划/泵终局 = 工作项事实源 → 即时刷快照
        if (["inbox_dispatch", "contract_stage_plan_updated", "delivery_pump_completed", "delivery_pump_exhausted"].includes(data?.type)) {
          pollAll();
        }
        if (data?.type === "system_reset") pollAll();
      },
    },
    onStatus: (status) => {
      store.patch({ connected: status === "open" });
      if (status === "reconnecting") {
        sseWasDown = true;
      } else if (status === "open" && sseWasDown) {
        sseWasDown = false;
        pollAll(); // 重连补课：断线窗口的 track_end/派工快照一次对齐
      }
    },
  });

  // ── 事件委托（data-action，禁止 onclick 字符串桥）──
  function onClick(event) {
    const target = event.target.closest?.("[data-action]");
    if (!target || !page.contains(target)) return;
    const action = target.getAttribute("data-action");
    if (action === "open-run") {
      const runId = target.getAttribute("data-run-id");
      if (runId) window.location.hash = `#/inspect?run=${encodeURIComponent(runId)}`;
    } else if (action === "open-work-item") {
      const id = target.getAttribute("data-work-item-id");
      if (id) window.location.hash = `#/inspect?wi=${encodeURIComponent(id)}`;
    } else if (action === "toggle-drawer") {
      store.patch({ drawerOpen: store.get().drawerOpen !== true });
    } else if (action === "sentinel-dismiss") {
      const id = target.getAttribute("data-sentinel-id");
      if (id) store.patch({ dismissedSentinels: [...(store.get().dismissedSentinels || []), id] });
    } else if (action === "sentinel-evidence") {
      // 证据深链：有 run → #/inspect?run=；只有合约 → #/inspect?wi=（深链早已支持两把钥匙）。
      // 无目标的按钮由 pulse-column 渲染为 disabled，点击到不了这里——不再裸跳 #/inspect 占位。
      const run = target.getAttribute("data-target-run");
      const wi = target.getAttribute("data-target-wi");
      if (run) window.location.hash = `#/inspect?run=${encodeURIComponent(run)}`;
      else if (wi) window.location.hash = `#/inspect?wi=${encodeURIComponent(wi)}`;
    }
  }
  document.addEventListener("click", onClick);

  render();

  return () => {
    unsubscribe();
    clearInterval(pollTimer);
    clearTimeout(flowPruneTimer);
    stream.close();
    document.removeEventListener("click", onClick);
    document.removeEventListener("visibilitychange", onVisibility);
    board.destroy(); // 图板自持 window pointermove/up/keydown + store 订阅,卸载必须显式清理,否则每次切区/切语言无界累积
    page.remove();
  };
}

// api 对象不暴露 token 字段——token 只经 location.search 单源读取（沿用旧 getToken 语义）。
function apiToken() {
  return new URLSearchParams(window.location.search).get("token") || "";
}
