import test from "node:test";
import assert from "node:assert/strict";
import { renderStatStrip } from "../ui/components/stat-strip.js";
import { renderWorkItemList } from "../ui/components/work-item-list.js";
import { renderCommandLayout } from "../ui/pages/command/command-page.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });

test("stat-strip: 单条带行内项 + 五语义色 + 在线方灯（2026-08-25 重设计）", () => {
  const html = renderStatStrip({ active: 3, queue: 2, done: 41, alert: 1, events: 7, uptime: "ON" }, i18n.t);
  assert.equal((html.match(/class="stat-item"/g) || []).length, 6, "6 项行内读数(无独立框)");
  assert.doesNotMatch(html, /stat-cell/, "不再独立成框");
  assert.match(html, /stat-value is-active">3</);
  assert.match(html, /stat-value is-queue">2</);
  assert.match(html, /stat-value is-done">41</);
  assert.match(html, /stat-value is-alertable">1</, "告警>0 染红");
  assert.match(html, /stat-value is-events">7</);
  assert.match(html, /stat-lamp is-on/, "在线方灯");
  assert.match(html, /stat-label">ACTIVE</);
  // agents(节点数)不再出现——图上自见,读数带不重复
  assert.doesNotMatch(html, /data-stat="agents"/);
  // 告警为 0 时不染红(降噪)
  const calm = renderStatStrip({ active: 0, queue: 0, done: 5, alert: 0, events: 0, uptime: "OFF" }, i18n.t);
  assert.match(calm, /stat-value is-muted">0</);
  assert.match(calm, /stat-lamp"/, "离线灯不亮");
});

test("command layout: 三栏 grid + 读数带槽位", () => {
  const html = renderCommandLayout(i18n.t);
  assert.match(html, /class="command-grid"/);
  assert.match(html, /class="col-workitems"/);
  assert.match(html, /class="col-graph"/);
  assert.match(html, /class="col-pulse"/);
  assert.match(html, /data-slot="stat-strip"/);
});

test("work-item-list: 状态分组 + 点击跳详情携带 id", () => {
  const html = renderWorkItemList([
    { id: "TC-1", task: "do a", status: "running", pct: 40 },
    { id: "TC-2", task: "do b", status: "pending" },
    { id: "TC-3", task: "do c", status: "completed" },
    { id: "TC-4", task: "do d", status: "failed" },
  ], i18n.t);
  for (const group of ["wi-group-running", "wi-group-queued", "wi-group-done"]) {
    assert.match(html, new RegExp(group));
  }
  assert.match(html, /data-action="open-work-item" data-work-item-id="TC-1"/);
  assert.match(html, /wi-pct">40%</);
  // queued 组含 pending，done 组含 completed+failed
  const queued = html.indexOf("wi-group-queued");
  const done = html.indexOf("wi-group-done");
  assert.ok(html.indexOf("TC-2") > queued && html.indexOf("TC-2") < done);
  assert.ok(html.indexOf("TC-3") > done && html.indexOf("TC-4") > done);
});

test("work-item-list: 空态", () => {
  const html = renderWorkItemList([], i18n.t);
  assert.match(html, /wi-empty/);
});

// 卸载清理守卫(v234 修复:审计抓到的唯一 HIGH——图板泄漏)。
// command 页 mount 时建 graph-board(它自持 window pointermove/up/keydown + store 订阅),
// 卸载闭包必须显式 board.destroy() 否则每次切区/切语言无界累积监听器。
// 无 jsdom 故用源码静态守卫:锁"卸载函数里调了 board.destroy()",防回归。
test("command 卸载闭包必须调 board.destroy()(防图板监听器泄漏)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/pages/command/index.js", import.meta.url), "utf8");
  // 卸载闭包 = 文件里 `return () => {` 到匹配 `};` 之间
  const start = src.indexOf("return () => {");
  assert.ok(start >= 0, "command 页应有卸载闭包");
  const body = src.slice(start, src.indexOf("\n  };", start));
  assert.match(body, /board\.destroy\(\)/, "卸载闭包必须调 board.destroy() 清理图板自持的 window 监听器与 store 订阅");
  // 同时确认 board 确有 destroy 方法(不是调了个不存在的)
  const ctrl = readFileSync(new URL("../ui/pages/command/graph-board-controller.js", import.meta.url), "utf8");
  assert.match(ctrl, /destroy\(\)\s*\{/, "graph-board-controller 必须实现 destroy()");
});

// 图板脏检查:store 高频写(SSE 事件流)下,与图无关的变更不得重建 SVG——
// innerHTML 重建会把交接滑行/呼吸动画整个重启(闪动),与 index.js paint() 同一套治法。
test("graph-board-controller: 内容未变不重建 DOM(动画不重启),内容变更才重绘", async () => {
  const hadWindow = typeof globalThis.window !== "undefined";
  if (!hadWindow) globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const { createGraphBoard } = await import("../ui/pages/command/graph-board-controller.js");
    const { createStore } = await import("../ui/core/store.js");
    let paints = 0;
    const container = {
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; },
      set innerHTML(v) { paints += 1; this._raw = v; },
      get innerHTML() { return this._raw; },
    };
    const store = createStore({ graph: { nodes: [], edges: [] }, runs: {}, flows: [] });
    const board = createGraphBoard({
      container, api: {}, store, i18n,
      buildModel: (s) => ({ nodes: s.graph?.nodes || [], edges: s.graph?.edges || [], flows: [], queues: {}, cycles: [] }),
    });
    assert.equal(paints, 1, "首帧渲染一次");
    store.patch({ runs: { "r-1": { agentId: "w" } } }); // 与图内容无关的 store 写
    assert.equal(paints, 1, "同内容不得重建 DOM");
    store.patch({ graph: { nodes: [{ id: "a", role: "executor", status: "idle" }], edges: [] } });
    assert.equal(paints, 2, "内容变更才重绘");
    board.destroy();
  } finally {
    if (!hadWindow) delete globalThis.window;
  }
});

// flows TTL 到期主动剪枝:TTL 只在渲染时过滤的话,最后一次交接动画会滞留到下个
// SSE/轮询才消失。守卫:到期定时器存在 + 派工事件后排枪 + 卸载清理。
test("command flows: TTL 到期定时剪枝重渲(动画不滞留),卸载清理定时器", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/pages/command/index.js", import.meta.url), "utf8");
  assert.match(src, /function scheduleFlowPrune/, "剪枝调度在场");
  assert.match(src, /Math\.min\(\.\.\.flows\.map\(\(f\) => f\.ts \+ FLOW_TTL_MS\)\)/, "按最早到期 flow 排枪");
  const dispatchBlock = src.slice(src.indexOf("graph_dispatch:"), src.indexOf('pushEvent("graph_dispatch"'));
  assert.match(dispatchBlock, /scheduleFlowPrune\(\)/, "派工进 flow 后必须排一枪到期剪枝");
  const unmount = src.slice(src.indexOf("return () => {"), src.indexOf("\n  };", src.indexOf("return () => {")));
  assert.match(unmount, /clearTimeout\(flowPruneTimer\)/, "卸载清理剪枝定时器");
});

// 死码清理守卫(2026-08-26 一致性批):零引用即删,不许复活。
test("前端死码不复活: agents 统计残链/GRAPH_GRID_SNAP/.zone-stub/stat.agents 键", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/pages/command/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bagents:/, "stat-strip 不再收 agents(STAT_ORDER 早已去掉,传参是残链)");
  const gb = readFileSync(new URL("../ui/components/graph-board.js", import.meta.url), "utf8");
  assert.doesNotMatch(gb, /GRAPH_GRID_SNAP/, "GRAPH_GRID_SNAP 零引用导出已删(snap 走 graphSnap)");
  const css = readFileSync(new URL("../ui/pages/command/command.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /zone-stub/, ".zone-stub 零引用样式已删");
  const { LANG_PACKS } = await import("../ui/core/i18n.js");
  assert.equal("stat.agents" in LANG_PACKS["en-US"], false, "stat.agents 键已随读数项退役(en)");
  assert.equal("stat.agents" in LANG_PACKS["zh-CN"], false, "stat.agents 键已随读数项退役(zh)");
});

// ── 修1 守卫:哨兵「查看证据」深链——裸 #/inspect 占位跳转不复活 + 采集保留深链上下文 ──
test("sentinel-evidence: 占位跳转已废,深链 run/wi 双钥匙;信号采集保留 runId/sessionKey/contractId", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/pages/command/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /window\.location\.hash = "#\/inspect"/, "裸 #/inspect 占位跳转不得复活");
  const block = src.slice(src.indexOf('action === "sentinel-evidence"'));
  assert.match(block, /#\/inspect\?run=/, "有 run → 深链 run");
  assert.match(block, /#\/inspect\?wi=/, "只有合约 → 深链工作项(wi)");
  // 采集端:alert 信号条目必须保留深链上下文(SSE 缺列即 null)
  const alertBlock = src.slice(src.indexOf("alert: (data) =>"), src.indexOf("onStatus:"));
  assert.match(alertBlock, /runId: data\?\.runId \?\? null/, "采集保留 runId");
  assert.match(alertBlock, /sessionKey: data\?\.sessionKey \?\? null/, "采集保留 sessionKey");
  assert.match(alertBlock, /contractId: data\?\.contractId \?\? null/, "采集保留 contractId");
});

// ── 修2 守卫:实时滞留治本——SSE 是增量,轮询是真值,重连/回页必对账 ──
test("pruneRunsAgainstTracking: 活跃集内留(sessionKey 键+workItemId 合约键)/外删/竞态豁免/无变化同引用", async () => {
  const { pruneRunsAgainstTracking } = await import("../ui/pages/command/index.js");
  const runs = {
    "TC-live": { runId: "TC-live", lastSeen: 100 },       // 合约键,活跃(经 workItemId)
    "agent:s-live": { runId: "agent:s-live", lastSeen: 100 }, // sessionKey 键,活跃
    "TC-stale": { runId: "TC-stale", lastSeen: 100 },     // 断线窗口错过 track_end 的滞留卡
    "TC-fresh": { runId: "TC-fresh", lastSeen: 900 },     // poll 取样后才被 SSE upsert → 本轮豁免
  };
  const tracking = {
    "agent:s-live": { agentId: "agent", workItemId: "TC-live", status: "running" },
  };
  const pruned = pruneRunsAgainstTracking(runs, tracking, { protectSinceTs: 500 });
  assert.deepEqual(Object.keys(pruned).sort(), ["TC-fresh", "TC-live", "agent:s-live"], "活跃留/滞留删/新鲜豁免");
  // 空闲系统(trackingSessions={}) → 全部滞留卡清空(用户报的「planner 一直在运行」正是这形态)
  const idle = pruneRunsAgainstTracking({ "TC-stale": { lastSeen: 100 } }, {}, { protectSinceTs: 500 });
  assert.deepEqual(idle, {}, "空闲真值下滞留卡全清");
  // 无需修剪 → 返回同一引用(不触发无谓重渲)
  const same = { "agent:s-live": { lastSeen: 100 } };
  assert.equal(pruneRunsAgainstTracking(same, tracking, { protectSinceTs: 500 }), same, "无变化返回原引用");
});

test("对账接线源码守卫: pollAll 修剪 runs + SSE 重连补课 + visibilitychange 回页即刷(含卸载清理)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/pages/command/index.js", import.meta.url), "utf8");
  // pollAll 里用 runtime.trackingSessions 修剪 runs
  const pollBlock = src.slice(src.indexOf("async function pollAll"), src.indexOf("const pollTimer"));
  assert.match(pollBlock, /pruneRunsAgainstTracking\(runsNow, runtime\.trackingSessions/, "轮询真值必对账 runs");
  // SSE 重连(曾 reconnecting → open)触发 pollAll 补课
  const statusBlock = src.slice(src.indexOf("onStatus: (status)"), src.indexOf("// ── 事件委托"));
  assert.match(statusBlock, /reconnecting/, "记录断线态");
  assert.match(statusBlock, /pollAll\(\)/, "重连即整轮对账");
  // 回页立即刷 + 卸载清理监听
  assert.match(src, /document\.addEventListener\("visibilitychange", onVisibility\)/, "回页对账接线");
  const unmount = src.slice(src.indexOf("return () => {"), src.indexOf("\n  };", src.indexOf("return () => {")));
  assert.match(unmount, /removeEventListener\("visibilitychange", onVisibility\)/, "卸载清理 visibility 监听");
  // inspect 页同纪律(5s 轮询已有,回页立即补一轮)
  const insp = readFileSync(new URL("../ui/pages/inspect/index.js", import.meta.url), "utf8");
  assert.match(insp, /addEventListener\("visibilitychange", onVisibility\)/, "透视页回页即刷");
  assert.match(insp, /removeEventListener\("visibilitychange", onVisibility\)/, "透视页卸载清理");
});

// sentinelSignals 真实形状是按键分桶 map({refused,alerts,chainTips}→数组),初值必须一致。
test("app 壳: sentinelSignals 初值=对象 map(不是数组);死键 agents 已出店", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(src, /sentinelSignals:\s*\{\}/, "初值=空 map,与采集端 signals[key] 写法一致");
  assert.doesNotMatch(src, /sentinelSignals:\s*\[\]/, "数组初值是形状谎报");
  assert.doesNotMatch(src, /\bagents:\s*\[\]/, "store 死键 agents 已删(零读方)");
});
