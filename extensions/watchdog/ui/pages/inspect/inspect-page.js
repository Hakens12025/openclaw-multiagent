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

// ── 执行模型（合约正本 executionModels 的透视投影）──
// 数据：inspect.run 的 detail.contracts.executionModels = { contractId: { agentId: "provider/model" } }，
// 稀疏——只有已执行过的合约才有键，旧数据/未执行合约缺席（缺席 → 空数组 → 整块不渲染）。
// 同 run 门：树只挂各 thread 最新 run 的详情，深链却可能选中更早的 run —— runId 不一致就不显示，
// 宁可缺块也不让别的 run 的模型串台（detail.runId 由 readRunDetail 恒返回）。
// 组内/组间都保持后端给的顺序（executionModels 的键序=盖章先后=执行先后，比字母序更可读）。
export function buildExecutionModelGroups(detail, runId = null) {
  if (!runId || !detail || detail.runId !== runId) return [];
  const models = detail.contracts?.executionModels;
  if (!models || typeof models !== "object") return [];
  return Object.keys(models)
    .map((contractId) => {
      const perAgent = models[contractId] || {};
      const rows = Object.keys(perAgent)
        .filter((agentId) => typeof perAgent[agentId] === "string" && perAgent[agentId].trim())
        .map((agentId) => ({ agentId, model: perAgent[agentId].trim() }));
      return { contractId, short: String(contractId).slice(-6), rows };
    })
    .filter((group) => group.rows.length > 0);
}

// 执行模型读数条：每合约一组（尾号 chip 呼应时间线 .tl-contract），组内每行 agentId → provider/model。
// 空组 → 空串（不出空壳、不出占位文案）。模型值本身是数据，不入 i18n 键表。
export function renderExecutionModels(groups = [], t) {
  if (!Array.isArray(groups) || !groups.length) return "";
  const body = groups.map((group) => {
    const rows = group.rows.map((row) => `<div class="insp-exec-row">`
      + `<span class="insp-exec-agent">${esc(row.agentId)}</span>`
      + `<span class="insp-exec-arrow" aria-hidden="true">→</span>`
      + `<span class="insp-exec-model">${esc(row.model)}</span>`
      + `</div>`).join("");
    return `<div class="insp-exec-group">`
      + `<span class="insp-exec-cid" title="${esc(group.contractId)}">${esc(group.short)}</span>`
      + `<div class="insp-exec-rows">${rows}</div></div>`;
  }).join("");
  return `<section class="insp-exec">`
    + `<div class="insp-exec-head">${esc(t("inspect.exec.title"))}</div>${body}</section>`;
}

// 深链解析：#/inspect?run=<id>（脉搏卡/哨兵证据）与 ?wi=<id>（工作项，id=contractId）
// 都是 inspect.run_join 的钥匙，统一成 run 选中意图，由 index.js 调 surface 定位。
export function resolveDeepLinkSelection(params = {}) {
  const id = params.run || params.wi || null;
  return id ? { type: "run", id: String(id) } : null;
}
