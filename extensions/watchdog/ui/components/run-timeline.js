// components/run-timeline.js — 透视页核心：三账混排时间线（纯渲染 + 纯函数装配）。
//
// 排序纪律（142 四序铁律的前端投影）：
//   - run 事件按 seq 升序成脊（店内权威序）；
//   - trace 证据行带 anchorSeq 时插到对应事件之后（同锚多行按 (sessionKey, seq) 稳定序）；
//   - 无锚 trace 与 transcript 思考按 ts 就近插入，且一律标 approx:true ——
//     ts 永不作主排序键，近似位必须让读的人看得见（同 run-join.js 的 approx 纪律）。
//   - 证据账里的 session_open/close 生命周期标记（无 name）不进时间线。
import { esc } from "../core/html.js";

const ARGS_DIGEST_CAP = 80;
const THOUGHT_GIST_CAP = 44;

function truncate(text, cap) {
  const s = String(text ?? "");
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

// 思考折叠行只显一行短摘要(首行非空 + 截断);思考全文留到展开(renderThoughtDetail),
// 不在时间线里直接铺全文(2026-08-26 用户裁决:💭 ·「agent」· 短描述,点开才出全文)。
function thoughtGist(content) {
  const firstLine = String(content ?? "").split("\n").find((l) => l.trim()) || "";
  return truncate(firstLine.trim(), THOUGHT_GIST_CAP);
}

// ts 归一：事件/trace 是 epoch ms（数字），transcript 的 ts 是 ISO 串——
// Number("2026-08-…")=NaN 会让思考全部塌到 ts=0 排头（实测 6 条思考堆在 run_triggered 之前）。
// 数字直取，字符串走 Date.parse，让思考按真实时刻「就近」插到对应工具调用旁。
function toEpoch(ts) {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

// 展开详情里的可读本地时间（YYYY-MM-DD HH:mm:ss，本地时区、定长）。值是数据不入键表。
function fmtClock(ts) {
  const ms = toEpoch(ts);
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function safeJson(v, pretty) {
  try {
    return JSON.stringify(v, null, pretty ? 2 : 0);
  } catch {
    return String(v);
  }
}

function argsDigest(args) {
  if (args == null) return "";
  let s;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return truncate(s, ARGS_DIGEST_CAP);
}

// buildTimelineEntries({ events, traces, transcriptMessages }) → 混排条目数组（纯函数）。
// traces 形状：[{ sessionKey, rows: [trace 行] }]（inspect.trace 出闸行，含 anchorSeq/gseq）。
export function buildTimelineEntries({ events = [], traces = [], transcriptMessages = [], transcriptAgentId = null } = {}) {
  const spine = [...events]
    .filter((e) => Number.isInteger(e?.seq))
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      key: `e:${e.seq}`,
      kind: "event",
      ts: Number(e.ts) || 0,
      agentId: e.agentId || null,
      label: e.type || "event",
      outcome: null,
      approx: false,
      detail: e,
    }));

  const anchored = new Map(); // anchorSeq → 条目[]
  const floating = []; // 无锚 trace + 思考，ts 就近
  for (const trace of traces) {
    const sessionKey = trace?.sessionKey || "";
    for (const row of trace?.rows || []) {
      if (!row?.name) continue; // session_open/close 生命周期标记不进时间线
      const entry = {
        key: `t:${sessionKey}:${row.seq}`,
        kind: "tool",
        ts: Number(row.ts) || 0,
        agentId: row.agentId || null,
        sessionKey,
        label: row.name,
        // 解耦双标签透传：trace schema 天生正交（kind=internal|collab × channel=fc|fence|text）；
        // 带进 entry 才能在行里显小标，让「任何执行源都能投进来」可见（trace-event-schema.js）。
        traceKind: row.kind || null,
        traceChannel: row.channel || null,
        outcome: row.outcome || null,
        argsDigest: argsDigest(row.args),
        approx: !(Number.isInteger(row.anchorSeq) && row.anchorSeq != null),
        detail: row,
      };
      if (entry.approx) {
        floating.push(entry);
      } else {
        const bucket = anchored.get(row.anchorSeq) || [];
        bucket.push(entry);
        anchored.set(row.anchorSeq, bucket);
      }
    }
  }
  for (const bucket of anchored.values()) {
    bucket.sort((a, b) => String(a.sessionKey).localeCompare(String(b.sessionKey)) || a.key.localeCompare(b.key));
  }

  (transcriptMessages || []).forEach((message, mi) => {
    if (message?.role !== "assistant") return; // 只看 agent 侧思考/文本
    const content = message.thinking || message.text || "";
    if (!content) return;
    const ts = toEpoch(message.ts);
    // key 用 transcript 内序号 mi(append-only,跨轮询稳定);
    // 旧 floating.length 会随无锚 trace 增多漂移,轮询后展开态就丢。
    floating.push({
      key: `m:${ts}:${mi}`,
      kind: "thought",
      ts,
      agentId: transcriptAgentId, // 思考归属=该 transcript 所属 agent(loadSessionData 选中的 agent)
      label: "",
      content,
      outcome: null,
      approx: true, // transcript 无任何权威序键，ts 就近是近似位
      detail: { role: message.role, ts: message.ts, thinking: message.thinking, text: message.text },
    });
  });

  // 装配：事件脊 + 锚定桶就近挂在锚事件后。
  const out = [];
  for (const event of spine) {
    out.push(event);
    const bucket = anchored.get(Number(event.detail.seq));
    if (bucket) out.push(...bucket);
  }
  // 锚到不存在事件的桶（跨 run 锚/锚 seq 已 GC）：降级为浮动，不留白。
  for (const [seq, bucket] of anchored) {
    if (!spine.some((e) => Number(e.detail.seq) === seq)) floating.push(...bucket);
  }
  // 浮动条目 ts 就近：找最后一条 ts <= 自身 ts 的已就位条目，插到其后；都没有 → 排头。
  floating.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
  for (const item of floating) {
    let at = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].ts <= item.ts) { at = i; break; }
    }
    out.splice(at + 1, 0, item);
  }
  return out;
}

// 三类 kind 的字形：◆ 生命周期里程碑（可染色文本）/ 🔧 工具调用 / 💭 思考（后二者 emoji 本色）。
const GLYPHS = { event: "◆", tool: "🔧", thought: "💭" };

function tailId(id) {
  if (!id) return "";
  const s = String(id);
  const i = s.lastIndexOf("-");
  return i >= 0 ? s.slice(i + 1) : s;
}

// 事件类型 → 人类可读描述（走 i18n；未知类型回退原始 type，不显示裸键）。
function eventLabel(type, t) {
  const key = `inspect.event.${type}`;
  const translated = t(key);
  return translated === key ? type : translated;
}

// 事件副标题：从 payload 提炼一眼关键信息（值都是数据/英文枚举，不入 i18n 键表）。
function eventSubtitle(ev) {
  const p = (ev && ev.payload) || {};
  switch (ev && ev.type) {
    case "dispatched": return p.from && p.to ? `${p.from} → ${p.to}` : "";
    case "closed": return p.terminalStatus || "";
    case "contract_created": return p.status || "";
    case "declared": return p.status || ""; // agent 声明的状态(completed/running…)
    case "run_triggered": return p.origin || "";
    case "run_closed": return tailId(p.lastContractId);
    case "ticket_written":
    case "delivered": return tailId(p.ticketId);
    default: return "";
  }
}

// 状态值语义色:让「这步成没成」一眼可见。pending/queued=中性,running=蓝
// (08-26 裁决「运行=蓝」,橙留给 CTA/选中/强调),completed/done=绿,failed/error=红。
// 非状态副标题(webui/from→to/id)不命中,保持素净灰。
const STATUS_TONE = {
  completed: "ok", done: "ok", succeeded: "ok",
  failed: "fail", error: "fail", aborted: "fail",
  running: "run", active: "run", in_progress: "run",
  pending: "muted", queued: "muted", waiting: "muted",
};
function statusClass(val) {
  const tone = STATUS_TONE[String(val || "").trim().toLowerCase()];
  return tone ? ` tl-st-${tone}` : "";
}

// 事件成败：closed 终局事件按 terminalStatus 上色（failed=红 让「红=失败」一致；completed=绿）。
function eventOutcome(ev) {
  if (ev && ev.type === "closed") {
    const st = ev.payload && ev.payload.terminalStatus;
    if (st === "failed") return "failed";
    if (st === "completed") return "done";
  }
  return null;
}

// 执行主体：event/tool 带 agentId 直接显；生命周期事件常无 agentId（平台系统盖章）→ 走 i18n 的「系统」。
// thought 无主体列 → 空。
function actorLabel(entry, t) {
  if (entry.agentId) return entry.agentId;
  if (entry.kind === "event") return t("inspect.actor.system");
  return "";
}

// 解耦小标：trace 正交双标签 kind·channel（如 internal·fc / collab·text）；缺列则显在场的一个。
function toolTag(entry) {
  const k = entry.traceKind;
  const c = entry.traceChannel;
  if (k && c) return `${k}·${c}`;
  return k || c || "";
}

// ── 多合约 run 的交织可读性：合约尾号小 chip ──
// L1 assign_task 中场协作是合法并发——一个 run 里多个合约的事件交织不是 bug。
// run 内出现 >1 个 contractId 时，每行（event/tool，detail 带 contractId 者）加合约末 6 位
// muted 等宽小 chip，让「哪行属哪份合约」一眼可辨；单合约 run 不加（不添噪）。
function entryContractId(entry) {
  return entry?.detail?.contractId || null;
}

function contractChip(entry) {
  const cid = entryContractId(entry);
  return cid ? `<span class="tl-contract">${esc(String(cid).slice(-6))}</span>` : "";
}

// ── 展开详情：可读结构化视图（KV/分组），取代裸 JSON dump ──
// KV 行：左标签（muted 小字）+ 右值（可含 HTML，值在调用点已转义）。block 变体让多行值顶对齐。
function kv(label, valueHtml, block = false) {
  return `<div class="tl-kv${block ? " tl-kv-block" : ""}">`
    + `<span class="tl-kv-k">${esc(label)}</span>`
    + `<span class="tl-kv-v">${valueHtml}</span></div>`;
}

// 因果来源：causeRefs 逐条 runId#seq（同 run 常见，runId 作 title 兜信息、seq 常驻）。
function renderCauseRefs(refs) {
  if (!Array.isArray(refs) || !refs.length) return "";
  return refs
    .map((r) => `<span class="tl-ref" title="${esc(String(r?.runId ?? ""))}">`
      + `${esc(String(r?.runId ?? ""))}#${esc(String(r?.seq ?? ""))}</span>`)
    .join("");
}

// payload 逐字段：key（muted）+ value（对象 JSON、其余原值）。值是数据/英文枚举，不入键表。
function renderPayloadFields(payload) {
  if (!payload || typeof payload !== "object") return "";
  const keys = Object.keys(payload);
  if (!keys.length) return "";
  const rows = keys.map((k) => {
    const v = payload[k];
    const text = v !== null && typeof v === "object" ? safeJson(v, false) : String(v);
    return `<div class="tl-field"><span class="tl-field-k">${esc(k)}</span>`
      + `<span class="tl-field-v">${esc(text)}</span></div>`;
  }).join("");
  return `<div class="tl-fields">${rows}</div>`;
}

// 原始 JSON 折叠块：取证不丢。原生 <details>，无 store 态、无 data-action（在 tl-detail 内、
// 不在可点行 div 内，clos­est 不命中 toggle-entry，点开点收都归浏览器）。
function rawBlock(detail, t) {
  return `<details class="tl-raw"><summary class="tl-raw-sum">${esc(t("inspect.detail.raw"))}</summary>`
    + `<pre class="tl-raw-pre">${esc(safeJson(detail, true))}</pre></details>`;
}

// event 详情：执行主体 · 时间 · 类型(英文+中文描述) · 合约 · 因果来源 · payload 逐字段。
function renderEventDetail(entry, t) {
  const ev = entry.detail || {};
  const rows = [];
  rows.push(kv(t("inspect.detail.actor"), esc(ev.agentId || t("inspect.actor.system"))));
  rows.push(kv(t("inspect.detail.time"), esc(fmtClock(ev.ts))));
  rows.push(kv(
    t("inspect.detail.type"),
    `<span class="tl-kv-type">${esc(ev.type || "")}</span>`
      + `<span class="tl-kv-desc">${esc(eventLabel(ev.type, t))}</span>`,
  ));
  if (ev.contractId) rows.push(kv(t("inspect.detail.contract"), esc(ev.contractId)));
  const causes = renderCauseRefs(ev.causeRefs);
  if (causes) rows.push(kv(t("inspect.detail.cause"), causes, true));
  const fields = renderPayloadFields(ev.payload);
  if (fields) rows.push(kv(t("inspect.detail.payload"), fields, true));
  return rows.join("") + rawBlock(ev, t);
}

// tool 详情：执行主体 · 工具名 · kind·channel · args(完整展开) · outcome · 拒因/错误。
function renderToolDetail(entry, t) {
  const row = entry.detail || {};
  const rows = [];
  if (row.agentId) rows.push(kv(t("inspect.detail.actor"), esc(row.agentId)));
  rows.push(kv(t("inspect.detail.tool"), `<span class="tl-kv-type">${esc(row.name || entry.label || "")}</span>`));
  const tag = toolTag(entry);
  if (tag) rows.push(kv(t("inspect.detail.channel"), esc(tag)));
  if (row.args != null) {
    rows.push(kv(t("inspect.detail.args"), `<pre class="tl-args-full">${esc(safeJson(row.args, true))}</pre>`, true));
  }
  if (row.outcome) {
    rows.push(kv(
      t("inspect.detail.outcome"),
      `<span class="tl-kv-outcome tl-oc-${esc(row.outcome)}">${esc(row.outcome)}</span>`,
    ));
  }
  const reason = row.result && row.result.blockReason;
  if (reason) rows.push(kv(t("inspect.detail.blockReason"), `<span class="tl-kv-reason">${esc(reason)}</span>`, true));
  if (row.error != null) {
    const errText = typeof row.error === "string" ? row.error : safeJson(row.error, false);
    rows.push(kv(t("inspect.detail.error"), `<span class="tl-kv-reason">${esc(errText)}</span>`, true));
  }
  return rows.join("") + rawBlock(row, t);
}

// thought 详情：时间 · 思考全文 · 回复文本（不再截断，展开即全文）。
function renderThoughtDetail(entry, t) {
  const d = entry.detail || {};
  const rows = [];
  rows.push(kv(t("inspect.detail.time"), esc(fmtClock(d.ts))));
  if (d.thinking) rows.push(kv(t("inspect.detail.thinking"), `<div class="tl-kv-prose">${esc(d.thinking)}</div>`, true));
  if (d.text) rows.push(kv(t("inspect.detail.text"), `<div class="tl-kv-prose">${esc(d.text)}</div>`, true));
  return rows.join("") + rawBlock(d, t);
}

function renderDetail(entry, t) {
  if (entry.kind === "event") return renderEventDetail(entry, t);
  if (entry.kind === "tool") return renderToolDetail(entry, t);
  return renderThoughtDetail(entry, t);
}

const DOT = `<span class="tl-dot" aria-hidden="true">·</span>`;

// 四段式行：[执行主体] · [英文type/工具名] · [中文描述/kind·channel 小标] · [小字payload/args] + 右侧 outcome 徽章。
// 英文 type 常驻（未知新类型也能读，这是解耦落点）；outcome 三态上色见 CSS（refused=红/error=琥珀/ok=中性）。
function renderRow(entry, expandedKey, t, highlightAgentId = null, showContractChip = false) {
  const classes = ["tl-row", `tl-${entry.kind}`];
  // 选中 agent 时用「聚焦」区分,不碰 border-left(那条留给失败红边)：
  //   选中 agent 的行 → tl-mine(主体名标蓝);别的 agent 的行 → tl-faded(淡出);
  //   系统行(无 agentId)不动,留作 run 骨架。
  if (highlightAgentId) {
    if (entry.agentId === highlightAgentId) classes.push("tl-mine");
    else if (entry.agentId) classes.push("tl-faded");
  }
  const actor = actorLabel(entry, t);
  const seg = [];
  if (entry.kind === "event") {
    const eo = eventOutcome(entry.detail);
    if (eo === "failed") classes.push("tl-event-failed");
    else if (eo === "done") classes.push("tl-event-done");
    const subtitle = eventSubtitle(entry.detail);
    if (actor) seg.push(`<span class="tl-actor">${esc(actor)}</span>`);
    seg.push(`<span class="tl-type">${esc(entry.label)}</span>`);
    if (showContractChip) {
      const chip = contractChip(entry);
      if (chip) seg.push(chip);
    }
    seg.push(`<span class="tl-label">${esc(eventLabel(entry.label, t))}</span>`);
    if (subtitle) seg.push(`<span class="tl-sub${statusClass(subtitle)}">${esc(subtitle)}</span>`);
  } else if (entry.kind === "tool") {
    if (entry.outcome === "refused") classes.push("tl-refused");
    else if (entry.outcome === "error") classes.push("tl-errored");
    const tag = toolTag(entry);
    if (actor) seg.push(`<span class="tl-actor">${esc(actor)}</span>`);
    seg.push(`<span class="tl-label">${esc(entry.label)}</span>`);
    if (showContractChip) {
      const chip = contractChip(entry);
      if (chip) seg.push(chip);
    }
    if (tag) seg.push(`<span class="tl-tag">${esc(tag)}</span>`);
    if (entry.argsDigest) seg.push(`<span class="tl-args">${esc(entry.argsDigest)}</span>`);
  } else if (entry.kind === "thought") {
    // 折叠态只显 💭 · agent · 短摘要(一行);思考全文点开才出(renderThoughtDetail)。
    if (entry.agentId) seg.push(`<span class="tl-actor tl-thought-actor">${esc(entry.agentId)}</span>`);
    seg.push(`<span class="tl-thought-preview">${esc(thoughtGist(entry.content))}</span>`);
  }
  const main = `<span class="tl-main">${seg.join(DOT)}</span>`;
  let tail = "";
  if (entry.kind === "tool" && entry.outcome) tail += `<span class="tl-outcome">${esc(entry.outcome)}</span>`;
  if (entry.approx) tail += `<span class="tl-approx" title="${esc(t("inspect.timeline.approx"))}">~</span>`;
  const expanded = entry.key === expandedKey;
  if (expanded) classes.push("tl-open");
  let html = `<div class="${classes.join(" ")}" data-action="toggle-entry" data-entry-key="${esc(entry.key)}">`
    + `<span class="tl-glyph">${GLYPHS[entry.kind] || "·"}</span>`
    + `${main}${tail}</div>`;
  if (expanded) {
    html += `<div class="tl-detail">${renderDetail(entry, t)}</div>`;
  }
  return html;
}

// 图例：三类 kind 字形 + 两态失败语义色，让读的人一眼对上
// 「◆=生命周期 / 🔧=工具 / 💭=思考 / 红=被平台拦(refused|closed=failed) / 琥珀=工具报错(error)」。
function renderLegend(t) {
  const items = [
    { g: "◆", cls: "tl-lg-event", label: t("inspect.legend.event") },
    { g: "🔧", cls: "tl-lg-tool", label: t("inspect.legend.tool") },
    { g: "💭", cls: "tl-lg-thought", label: t("inspect.legend.thought") },
    { g: "■", cls: "tl-lg-fail", label: t("inspect.legend.failure") },
    { g: "■", cls: "tl-lg-error", label: t("inspect.legend.error") },
  ];
  const body = items
    .map((it) => `<span class="tl-lg-item"><span class="tl-lg-glyph ${it.cls}">${it.g}</span>${esc(it.label)}</span>`)
    .join("");
  return `<div class="tl-legend">${body}</div>`;
}

export function renderRunTimeline(model = {}, t) {
  // 默认 snapshot（思考藏起,按钮点开）：2026-08-26 用户裁决——默认干净流程骨架
  // (生命周期+工具),思考经「💭 显示思考」按钮浮现。mode 二态:full=含思考 / snapshot=仅骨架。
  const { entries = [], mode = "snapshot", expandedKey = null, highlightAgentId = null } = model;
  const thoughtsShown = mode !== "snapshot";
  const visible = thoughtsShown ? entries : entries.filter((e) => e.kind !== "thought");
  // 多合约判定按全量 entries（不随 mode 过滤漂移）：>1 个 contractId 才开 chip。
  const contractIds = new Set();
  for (const e of entries) {
    const cid = entryContractId(e);
    if (cid) contractIds.add(cid);
  }
  const showContractChip = contractIds.size > 1;
  const nextMode = thoughtsShown ? "snapshot" : "full";
  // 按钮标当前动作：显思考态 → 提供「隐藏思考」；隐思考态 → 提供「显示思考」。on 态橙描边即时反馈。
  const toggleLabel = thoughtsShown ? t("inspect.thinking.hide") : t("inspect.thinking.show");
  let html = `<div class="run-timeline">`
    + `<div class="tl-head">`
    + renderLegend(t)
    + `<button type="button" class="tl-mode${thoughtsShown ? " tl-mode-on" : ""}"`
    + ` data-action="set-mode" data-mode="${nextMode}" aria-pressed="${thoughtsShown}">`
    + `<span class="tl-mode-glyph" aria-hidden="true">💭</span>${esc(toggleLabel)}</button>`
    + `</div>`;
  if (!visible.length) {
    return `${html}<div class="tl-empty">${esc(t("inspect.timeline.empty"))}</div></div>`;
  }
  for (const entry of visible) html += renderRow(entry, expandedKey, t, highlightAgentId, showContractChip);
  return `${html}</div>`;
}
