// components/pulse-column.js — LIVE PULSE 右栏 + 哨兵卡 + 日志抽屉（纯渲染 + 纯函数哨兵规则）。
// 哨兵信号源：refused 尖峰 / SSE alert error 族（类型清单对齐 lib/core/event-types.js 的
// Errors 段）/ 队列淤积 / 链尖报警。出现即插入、解决即消失（由 model.sentinels 驱动）。
import { esc } from "../core/html.js";

const REFUSED_WINDOW_MS = 5 * 60 * 1000;
const REFUSED_SPIKE_MIN = 3;
const QUEUE_BACKLOG_MIN = 5;

// SSE alert error 族（lib/core/event-types.js Errors 段的前端镜像；后端常量改动需同步此处）
const ALERT_ERROR_TYPES = new Set([
  "error",
  "runtime_wake_failed",
  "system_action_delivery_failed",
  "delivery_pump_exhausted",
  "delivery_ticket_write_failed",
  "runtime_agent_end_failed",
  "runtime_finalize_failed",
  "runtime_transport_cleanup_failed",
  "runtime_crash_recovery_failed",
  "runtime_contract_read_failed",
]);

// 链尖报警事件（执行硬停逼近阈值的告警）
const CHAIN_TIP_TYPES = new Set(["execution_hard_stop_warning"]);

// 证据定位（纯函数）：取该信号族**最近一条**带 runId/contractId 的条目 → { runId, contractId }；
// 全族都没料 → null（诚实 UI：按钮据此降级为禁用，不装能跳）。
function latestEvidenceTarget(entries = []) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.runId || e?.contractId) {
      return { runId: e.runId || null, contractId: e.contractId || null };
    }
  }
  return null;
}

// evaluateSentinels(signals, { now }) → [{ id, kind, params, target }]。纯函数，可单测。
// target = 深链定位（信号采集端保留的 runId/contractId）；queueBacklog 无 run 概念恒 null。
export function evaluateSentinels(signals = {}, { now = Date.now() } = {}) {
  const out = [];
  const refusedInWindow = (signals.refused || []).filter((e) => now - (e?.ts || 0) <= REFUSED_WINDOW_MS);
  if (refusedInWindow.length >= REFUSED_SPIKE_MIN) {
    out.push({
      id: "refusedSpike", kind: "refusedSpike", params: { n: refusedInWindow.length },
      target: latestEvidenceTarget(refusedInWindow),
    });
  }
  const errorAlert = (signals.alerts || []).find((a) => ALERT_ERROR_TYPES.has(a?.type));
  if (errorAlert) {
    out.push({
      id: `sseError:${errorAlert.type}`, kind: "sseError", params: { type: errorAlert.type },
      target: latestEvidenceTarget((signals.alerts || []).filter((a) => a?.type === errorAlert.type)),
    });
  }
  if ((signals.queueDepth || 0) >= QUEUE_BACKLOG_MIN) {
    out.push({ id: "queueBacklog", kind: "queueBacklog", params: { n: signals.queueDepth }, target: null });
  }
  const chainTip = (signals.chainTips || []).find((a) => CHAIN_TIP_TYPES.has(a?.type));
  if (chainTip) {
    out.push({
      id: `chainTip:${chainTip.type}`, kind: "chainTip", params: { type: chainTip.type },
      target: latestEvidenceTarget((signals.chainTips || []).filter((a) => CHAIN_TIP_TYPES.has(a?.type))),
    });
  }
  return out;
}

// 证据按钮三态：有 runId → 深链 run；只有 contractId → 深链工作项（wi）；都没有 → 禁用 +
// 降级文案（诚实 UI，裸 #/inspect 占位跳转已废）。禁用态浏览器不发 click，handler 无需判。
function renderEvidenceButton(sentinel, t) {
  const target = sentinel.target || null;
  if (!target) {
    return `<button type="button" disabled data-action="sentinel-evidence"`
      + ` data-sentinel-id="${esc(sentinel.id)}">${esc(t("sentinel.noEvidence"))}</button>`;
  }
  const ref = target.runId
    ? ` data-target-run="${esc(target.runId)}"`
    : ` data-target-wi="${esc(target.contractId)}"`;
  return `<button type="button" data-action="sentinel-evidence" data-sentinel-id="${esc(sentinel.id)}"${ref}>`
    + `${esc(t("sentinel.viewEvidence"))}</button>`;
}

function renderSentinelCard(sentinel, t) {
  return `<div class="sentinel-card" data-sentinel-id="${esc(sentinel.id)}">`
    + `<div class="sentinel-head">${esc(t("sentinel.title"))}</div>`
    + `<div class="sentinel-body">${esc(t(`sentinel.${sentinel.kind}`, sentinel.params))}</div>`
    + `<div class="sentinel-actions">`
    + renderEvidenceButton(sentinel, t)
    + `<button type="button" data-action="sentinel-dismiss" data-sentinel-id="${esc(sentinel.id)}">${esc(t("sentinel.dismiss"))}</button>`
    + `</div></div>`;
}

function renderPulseCard(run, t) {
  const progress = Math.max(0, Math.min(100, Number(run.progress) || 0));
  return `<div class="pulse-card" data-action="open-run" data-run-id="${esc(run.runId)}">`
    + `<div class="pulse-card-head"><span class="pulse-agent">${esc(run.agentId || "")}</span>`
    + `<span class="pulse-elapsed">${esc(t("pulse.elapsed", { ms: run.elapsedMs ?? 0 }))}</span></div>`
    + `<div class="pulse-tool-line">${esc(run.lastTool || "")}</div>`
    + `<div class="pulse-progress"><div class="pulse-progress-fill" style="width: ${progress}%"></div></div>`
    + `</div>`;
}

export function renderPulseColumn(model = {}, t) {
  const { runs = [], sentinels = [] } = model;
  let body = `<div class="pulse-title">${esc(t("pulse.title"))}</div>`;
  for (const sentinel of sentinels) body += renderSentinelCard(sentinel, t);
  if (!runs.length) {
    body += `<div class="pulse-empty">${esc(t("pulse.empty"))}</div>`;
  } else {
    for (const run of runs) body += renderPulseCard(run, t);
  }
  return `<div class="pulse-column">${body}</div>`;
}

export function renderLogDrawer(model = {}, t) {
  const { events = [], open = false } = model;
  let body = `<button type="button" class="drawer-bar" data-action="toggle-drawer">`
    + `${esc(t("drawer.title"))} · ${esc(t(open ? "drawer.collapse" : "drawer.expand"))}</button>`;
  if (open) {
    body += `<div class="drawer-body">`;
    if (!events.length) {
      body += `<div class="drawer-empty">${esc(t("drawer.empty"))}</div>`;
    } else {
      for (const event of events) {
        body += `<div class="drawer-event-row"><span class="drawer-event-type">${esc(event.type)}</span> ${esc(event.text ?? "")}</div>`;
      }
    }
    body += `</div>`;
  }
  return `<div class="log-drawer${open ? " open" : ""}">${body}</div>`;
}
