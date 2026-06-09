// viz-master-knowledge.js — the chart-family knowledge layer for the visualization master.
// Mirrors operator-knowledge.js but scoped to the chart family. DRY: the fragment scorer
// (scoreFragment), the request tokenizer (tokenizeRequest) and the wiki grounding retriever
// (retrieveWikiGroundingNotes) are IMPORTED from operator-knowledge.js — agent-agnostic
// machinery, not re-implemented here. This module only contributes viz-specific static
// fragments + two LIVE fragments (existing charts, chart-scoped capabilities).

import {
  scoreFragment,
  tokenizeRequest,
  retrieveWikiGroundingNotes,
} from "../operator/operator-knowledge.js";
import { normalizeString } from "../core/normalize.js";

const MAX_SELECTED_FRAGMENTS = 6;

// Static, viz-specific grounding. sourcePath points at the chart-build skill (the WHAT/HOW),
// while these fragments carry the WHY/boundary the brain plans against.
const VIZ_STATIC_KNOWLEDGE_FRAGMENTS = Object.freeze([
  {
    id: "chart-build-workflow",
    title: "Chart Build Workflow",
    sourcePath: "skills/chart-build/SKILL.md",
    priority: 10,
    tags: ["chart", "图表", "可视化", "visualization", "line", "bar", "pie", "折线", "柱状", "饼图", "series", "spec", "画图", "数据", "data"],
    summary: "面对一个可视化/图表请求(画折线/柱状/饼图、把一组数据做成图)按 4 步: ①读懂数据(一组或多组扁平 {x,y} 点集,静态非数据流) ②选图表类型(line|bar|pie) ③把数据装进声明式 chart-spec ④emit 恰好一个 apply.chart_create 步骤。viz-master 只产出图表 spec、到 apply.chart_create 为止,渲染由平台手写 SVG 渲染器接管——不写 SVG、不调样式、一个 plan 只建一张图(多图诉求拆成多次请求)。绝不 emit verify 步骤(apply.chart_create 无 verificationCapability)。",
  },
  {
    id: "chart-spec-contract",
    title: "Chart Spec Contract (validateChartSpec)",
    sourcePath: "skills/chart-build/SKILL.md",
    priority: 9,
    tags: ["spec", "schema", "chart", "图表", "validateChartSpec", "契约", "id", "type", "series", "points", "axes"],
    summary: "声明式 chart-spec(version 1)契约,经 validateChartSpec 校验: id 必填 kebab-case(^[a-z0-9][a-z0-9-]{1,48}$,无路径穿越) · type 必填 line|bar|pie · series 非空数组,每条 {name, points:[{x:number|string, y:number}]} 至少一个点 · title/label/axes/render 可选(axes 在 pie 时忽略) · dataBinding 固定 {mode:'static'}(sse 保留未启用)。payload 形如 {spec:{...}}; 同 id 覆盖(upsert)。spec 非法 → 平台直接 {ok:false} 拒绝,所以装数据时严格遵守 schema。",
  },
  {
    id: "chart-family-boundary",
    title: "Chart Family Boundary",
    sourcePath: "skills/chart-build/SKILL.md",
    priority: 9,
    tags: ["boundary", "边界", "chart", "图表", "非真值", "non-truth", "operator", "agent", "graph", "knowledge", "权限", "ownership"],
    summary: "viz-master 是可视化专项 meta-agent,唯一拥有 chart 家族(它是 charts.json 这个非真值控制面的 SOLE WRITER,knowledge-bases.json 同级)。能且仅能写 chart 家族(apply.chart_create / apply.chart_move)+ 读 inspect.charts;绝不碰 agent/graph/knowledge 等结构真值家族——建 agent、改图、跑 loop、改知识库是 operator 的领域,遇到这类诉求交还 operator 或拒绝。charts.json 非真值 → 写图表绝不触发结构快照、绝不进 readTruths。超出 line/bar/pie 扁平点集表达上限(任意 SVG/交互/实时 SSE 绑定)同样拒绝。",
  },
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// LIVE fragment — lists the charts that already exist so the brain UPSERTS by id (overwrites a
// stale chart) instead of inventing a duplicate. Returns null when the board is empty.
function buildExistingChartsFragment(charts = []) {
  const list = Array.isArray(charts) ? charts : [];
  if (list.length === 0) {
    return {
      id: "live-existing-charts",
      title: "Existing Charts (live)",
      sourcePath: "runtime charts.json",
      priority: 8,
      tags: ["chart", "图表", "charts", "已存在", "看板", "board", "upsert", "id"],
      summary: "当前看板没有任何已存在 chart。新建一张时自取一个 kebab-case id 即可。",
    };
  }
  const lines = list
    .map((chart) => {
      const id = normalizeString(chart?.id);
      if (!id) return null;
      const type = normalizeString(chart?.spec?.type || chart?.type) || "?";
      const title = normalizeText(chart?.spec?.title || chart?.label || "");
      return `${id}[${type}]${title ? ` · ${title}` : ""}`;
    })
    .filter(Boolean);
  return {
    id: "live-existing-charts",
    title: "Existing Charts (live)",
    sourcePath: "runtime charts.json",
    priority: 8,
    tags: ["chart", "图表", "charts", "已存在", "看板", "board", "upsert", "id", "覆盖"],
    summary: `当前看板已有 ${lines.length} 张 chart(id[type] · title):\n${lines.join("\n")}\n要更新其中某张,用相同 id 即可(apply.chart_create 是 upsert,同 id 覆盖);要新建,取一个未占用的 kebab-case id,不要重复造同 id。`,
  };
}

// LIVE fragment — the chart-scoped executable surfaces (already narrowed to viz-master ownership by
// the caller via filterExecutableSurfacesForActor). Lists ids so the brain selects a real surface;
// returns null when the (already-filtered) list is empty.
function buildChartCapabilityFragment(surfaces = []) {
  const ids = (Array.isArray(surfaces) ? surfaces : [])
    .map((surface) => normalizeString(surface?.id))
    .filter(Boolean);
  if (ids.length === 0) return null;
  return {
    id: "live-chart-capabilities",
    title: "Live Chart Capabilities",
    sourcePath: "runtime cli-system surfaces",
    priority: 8,
    tags: ["chart", "图表", "surface", "执行", "apply", "chart_create", "chart_move", "可视化", "verify"],
    summary: `viz-master 当前可执行的 chart 面共 ${ids.length} 个:${ids.join("、")}。这就是全部可用动作——只在 chart 家族内规划;不要规划 agent/graph/knowledge 面(无权),也不要 emit verify 步骤(apply.chart_create 无 verificationCapability)。`,
  };
}

// Mirrors buildOperatorKnowledgeContext: score the static + live fragments against the request and
// keep the top-N, plus wiki grounding notes. Reuses the IMPORTED scoreFragment / tokenizeRequest /
// retrieveWikiGroundingNotes — no duplicated scorer/tokenizer/retriever.
export async function buildVizMasterKnowledgeContext({
  requestText,
  charts,
  surfaces,
} = {}) {
  const request = tokenizeRequest(requestText);
  const fragments = [
    ...VIZ_STATIC_KNOWLEDGE_FRAGMENTS,
    buildExistingChartsFragment(charts),
    buildChartCapabilityFragment(surfaces),
  ].filter(Boolean);

  const selectedFragments = fragments
    .map((fragment) => ({ ...fragment, score: scoreFragment(fragment, request) }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, MAX_SELECTED_FRAGMENTS)
    .map(({ score, tags, priority, ...fragment }) => fragment);

  return {
    selectedFragments,
    // Same WHY grounding as operator: wiki-RAG (compiled rationale). searchWiki never throws —
    // degraded/empty on missing embeddings keeps viz-master grounded by selectedFragments.
    retrievedNotes: await retrieveWikiGroundingNotes(requestText, 4),
  };
}

