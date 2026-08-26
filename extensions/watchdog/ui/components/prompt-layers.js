// components/prompt-layers.js — 提示词装配 Tab（纯渲染）。
// 2026-08-25 重制：从老版扁平清单 → 六层装配栈遥测读数。
// 每层一行：在场灯 + 层名 + 度量位 + 字符数。三态：
//   · 可度量层（有 chars>0：role/soul/wake）→ 橙比例条 + 原值字符数；
//   · 结构层（present 但无 chars：framework/tools/skills 是绑定/框架注入，本无字数）→ 结构标记，不画空白条；
//   · 缺席层（present=false）→ 灯空心、条隐藏、整行压暗。
// 数据 = inspect.session_system_prompt 出闸：layers[]（framework/tools/skills/role/soul/wake）
// + injectedFiles 正文 + activePath/source 角标。展开层看正文（含 source 一行）。
import { esc } from "../core/html.js";

// 条宽归一：以本次装配里最长一层的 chars 为满格，绝对字符数直觉可比。
function layerBarWidth(layer, maxChars) {
  if (!Number.isFinite(layer.chars) || layer.chars <= 0 || maxChars <= 0) return 0;
  return Math.max(4, Math.round((layer.chars / maxChars) * 100));
}

// 取证工具：字符数显示原值（不缩写 k），精度不丢；占比条负责一眼看大小。
function formatChars(n) {
  return Number.isFinite(n) ? String(n) : "";
}

function renderLayer(layer, openLayer, maxChars, t) {
  const present = layer.present === true;
  const cls = present ? "pl-layer-present" : "pl-layer-absent";
  const open = present && openLayer === layer.layer;
  // 可度量层（有正的 chars：role/soul/wake）→ 橙比例条 + 原值；
  // 结构层（present 但无 chars：framework/tools/skills 是绑定/框架注入，本无字数）→ 结构标记，
  //   不再画 width=0 的空白条（那正是「全白不知所以」的病根）。缺席层 → 条隐藏（CSS）。
  const measurable = present && Number.isFinite(layer.chars) && layer.chars > 0;
  const width = measurable ? layerBarWidth(layer, maxChars) : 0;
  const chars = measurable ? formatChars(layer.chars) : "—";
  const gauge = measurable
    ? `<span class="pl-bar"><span class="pl-bar-fill" style="width: ${width}%"></span></span>`
    : (present
        ? `<span class="pl-bar-na">${esc(t("inspect.prompt.structural"))}</span>`
        : `<span class="pl-bar"></span>`);

  let html = `<div class="pl-layer ${cls}${open ? " open" : ""}" data-action="toggle-layer" data-layer="${esc(layer.layer)}">`
    + `<span class="pl-lamp"></span>`
    + `<span class="pl-layer-name">${esc(layer.name || layer.layer)}</span>`
    + gauge
    + `<span class="pl-chars">${esc(chars)}</span>`
    + `</div>`;
  if (open) {
    if (layer.source) {
      html += `<div class="pl-layer-source">${esc(t("inspect.prompt.source"))}: ${esc(layer.source)}</div>`;
    }
    if (typeof layer.content === "string" && layer.content) {
      html += `<pre class="pl-layer-content">${esc(layer.content)}</pre>`;
    }
  }
  return html;
}

function renderFile(file, openFile, t) {
  const name = file.name || file.path || "?";
  const open = openFile === name;
  let meta = Number.isFinite(file.contentChars)
    ? `<span class="pl-meta">${esc(formatChars(file.contentChars))}</span>` : "";
  if (file.truncated === true) {
    meta += `<span class="pl-truncated">${esc(t("inspect.prompt.truncated"))}</span>`;
  }
  let html = `<div class="pl-file-row${open ? " open" : ""}" data-action="toggle-file" data-file="${esc(name)}">`
    + `<span class="pl-file-name">${esc(name)}</span>${meta}</div>`;
  if (open && typeof file.content === "string" && file.content) {
    html += `<pre class="pl-file-content">${esc(file.content)}</pre>`;
  }
  return html;
}

export function renderPromptLayers(model = {}, t) {
  const { report = null, openLayer = null, openFile = null } = model;
  if (!report || report.available !== true) {
    return `<div class="prompt-layers"><div class="pl-unavailable">${esc(t("inspect.prompt.unavailable"))}</div></div>`;
  }
  const layers = report.layers || [];
  const presentCount = layers.filter((l) => l.present === true).length;
  const maxChars = layers.reduce((m, l) => (Number.isFinite(l.chars) && l.chars > m ? l.chars : m), 0);

  let html = `<div class="prompt-layers">`
    + `<div class="pl-head">`
    + `<span class="pl-head-title">${esc(t("inspect.prompt.stackTitle"))}</span>`
    + `<span class="pl-meta">${esc(t("inspect.prompt.stackCount", { present: presentCount, total: layers.length }))}</span>`
    + `<span class="pl-meta">${esc(t("inspect.prompt.activePath"))}: ${esc(report.activePath || "-")}</span>`
    + `</div>`
    + `<div class="pl-stack">`;
  for (const layer of layers) html += renderLayer(layer, openLayer, maxChars, t);
  html += `</div>`;

  const files = Array.isArray(report.injectedFiles) ? report.injectedFiles : [];
  if (files.length) {
    html += `<div class="pl-files-title">${esc(t("inspect.prompt.injectedFiles"))} (${files.length})</div>`;
    for (const file of files) html += renderFile(file, openFile, t);
  }
  return `${html}</div>`;
}
