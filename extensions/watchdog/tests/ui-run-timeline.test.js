import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTimelineEntries, renderRunTimeline } from "../ui/components/run-timeline.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });
const base = 1_700_000_000_000;

const events = [
  { seq: 1, ts: base, type: "run_triggered", contractId: "C-1" },
  { seq: 2, ts: base + 100, type: "contract_created", contractId: "C-1", agentId: "w-a", sessionKey: "s-1" },
  { seq: 3, ts: base + 400, type: "collected", contractId: "C-1", agentId: "w-a", sessionKey: "s-1" },
];

const traces = [
  {
    sessionKey: "s-1",
    rows: [
      { seq: 1, ts: base + 150, name: "read", args: { path: "inbox/c.json" }, outcome: "ok",
        agentId: "w-a", anchorRunId: "r-1", anchorSeq: 2, gseq: 11 },
      { seq: 2, ts: base + 200, name: "write", args: { path: "outbox/r.md" }, outcome: "refused",
        agentId: "w-a", anchorRunId: "r-1", anchorSeq: 2, gseq: 12 },
      { seq: 3, ts: base + 300, name: "bash", args: { cmd: "ls" }, outcome: "ok",
        agentId: "w-a", anchorRunId: null, anchorSeq: null, gseq: 13 },
      { seq: 0, ts: base + 50, kind: "session_open", sessionKey: "s-1", agentId: "w-a" },
    ],
  },
];

const transcriptMessages = [
  { role: "assistant", ts: base + 180, thinking: "I should read the contract first and then write the report carefully", text: "" },
  { role: "user", ts: base + 90, text: "do the task" },
];

test("run-timeline 混排：事件按 seq 成脊，锚定 trace 插到对应事件后", () => {
  const entries = buildTimelineEntries({ events, traces, transcriptMessages: [] });
  const kinds = entries.map((e) => `${e.kind}:${e.label}`);
  // 脊: seq1 → [read, write 锚在 seq2 后但先排?] 锚定插入: e2 后跟 read/write; bash 无锚按 ts 就近
  assert.deepEqual(kinds, [
    "event:run_triggered",
    "event:contract_created",
    "tool:read",
    "tool:write",
    "tool:bash",
    "event:collected",
  ]);
  // 无锚的 bash(ts=base+300) 就近插到 ts<=300 的末位之后 = write 之后,标 approx
  const bash = entries.find((e) => e.label === "bash");
  assert.equal(bash.approx, true, "无锚 trace 标近似位");
  const read = entries.find((e) => e.label === "read");
  assert.equal(read.approx, false, "锚定 trace 不是近似位");
  // session_open 无 name = 生命周期标记,不进时间线
  assert.ok(!entries.some((e) => e.label === "session_open"));
});

test("run-timeline 混排：transcript 思考按 ts 就近插入并标 approx", () => {
  const entries = buildTimelineEntries({ events, traces, transcriptMessages });
  const thought = entries.find((e) => e.kind === "thought");
  assert.ok(thought, "思考条目在场");
  assert.equal(thought.approx, true);
  // ts=base+180 → 就近在 read(base+150) 之后、write(base+200) 之前
  const labels = entries.map((e) => e.label || e.kind);
  const at = labels.indexOf("thought");
  assert.equal(labels[at - 1], "read");
  assert.equal(labels[at + 1], "write");
  // user 消息不进（只看 agent 侧思考/文本）
  assert.equal(entries.filter((e) => e.kind === "thought").length, 1);
});

test("run-timeline 渲染：快照态只 ◆+🔧，完整态含 💭", () => {
  const entries = buildTimelineEntries({ events, traces, transcriptMessages });
  const snapshot = renderRunTimeline({ entries, mode: "snapshot", expandedKey: null }, i18n.t);
  assert.match(snapshot, /tl-row tl-event/);
  assert.match(snapshot, /tl-row tl-tool/);
  assert.doesNotMatch(snapshot, /tl-row tl-thought/, "快照态不渲染思考");
  assert.match(snapshot, /data-action="set-mode" data-mode="full"/);

  const full = renderRunTimeline({ entries, mode: "full", expandedKey: null }, i18n.t);
  assert.match(full, /tl-row tl-thought/);
  assert.match(full, /data-action="set-mode" data-mode="snapshot"/);
});

test("run-timeline 渲染：refused 标红 + 点行展开 payload", () => {
  const entries = buildTimelineEntries({ events, traces, transcriptMessages: [] });
  const html = renderRunTimeline({ entries, mode: "snapshot", expandedKey: null }, i18n.t);
  assert.match(html, /tl-row tl-tool tl-refused/, "refused 行带标红类");
  assert.match(html, /data-action="toggle-entry" data-entry-key=/, "行可点");

  const write = entries.find((e) => e.label === "write");
  const expanded = renderRunTimeline({ entries, mode: "snapshot", expandedKey: write.key }, i18n.t);
  assert.match(expanded, /tl-detail/, "展开行带 details 抽屉");
  assert.match(expanded, /outbox\/r\.md/, "抽屉里是美化后的 payload JSON");
});

// ── ②③ 事件描述 + kind 区分 + 颜色语义 ──
const lifecycleEvents = [
  { seq: 1, ts: base, type: "run_triggered", payload: { origin: "webui" } },
  { seq: 2, ts: base + 100, type: "dispatched", agentId: "planner", payload: { from: "controller", to: "planner" } },
  { seq: 3, ts: base + 200, type: "closed", payload: { terminalStatus: "failed", reason: "contract.output missing_file" } },
  { seq: 4, ts: base + 300, type: "delivered", payload: { ticketId: "dlv-TC-123-abc", suppressed: false } },
  { seq: 5, ts: base + 400, type: "mystery_event" },
];

test("run-timeline ②: 事件类型渲染人类可读描述 + 未知类型回退原始 type（不泄漏裸键）", () => {
  const entries = buildTimelineEntries({ events: lifecycleEvents });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  assert.match(html, /<span class="tl-label">run triggered<\/span>/, "run_triggered → 人类可读");
  assert.match(html, /<span class="tl-label">dispatched<\/span>/);
  assert.match(html, /<span class="tl-label">contract closed<\/span>/);
  assert.match(html, /<span class="tl-label">delivered<\/span>/);
  // 未知类型无 i18n 键 → 回退原始 type（不显示裸键 inspect.event.*）
  assert.match(html, /<span class="tl-label">mystery_event<\/span>/);
  assert.doesNotMatch(html, /inspect\.event\./, "不泄漏裸 i18n 键");
});

test("run-timeline ②: 事件副标题从 payload 提炼关键信息", () => {
  const entries = buildTimelineEntries({ events: lifecycleEvents });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  assert.match(html, /tl-sub">controller → planner</, "dispatched from→to");
  assert.match(html, /tl-sub tl-st-fail">failed</, "closed 终局态(带失败语义色)");
  assert.match(html, /tl-sub">abc</, "delivered ticket 末段(非状态,无语义色)");
});

test("run-timeline ③: 失败语义色（closed=failed→红里程碑；红只在失败处）", () => {
  const entries = buildTimelineEntries({ events: lifecycleEvents });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  assert.match(html, /tl-row tl-event tl-event-failed/, "closed=failed 行标失败类");
  // 非失败事件（run_triggered）不带任何红失败类
  const triggerRow = html.split('data-action="toggle-entry"').find((r) => r.includes("run triggered"));
  assert.ok(triggerRow && !/tl-event-failed|tl-refused/.test(triggerRow), "非失败事件不带红失败类");
});

test("run-timeline ③: closed=completed → 完成绿里程碑", () => {
  const entries = buildTimelineEntries({ events: [{ seq: 1, ts: base, type: "closed", payload: { terminalStatus: "completed" } }] });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  assert.match(html, /tl-row tl-event tl-event-done/);
  assert.match(html, /tl-sub tl-st-ok">completed</, "completed 带完成绿语义色");
});

test("run-timeline ③: 图例三类 kind + 失败两态（常驻头部；红=refused/琥珀=error 可辨）", () => {
  const html = renderRunTimeline({ entries: [], mode: "snapshot" }, i18n.t);
  assert.match(html, /tl-legend/, "图例容器");
  assert.match(html, /tl-lg-event/);
  assert.match(html, /tl-lg-fail/);
  assert.match(html, /tl-lg-error/, "琥珀 error 图例项（与 refused 红可辨）");
  assert.match(html, /lifecycle/);
  assert.match(html, /tool call/);
  assert.match(html, /thinking/);
  assert.match(html, /failed \/ refused/);
  assert.match(html, /tool error/, "error 含义在图例可读");
});

// ── A. 四段式 + 解耦双标签（kind·channel）+ 执行主体 ──
// trace schema 天生正交：kind ∈ {internal,collab} × channel ∈ {fc,fence,text}（trace-event-schema.js）。
// 实测数据全 internal·fc，但字段在场——前端必须按可能有 collab 渲染。
const decoupledTraces = [
  {
    sessionKey: "s-2",
    rows: [
      { seq: 1, ts: base + 10, name: "read", args: { path: "inbox/c.json" }, outcome: "ok",
        kind: "internal", channel: "fc", agentId: "worker", anchorSeq: 2, gseq: 21 },
      { seq: 2, ts: base + 20, name: "read", args: { path: "outbox/x" }, outcome: "error",
        kind: "internal", channel: "fc", agentId: "worker", anchorSeq: 2, gseq: 22 },
      { seq: 3, ts: base + 30, name: "assign_task", args: { to: "w2" }, outcome: "ok",
        kind: "collab", channel: "text", agentId: "worker", anchorSeq: 2, gseq: 23 },
    ],
  },
];

test("run-timeline A: tool entry 透传 traceKind/traceChannel（解耦双标签带进条目）", () => {
  const entries = buildTimelineEntries({ events, traces: decoupledTraces });
  const readOk = entries.find((e) => e.kind === "tool" && e.label === "read" && e.outcome === "ok");
  assert.equal(readOk.traceKind, "internal", "kind 透传");
  assert.equal(readOk.traceChannel, "fc", "channel 透传");
  const collab = entries.find((e) => e.traceKind === "collab");
  assert.ok(collab, "collab 行在场");
  assert.equal(collab.traceChannel, "text");
});

test("run-timeline A: tool 行四段式——执行主体 + 工具名 + kind·channel 小标 + outcome 徽章", () => {
  const entries = buildTimelineEntries({ events, traces: decoupledTraces });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  assert.match(html, /tl-actor">worker</, "执行主体 agentId 常驻");
  assert.match(html, /tl-tag">internal·fc</, "internal·fc 小标显出解耦结构");
  assert.match(html, /tl-tag">collab·text</, "collab 行按 kind·channel 可区分");
  assert.match(html, /tl-outcome">ok</, "outcome 徽章在场");
});

test("run-timeline A: event 行——英文 type 常驻(等宽次级) + 执行主体(agentId 或 系统)", () => {
  const entries = buildTimelineEntries({ events: lifecycleEvents });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  const rows = html.split('data-action="toggle-entry"');
  const trigRow = rows.find((r) => r.includes("run triggered"));
  assert.match(trigRow, /tl-actor">SYSTEM</, "无 agentId 事件→系统(i18n)");
  assert.match(trigRow, /tl-type">run_triggered</, "英文原始 type 常驻(解耦落点，未知新类型也能读)");
  const dispRow = rows.find((r) => r.includes(">dispatched<"));
  assert.match(dispRow, /tl-actor">planner</, "带 agentId 事件→显 agentId");
});

// ── B. outcome 三态可辨：ok=中性 / refused=红(tl-refused) / error=琥珀(tl-errored) ──
test("run-timeline B: refused=红 与 error=琥珀 互不混淆（补齐 error 上色缺口）", () => {
  const mixed = [
    {
      sessionKey: "s-3",
      rows: [
        { seq: 1, ts: base + 10, name: "write", args: {}, outcome: "refused",
          kind: "internal", channel: "fc", agentId: "w", anchorSeq: 2 },
        { seq: 2, ts: base + 20, name: "read", args: {}, outcome: "error",
          kind: "internal", channel: "fc", agentId: "w", anchorSeq: 2 },
      ],
    },
  ];
  const entries = buildTimelineEntries({ events, traces: mixed });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  // 按行 div 起点切（类列表在 data-action 之前，故切 data-action 会把类挪到上一块）
  const rows = html.split('<div class="tl-row').slice(1);
  const refusedRow = rows.find((r) => r.includes('tl-outcome">refused'));
  const errorRow = rows.find((r) => r.includes('tl-outcome">error'));
  assert.ok(refusedRow && /tl-refused/.test(refusedRow) && !/tl-errored/.test(refusedRow), "refused 行=红 tl-refused，不挂 errored");
  assert.ok(errorRow && /tl-errored/.test(errorRow) && !/tl-refused/.test(errorRow), "error 行=琥珀 tl-errored，不挂 refused");
});

test("run-timeline 折叠思考行：💭·「agent」·短摘要(首行截断,不铺全文) + 空态", () => {
  // 多行长思考:折叠行只取首行短摘要,不铺全文;归属=transcriptAgentId。
  const longThink = `${"首行摘要".repeat(20)}\n第二行不该进折叠预览\n${"y".repeat(300)}`;
  const entries = buildTimelineEntries({
    events: [], traces: [],
    transcriptMessages: [{ role: "assistant", ts: base, thinking: longThink, text: "" }],
    transcriptAgentId: "planner",
  });
  const html = renderRunTimeline({ entries, mode: "full", expandedKey: null }, i18n.t);
  // 折叠行显 agent 归属(「」由 CSS 加,JS 只出 agentId)
  assert.match(html, /tl-actor tl-thought-actor">planner</, "折叠思考行标 agent 归属");
  // 摘要短(≤ gist 上限 + 省略号),且只取首行(不含第二行内容)
  const preview = html.match(/tl-thought-preview">([^<]*)</)[1];
  assert.ok(preview.length <= 46, `折叠摘要必须短(实际 ${preview.length})`);
  assert.doesNotMatch(preview, /第二行/, "折叠预览只取首行");
  assert.doesNotMatch(html, new RegExp("y".repeat(60)), "折叠行绝不铺全文");

  // 展开才出思考全文
  const thought = entries.find((e) => e.kind === "thought");
  const openHtml = renderRunTimeline({ entries, mode: "full", expandedKey: thought.key }, i18n.t);
  assert.match(openHtml, new RegExp("y".repeat(60)), "点开后显示思考全文");

  const empty = renderRunTimeline({ entries: [], mode: "snapshot", expandedKey: null }, i18n.t);
  assert.match(empty, /tl-empty/);
});

// ── ① 展开详情：可读结构化视图（KV/分组），取代裸 JSON dump ──
test("① event 展开=结构化 KV（执行主体/时间/类型/合约/因果/payload）+ 原始 JSON 折叠保留", () => {
  const ev = [{ seq: 3, ts: base + 100, type: "dispatched", contractId: "TC-1", agentId: "planner",
    payload: { from: "controller", to: "planner" }, causeRefs: [{ runId: "r-1", seq: 2 }] }];
  const entries = buildTimelineEntries({ events: ev });
  const html = renderRunTimeline({ entries, mode: "full", expandedKey: entries[0].key }, i18n.t);
  // KV 标签走 i18n（非裸键、非裸 JSON）
  assert.match(html, /tl-kv-k">EXECUTOR</);
  assert.match(html, /tl-kv-k">TIME</);
  assert.match(html, /tl-kv-k">TYPE</);
  assert.match(html, /tl-kv-k">CONTRACT</);
  assert.match(html, /tl-kv-k">CAUSED BY</);
  assert.match(html, /tl-kv-k">PAYLOAD</);
  // 类型段：英文 type（主字）+ 可读描述（副字）
  assert.match(html, /tl-kv-type">dispatched<\/span><span class="tl-kv-desc">dispatched</);
  // 因果来源芯片 runId#seq
  assert.match(html, /tl-ref[^>]*>r-1#2</);
  // payload 逐字段 key→value
  assert.match(html, /tl-field-k">from<\/span><span class="tl-field-v">controller</);
  // 取证不丢：原始 JSON 折叠块
  assert.match(html, /<details class="tl-raw"><summary class="tl-raw-sum">RAW JSON</);
  // 反证：不再把 detail 整坨塞进一个 <pre class="tl-detail">（旧病）
  assert.doesNotMatch(html, /<pre class="tl-detail">/);
});

test("① tool 展开=工具名/kind·channel/args完整/outcome/拒因(blockReason 人话)", () => {
  const tr = [{ sessionKey: "s-1", rows: [
    { seq: 2, ts: base + 20, name: "ls", kind: "internal", channel: "fc",
      args: { path: "outbox/x", recursive: true },
      result: { blockReason: "路径限制：planner 的读取范围是 inbox/ 目录" },
      outcome: "refused", agentId: "planner", anchorSeq: 2 } ] }];
  const entries = buildTimelineEntries({ events, traces: tr });
  const tool = entries.find((e) => e.kind === "tool" && e.label === "ls");
  const html = renderRunTimeline({ entries, mode: "full", expandedKey: tool.key }, i18n.t);
  assert.match(html, /tl-kv-k">TOOL</);
  assert.match(html, /tl-kv-type">ls</);
  assert.match(html, /tl-kv-k">KIND·CHANNEL<\/span><span class="tl-kv-v">internal·fc</);
  // args 完整展开（多行 pretty JSON，不是 80 字 digest 截断；引号经 esc → &quot;）
  assert.match(html, /tl-args-full/);
  assert.match(html, /&quot;recursive&quot;: true/);
  // outcome 徽章上色类 + 拒因红字（人话，取证）
  assert.match(html, /tl-kv-outcome tl-oc-refused">refused</);
  assert.match(html, /tl-kv-k">REFUSED<\/span><span class="tl-kv-v"><span class="tl-kv-reason">路径限制/);
  assert.match(html, /tl-raw-sum">RAW JSON</);
});

test("① tool 展开=error 文本走 ERROR 段（工具自身报错取证）", () => {
  const tr = [{ sessionKey: "s-1", rows: [
    { seq: 2, ts: base + 20, name: "bash", kind: "internal", channel: "fc", args: { cmd: "x" },
      error: "command not found: x", outcome: "error", agentId: "worker", anchorSeq: 2 } ] }];
  const entries = buildTimelineEntries({ events, traces: tr });
  const tool = entries.find((e) => e.kind === "tool" && e.label === "bash");
  const html = renderRunTimeline({ entries, mode: "full", expandedKey: tool.key }, i18n.t);
  assert.match(html, /tl-kv-k">ERROR<\/span><span class="tl-kv-v"><span class="tl-kv-reason">command not found/);
});

test("① thought 展开=时间 + 思考全文 + 回复文本（不再截断）", () => {
  const longThink = "y".repeat(300);
  const entries = buildTimelineEntries({ events: [], traces: [],
    transcriptMessages: [{ role: "assistant", ts: base, thinking: longThink, text: "done" }] });
  const thought = entries.find((e) => e.kind === "thought");
  const html = renderRunTimeline({ entries, mode: "full", expandedKey: thought.key }, i18n.t);
  assert.match(html, /tl-kv-k">THINKING</);
  assert.match(html, /tl-kv-k">REPLY</);
  // 展开区含全文（300 字未截断）
  const prose = html.match(/tl-kv-prose">(y+)</)[1];
  assert.equal(prose.length, 300, "思考全文展开不截断");
});

// ── ② 思考浮现：默认藏(按钮点开) + 一键切换 + ISO ts 归一就近 ──
test("② 默认藏思考(默认 snapshot,按钮点开)+ 按钮说人话(💭 显示/隐藏思考)+ on 态即时反馈", () => {
  const entries = buildTimelineEntries({ events, traces, transcriptMessages });
  // 不传 mode → 默认 snapshot：干净流程骨架,思考藏起,按钮提供「显示思考」
  const dflt = renderRunTimeline({ entries }, i18n.t);
  assert.doesNotMatch(dflt, /tl-row tl-thought/, "默认不显思考(骨架态)");
  assert.match(dflt, />💭<\/span>SHOW THINKING/, "默认按钮=显示思考");
  assert.doesNotMatch(dflt, /tl-mode tl-mode-on/, "默认按钮无 on");
  assert.match(dflt, /data-action="set-mode" data-mode="full"/, "点它=显示思考");
  // 显思考态(full)：思考行在场 + 按钮 on + 提供「隐藏思考」
  const shown = renderRunTimeline({ entries, mode: "full" }, i18n.t);
  assert.match(shown, /tl-row tl-thought/, "full 态显思考");
  assert.match(shown, /class="tl-mode tl-mode-on"/, "显思考态按钮 on");
  assert.match(shown, /aria-pressed="true"/);
  assert.match(shown, /tl-mode-glyph" aria-hidden="true">💭<\/span>HIDE THINKING/);
  assert.match(shown, /data-action="set-mode" data-mode="snapshot"/, "点它=隐藏思考");
});

test("② transcript 的 ISO 串 ts 归一 → 思考按真实时刻就近（不塌到排头）", () => {
  // 真实 transcript 的 ts 是 ISO 串；旧码 Number(iso)=NaN→0 把所有思考堆到 run_triggered 之前。
  const isoMsgs = [{ role: "assistant", ts: new Date(base + 180).toISOString(), thinking: "mid thought", text: "" }];
  const entries = buildTimelineEntries({ events, traces, transcriptMessages: isoMsgs });
  const idx = entries.findIndex((e) => e.kind === "thought");
  assert.ok(idx > 0, "思考不再塌到排头（idx>0）");
  const thought = entries[idx];
  assert.ok(thought.ts > 0, "ISO 串 ts 已归一为正 epoch");
  // ts=base+180 → 就近落在 read(base+150) 之后
  assert.equal(entries[idx - 1].label, "read", "思考插到对应工具调用旁");
});

// ── 多合约 run 交织可读性（2026-08-27 修3）：>1 合约才出尾号 chip,单合约不添噪 ──
test("多合约 run: event/tool 行带合约末 6 位 chip(muted 等宽);thought 无合约不带", () => {
  // L1 assign_task 中场协作:caller 回合内给 worker 建 DIRECT 合约,两合约事件合法交织
  const interleaved = [
    { seq: 5, ts: base, type: "turn_started", contractId: "TC-planner-a1b2c3", agentId: "planner" },
    { seq: 6, ts: base + 100, type: "contract_created", contractId: "TC-worker-d65047", agentId: "worker" },
    { seq: 10, ts: base + 400, type: "collected", contractId: "TC-planner-a1b2c3", agentId: "planner" },
  ];
  const tr = [{ sessionKey: "s-w", rows: [
    { seq: 1, ts: base + 150, name: "read", args: {}, outcome: "ok", agentId: "worker",
      contractId: "TC-worker-d65047", anchorSeq: 6, kind: "internal", channel: "fc" },
  ] }];
  const entries = buildTimelineEntries({
    events: interleaved, traces: tr,
    transcriptMessages: [{ role: "assistant", ts: base + 200, thinking: "x", text: "" }],
  });
  const html = renderRunTimeline({ entries, mode: "full", expandedKey: null }, i18n.t);
  assert.match(html, /tl-contract">a1b2c3</, "planner 合约尾号 chip");
  assert.match(html, /tl-contract">d65047</, "worker 合约尾号 chip");
  assert.equal((html.match(/tl-contract"/g) || []).length, 4, "3 事件+1 工具行各一枚;thought 无合约不带");
  // chip 紧跟四段式的 type/工具名之后
  assert.match(html, /tl-type">turn_started<\/span>[\s\S]*?tl-contract">a1b2c3</);
});

test("单合约 run: 不出合约 chip(不添噪);合约 chip 样式=muted 等宽微字", async () => {
  // 既有 events 夹具全 C-1 单合约 → 零 chip
  const entries = buildTimelineEntries({ events, traces, transcriptMessages: [] });
  const html = renderRunTimeline({ entries, mode: "snapshot", expandedKey: null }, i18n.t);
  assert.doesNotMatch(html, /tl-contract/, "单合约 run 零 chip");
  const css = await readFile(new URL("../ui/components/run-timeline.css", import.meta.url), "utf8");
  const rule = (css.replace(/\/\*[\s\S]*?\*\//g, "").match(/\.tl-contract\s*\{[^}]*\}/) || [""])[0];
  assert.match(rule, /var\(--muted\)/, "chip=muted");
  assert.match(rule, /var\(--font-mono\)/, "chip=等宽");
});

// ── CSS 结构守卫（连线/详情的视觉契约；纪律：零圆角零阴影零渐变） ──
test("① CSS：详情 KV 网格 + 原始折叠 + ② on 态 存在；零圆角零阴影零渐变", async () => {
  const css = await readFile(new URL("../ui/components/run-timeline.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /\.tl-kv\s*\{[^}]*display:\s*grid/, "KV 网格布局");
  assert.match(noComments, /\.tl-args-full\s*\{/, "args 完整展开样式");
  assert.match(noComments, /\.tl-raw-sum\s*\{/, "原始 JSON 折叠触发器样式");
  assert.match(noComments, /\.tl-mode-on\s*\{/, "显思考 on 态样式");
  assert.doesNotMatch(noComments, /border-radius|box-shadow|gradient/, "零圆角零阴影零渐变");
});

test("状态值语义色：completed=绿/failed=红/running=蓝/pending=灰;非状态副标题不上色", () => {
  const evs = [
    { seq: 1, type: "run_triggered", ts: 1000, payload: { origin: "webui" } },
    { seq: 2, type: "contract_created", agentId: "planner", ts: 1100, payload: { status: "pending" } },
    { seq: 3, type: "declared", agentId: "worker", ts: 1200, payload: { status: "completed" } },
    { seq: 4, type: "closed", ts: 1300, payload: { terminalStatus: "failed" } },
  ];
  const entries = buildTimelineEntries({ events: evs, traces: [], transcriptMessages: [] });
  const html = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  assert.match(html, /tl-sub tl-st-muted">pending</, "pending=中性灰");
  assert.match(html, /tl-sub tl-st-ok">completed</, "completed=绿");
  assert.match(html, /tl-sub tl-st-fail">failed</, "failed=红");
  // 非状态副标题(origin=webui)不带状态色类
  assert.match(html, /tl-sub">webui</, "webui 非状态,保持素净灰(无 tl-st-)");
  assert.doesNotMatch(html, /tl-st-\w+">webui</, "非状态值不上语义色");
});

test("状态语义色统一: tl-st-run=蓝(--info,08-26 裁决「运行=蓝」,橙留给强调)", async () => {
  const css = await readFile(new URL("../ui/components/run-timeline.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /\.tl-sub\.tl-st-run\s*\{\s*color:\s*var\(--info\)/, "running 副标题=任务蓝");
  assert.doesNotMatch(noComments, /\.tl-sub\.tl-st-run\s*\{\s*color:\s*var\(--active\)/, "running 不再用橙");
});

test("思考条目 key 稳定:轮询后无锚 trace 增多不改思考 key(展开态不漂移)", () => {
  const msg = [{ role: "assistant", ts: base + 180, thinking: "mid thought", text: "" }];
  const first = buildTimelineEntries({ events, traces, transcriptMessages: msg });
  // 下一轮轮询:同一条思考,但无锚 trace 多了一条(浮动条目数变化)
  const moreTraces = [{
    sessionKey: "s-1",
    rows: [...traces[0].rows, { seq: 9, ts: base + 500, name: "extra", args: {}, outcome: "ok",
      agentId: "w-a", anchorRunId: null, anchorSeq: null, gseq: 19 }],
  }];
  const second = buildTimelineEntries({ events, traces: moreTraces, transcriptMessages: msg });
  const k1 = first.find((e) => e.kind === "thought").key;
  const k2 = second.find((e) => e.kind === "thought").key;
  assert.equal(k1, k2, "思考 key 不得随浮动条目数量漂移(否则 expandedKey 失配,展开态丢)");
});

test("⑤ 选中 agent → 聚焦:选中行 tl-mine,别的 agent 行 tl-faded 淡出;不选则无", () => {
  const evs = [
    { seq: 1, type: "dispatched", agentId: "planner", ts: 1000, payload: {} },
    { seq: 2, type: "claimed", agentId: "worker", ts: 2000, payload: {} },
    { seq: 3, type: "run_triggered", ts: 3000, payload: { origin: "webui" } }, // 系统行:不动
  ];
  const entries = buildTimelineEntries({ events: evs, traces: [], transcriptMessages: [] });
  const html = renderRunTimeline({ entries, mode: "snapshot", highlightAgentId: "worker" }, i18n.t);
  // worker 行=聚焦(tl-mine,主体名蓝),planner 行=淡出(tl-faded)
  assert.match(html, /class="tl-row tl-event tl-mine"[\s\S]*?tl-actor">worker</, "选中 worker 行标 tl-mine");
  assert.match(html, /class="tl-row tl-event tl-faded"[\s\S]*?tl-actor">planner</, "别的 agent(planner) 行淡出 tl-faded");
  // 系统行(run_triggered,无 agentId)既不聚焦也不淡出——留作 run 骨架
  assert.match(html, /class="tl-row tl-event"[^>]*e:3/, "系统行不带 tl-mine/tl-faded");
  // 不传 highlightAgentId → 零聚焦标记
  const none = renderRunTimeline({ entries, mode: "snapshot" }, i18n.t);
  assert.doesNotMatch(none, /tl-mine|tl-faded/, "未选中 agent 时零聚焦标记");
});

test("⑤ 回归守卫:选中聚焦不夺 border-left(失败红边不被盖)——tl-mine/tl-faded 不设背景/左边框", async () => {
  const css = await readFile(new URL("../ui/components/run-timeline.css", import.meta.url), "utf8");
  const mine = css.match(/\.tl-row\.tl-mine[^{]*\{[^}]*\}/g) || [];
  const faded = css.match(/\.tl-row\.tl-faded[^{]*\{[^}]*\}/g) || [];
  for (const rule of [...mine, ...faded]) {
    assert.doesNotMatch(rule, /background|border-left/, `聚焦规则不得动 background/border-left: ${rule}`);
  }
  assert.match(faded.join(""), /opacity/, "淡出走 opacity");
});
