// pages/inspect/index.js — 透视页组装：左树 + 右详三 Tab，store 单向数据流接线。
// 数据源：inspect.threads（树清单）/ inspect.run（run 详情+participants）/
// inspect.run_join（事件+证据+参与者全景，深链定位同一把钥匙）/
// inspect.trace（带锚点证据行，供时间线锚定对齐）/
// inspect.session_transcript（思考/文本 + 输出 Tab）/ inspect.session_system_prompt（六层）/
// inspect.contract_seal（输出 Tab 封条徽标）。
// live 中 run（join.run.closed !== true）轮询 5s 刷新，页面隐藏时暂停。
import {
  renderInspectLayout,
  renderTabBar,
  buildTreeModel,
  sessionIdFromParticipantFiles,
  resolveDeepLinkSelection,
} from "./inspect-page.js";
import { renderThreadTree } from "../../components/thread-tree.js";
import { buildTimelineEntries, renderRunTimeline } from "../../components/run-timeline.js";
import { renderPromptLayers } from "../../components/prompt-layers.js";
import { renderOutputPanel } from "../../components/output-panel.js";
import { esc } from "../../core/html.js";

const POLL_MS = 5000;
const THREAD_LIMIT = 50;

// join 结果的 traces 无锚点列（payload-only）；锚定行要经 inspect.trace 按 sessionKey 取。
// 并行取（Promise.all,多会话 run 不再逐个串行等待）;单会话失败/空仍只留白（导出供单测）。
export async function fetchAnchoredTraces(api, joinResult) {
  const sessionKeys = [...new Set((joinResult?.events || []).map((e) => e.sessionKey).filter(Boolean))];
  const results = await Promise.all(sessionKeys.map(async (sessionKey) => {
    try {
      const rows = await api.inspect("inspect.trace", { sessionKey });
      return Array.isArray(rows) && rows.length ? { sessionKey, rows } : null;
    } catch { return null; /* 单会话缺席只让该段留白 */ }
  }));
  return results.filter(Boolean);
}

export function mountInspectPage(host, { store, api, i18n, routeParams = {} }) {
  const page = document.createElement("div");
  page.className = "inspect-page";
  page.innerHTML = renderInspectLayout(i18n.t);
  host.appendChild(page);

  const slots = {
    grid: page.querySelector(".inspect-grid"),
    tree: page.querySelector('[data-slot="tree"]'),
    detail: page.querySelector('[data-slot="detail"]'),
  };

  // ── 数据装载（全部经 api 收口，写 store）──
  async function loadThreads() {
    try {
      const result = await api.inspect("inspect.threads", { limit: THREAD_LIMIT });
      store.patch({ inspectThreads: result?.threads || [], inspectError: null });
    } catch (e) {
      store.patch({ inspectError: e?.message || String(e) });
    }
  }

  async function loadRunDetail(threadId) {
    const state = store.get();
    const thread = (state.inspectThreads || []).find((th) => th.threadId === threadId);
    if (!thread?.latestRunId) return;
    try {
      const detail = await api.inspect("inspect.run", { threadId, runId: thread.latestRunId });
      const runDetails = { ...(store.get().inspectRunDetails || {}) };
      runDetails[threadId] = detail;
      store.patch({ inspectRunDetails: runDetails });
    } catch { /* 单 thread 详情失败不拖垮整树 */ }
  }

  async function loadJoin(query) {
    store.patch({ inspectLoading: true });
    try {
      const join = await api.inspect("inspect.run_join", query);
      if (!join || join.found === false) {
        store.patch({ inspectLoading: false, inspectJoin: null, inspectError: null });
        return null;
      }
      const traces = await fetchAnchoredTraces(api, join);
      const { threadId, runId } = join.target;
      // 事件并进 runDetails，供树状态点（failed 检测）使用
      const runDetails = { ...(store.get().inspectRunDetails || {}) };
      runDetails[threadId] = { ...(runDetails[threadId] || {}), found: true, run: join.run, events: join.events,
        participants: join.participants };
      // 正在看的 run 其所属 thread 自动展开，树里能看到该 run/agent 子级高亮（深链/脉搏跳转同理）。
      const expanded = store.get().inspectExpandedThreads || [];
      store.patch({
        inspectLoading: false,
        inspectError: null,
        inspectJoin: { ...join, anchoredTraces: traces },
        inspectRunDetails: runDetails,
        inspectSelected: { type: "run", threadId, runId },
        inspectExpandedThreads: expanded.includes(threadId) ? expanded : [...expanded, threadId],
      });
      return join;
    } catch (e) {
      store.patch({ inspectLoading: false, inspectError: e?.message || String(e) });
      return null;
    }
  }

  // prompt/output 两个 Tab 的数据源：选中 agent 的 session。
  async function loadSessionData() {
    const { inspectJoin: join, inspectAgentId } = store.get();
    if (!join) return;
    const participants = join.participants || [];
    const participant = participants.find((p) => p.agentId === inspectAgentId) || participants[0];
    if (!participant) return;
    const agentId = participant.agentId;
    const sessionId = sessionIdFromParticipantFiles(participant.sessionTranscripts);
    if (!sessionId) {
      store.patch({ inspectPrompt: null, inspectTranscript: null, inspectSeal: null, inspectAgentId: agentId });
      return;
    }
    const contractId = participant.outboxes?.[0]?.contractId || participant.inboxes?.[0]?.contractId || null;
    const [prompt, transcript, seal] = await Promise.all([
      api.inspect("inspect.session_system_prompt", { agentId, sessionId }).catch(() => null),
      api.inspect("inspect.session_transcript", { agentId, sessionId }).catch(() => null),
      contractId ? api.inspect("inspect.contract_seal", { contractId }).catch(() => null) : null,
    ]);
    store.patch({ inspectPrompt: prompt, inspectTranscript: transcript, inspectSeal: seal, inspectAgentId: agentId });
  }

  // ── 渲染（store 只读）──
  function render() {
    const state = store.get();
    const threads = state.inspectThreads || [];
    const selected = state.inspectSelected || null;
    const treeCollapsed = state.inspectTreeCollapsed === true;
    slots.grid?.classList.toggle("tree-collapsed", treeCollapsed);
    const treeHtml = renderThreadTree(
      {
        ...buildTreeModel({
          threads,
          runDetails: state.inspectRunDetails || {},
          selected,
          expandedThreads: state.inspectExpandedThreads || [],
        }),
        collapsed: treeCollapsed,
      },
      i18n.t,
    );

    const tab = state.inspectTab || "timeline";
    let detail = renderTabBar(tab, i18n.t);
    if (state.inspectLoading) {
      detail += `<div class="insp-state">${esc(i18n.t("state.loading"))}</div>`;
    } else if (state.inspectError) {
      detail += `<div class="insp-state insp-error">${esc(i18n.t("state.error", { msg: state.inspectError }))}</div>`;
    } else if (!selected) {
      detail += `<div class="insp-state">${esc(i18n.t("inspect.detail.empty"))}</div>`;
    } else if (tab === "timeline") {
      const join = state.inspectJoin;
      const entries = join
        ? buildTimelineEntries({
            events: join.events || [],
            traces: join.anchoredTraces || [],
            transcriptMessages: state.inspectTranscript?.messages || [],
            transcriptAgentId: state.inspectAgentId || null, // 思考归属=选中 agent
          })
        : [];
      detail += renderRunTimeline(
        {
          entries,
          mode: state.inspectMode || "snapshot",
          expandedKey: state.inspectExpandedKey || null,
          highlightAgentId: state.inspectFocusAgentId || null, // 只有显式选 agent 才聚焦;选 r- 退出
        },
        i18n.t,
      );
    } else if (tab === "prompt") {
      detail += renderPromptLayers(
        { report: state.inspectPrompt, openLayer: state.inspectOpenLayer || null, openFile: state.inspectOpenFile || null },
        i18n.t,
      );
    } else {
      detail += renderOutputPanel(
        {
          producedFiles: state.inspectTranscript?.producedFiles || null,
          delivery: state.inspectTranscript?.delivery || null,
          seal: state.inspectSeal || null,
          openFile: state.inspectOpenFile || null,
        },
        i18n.t,
      );
    }
    // 脏检查:内容未变则不重建 DOM——避免 live run 5s 轮询把整块 innerHTML 反复重建,
    // 既省重排又让入场动画只在真正变化时播(否则每次轮询都闪一下,正是要治的「生硬」)。
    if (slots.tree._html !== treeHtml) {
      slots.tree.innerHTML = treeHtml;
      slots.tree._html = treeHtml;
    }
    if (slots.detail._html !== detail) {
      slots.detail.innerHTML = detail;
      slots.detail._html = detail;
    }
  }

  // ── 事件委托（data-action，禁止 onclick 字符串桥）──
  function onClick(event) {
    const target = event.target.closest?.("[data-action]");
    if (!target || !page.contains(target)) return;
    const action = target.getAttribute("data-action");
    if (action === "select-node") {
      const type = target.getAttribute("data-node-type");
      const threadId = target.getAttribute("data-thread-id");
      const runId = target.getAttribute("data-run-id");
      const agentId = target.getAttribute("data-agent-id");
      if (type === "thread") {
        // 点 thread（含折叠细轨的点）：选中 + 切该 thread 展开（细轨点先 un-collapse 再展开）。
        // 从细轨点进来时该 thread 未在展开集里 → 直接展开；已展开则收起（再点收起）。
        const expanded = store.get().inspectExpandedThreads || [];
        const railClick = store.get().inspectTreeCollapsed === true;
        const willExpand = railClick || !expanded.includes(threadId);
        const nextExpanded = willExpand
          ? [...new Set([...expanded, threadId])]
          : expanded.filter((id) => id !== threadId);
        store.patch({
          inspectSelected: { type: "thread", threadId },
          inspectTreeCollapsed: false,
          inspectExpandedThreads: nextExpanded,
          inspectFocusAgentId: null, // 选 thread → 退出 agent 聚焦
        });
        if (willExpand) loadRunDetail(threadId);
      } else if (type === "run" || type === "agent") {
        // 聚焦态由 inspectFocusAgentId 单独承载(不复用 inspectAgentId——那个被 loadSessionData/轮询改):
        //   选 agent → 聚焦它;选 run(r-) → 退出聚焦回全局 run 视图。
        if (type === "agent" && agentId) {
          store.patch({ inspectAgentId: agentId, inspectFocusAgentId: agentId });
        } else {
          store.patch({ inspectFocusAgentId: null });
        }
        const currentJoin = store.get().inspectJoin;
        const sameRunLoaded = currentJoin?.target?.runId === runId && currentJoin?.found !== false;
        if (sameRunLoaded) {
          // 同 run 已加载：只切 agent 高亮 + 重取会话数据，不整块重拉 join（免闪烁/免丢展开态）。
          store.patch({
            inspectSelected: type === "agent"
              ? { type: "agent", threadId, runId, agentId }
              : { type: "run", threadId, runId },
          });
          loadSessionData();
        } else if (runId) {
          loadJoin({ runId }).then(() => {
            if (type === "agent" && agentId) {
              store.patch({ inspectSelected: { type: "agent", threadId, runId, agentId } });
            }
            loadSessionData();
          });
        }
      }
    } else if (action === "toggle-tree") {
      store.patch({ inspectTreeCollapsed: !store.get().inspectTreeCollapsed });
    } else if (action === "set-tab") {
      store.patch({ inspectTab: target.getAttribute("data-tab") });
    } else if (action === "set-mode") {
      store.patch({ inspectMode: target.getAttribute("data-mode") });
    } else if (action === "toggle-entry") {
      const key = target.getAttribute("data-entry-key");
      store.patch({ inspectExpandedKey: store.get().inspectExpandedKey === key ? null : key });
    } else if (action === "toggle-layer") {
      const layer = target.getAttribute("data-layer");
      store.patch({ inspectOpenLayer: store.get().inspectOpenLayer === layer ? null : layer });
    } else if (action === "toggle-file" || action === "toggle-output-file") {
      const file = target.getAttribute("data-file");
      store.patch({ inspectOpenFile: store.get().inspectOpenFile === file ? null : file });
    }
  }
  document.addEventListener("click", onClick);

  const unsubscribe = store.subscribe((state, changed) => {
    if (changed.some((k) => k.startsWith("inspect"))) render();
  });

  // ── live run 轮询（页面可见时；closed 即停刷）+ 回页立即补一轮（同指挥台对账纪律）──
  function pollTick() {
    if (typeof document !== "undefined" && document.hidden) return;
    const { inspectJoin: join, inspectSelected: selected } = store.get();
    if (join && join.run?.closed !== true && selected?.runId) {
      loadJoin({ runId: selected.runId }).then(() => loadSessionData());
    }
  }
  const pollTimer = setInterval(pollTick, POLL_MS);
  function onVisibility() {
    if (!document.hidden) pollTick();
  }
  document.addEventListener("visibilitychange", onVisibility);

  // ── 深链：#/inspect?run=<id>（脉搏卡/哨兵证据/工作项的跳转目标）──
  const deepLink = resolveDeepLinkSelection(routeParams);
  loadThreads().then(() => {
    if (deepLink) {
      loadJoin({ runId: deepLink.id }).then((join) => {
        if (join) {
          loadRunDetail(join.target.threadId);
          loadSessionData();
        }
      });
    }
  });

  render();

  return () => {
    unsubscribe();
    clearInterval(pollTimer);
    document.removeEventListener("click", onClick);
    document.removeEventListener("visibilitychange", onVisibility);
    page.remove();
  };
}
