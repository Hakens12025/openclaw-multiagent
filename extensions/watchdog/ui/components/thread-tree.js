// components/thread-tree.js — 透视页左树：thread → run → agent 三级（纯渲染）。
// 两层折叠互不干扰：
//   ① 整树折叠成细轨（collapsed）——展开态全树 + ‹收起；折叠态只留状态点竖排 + ›展开。
//   ② 单 thread 展开/收起（thread.expanded）——caret ▸/▾，收起时不铺 run/agent 子级。
// 点任一细轨点/thread 头 = 选中该 thread + 切该 thread 展开（un-collapse / toggle 在宿主页 onClick 收口）。
// 节点状态点：running=蓝 / done=暖黑 / failed=砖红 / unknown=灰(未加载,中性)（CSS 类 status-*，色值在 tokens）。
// 交互走 data-action="select-node"（data-node-type=thread|run|agent）+ "toggle-tree"，宿主页事件委托。
import { esc } from "../core/html.js";

function isSelected(selected, type, ids) {
  if (!selected || selected.type !== type) return false;
  return (!ids.threadId || selected.threadId === ids.threadId)
    && (!ids.runId || selected.runId === ids.runId)
    && (!ids.agentId || selected.agentId === ids.agentId);
}

function statusOf(node) {
  // 未知/缺失状态一律落 unknown 中性灰,不谎报 done。
  return ["running", "done", "failed", "unknown"].includes(node?.status) ? node.status : "unknown";
}

// 文件管理器式连线（纯渲染层，从数组位置算 isLast，不改 buildTreeModel）：
//   祖先列 cont=true → 整行高竖线 │（该祖先还有后续兄弟，线要续下去）；cont=false → 空列（末支下方留白）。
//   本节点分支列 → ├（非末项,竖线贯穿续接下一兄弟）或 └（末项,竖线止于中点）+ 横臂。
// 连线用 CSS 伪元素画（连续、丝滑），box 字仅作类名语义。ancestorContinues 顺序 = 从最外层到父级。
function renderGuides(ancestorContinues, isLast) {
  let inner = "";
  for (const cont of ancestorContinues) inner += `<span class="tt-guide${cont ? " cont" : ""}"></span>`;
  inner += `<span class="tt-guide tt-branch${isLast ? " last" : " through"}"></span>`;
  return `<span class="tt-guides" aria-hidden="true">${inner}</span>`;
}

function renderAgentNode(agent, ids, selected, agentIsLast, runIsLast) {
  const cls = isSelected(selected, "agent", { ...ids, agentId: agent.agentId }) ? " selected" : "";
  // 祖先列 = run 级：run 非末项则竖线续下去（cont），否则留白。分支列 = agent 自身末项判定。
  return `<div class="tt-node tt-depth-3${cls}" data-action="select-node" data-node-type="agent"`
    + ` data-thread-id="${esc(ids.threadId)}" data-run-id="${esc(ids.runId)}" data-agent-id="${esc(agent.agentId)}">`
    + renderGuides([!runIsLast], agentIsLast)
    + `<span class="tt-dot status-${statusOf(agent)}"></span><span class="tt-label">${esc(agent.agentId)}</span></div>`;
}

function renderRunNode(run, threadId, selected, runIsLast) {
  const ids = { threadId, runId: run.runId };
  const cls = isSelected(selected, "run", ids) ? " selected" : "";
  // run 挂在 thread（根）下，只有自身分支列（无祖先竖线列）。
  let html = `<div class="tt-node tt-depth-2${cls}" data-action="select-node" data-node-type="run"`
    + ` data-thread-id="${esc(threadId)}" data-run-id="${esc(run.runId)}">`
    + renderGuides([], runIsLast)
    + `<span class="tt-dot status-${statusOf(run)}"></span><span class="tt-label">${esc(run.runId)}</span></div>`;
  const agents = run.agents || [];
  agents.forEach((agent, i) => {
    html += renderAgentNode(agent, ids, selected, i === agents.length - 1, runIsLast);
  });
  return html;
}

function renderThreadNode(thread, selected) {
  const cls = isSelected(selected, "thread", { threadId: thread.threadId }) ? " selected" : "";
  const expanded = thread.expanded === true;
  // caret 折叠标：▾ 展开 / ▸ 收起。点 thread 头 = 切展开（宿主页 onClick 收口）。
  const caret = expanded ? "▾" : "▸";
  let html = `<div class="tt-node tt-depth-1 tt-thread${expanded ? " tt-expanded" : ""}${cls}"`
    + ` data-action="select-node" data-node-type="thread" data-thread-id="${esc(thread.threadId)}"`
    + ` aria-expanded="${expanded}">`
    + `<span class="tt-caret" aria-hidden="true">${caret}</span>`
    + `<span class="tt-dot status-${statusOf(thread)}"></span><span class="tt-label">${esc(thread.threadId)}</span>`
    + `<span class="tt-run-count">${thread.runCount ?? 0}</span></div>`;
  if (expanded) {
    const runs = thread.runs || [];
    runs.forEach((run, i) => {
      html += renderRunNode(run, thread.threadId, selected, i === runs.length - 1);
    });
  }
  // 整个 thread(头 + 展开的 run/agent)包成一组:虚线分隔只落在「组与组之间」(=t- 之间),
  // 组内 run/agent 之间不再有虚线(见 thread-tree.css .tt-group)。
  return `<div class="tt-group">${html}</div>`;
}

// 折叠细轨：展开按钮 + 每 thread 一个状态点（点=展开并选中）。
function renderRail(threads, selected, t) {
  let body = `<button type="button" class="tt-rail-toggle" data-action="toggle-tree"`
    + ` title="${esc(t("inspect.tree.expand"))}" aria-label="${esc(t("inspect.tree.expand"))}">›</button>`;
  for (const thread of threads) {
    const sel = isSelected(selected, "thread", { threadId: thread.threadId })
      || (selected && selected.threadId === thread.threadId);
    body += `<button type="button" class="tt-rail-dot${sel ? " selected" : ""}" data-action="select-node"`
      + ` data-node-type="thread" data-thread-id="${esc(thread.threadId)}"`
      + ` title="${esc(thread.threadId)}"><span class="tt-dot status-${statusOf(thread)}"></span></button>`;
  }
  return `<div class="thread-tree tt-rail">${body}</div>`;
}

export function renderThreadTree(model = {}, t) {
  const { threads = [], selected = null, collapsed = false } = model;
  if (collapsed) return renderRail(threads, selected, t);

  const head = `<div class="tt-head">`
    + `<span class="tt-title">${esc(t("inspect.tree.title"))}</span>`
    + `<button type="button" class="tt-collapse" data-action="toggle-tree"`
    + ` title="${esc(t("inspect.tree.collapse"))}" aria-label="${esc(t("inspect.tree.collapse"))}">‹</button>`
    + `</div>`;
  if (!threads.length) {
    return `<div class="thread-tree">${head}<div class="tt-empty">${esc(t("inspect.tree.empty"))}</div></div>`;
  }
  let body = "";
  for (const thread of threads) {
    body += renderThreadNode(thread, selected);
  }
  return `<div class="thread-tree">${head}${body}</div>`;
}
