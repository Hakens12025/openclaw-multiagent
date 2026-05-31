// dashboard-workflow.js — 「工作流」页
//
// 三区 grid：右上=缩略图总览 / 左=workflow 拓扑 / 中=session 查看器（聊天气泡）。
//
// 缩略图（P-WF6 改）：复用主页 dashboard-svg.js 的列布局常量 + calcEdgePath 贝塞尔曲线，
//   拿与主页一致的 XY（含 localStorage 'openclaw-node-layout' 拖拽位），小卡片 + 曲线连边，
//   让 worker→worker2 边绕开 worker-3/4，不再像一条穿过它们的链。
//
// 交互（P-WF3，纯前端，复用已有端点）：
//   1. 缩略图 hover agent → 其工作流成员闪动（.wf-blink）。
//   2. 缩略图 click agent → 左侧渲染该 workflow 拓扑（BFS 分层自上而下）。
//   3. SSE /watchdog/stream → track_* + alert → 当前左侧 workflow 成员闪动（.wf-running）。
//   4. 点左侧拓扑 agent → 选中 + 中间 session 查看器加载。
//
// session 查看器（P-WF4 + P-WF6 气泡化）：
//   - 聊天气泡：input(user 含文本) 左对齐蓝、output(assistant + 其后 toolResult 归并) 右对齐橙。
//   - 默认只显示正文；toolCall/toolResult/thinking 收进气泡内一个折叠 disclosure「▸ 步骤详情 (N)」。
//   - 输入气泡 ⓘ → 抽屉展示 inspect.session_system_prompt 的系统提示词拼装（注入文件/skills/tools/字符分解）。

import { esc, getToken, toast } from "./dashboard-common.js";
import { t } from "./dashboard-i18n.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";
import { shouldDisplayDashboardAgentRecord } from "./dashboard-agent-visibility.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// 主页节点布局常量（与 dashboard-svg.js 同值，纯常量/纯函数就地复刻）。
// 不直接 import dashboard-svg.js：它会 transitively 拉入 dashboard.js（主页）的
// 顶层副作用（setInterval 轮询 + 全局 click 监听 + 渲染到 #runtimeGraphSvg），
// 在本页会空转/报错。故只复刻所需的布局常量 + calcEdgePath 贝塞尔算法（皆纯）。
const HOME_NODE_W = 160, HOME_NODE_H = 78;
const HOME_SLOT_GAP = 28, HOME_SLOT_H = HOME_NODE_H + HOME_SLOT_GAP;
const HOME_COL_LEFT = 20, HOME_COL_CENTER = 270;
const HOME_TOP_Y = 28;
const HOME_GRID_SNAP = 10;
const HOME_LAYOUT_STORAGE_KEY = "openclaw-node-layout";

function homeSnap(v) { return Math.round(v / HOME_GRID_SNAP) * HOME_GRID_SNAP; }

// 主页 flow line 路由算法（dashboard-svg.js calcEdgePath 的就地复刻，纯函数）。
// 端口式连接：依据两端相对位置（左右/同列/反向/回环）选不同贝塞尔走法，
// 让如 worker→worker2 的边自然绕开夹在中间的 worker-3/4。
function calcEdgePath(pFrom, pTo) {
  const isLoopBack = pFrom.y > pTo.y && Math.abs(pFrom.x - pTo.x) < pFrom.w + 60;
  const isSameCol = Math.abs(pFrom.x - pTo.x) < 30;
  const isLR = pFrom.x + pFrom.w <= pTo.x;
  const isRL = pTo.x + pTo.w <= pFrom.x;

  let x1, y1, x2, y2, pathD, labelX, labelY;

  if (isLoopBack) {
    x1 = pFrom.x;           y1 = pFrom.y + pFrom.h / 2;
    x2 = pTo.x;             y2 = pTo.y + pTo.h / 2;
    const loopOffset = Math.max(70, Math.abs(y1 - y2) * 0.35);
    const cx = Math.min(x1, x2) - loopOffset;
    pathD = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
    labelX = cx - 4;
    labelY = (y1 + y2) / 2;
  } else if (isSameCol) {
    const goingDown = pFrom.y < pTo.y;
    x1 = pFrom.x + pFrom.w / 2; y1 = goingDown ? pFrom.y + pFrom.h : pFrom.y;
    x2 = pTo.x + pTo.w / 2;     y2 = goingDown ? pTo.y : pTo.y + pTo.h;
    const dist = Math.abs(y2 - y1);
    const tension = Math.max(dist * 0.3, 20);
    const offsetX = 12;
    pathD = `M${x1},${y1} C${x1 + offsetX},${y1 + (goingDown ? tension : -tension)} ${x2 - offsetX},${y2 + (goingDown ? -tension : tension)} ${x2},${y2}`;
    labelX = (x1 + x2) / 2 + offsetX;
    labelY = (y1 + y2) / 2;
  } else if (isLR) {
    x1 = pFrom.x + pFrom.w; y1 = pFrom.y + pFrom.h / 2;
    x2 = pTo.x;             y2 = pTo.y + pTo.h / 2;
    const dist = Math.abs(x2 - x1);
    const tension = Math.max(dist * 0.4, 50);
    pathD = `M${x1},${y1} C${x1 + tension},${y1} ${x2 - tension},${y2} ${x2},${y2}`;
    labelX = (x1 + x2) / 2;
    labelY = (y1 + y2) / 2 - 6;
  } else if (isRL) {
    const sameRow = Math.abs(pFrom.y - pTo.y) < pFrom.h * 0.6;
    if (sameRow) {
      x1 = pFrom.x + pFrom.w / 2; y1 = pFrom.y;
      x2 = pTo.x + pTo.w / 2;     y2 = pTo.y;
      const dist = Math.abs(x1 - x2);
      const arcHeight = Math.max(dist * 0.12, 30);
      const cy = Math.min(y1, y2) - arcHeight;
      pathD = `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = cy - 6;
    } else {
      x1 = pFrom.x;           y1 = pFrom.y + pFrom.h / 2;
      x2 = pTo.x + pTo.w;     y2 = pTo.y + pTo.h / 2;
      const dist = Math.abs(x1 - x2);
      const tension = Math.max(dist * 0.4, 50);
      pathD = `M${x1},${y1} C${x1 - tension},${y1} ${x2 + tension},${y2} ${x2},${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = (y1 + y2) / 2 - 6;
    }
  } else {
    const goingDown = pFrom.y < pTo.y;
    x1 = pFrom.x + pFrom.w / 2; y1 = goingDown ? pFrom.y + pFrom.h : pFrom.y;
    x2 = pTo.x + pTo.w / 2;     y2 = goingDown ? pTo.y : pTo.y + pTo.h;
    const tension = Math.max(Math.abs(y2 - y1) * 0.3, 30);
    pathD = `M${x1},${y1} C${x1},${y1 + (goingDown ? tension : -tension)} ${x2},${y2 + (goingDown ? -tension : tension)} ${x2},${y2}`;
    labelX = (x1 + x2) / 2;
    labelY = (y1 + y2) / 2;
  }

  return { pathD, x1, y1, x2, y2, labelX, labelY };
}

// 左侧拓扑布局常量（自顶向下分层）
const TOPO = Object.freeze({
  NODE_W: 150,
  NODE_H: 56,
  LAYER_GAP: 56, // 层间垂直间距
  COL_GAP: 28, // 同层节点水平间距
  TOP_Y: 24,
  PAD: 24,
});

// 共享运行态（本页内存态，不写持久层）
const state = {
  agents: [], // /watchdog/agents 原始列表
  edges: [], // inspect.agent_graph edges
  workflows: [], // inspect.agent_workflows .workflows
  byAgent: {}, // inspect.agent_workflows .byAgent: agentId → workflowId
  activeWorkflowId: null, // 左侧当前展示的 workflow
  activeMembers: new Set(), // 左侧 workflow 成员 id（SSE 闪动过滤用）
  selectedAgentId: null, // 中间 session 查看器当前 agent
  selectedWorkflowId: null,
  sessions: [], // 当前 agent 的 session 摘要列表（updatedAt 倒序）
  currentSessionId: null, // 下拉当前选中的 sessionId
  sessionRequestSeq: 0, // 切 agent/session 竞态守卫
  runningAgents: new Set(), // SSE 标记为 running 的 agentId
  sse: null,
};

function buildApiUrl(path) {
  const token = getToken();
  if (!token) return path;
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

async function fetchJson(path) {
  const response = await fetch(buildApiUrl(path), {
    headers: { "Content-Type": "application/json" },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const message = data?.error || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "textContent") el.textContent = value;
    else if (key === "className") el.setAttribute("class", value);
    else el.setAttribute(key, String(value));
  }
  return el;
}

function agentById(id) {
  return state.agents.find((a) => a.id === id) || null;
}

// 角色分类与排序，镜像主页 dashboard-svg.js buildRuntimeGraphSVG 的逻辑。
function classifyAgents(agents) {
  const visible = (Array.isArray(agents) ? agents : []).filter(shouldDisplayDashboardAgentRecord);
  const bridge = [];
  const planner = [];
  const center = [];
  for (const agent of visible) {
    const role = agent.role || "agent";
    if (role === "bridge") { bridge.push(agent); continue; }
    if (role === "planner") { planner.push(agent); continue; }
    center.push(agent);
  }
  bridge.sort((a, b) => a.id.localeCompare(b.id));
  planner.sort((a, b) => a.id.localeCompare(b.id));
  const order = (agent) => {
    if (agent.role === "researcher") return 10;
    if (agent.role === "executor" && agent.specialized) return 20;
    if (agent.role === "executor") return 30;
    if (agent.role === "reviewer") return 40;
    return 50;
  };
  center.sort((a, b) => {
    const diff = order(a) - order(b);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
  return { bridge, planner, center };
}

function nodeRoleClass(role) {
  if (role === "bridge") return " wf-node-bridge";
  if (role === "planner") return " wf-node-planner";
  if (role === "researcher" || role === "reviewer") return " wf-node-specialist";
  return "";
}

// 读主页拖拽布局（与 dashboard-svg.js 同一 localStorage key）。失败兜底空对象。
function readHomeSavedPositions() {
  try {
    const raw = localStorage.getItem(HOME_LAYOUT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// 复刻主页 buildRuntimeGraphSVG 的 placeNode 排布：bridge/planner 左列、其余角色中列，
// 再叠加主页拖拽保存位（savedPositions）。返回 {id:{x,y,w,h}}，w/h 用主页真实尺寸，
// 让 calcEdgePath 的曲线路由与主页一致（worker→worker2 自然绕开 worker-3/4）。
function computeHomePositions({ bridge, planner, center }) {
  const positions = {};
  const place = (id, x, y) => { positions[id] = { x: homeSnap(x), y: homeSnap(y), w: HOME_NODE_W, h: HOME_NODE_H }; };

  center.forEach((agent, i) => place(agent.id, HOME_COL_CENTER, HOME_TOP_Y + i * HOME_SLOT_H));
  let leftY = HOME_TOP_Y;
  for (const agent of bridge) { place(agent.id, HOME_COL_LEFT, leftY); leftY += HOME_SLOT_H; }
  if (bridge.length > 0 && planner.length > 0) leftY += 20; // 主页 bridge/planner 间隔
  for (const agent of planner) { place(agent.id, HOME_COL_LEFT, leftY); leftY += HOME_SLOT_H; }

  const saved = readHomeSavedPositions();
  for (const [id, pos] of Object.entries(saved)) {
    if (positions[id] && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      positions[id].x = homeSnap(pos.x);
      positions[id].y = homeSnap(pos.y);
    }
  }
  return positions;
}

// ── 缩略图渲染（P-WF6：复用主页布局 + 贝塞尔曲线 + hover/click 交互）──────────
function renderThumbnail(host) {
  host.innerHTML = "";
  const { bridge, planner, center } = classifyAgents(state.agents);
  const visibleIds = new Set([
    ...bridge.map((a) => a.id),
    ...planner.map((a) => a.id),
    ...center.map((a) => a.id),
  ]);
  const allVisible = [...bridge, ...planner, ...center];

  if (allVisible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wf-thumb-empty";
    empty.textContent = t("nav.workflow");
    host.appendChild(empty);
    return;
  }

  const positions = computeHomePositions({ bridge, planner, center });
  // viewBox 取所有节点外接盒 + 边距；缩放交给 viewBox（卡片在主页坐标系里画，整体缩小显示）。
  const xs = allVisible.map((a) => positions[a.id].x);
  const ys = allVisible.map((a) => positions[a.id].y);
  const minX = Math.min(...xs) - 24;
  const minY = Math.min(...ys) - 24;
  const maxX = Math.max(...xs.map((x, i) => x + positions[allVisible[i].id].w)) + 24;
  const maxY = Math.max(...ys.map((y, i) => y + positions[allVisible[i].id].h)) + 24;
  const svg = svgEl("svg", {
    className: "wf-thumb-svg",
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
  });

  // 连线（节点下层）：用主页 calcEdgePath 画曲线，只连两端均可见的边。
  for (const edge of state.edges) {
    const pFrom = positions[edge.from];
    const pTo = positions[edge.to];
    if (!pFrom || !pTo || !visibleIds.has(edge.from) || !visibleIds.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    const { pathD } = calcEdgePath(pFrom, pTo);
    svg.appendChild(svgEl("path", {
      d: pathD,
      className: "wf-edge wf-thumb-edge",
      "data-edge": `${edge.from}→${edge.to}`,
    }));
  }

  // 小卡片（主页坐标系，viewBox 整体缩小）：方框 + agent 名 + 角色，挂 hover/click。
  for (const agent of allVisible) {
    const pos = positions[agent.id];
    const role = agent.role || "agent";
    const cx = pos.x + pos.w / 2;
    const g = svgEl("g", { className: "wf-node wf-thumb-node", "data-agent": agent.id });
    g.appendChild(svgEl("rect", {
      x: pos.x, y: pos.y, width: pos.w, height: pos.h,
      className: `wf-node-box${nodeRoleClass(role)}`,
    }));
    g.appendChild(svgEl("text", {
      x: cx, y: pos.y + pos.h / 2 - 6,
      className: "wf-node-name", textContent: agent.id.toUpperCase(),
    }));
    g.appendChild(svgEl("text", {
      x: cx, y: pos.y + pos.h / 2 + 16,
      className: "wf-node-role", textContent: role.toUpperCase(),
    }));
    g.addEventListener("mouseenter", () => blinkWorkflowMembers(agent.id, true));
    g.addEventListener("mouseleave", () => blinkWorkflowMembers(agent.id, false));
    g.addEventListener("click", () => openWorkflowTopology(agent.id));
    svg.appendChild(g);
  }

  host.appendChild(svg);
}

// hover 缩略图 agent → 高亮其 workflow 全部 members（.wf-blink）。
function blinkWorkflowMembers(agentId, on) {
  const host = document.getElementById("wfThumbHost");
  if (!host) return;
  const workflowId = state.byAgent[agentId] || null;
  const members = workflowId
    ? (state.workflows.find((w) => w.id === workflowId)?.members || [agentId])
    : [agentId];
  const memberSet = new Set(members);
  host.querySelectorAll(".wf-thumb-node").forEach((node) => {
    const id = node.getAttribute("data-agent");
    node.classList.toggle("wf-blink", on && memberSet.has(id));
  });
}

// ── 左侧 workflow 拓扑（P-WF3：BFS 分层自顶向下）─────────────────────────────

// 从 entry 出发 BFS，按本 workflow 成员的有向边分层。环 / 不可达成员兜底追加到末层。
function layerWorkflow(workflow) {
  const members = new Set(workflow.members);
  const adjacency = new Map();
  for (const id of members) adjacency.set(id, []);
  for (const edge of state.edges) {
    if (members.has(edge.from) && members.has(edge.to) && edge.from !== edge.to) {
      adjacency.get(edge.from).push(edge.to);
    }
  }
  const layerOf = new Map();
  const queue = [];
  const entry = members.has(workflow.entry) ? workflow.entry : [...members].sort()[0];
  if (entry) { layerOf.set(entry, 0); queue.push(entry); }
  // 深度上限 = 成员数-1：简单图中任一节点的最长路径深度不可能超过 N-1。
  // 没有这个钳位，环（如 researcher→worker→reviewer→researcher）会让深度沿环无限递增 → 浏览器死循环。
  // DAG 不受影响（其最长路径本就 ≤ N-1）；环的反向边超过上限即忽略，保持自顶向下视觉。
  const maxLayer = Math.max(0, members.size - 1);
  while (queue.length > 0) {
    const node = queue.shift();
    const depth = layerOf.get(node);
    for (const next of adjacency.get(node) || []) {
      const candidate = depth + 1;
      if (candidate <= maxLayer && (!layerOf.has(next) || candidate > layerOf.get(next))) {
        // 取最长路径深度，避免反向边把节点拉回浅层（保持自顶向下视觉）。
        layerOf.set(next, candidate);
        queue.push(next);
      }
    }
  }
  // 不可达成员（独立 / 仅反向连通）追加到末层。
  let maxDepth = 0;
  for (const depth of layerOf.values()) maxDepth = Math.max(maxDepth, depth);
  for (const id of members) {
    if (!layerOf.has(id)) { maxDepth += 1; layerOf.set(id, maxDepth); }
  }
  // 组装为层数组。
  const layers = [];
  for (const [id, depth] of layerOf.entries()) {
    if (!layers[depth]) layers[depth] = [];
    layers[depth].push(id);
  }
  for (const layer of layers) { if (layer) layer.sort(); }
  return layers.filter(Boolean);
}

function layoutTopoPositions(layers) {
  const positions = {};
  const widths = layers.map((layer) => layer.length * TOPO.NODE_W + (layer.length - 1) * TOPO.COL_GAP);
  const maxRowW = Math.max(0, ...widths);
  layers.forEach((layer, depth) => {
    const rowW = widths[depth];
    const startX = TOPO.PAD + (maxRowW - rowW) / 2;
    const y = TOPO.TOP_Y + depth * (TOPO.NODE_H + TOPO.LAYER_GAP);
    layer.forEach((id, i) => {
      positions[id] = { x: startX + i * (TOPO.NODE_W + TOPO.COL_GAP), y };
    });
  });
  return { positions, maxRowW };
}

// 向下连线：源底边中点 → 目标顶边中点（自顶向下视觉）。
function topoEdgePath(from, to) {
  const x1 = from.x + TOPO.NODE_W / 2;
  const x2 = to.x + TOPO.NODE_W / 2;
  // 同层 / 反向：从右侧绕，避免压在方框上。
  if (to.y <= from.y) {
    const y1 = from.y + TOPO.NODE_H / 2;
    const y2 = to.y + TOPO.NODE_H / 2;
    const bend = Math.max(x1, x2) + TOPO.NODE_W * 0.5;
    return `M${from.x + TOPO.NODE_W},${y1} C${bend},${y1} ${bend},${y2} ${to.x + TOPO.NODE_W},${y2}`;
  }
  const y1 = from.y + TOPO.NODE_H;
  const y2 = to.y;
  const midY = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
}

function renderTopology(workflowId) {
  const body = document.getElementById("wfTopoBody");
  const head = document.getElementById("wfTopoHead");
  if (!body) return;
  const workflow = state.workflows.find((w) => w.id === workflowId) || null;
  if (!workflow) {
    body.innerHTML = `<div class="wf-placeholder">${esc("选择 AGENT")}</div>`;
    if (head) head.textContent = "";
    return;
  }
  state.activeWorkflowId = workflowId;
  state.activeMembers = new Set(workflow.members);

  if (head) {
    head.textContent = `${(workflow.entry || workflow.members[0] || "").toUpperCase()} · ${workflow.members.length}`;
  }

  const layers = layerWorkflow(workflow);
  const { positions, maxRowW } = layoutTopoPositions(layers);
  const totalW = maxRowW + TOPO.PAD * 2;
  const totalH = TOPO.TOP_Y + layers.length * (TOPO.NODE_H + TOPO.LAYER_GAP) + TOPO.PAD;

  body.innerHTML = "";
  const svg = svgEl("svg", {
    className: "wf-topo-svg",
    viewBox: `0 0 ${Math.max(totalW, 200)} ${Math.max(totalH, 120)}`,
    preserveAspectRatio: "xMidYMin meet",
  });

  // 连线（节点下层）：只画本 workflow 成员间的有向边。
  for (const edge of state.edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to || edge.from === edge.to) continue;
    svg.appendChild(svgEl("path", {
      d: topoEdgePath(from, to),
      className: "wf-edge wf-topo-edge",
      "data-edge": `${edge.from}→${edge.to}`,
    }));
  }

  // 节点：方框 + 名 + 角色 + 模型，挂 click 选中。
  for (const id of workflow.members) {
    const pos = positions[id];
    if (!pos) continue;
    const agent = agentById(id);
    const role = agent?.role || "agent";
    const isEntry = id === workflow.entry;
    const g = svgEl("g", {
      className: `wf-node wf-topo-node${isEntry ? " wf-topo-entry" : ""}`,
      "data-agent": id,
    });
    g.appendChild(svgEl("rect", {
      x: pos.x, y: pos.y, width: TOPO.NODE_W, height: TOPO.NODE_H,
      className: `wf-node-box${nodeRoleClass(role)}`,
    }));
    g.appendChild(svgEl("text", {
      x: pos.x + TOPO.NODE_W / 2, y: pos.y + 22,
      className: "wf-topo-name", textContent: id.toUpperCase(),
    }));
    g.appendChild(svgEl("text", {
      x: pos.x + TOPO.NODE_W / 2, y: pos.y + 38,
      className: "wf-topo-role", textContent: role.toUpperCase(),
    }));
    g.addEventListener("click", () => selectTopologyAgent(id));
    svg.appendChild(g);
  }

  body.appendChild(svg);
  applyRunningHighlight(); // 切 workflow 后立刻反映当前运行态
  applySelectedHighlight();
}

function openWorkflowTopology(agentId) {
  const workflowId = state.byAgent[agentId] || null;
  if (workflowId) {
    renderTopology(workflowId);
  } else {
    // 孤立 agent（无 workflow 归属）：构造单成员临时 workflow 视图。
    const solo = { id: `wf:${agentId}`, members: [agentId], entry: agentId };
    state.workflows = state.workflows.some((w) => w.id === solo.id)
      ? state.workflows
      : [...state.workflows, solo];
    renderTopology(solo.id);
  }
}

// 点左侧拓扑 agent → 选中 + 加载中间 session 查看器。
function selectTopologyAgent(agentId) {
  state.selectedAgentId = agentId;
  state.selectedWorkflowId = state.activeWorkflowId;
  applySelectedHighlight();
  loadSessionPanel(agentId);
}

function applySelectedHighlight() {
  const body = document.getElementById("wfTopoBody");
  if (!body) return;
  body.querySelectorAll(".wf-topo-node").forEach((node) => {
    node.classList.toggle("wf-selected", node.getAttribute("data-agent") === state.selectedAgentId);
  });
}

// ── 中间 session 查看器（P-WF4）────────────────────────────────────────────────

// 时间格式化：兼容毫秒数 / ISO 字符串 → 本地 YYYY-MM-DD HH:mm。
function formatTimestamp(value) {
  if (value == null || value === "") return "";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.length > 8 ? sessionId.slice(0, 8) : (sessionId || "");
}

// 平滑替换 session body 内容（淡出→换→淡入）。
// 用 swapToken 保证只有最新一次 swap 落地（快速切 agent 时旧 swap 被丢弃，不闪烁错内容）。
let swapToken = 0;
function swapSessionBody(renderFn) {
  const body = document.getElementById("wfSessionBody");
  if (!body) return;
  const token = ++swapToken;
  body.classList.add("wf-swap-out");
  window.setTimeout(() => {
    if (token !== swapToken) return; // 已有更新的 swap，丢弃本次
    renderFn(body);
    body.classList.remove("wf-swap-out");
    body.classList.add("wf-swap-in");
    window.setTimeout(() => body.classList.remove("wf-swap-in"), 220);
  }, 120);
}

// 选中 agent → 拉 session 列表，建下拉，默认选最新（第一项）。
async function loadSessionPanel(agentId) {
  const seq = ++state.sessionRequestSeq;
  swapSessionBody((body) => {
    body.innerHTML = `<div class="wf-session-loading">${esc("加载会话中…")}</div>`;
  });
  let sessions;
  try {
    sessions = await fetchJson(`/watchdog/inspect?surface=inspect.agent_sessions&agentId=${encodeURIComponent(agentId)}`);
  } catch (error) {
    if (seq !== state.sessionRequestSeq) return;
    swapSessionBody((body) => {
      body.innerHTML = `<div class="wf-session-empty">${esc(error.message || "ERROR")}</div>`;
    });
    return;
  }
  if (seq !== state.sessionRequestSeq) return; // 已切到别的 agent，丢弃
  state.sessions = Array.isArray(sessions) ? sessions.filter((s) => s && s.sessionId) : [];

  if (state.sessions.length === 0) {
    state.currentSessionId = null;
    swapSessionBody((body) => {
      body.innerHTML = `<div class="wf-session-empty">${esc("该 agent 暂无保存的会话（可能已被测试重置清理）")}</div>`;
    });
    return;
  }

  state.currentSessionId = state.sessions[0].sessionId; // 默认最新
  swapSessionBody((body) => {
    body.innerHTML = `
      <div class="wf-session-bar">
        <span class="wf-session-bar-label">${esc("会话")}</span>
        <select class="wf-session-select" id="wfSessionSelect">${buildSessionOptions()}</select>
        <button type="button" class="wf-prompt-btn" id="wfSessionPromptBtn" title="${esc("系统提示词拼装")}">ⓘ ${esc("系统提示词")}</button>
      </div>
      <div class="wf-transcript" id="wfTranscript"></div>
    `;
    const select = document.getElementById("wfSessionSelect");
    if (select) {
      select.value = state.currentSessionId;
      select.addEventListener("change", () => {
        state.currentSessionId = select.value;
        loadTranscript(state.selectedAgentId, state.currentSessionId);
      });
    }
    // 会话栏的「系统提示词」入口 —— 即便该 session 无输入气泡(如 worker2)也能查看。
    const promptBtn = document.getElementById("wfSessionPromptBtn");
    if (promptBtn) {
      promptBtn.addEventListener("click", () => openSystemPromptDrawer(state.selectedAgentId, state.currentSessionId));
    }
    // 在 #wfTranscript 进 DOM 后再拉 transcript（确保 loading 占位有处可挂）。
    loadTranscript(agentId, state.currentSessionId);
  });
}

function buildSessionOptions() {
  return state.sessions.map((session) => {
    const time = formatTimestamp(session.updatedAt);
    const parts = [shortSessionId(session.sessionId)];
    if (time) parts.push(time);
    if (session.contractId) parts.push(session.contractId);
    const label = parts.join("  ·  ");
    return `<option value="${esc(session.sessionId)}">${esc(label)}</option>`;
  }).join("");
}

// 拉 transcript 渲染（消息 + 引用文件）。
async function loadTranscript(agentId, sessionId) {
  const seq = ++state.sessionRequestSeq;
  const host = document.getElementById("wfTranscript");
  if (host) host.innerHTML = `<div class="wf-session-loading">${esc("加载内容中…")}</div>`;
  let transcript;
  try {
    transcript = await fetchJson(
      `/watchdog/inspect?surface=inspect.session_transcript`
      + `&agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`,
    );
  } catch (error) {
    if (seq !== state.sessionRequestSeq) return;
    const target = document.getElementById("wfTranscript");
    if (target) target.innerHTML = `<div class="wf-session-empty">${esc(error.message || "ERROR")}</div>`;
    return;
  }
  if (seq !== state.sessionRequestSeq) return; // 已切换，丢弃
  renderTranscript(transcript);
}

const TOOL_RESULT_TRUNCATE = 600;

function hasText(message) {
  return typeof message?.text === "string" && message.text.trim().length > 0;
}

// args 摘要：取前若干键值，截断长值。
function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    let printable;
    if (typeof value === "string") printable = value;
    else { try { printable = JSON.stringify(value); } catch { printable = String(value); } }
    if (printable.length > 60) printable = `${printable.slice(0, 60)}…`;
    parts.push(`${key}=${printable}`);
    if (parts.length >= 3) break;
  }
  return parts.join("  ");
}

// 把 messages 解析成若干 exchange（交换）：process（中间步骤）→ output。
//   真正的「输入」由 received（系统投递的合约）承载，单独渲染在顶部；这里不再有 input 气泡。
//   - .jsonl 里有非空文本的 user 消息 = 框架唤醒信号（如 "[cron Hook] Continue contract …"），
//     不是人类输入 → 折进 process 作为 `wake` 项，不再单画输入气泡。
//   - process：thinking、toolCall、toolResult、唤醒指令，
//     以及「只有 toolCall/thinking、无最终文本」的中间 assistant 消息。
//   - output：最后一条「有非空文本的 assistant 消息」的文本。
//     同一 exchange 多条 assistant 文本时，前面的降级成 process 的 text 项（不丢内容）。
function parseExchanges(messages) {
  const exchanges = [];
  let current = null;

  const ensureExchange = () => {
    if (!current) { current = { process: [], output: null, outputTs: null }; exchanges.push(current); }
    return current;
  };
  const pushSteps = (message) => {
    const ex = ensureExchange();
    if (message.thinking) ex.process.push({ type: "thinking", text: message.thinking });
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      ex.process.push({ type: "call", name: call.name || "tool", args: call.args });
    }
    for (const tr of Array.isArray(message.toolResults) ? message.toolResults : []) {
      const text = tr.contentText || "";
      if (text) ex.process.push({ type: "result", text });
    }
  };

  for (const message of messages) {
    const role = message?.role || null;
    if (role === "user" && hasText(message)) {
      // 框架唤醒信号 → 折进过程（不是人类输入）。
      const ex = ensureExchange();
      ex.process.push({ type: "wake", text: message.text });
      // 该 user 消息自身可能还带 toolResult/thinking → 一并进 process。
      pushSteps({ thinking: message.thinking, toolResults: message.toolResults });
      continue;
    }
    if (role === "assistant") {
      const ex = ensureExchange();
      // assistant 的 thinking/toolCall 始终入 process。
      pushSteps({ thinking: message.thinking, toolCalls: message.toolCalls, toolResults: message.toolResults });
      if (hasText(message)) {
        // 已有 output → 前一个降级为 process 的 text 项，本条成为新 output（取最后一条文本）。
        if (ex.output) ex.process.push({ type: "text", text: ex.output });
        ex.output = message.text;
        ex.outputTs = message.ts ?? null;
      }
      continue;
    }
    // user 无文本（仅 toolResult 承载）或其它角色：其步骤入当前 exchange process。
    pushSteps({ thinking: message?.thinking, toolCalls: message?.toolCalls, toolResults: message?.toolResults });
  }

  return exchanges;
}

// received source → 可读小标。
function receivedSourceLabel(source) {
  if (source === "inbox-snapshot") return "实投存档";
  if (source === "live-inbox") return "运行中";
  if (source === "contract") return "正本兜底";
  return source || "未知";
}

// 对话开头「系统发来」输入气泡：系统/上游实际投递给该 agent 的合约（received）。
// available===false → 淡色不可考注记。received 缺失（如非预期）→ 不画。
function buildReceivedBubble(received, agentId) {
  if (!received) return "";
  if (received.available === false) {
    return `<div class="wf-turn wf-turn-input">
      <div class="wf-bubble wf-bubble-received">
        <div class="wf-bubble-head">
          <span class="wf-bubble-role">📥 ${esc(`系统发送给 ${agentId || ""}`.trim())}</span>
        </div>
        <div class="wf-received-missing">${esc("系统输入不可考（无快照/正本）")}</div>
      </div>
    </div>`;
  }
  const task = typeof received.task === "string" ? received.task : "";
  const raw = typeof received.raw === "string" ? received.raw : "";
  let html = `<div class="wf-turn wf-turn-input">
    <div class="wf-bubble wf-bubble-received">
      <div class="wf-bubble-head">
        <span class="wf-bubble-role">📥 ${esc(`系统发送给 ${agentId || ""}`.trim())}</span>
        <span class="wf-received-source wf-received-source-${esc(received.source || "unknown")}">${esc(receivedSourceLabel(received.source))}</span>
      </div>
      <div class="wf-received-sub">${esc("系统/上游投递的合约")}</div>`;
  if (task) {
    html += `<div class="wf-received-task"><span class="wf-received-task-label">${esc("任务")}</span>${esc(task)}</div>`;
  }
  if (raw) {
    html += `<details class="wf-received-raw">
      <summary class="wf-received-raw-summary">▸ ${esc("完整合约")}</summary>
      <pre class="wf-received-raw-body">${esc(raw)}</pre>
    </details>`;
  }
  html += `</div></div>`;
  return html;
}

// 渲染单个 exchange 的「过程」开关（朴素明细，非气泡，默认收起）。process 为空则不画。
function buildProcessToggle(process) {
  if (!Array.isArray(process) || process.length === 0) return "";
  let inner = "";
  for (const step of process) {
    if (step.type === "thinking" || step.type === "text" || step.type === "wake") {
      const label = step.type === "thinking" ? "思考" : step.type === "wake" ? "唤醒指令" : "中间输出";
      inner += `<div class="wf-proc-item wf-proc-thinking">
        <div class="wf-proc-label">${esc(label)}</div>
        <div class="wf-proc-text">${esc(step.text)}</div>
      </div>`;
    } else if (step.type === "call") {
      const argsSummary = summarizeArgs(step.args);
      inner += `<div class="wf-proc-item wf-proc-call">
        <span class="wf-proc-icon">🔧</span>
        <span class="wf-proc-name">${esc(step.name)}</span>
        ${argsSummary ? `<span class="wf-proc-args">${esc(argsSummary)}</span>` : ""}
      </div>`;
    } else if (step.type === "result") {
      const text = step.text || "";
      if (text.length > TOOL_RESULT_TRUNCATE) {
        inner += `<details class="wf-proc-item wf-proc-result">
          <summary><span class="wf-proc-icon">📥</span> ${esc(`工具结果（${text.length} 字符，点击展开）`)}</summary>
          <div class="wf-proc-result-body">${esc(text)}</div>
        </details>`;
      } else {
        inner += `<div class="wf-proc-item wf-proc-result">
          <span class="wf-proc-icon">📥</span>
          <div class="wf-proc-result-body">${esc(text)}</div>
        </div>`;
      }
    }
  }
  return `<details class="wf-process">
    <summary class="wf-process-summary">▸ ${esc(`展开过程 (${process.length} 步)`)}</summary>
    <div class="wf-process-body">${inner}</div>
  </details>`;
}

function renderTranscript(transcript) {
  const host = document.getElementById("wfTranscript");
  if (!host) return;
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  const referencedFiles = Array.isArray(transcript?.referencedFiles) ? transcript.referencedFiles : [];

  let html = "";

  // 引用文件区（置顶）。
  if (referencedFiles.length > 0) {
    html += `<div class="wf-files">
      <div class="wf-files-head">${esc("引用文件")}<span class="wf-files-hint">${esc("划掉 = 已清理 / 不再存在")}</span></div>
      <div class="wf-files-list">`;
    referencedFiles.forEach((file, index) => {
      const name = (file.rawPath || file.resolvedPath || "").split("/").pop() || "(file)";
      const disabled = file.persistent === false;
      html += `<button type="button" class="wf-file${disabled ? " wf-file-disabled" : ""}"
        data-file-index="${index}"${disabled ? " disabled" : ""}>
        <span class="wf-file-name">${esc(name)}</span>
        <span class="wf-file-kind wf-file-kind-${esc(file.kind || "other")}">${esc(file.kind || "other")}</span>
      </button>`;
    });
    html += `</div></div>`;
  }

  if (messages.length === 0) {
    html += `<div class="wf-session-empty">${esc("该会话无可解析消息")}</div>`;
    host.innerHTML = html;
    return;
  }

  // 对话开头：系统/上游实际投递给该 agent 的合约（received）作为「系统发来」输入气泡。
  html += buildReceivedBubble(transcript?.received, transcript?.agentId || state.selectedAgentId);

  // exchange 模型：〔展开过程〕→ 输出（输入由 received 承载，唤醒信号折进过程）。
  const exchanges = parseExchanges(messages);

  html += `<div class="wf-chat">`;
  exchanges.forEach((ex) => {
    html += `<div class="wf-exchange">`;
    // 1. 过程开关（process 非空才画）。
    html += buildProcessToggle(ex.process);
    // 2. 输出气泡（有 output 文本才画）。
    if (ex.output) {
      const time = formatTimestamp(ex.outputTs);
      html += `<div class="wf-turn wf-turn-output">
        <div class="wf-bubble">
          <div class="wf-bubble-head">
            <span class="wf-bubble-role">${esc("输出")}</span>
            ${time ? `<span class="wf-bubble-time">${esc(time)}</span>` : ""}
          </div>
          <div class="wf-bubble-text">${esc(ex.output)}</div>
        </div>
      </div>`;
    }
    html += `</div>`;
  });
  html += `</div>`;

  // 产出文件区：该 agent 本轮真正产出的文件（持久产物包 artifacts/<cid>/<agent>/，过 session-clean），
  // 直接读正文内显。异于上方「引用文件」（历史读写引用、常被清而划掉）。
  const produced = transcript?.producedFiles;
  if (produced && produced.available && Array.isArray(produced.files) && produced.files.length > 0) {
    html += `<div class="wf-produced">
      <div class="wf-produced-head">📦 ${esc("产出文件")}<span class="wf-produced-count">${produced.files.length}</span></div>
      <div class="wf-produced-sub">${esc("该 agent 本轮产出的文件（独立留存，可直接读正文）")}</div>`;
    produced.files.forEach((f, i) => {
      const open = f.primary || produced.files.length === 1; // 主交付物 / 单文件默认展开
      const sizeLabel = Number.isFinite(f.chars) ? `${f.chars} 字` : "";
      html += `<div class="wf-pfile${open ? " wf-pfile-open" : ""}" data-pfile-index="${i}">
        <button type="button" class="wf-pfile-head">
          <span class="wf-pfile-caret">▸</span>
          <span class="wf-pfile-name">${esc(f.name)}</span>
          ${f.primary ? `<span class="wf-pfile-primary">${esc("主交付物")}</span>` : ""}
          <span class="wf-pfile-size">${esc(sizeLabel)}</span>
        </button>`;
      if (f.content != null) {
        html += `<pre class="wf-pfile-body">${esc(String(f.content))}</pre>`;
        if (f.truncated) html += `<div class="wf-pfile-trunc">${esc("…（已截断至 40000 字）")}</div>`;
      } else {
        html += `<div class="wf-pfile-binary">${esc("（二进制 / 不可读，仅列文件名）")}</div>`;
      }
      html += `</div>`;
    });
    html += `</div>`;
  }

  // 末位 agent（叶子，graph 无出边）：追加「用户接收到的消息」产出件区块。
  // 区别于 agent 自己的「输出」气泡（内部叙述）——这是真正投递给用户的最终产出件。
  const delivery = transcript?.delivery;
  if (delivery && delivery.isTerminal) {
    html += `<div class="wf-delivery">
      <div class="wf-delivery-head">📨 ${esc("用户接收到的消息")}</div>
      <div class="wf-delivery-sub">${esc("末位 agent 投递给用户的最终产出件（非 agent 内部输出叙述）")}</div>`;
    if (delivery.available && delivery.content) {
      html += `<pre class="wf-delivery-body">${esc(String(delivery.content))}</pre>`;
      if (delivery.truncated) {
        html += `<div class="wf-delivery-trunc">${esc("…（已截断至 40000 字）")}</div>`;
      }
    } else {
      html += `<div class="wf-delivery-missing">${esc("产出件已不在（可能已被清理）")}</div>`;
    }
    html += `</div>`;
  }

  host.innerHTML = html;

  // 绑定引用文件点击（reveal）。
  host.querySelectorAll(".wf-file:not(.wf-file-disabled)").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-file-index"));
      const file = referencedFiles[index];
      if (file) revealFile(file.resolvedPath);
    });
  });

  // 绑定输入气泡的「系统提示词」入口 → 抽屉。
  host.querySelectorAll(".wf-prompt-btn").forEach((button) => {
    button.addEventListener("click", () => openSystemPromptDrawer(state.selectedAgentId, state.currentSessionId));
  });

  // 绑定产出文件展开/收起。
  host.querySelectorAll(".wf-pfile-head").forEach((button) => {
    button.addEventListener("click", () => {
      const block = button.closest(".wf-pfile");
      if (block) block.classList.toggle("wf-pfile-open");
    });
  });
}

// ── 系统提示词抽屉（P-WF6 B：看提示词如何拼装）─────────────────────────────

let promptDrawerEscHandler = null;

function ensurePromptDrawer() {
  let drawer = document.getElementById("wfPromptDrawer");
  if (drawer) return drawer;
  drawer = document.createElement("div");
  drawer.id = "wfPromptDrawer";
  drawer.className = "wf-drawer";
  drawer.innerHTML = `
    <div class="wf-drawer-backdrop" data-drawer-close></div>
    <aside class="wf-drawer-panel" role="dialog" aria-modal="true">
      <div class="wf-drawer-head">
        <span class="wf-drawer-title">${esc("系统提示词拼装")}</span>
        <button type="button" class="wf-drawer-close" data-drawer-close aria-label="${esc("关闭")}">✕</button>
      </div>
      <div class="wf-drawer-body" id="wfPromptBody"></div>
    </aside>
  `;
  document.body.appendChild(drawer);
  drawer.querySelectorAll("[data-drawer-close]").forEach((el) => {
    el.addEventListener("click", closeSystemPromptDrawer);
  });
  return drawer;
}

function closeSystemPromptDrawer() {
  const drawer = document.getElementById("wfPromptDrawer");
  if (drawer) drawer.classList.remove("wf-drawer-open");
  if (promptDrawerEscHandler) {
    document.removeEventListener("keydown", promptDrawerEscHandler);
    promptDrawerEscHandler = null;
  }
}

async function openSystemPromptDrawer(agentId, sessionId) {
  if (!agentId || !sessionId) return;
  const drawer = ensurePromptDrawer();
  const body = document.getElementById("wfPromptBody");
  drawer.classList.add("wf-drawer-open");
  if (!promptDrawerEscHandler) {
    promptDrawerEscHandler = (event) => { if (event.key === "Escape") closeSystemPromptDrawer(); };
    document.addEventListener("keydown", promptDrawerEscHandler);
  }
  if (body) body.innerHTML = `<div class="wf-session-loading">${esc("加载提示词拼装…")}</div>`;

  let data;
  try {
    data = await fetchJson(
      `/watchdog/inspect?surface=inspect.session_system_prompt`
      + `&agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`,
    );
  } catch (error) {
    if (body) body.innerHTML = `<div class="wf-session-empty">${esc(error.message || "ERROR")}</div>`;
    return;
  }
  renderSystemPrompt(data);
}

// 双视图系统提示词：用户直连(SOUL/openclaw 类型) vs 系统派工(agent-awake/系统内部)，二选一。
// 顶部横幅标本 session 实际走哪条；两个暗按钮切换查看，非 active 的标「未进上下文，仅对比」。
let promptDrawerData = null;
let promptDrawerSelected = null;

function promptPathBanner(activePath) {
  if (activePath === "dispatch-agent-awake") {
    return "本 session 实际运行：系统内部派工 · 使用系统内部提示词（agent-awake）";
  }
  if (activePath === "direct-soul") {
    return "本 session 实际运行：用户直连 agent · 使用 openclaw 类型系统提示词（SOUL）";
  }
  return "本 session 运行路径未知";
}

function renderSystemPrompt(data) {
  const body = document.getElementById("wfPromptBody");
  if (!body) return;
  if (!data || data.available !== true) {
    body.innerHTML = `<div class="wf-session-empty">${esc("该 session 无系统提示词记录")}</div>`;
    return;
  }
  promptDrawerData = data;
  promptDrawerSelected = data.activePath === "dispatch-agent-awake" ? "agentAwake" : "soul";
  paintPromptDrawer();
}

function paintPromptDrawer() {
  const body = document.getElementById("wfPromptBody");
  const data = promptDrawerData;
  if (!body || !data) return;

  const activePath = data.activePath
    || (data.source === "contract-session-override" ? "dispatch-agent-awake" : "direct-soul");
  const views = data.views || {};
  // 视图回退：旧响应无 views 时，把顶层当作 active 的那条
  const soulView = views.soul || (activePath === "direct-soul" ? data : null);
  const awakeView = views.agentAwake || (activePath === "dispatch-agent-awake" ? data : null);
  const activeKey = activePath === "dispatch-agent-awake" ? "agentAwake" : "soul";

  let html = `<div class="wf-prompt-path wf-prompt-path-${esc(activePath)}">${esc(promptPathBanner(activePath))}</div>`;

  // 两个暗按钮（标 active 那条 + 禁用不可用视图）
  html += `<div class="wf-prompt-tabs">`;
  html += promptTabButton("soul", "openclaw 类型 · 用户直连", soulView, activeKey === "soul");
  html += promptTabButton("agentAwake", "系统内部 · 系统派工", awakeView, activeKey === "agentAwake");
  html += `</div>`;

  const selectedView = promptDrawerSelected === "agentAwake" ? awakeView : soulView;
  html += renderPromptViewBody(selectedView, promptDrawerSelected === activeKey);

  body.innerHTML = html;
  body.querySelectorAll(".wf-prompt-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const key = btn.getAttribute("data-view");
      if (key) { promptDrawerSelected = key; paintPromptDrawer(); }
    });
  });
  // 三级折叠(完整装配/技能列表/单 skill head)同一套：点 toggle → 翻 box 的 data-*open → 更新按钮文案。
  // label(wasOpen)=null 则只翻 ▸/▾ 前缀(保留原文，用于"▸ skillId")。
  const TOGGLES = [
    { btn: ".wf-asm-toggle", box: ".wf-asm", attr: "data-asm-open", label: (wasOpen) => wasOpen ? "▸ 点击显示完整装配（按真实装配顺序）" : "▾ 收起完整装配" },
    { btn: ".wf-skill-toggle", box: ".wf-skill-row", attr: "data-skill-open", label: (wasOpen) => wasOpen ? "展开 skill ▸" : "收起 skill ▾" },
    { btn: ".wf-skillitem-toggle", box: ".wf-skill-item", attr: "data-skillitem-open", label: null },
  ];
  for (const cfg of TOGGLES) {
    body.querySelectorAll(cfg.btn).forEach((btn) => {
      btn.addEventListener("click", () => {
        const box = btn.closest(cfg.box);
        if (!box) return;
        const wasOpen = box.getAttribute(cfg.attr) === "1";
        box.setAttribute(cfg.attr, wasOpen ? "0" : "1");
        btn.textContent = cfg.label ? cfg.label(wasOpen) : btn.textContent.replace(/^[▸▾]/, wasOpen ? "▸" : "▾");
      });
    });
  }
}

function promptTabButton(key, label, view, isActive) {
  const disabled = !view || view.available !== true;
  const on = promptDrawerSelected === key;
  return `<button type="button" class="wf-prompt-tab${on ? " wf-prompt-tab-on" : ""}${disabled ? " wf-prompt-tab-disabled" : ""}" data-view="${esc(key)}"${disabled ? " disabled" : ""}>
    <span class="wf-prompt-tab-label">${esc(label)}</span>${isActive ? `<span class="wf-prompt-tab-badge">${esc("本 session")}</span>` : ""}
  </button>`;
}

// 完整装配视图：按真实装配顺序（框架基础 → 工具 → 技能 → 工作区文件正文 → 框架尾部）列各段 + 字数。
// 数据源：systemPromptReport（框架真值）。中继 agent/agent-awake 视图未记录 skills/tools 字数时如实标注。
function buildAssemblyHtml(view) {
  const r = view.report && typeof view.report === "object" ? view.report : {};
  const sp = r.systemPrompt && typeof r.systemPrompt === "object" ? r.systemPrompt : {};
  const total = Number(sp.chars);
  const proj = Number(sp.projectContextChars);
  const skills = r.skills && typeof r.skills === "object" ? r.skills : {};
  const tools = r.tools && typeof r.tools === "object" ? r.tools : {};
  const skillChars = Number(skills.promptChars) || 0;
  const toolChars = (Number(tools.schemaChars) || 0) + (Number(tools.listChars) || 0);
  const baseChars = Number.isFinite(total) ? Math.max(0, total - (Number.isFinite(proj) ? proj : 0) - skillChars - toolChars) : null;
  const fileNames = (Array.isArray(view.injectedFiles) ? view.injectedFiles : []).map((f) => f.name).filter(Boolean);
  // 报告里有 tools/skills（精确，带字数）优先；否则回退 AgentBinding 配置范围（仅名字，无字数）。
  const binding = (promptDrawerData && promptDrawerData.bindingCapabilities) || {};
  let skillNames = Array.isArray(skills.entries) ? skills.entries.map((e) => (e && (e.id || e.name)) || e).filter(Boolean) : [];
  let toolNames = Array.isArray(tools.entries) ? tools.entries.map((e) => (e && (e.name || e.id)) || e).filter(Boolean) : [];
  let toolsFromBinding = false;
  let skillsFromBinding = false;
  if (toolNames.length === 0 && Array.isArray(binding.tools) && binding.tools.length) { toolNames = binding.tools; toolsFromBinding = true; }
  if (skillNames.length === 0 && Array.isArray(binding.skills) && binding.skills.length) { skillNames = binding.skills; skillsFromBinding = true; }
  const chip = (n) => (Number.isFinite(n) ? `<span class="wf-asm-chars">${n.toLocaleString()} ${esc("字")}</span>` : "");
  const row = (idx, label, chars, detail) => `<div class="wf-asm-row">
      <div class="wf-asm-row-head"><span class="wf-asm-idx">${idx}</span><span class="wf-asm-label">${esc(label)}</span>${chip(chars)}</div>
      ${detail ? `<div class="wf-asm-detail">${esc(detail)}</div>` : ""}
    </div>`;

  let html = "";
  if (Number.isFinite(total)) {
    html += `<div class="wf-asm-total">${esc("系统提示词总长")} ${total.toLocaleString()} ${esc("字（不含逐字工具 schema 折叠部分）")}</div>`;
  } else {
    html += `<div class="wf-asm-note">${esc("本视图无框架精确报告，仅有正文；工具/技能字数未记录（中继 agent / agent-awake）。")}</div>`;
  }
  html += row("①", "框架基础提示（You are… / runtime / citations）", baseChars, "openclaw 核心运行时指令，任何会话都在");
  html += row(
    "②",
    toolsFromBinding ? "工具 tools（据 AgentBinding 配置范围）" : "工具 tools（schema）",
    toolsFromBinding ? null : (toolChars || null),
    toolNames.length ? toolNames.join(" / ") + (toolsFromBinding ? "　·　字数未记（合约会话无框架报告）" : "") : "（无）",
  );
  // ③ 技能 skills —— 三级嵌套展开：展开 skill → 逐个列 → 每个再展开看它的 head（agent 实际读到的）。
  const skillHeads = (promptDrawerData && promptDrawerData.skillHeads) || {};
  html += `<div class="wf-asm-row wf-skill-row" data-skill-open="0">
    <div class="wf-asm-row-head">
      <span class="wf-asm-idx">③</span>
      <span class="wf-asm-label">${esc("技能 skills" + (skillsFromBinding ? "（据 AgentBinding 配置范围）" : ""))}</span>
      ${!skillsFromBinding && skillChars ? chip(skillChars) : ""}
      ${skillNames.length ? `<button type="button" class="wf-skill-toggle">${esc("展开 skill ▸")}</button>` : ""}
    </div>`;
  if (skillNames.length) {
    html += `<div class="wf-skill-list">`;
    for (const sid of skillNames) {
      const head = skillHeads[sid];
      html += `<div class="wf-skill-item" data-skillitem-open="0">
        <button type="button" class="wf-skillitem-toggle">${esc("▸ " + sid)}</button>
        ${head
          ? `<pre class="wf-skill-head">${esc(String(head))}</pre>`
          : `<div class="wf-skill-head wf-skill-head-missing">${esc("（读不到 head）")}</div>`}
      </div>`;
    }
    html += `</div>`;
    html += `<div class="wf-asm-detail">${esc("head = 注入上下文的描述/元数据（强制注入）；SKILL.md 全文由 agent 判断适用后按需 read（见 session transcript）")}</div>`;
  } else {
    html += `<div class="wf-asm-detail">${esc("（无）")}</div>`;
  }
  html += `</div>`;
  html += row("④", "工作区文件 # Project Context（= 上方正文）", Number.isFinite(proj) ? proj : null, fileNames.length ? fileNames.join(" / ") : "（无）");
  html += row("⑤", "框架尾部（Silent Replies / Heartbeats / Runtime）", null, "含在框架基础统计内");
  html += `<div class="wf-asm-src">${esc("顺序据框架 subagent-registry buildSystemPrompt（lines.push 序）+ systemPromptReport 字数")}</div>`;
  return html;
}

function renderPromptViewBody(view, selectedIsActive) {
  if (!view || view.available !== true) {
    return `<div class="wf-prompt-empty">${esc("此视图不可用")}</div>`;
  }
  const report = view.report && typeof view.report === "object" ? view.report : {};
  const injectedFiles = Array.isArray(view.injectedFiles) ? view.injectedFiles : [];
  const totalContentChars = Number(view.totalContentChars);

  let html = "";
  if (!selectedIsActive) {
    html += `<div class="wf-prompt-note wf-prompt-note-alt">${esc("此为另一模式会用的提示词 —— 本 session 未把它拼进上下文，仅供对比（两路互斥）。")}</div>`;
  }

  const sourceLabel = view.source === "run"
    ? "框架精确报告"
    : view.source === "contract-session-override"
      ? "agent-awake · 系统内部提示词"
      : "openclaw 类型 · 由工作区文件重建";
  html += `<div class="wf-prompt-bar-top">
    <span class="wf-prompt-source wf-prompt-source-${esc(view.source || "unknown")}">${esc(sourceLabel)}</span>`;
  if (Number.isFinite(totalContentChars)) {
    html += `<span class="wf-prompt-total">${totalContentChars.toLocaleString()} ${esc("字")}</span>`;
  }
  html += `</div>`;

  if (view.source === "reconstructed") {
    html += `<div class="wf-prompt-note">${esc("由工作区文件重建（该 session 无运行时精确报告）：以下为会被注入的工作区文件原文，非框架实际拼入的精确字节/裁剪。")}</div>`;
  }

  if (injectedFiles.length === 0) {
    html += `<div class="wf-prompt-empty">${esc("无注入文件")}</div>`;
  } else {
    html += `<div class="wf-prompt-doc">`;
    for (const file of injectedFiles) {
      const name = file.name || (typeof file.path === "string" ? file.path.split("/").pop() : "") || "(file)";
      html += `<div class="wf-prompt-sec">
        <div class="wf-prompt-sec-head">${esc(`── ${name} ──`)}</div>`;
      if (file.content == null) {
        html += `<div class="wf-prompt-sec-missing">${esc("（文件已不在或不可读）")}</div>`;
      } else {
        html += `<pre class="wf-prompt-sec-body">${esc(String(file.content))}</pre>`;
        if (file.truncated) {
          html += `<div class="wf-prompt-sec-trunc">${esc("…（已截断至 40000 字）")}</div>`;
        }
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // 完整装配（默认折叠，放正文最下方）：点开按真实装配顺序展示框架基础/工具/技能/工作区文件各段字数。
  html += `<div class="wf-asm" data-asm-open="0">
    <button type="button" class="wf-asm-toggle">${esc("▸ 点击显示完整装配（按真实装配顺序）")}</button>
    <div class="wf-asm-body">${buildAssemblyHtml(view)}</div>
  </div>`;

  return html;
}

// 点引用文件 → POST /watchdog/reveal-file 触发系统文件管理器（不在网页显示正文）。
async function revealFile(resolvedPath) {
  if (!resolvedPath) return;
  try {
    const response = await fetch(buildApiUrl("/watchdog/reveal-file"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: resolvedPath }),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    toast("已在文件管理器打开", "success");
  } catch (error) {
    toast(`打开失败：${error.message || "ERROR"}`, "error");
  }
}

// ── SSE 驱动「当前任务流程」动态高亮 ─────────────────────────────────────────

// 从任意 SSE 事件提取候选 agentId（兼容 track 与各类 alert 字段）。
function extractEventAgents(data) {
  const ids = [];
  for (const key of ["agentId", "assignee", "targetAgent", "from", "source", "initialStage"]) {
    const value = data?.[key];
    if (typeof value === "string" && value.trim()) ids.push(value.trim());
  }
  return ids;
}

function markRunning(agentIds, running) {
  for (const id of agentIds) {
    if (running) state.runningAgents.add(id);
    else state.runningAgents.delete(id);
  }
  applyRunningHighlight();
}

function applyRunningHighlight() {
  const body = document.getElementById("wfTopoBody");
  if (!body) return;
  body.querySelectorAll(".wf-topo-node").forEach((node) => {
    const id = node.getAttribute("data-agent");
    node.classList.toggle("wf-running", state.runningAgents.has(id));
  });
}

function handleSseEvent(type, data) {
  if (!data || typeof data !== "object") return;
  const agents = extractEventAgents(data).filter((id) => state.activeMembers.has(id));
  if (agents.length === 0) return;
  if (type === "track_end") {
    markRunning(agents, false);
    return;
  }
  // track_start / track_progress / alert(inbox_dispatch/loop_started/loop_advanced) → running 态闪动。
  if (type === "track_start" || type === "track_progress") {
    markRunning(agents, true);
    return;
  }
  if (type === "alert") {
    const alertType = data.type;
    if (alertType === "inbox_dispatch" || alertType === "loop_started" || alertType === "loop_advanced") {
      markRunning(agents, true);
    }
  }
}

function connectSse() {
  const token = getToken();
  let es;
  try {
    es = new EventSource(`/watchdog/stream?token=${encodeURIComponent(token)}`);
  } catch {
    return; // 安静兜底，不刷屏
  }
  state.sse = es;
  for (const type of ["track_start", "track_progress", "track_end", "alert"]) {
    es.addEventListener(type, (event) => {
      let parsed = null;
      try { parsed = JSON.parse(event.data); } catch { return; }
      handleSseEvent(type, parsed);
    });
  }
  es.onerror = () => {
    // 静默重连，不报错刷屏。
    try { es.close(); } catch {}
    state.sse = null;
    state.runningAgents.clear();
    applyRunningHighlight();
    window.setTimeout(connectSse, 5000);
  };
}

// ── 页面装配 ─────────────────────────────────────────────────────────────────

function renderShell(root) {
  root.innerHTML = `
    <div class="wf-grid">
      <section class="wf-region wf-region-topo">
        <div class="wf-region-head">
          <span>${esc(t("nav.workflow"))} • TOPOLOGY</span>
          <span class="wf-region-count" id="wfTopoHead"></span>
        </div>
        <div class="wf-region-body wf-topo-body" id="wfTopoBody">
          <div class="wf-placeholder">${esc("选择 AGENT")}</div>
        </div>
      </section>

      <section class="wf-region wf-region-thumb">
        <div class="wf-region-head">
          <span>OVERVIEW</span>
          <span class="wf-region-count" id="wfThumbCount"></span>
        </div>
        <div class="wf-region-body wf-thumb-body" id="wfThumbHost"></div>
      </section>

      <section class="wf-region wf-region-session">
        <div class="wf-region-head">
          <span>SESSION</span>
        </div>
        <div class="wf-region-body" id="wfSessionBody">
          <div class="wf-placeholder">${esc("选择 AGENT")}</div>
        </div>
      </section>
    </div>
  `;
}

async function loadData() {
  const host = document.getElementById("wfThumbHost");
  const countEl = document.getElementById("wfThumbCount");
  if (!host) return;
  try {
    const [agents, graph, workflows] = await Promise.all([
      fetchJson("/watchdog/agents"),
      fetchJson("/watchdog/inspect?surface=inspect.agent_graph"),
      fetchJson("/watchdog/inspect?surface=inspect.agent_workflows"),
    ]);
    state.agents = Array.isArray(agents) ? agents : [];
    state.edges = Array.isArray(graph?.edges) ? graph.edges : [];
    state.workflows = Array.isArray(workflows?.workflows) ? workflows.workflows : [];
    state.byAgent = workflows?.byAgent && typeof workflows.byAgent === "object" ? workflows.byAgent : {};
    renderThumbnail(host);
    const visibleCount = state.agents.filter(shouldDisplayDashboardAgentRecord).length;
    if (countEl) countEl.textContent = `${visibleCount}`;
    connectSse(); // 数据就绪后再连 SSE（activeMembers 初始为空，事件会被安静过滤）
  } catch (error) {
    host.innerHTML = `<div class="wf-thumb-empty">${esc(error.message || "ERROR")}</div>`;
  }
}

function init() {
  initDashboardSubpage({ page: "workflow", backHref: "/watchdog/progress" });
  const root = document.getElementById("workflowExperience");
  if (!root) return;
  renderShell(root);
  loadData();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
