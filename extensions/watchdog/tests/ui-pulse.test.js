import test from "node:test";
import assert from "node:assert/strict";
import { renderPulseColumn, renderLogDrawer, evaluateSentinels } from "../ui/components/pulse-column.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });
const runs = [{ runId: "r-1", agentId: "worker-a", lastTool: "read_file", progress: 40, elapsedMs: 1200 }];

test("pulse: 正常态脉搏卡（最近工具调用行 + 点击携带 runId）", () => {
  const html = renderPulseColumn({ runs, sentinels: [] }, i18n.t);
  assert.match(html, /class="pulse-card"/);
  assert.match(html, /pulse-tool-line">read_file</);
  assert.match(html, /data-action="open-run" data-run-id="r-1"/);
  assert.match(html, /pulse-progress/);
});

test("sentinel: 异常信号置顶 + 砖红 + 双按钮；消失即移除", () => {
  const alerted = renderPulseColumn({
    runs,
    sentinels: [{ id: "queueBacklog", kind: "queueBacklog", params: { n: 7 } }],
  }, i18n.t);
  assert.match(alerted, /class="sentinel-card"/);
  assert.ok(alerted.indexOf("sentinel-card") < alerted.indexOf("pulse-card"), "哨兵卡置顶");
  assert.match(alerted, /data-action="sentinel-evidence" data-sentinel-id="queueBacklog"/);
  assert.match(alerted, /data-action="sentinel-dismiss" data-sentinel-id="queueBacklog"/);

  const clean = renderPulseColumn({ runs, sentinels: [] }, i18n.t);
  assert.doesNotMatch(clean, /sentinel-card/);
});

test("evaluateSentinels: 四条 MVP 规则 + refused 五分钟窗口", () => {
  const now = 1_000_000_000;
  const out = evaluateSentinels({
    refused: [{ ts: now - 1000 }, { ts: now - 2000 }, { ts: now - 3000 }],
    alerts: [{ type: "runtime_wake_failed", ts: now - 500 }],
    queueDepth: 6,
    chainTips: [{ type: "execution_hard_stop_warning", ts: now - 100 }],
  }, { now });
  assert.deepEqual(
    out.map((s) => s.kind).sort(),
    ["chainTip", "queueBacklog", "refusedSpike", "sseError"],
  );
  assert.equal(out.find((s) => s.kind === "refusedSpike").params.n, 3);

  const stale = evaluateSentinels({
    refused: [{ ts: now - 6 * 60 * 1000 }, { ts: now - 7 * 60 * 1000 }, { ts: now - 8 * 60 * 1000 }],
    alerts: [],
    queueDepth: 0,
    chainTips: [],
  }, { now });
  assert.equal(stale.length, 0, "窗口外 refused 不计");
});

// ── 哨兵证据深链（2026-08-27 修1）：target 提取纯函数 + 按钮三态 ──
test("evaluateSentinels: target=信号族最近一条带 runId/contractId 的条目;queueBacklog 恒 null", () => {
  const now = 1_000_000_000;
  const out = evaluateSentinels({
    refused: [
      { ts: now - 3000, type: "system_action_role_policy_rejected", runId: null, sessionKey: null, contractId: "TC-old" },
      { ts: now - 2000, type: "system_action_role_policy_rejected", runId: null, sessionKey: null, contractId: "TC-new" },
      { ts: now - 1000, type: "system_action_role_policy_rejected", runId: null, sessionKey: "s-x", contractId: null }, // 最近但无 run/合约
    ],
    alerts: [
      { ts: now - 900, type: "runtime_wake_failed", runId: "r-77", sessionKey: null, contractId: null },
      { ts: now - 800, type: "inbox_dispatch", runId: null, sessionKey: null, contractId: "TC-noise" }, // 非 error 族不得混入
    ],
    queueDepth: 6,
    chainTips: [{ ts: now - 100, type: "execution_hard_stop_warning", runId: null, sessionKey: null, contractId: null }],
  }, { now });
  const refused = out.find((s) => s.kind === "refusedSpike");
  assert.deepEqual(refused.target, { runId: null, contractId: "TC-new" }, "取最近一条**带料**的(跳过无料的最近条)");
  const sse = out.find((s) => s.kind === "sseError");
  assert.deepEqual(sse.target, { runId: "r-77", contractId: null }, "sseError target 只从同 type 族取,不吃非 error 噪声");
  assert.equal(out.find((s) => s.kind === "queueBacklog").target, null, "队列淤积无 run 概念");
  assert.equal(out.find((s) => s.kind === "chainTip").target, null, "全族无料 → null,不造假");
});

test("sentinel 证据按钮三态: runId→data-target-run / 仅 contractId→data-target-wi / 无料→disabled 降级", () => {
  const html = renderPulseColumn({
    runs: [],
    sentinels: [
      { id: "a", kind: "sseError", params: { type: "error" }, target: { runId: "r-1", contractId: "TC-1" } },
      { id: "b", kind: "refusedSpike", params: { n: 3 }, target: { runId: null, contractId: "TC-2" } },
      { id: "c", kind: "queueBacklog", params: { n: 7 }, target: null },
    ],
  }, i18n.t);
  const cards = html.split('class="sentinel-card"').slice(1);
  assert.match(cards[0], /data-action="sentinel-evidence" data-sentinel-id="a" data-target-run="r-1"/, "有 run 深链 run");
  assert.doesNotMatch(cards[0], /disabled|data-target-wi/, "有 run 不降级也不挂 wi");
  assert.match(cards[1], /data-sentinel-id="b" data-target-wi="TC-2"/, "只有合约 → 深链工作项");
  assert.match(cards[2], /<button type="button" disabled/, "无料按钮禁用(诚实 UI)");
  assert.doesNotMatch(cards[2], /data-target-/, "禁用按钮零深链属性");
  assert.match(cards[2], /NO EVIDENCE REF/, "降级文案(不装能跳)");
});

test("log-drawer: 收起条 + 展开事件流", () => {
  const closed = renderLogDrawer({ events: [{ type: "alert", text: "x" }], open: false }, i18n.t);
  assert.match(closed, /data-action="toggle-drawer"/);
  assert.doesNotMatch(closed, /drawer-event-row/);
  const open = renderLogDrawer({ events: [{ type: "alert", text: "x" }], open: true }, i18n.t);
  assert.match(open, /drawer-event-row/);
});
