// pages/inspect/inspect-page.js — 透视页布局 + 纯函数模型装配。
// 布局：左树槽位 + 右详槽位（Tab 条 + 内容）。装配/推导纯函数可单测，wiring 在 index.js。
import { esc } from "../../core/html.js";

// 三 Tab：timeline 默认 / prompt 提示词装配 / output 输出。
export const INSPECT_TABS = Object.freeze(["timeline", "prompt", "output"]);

export function renderInspectLayout(t) {
  return `<h1 class="inspect-title">${esc(t("inspect.title"))}</h1>`
    + `<div class="inspect-grid">`
    + `<section class="col-tree" data-slot="tree"></section>`
    + `<section class="col-detail" data-slot="detail"></section>`
    + `</div>`;
}

export function renderTabBar(activeTab, t) {
  const tabs = INSPECT_TABS.map((tab) => {
    const cls = tab === activeTab ? "insp-tab active" : "insp-tab";
    return `<button type="button" class="${cls}" data-action="set-tab" data-tab="${tab}">${esc(t(`inspect.tab.${tab}`))}</button>`;
  }).join("");
  return `<div class="insp-tabs">${tabs}</div>`;
}

// run 状态推导：run.json 投影 closed=true → done（有失败类事件 → failed）；
// 投影缺席/未关账 → running（事件账仍是真值，投影滞后合法）。
export function deriveRunStatus(run, events = []) {
  const failed = (events || []).some((e) => typeof e?.type === "string" && e.type.includes("fail"));
  if (run && run.closed === true) return failed ? "failed" : "done";
  return failed ? "failed" : "running";
}

// participants 文件名 → sessionId：session-<sid>.jsonl（跳过 .prompt.json sidecar 与 turn-*）。
export function sessionIdFromParticipantFiles(names = []) {
  for (const name of names) {
    if (typeof name !== "string") continue;
    if (name.endsWith(".prompt.json")) continue;
    const m = name.match(/^session-(.+)\.jsonl$/);
    if (m) return m[1];
  }
  return null;
}

// 树模型装配：threads 根清单 + 已加载的 runDetail → thread-tree 组件模型。
// 每 thread 独立展开门（expandedThreads 集）：折叠 → runs=null（只出 thread 行 + caret ▸）；
// 展开且详情已加载 → 铺开 latestRun 与 agents（caret ▾）。展开但详情未到位 → expanded=true/runs=null
// （caret ▾，正文异步补齐后重渲染）。整树折叠成细轨（collapsed）是另一层，宿主页处理。
// （inspect.threads 只给最新 run 的锚；历史 run 清单留给后续批次的 run 分页。）
export function buildTreeModel({ threads = [], runDetails = {}, selected = null, expandedThreads = [] } = {}) {
  const expandedSet = new Set(expandedThreads);
  return {
    selected,
    threads: (threads || []).map((thread) => {
      const expanded = expandedSet.has(thread.threadId);
      const detail = runDetails[thread.threadId];
      const loaded = !!(detail && detail.found === true && thread.latestRunId);
      // 详情未加载 → unknown 中性态(灰点),不谎报 done;failed/running 判定只在 loaded 后。
      const status = loaded ? deriveRunStatus(detail.run, detail.events || []) : "unknown";
      const runs = (expanded && loaded)
        ? [{
            runId: thread.latestRunId,
            status,
            agents: (detail.participants || []).map((p) => ({ agentId: p.agentId, status })),
          }]
        : null;
      return { threadId: thread.threadId, runCount: thread.runCount, status, expanded, runs };
    }),
  };
}

// 深链解析：#/inspect?run=<id>（脉搏卡/哨兵证据）与 ?wi=<id>（工作项，id=contractId）
// 都是 inspect.run_join 的钥匙，统一成 run 选中意图，由 index.js 调 surface 定位。
export function resolveDeepLinkSelection(params = {}) {
  const id = params.run || params.wi || null;
  return id ? { type: "run", id: String(id) } : null;
}
