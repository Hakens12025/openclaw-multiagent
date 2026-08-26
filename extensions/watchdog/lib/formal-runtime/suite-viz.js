// lib/formal-runtime/suite-viz.js — viz-master 可视化套件（确定性，零 LLM）
//
// viz-master 是 meta-agent，因为它是 chart 家族的「唯一写者」（charts.json 是非真值 control-plane
// 存储，非平台真值 —— 见 lib/cli-system/meta-agent-surface-ownership.js）。operator suite 已经测了
// 拥有权门（viz 被拒 agents.*、放行 apply.chart_create、匿名被拒）；本套件测的是 viz-master 真正
// 产出可视化的完整管道 —— 经 executeCliSystemSurface(actor:'viz-master') 真跑 apply.chart_create /
// apply.chart_delete，走同一条运行时执行器路径（零旁路，非直调 handler）。
//
// 覆盖：① 静态图创建（embedded series）② 实时绑定图创建（sse → inspect.* 轮询，line-only，
//   viz-master 的「临时可视化」签名能力，验 binding 归一/钳位）③ create→persist→inspect.charts
//   往返 ④ 非法 spec 被 validateChartSpec 拒（ok:false 而非落盘）⑤ delete 清理。finally 兜底删除
//   探针图（即使中途失败也不把探针图留在用户看板上）。

import { runCheck } from "./checks/check-runner.js";
import { executeCliSystemSurface } from "../cli-system/cli-surface-executor.js";
import { inspectCliSystemSurface } from "../cli-system/cli-surface-inspector.js";

const VIZ_ACTOR = "viz-master";
export const STATIC_PROBE_ID = "formal-viz-static-probe";
export const SSE_PROBE_ID = "formal-viz-sse-probe";
const PROBE_IDS = Object.freeze([STATIC_PROBE_ID, SSE_PROBE_ID]);

// 最小合法静态 spec：id(kebab) + type + 非空 series（points 需数值 y）。
export function buildStaticProbeSpec(id = STATIC_PROBE_ID) {
  return {
    id,
    type: "bar",
    title: "formal viz static probe",
    series: [{ name: "probe", points: [{ x: "a", y: 1 }, { x: "b", y: 2 }] }],
  };
}

// 实时绑定 spec：sse 只允许 line；binding.source 必须是 inspect.* 面。intervalMs/maxPoints 故意
// 越界，验 validateChartSpec 的钳位（1000→5000 下界，999→200 上界）。
export function buildSseProbeSpec(id = SSE_PROBE_ID) {
  return {
    id,
    type: "line",
    title: "formal viz live probe",
    series: [{ name: "live", points: [{ x: 0, y: 0 }] }],
    dataBinding: { mode: "sse", binding: { source: "inspect.runtime_state", field: "dispatchQueue", intervalMs: 1000, maxPoints: 999 } },
  };
}

// 缺 series → validateChartSpec 抛 → createChartDefinition 归一成 ok:false（非未捕获抛）。
export function buildMalformedSpec() {
  return { id: "formal-viz-bad-probe", type: "line" };
}

// 纯函数：判定一次 chart 创建结果（单测喂 canned executor 结果）。
export function classifyChartCreate(res, expectedId) {
  if (!res || res.ok !== true) {
    return { status: "fail", evidence: `apply.chart_create ok!=true: ${JSON.stringify(res).slice(0, 200)}` };
  }
  if (res.chart?.id !== expectedId) {
    return { status: "fail", evidence: `created chart id="${res.chart?.id}" != expected "${expectedId}"` };
  }
  return { status: "pass", evidence: `chart "${expectedId}" created (type=${res.chart?.spec?.type})` };
}

// 纯函数：验 sse 绑定被归一/钳位（单测喂 canned chart）。
export function evaluateSseNormalization(chart) {
  const db = chart?.spec?.dataBinding;
  if (!db || db.mode !== "sse" || !db.binding) {
    return { ok: false, evidence: `dataBinding is not a normalized sse binding: ${JSON.stringify(db)}` };
  }
  const b = db.binding;
  const problems = [];
  if (b.source !== "inspect.runtime_state") problems.push(`source=${b.source}`);
  if (b.intervalMs !== 5000) problems.push(`intervalMs=${b.intervalMs} (expected clamp→5000)`);
  if (b.maxPoints !== 200) problems.push(`maxPoints=${b.maxPoints} (expected clamp→200)`);
  return problems.length
    ? { ok: false, evidence: `sse binding not normalized: ${problems.join(", ")}` }
    : { ok: true, evidence: `sse binding normalized: source=${b.source}, intervalMs=${b.intervalMs} (clamped), maxPoints=${b.maxPoints} (clamped)` };
}

async function listChartIds() {
  const charts = await inspectCliSystemSurface({ surfaceId: "inspect.charts" });
  const list = Array.isArray(charts) ? charts : (Array.isArray(charts?.charts) ? charts.charts : []);
  return list.map((c) => c?.id);
}

async function createChart(spec) {
  return executeCliSystemSurface({ surfaceId: "apply.chart_create", actor: VIZ_ACTOR, payload: { spec } });
}

async function deleteChart(chartId) {
  return executeCliSystemSurface({ surfaceId: "apply.chart_delete", actor: VIZ_ACTOR, payload: { chartId } });
}

export async function runVizSuite(run, context) {
  try {
    // ① 静态图创建（经 viz-master executor 真跑）
    await runCheck(context, { id: "viz.create-static", subsystem: "viz", title: "viz-master creates a static chart via the executor", code: "E-VIZ-001" }, async () => {
      const res = await createChart(buildStaticProbeSpec());
      return classifyChartCreate(res, STATIC_PROBE_ID);
    });

    // ② 实时绑定图创建 + binding 归一/钳位
    await runCheck(context, { id: "viz.create-live-sse", subsystem: "viz", title: "viz-master creates an sse live-bound line chart (binding normalized)", code: "E-VIZ-001" }, async () => {
      const res = await createChart(buildSseProbeSpec());
      const base = classifyChartCreate(res, SSE_PROBE_ID);
      if (base.status !== "pass") return base;
      const norm = evaluateSseNormalization(res.chart);
      return norm.ok ? `sse-bound line chart created; ${norm.evidence}` : { status: "fail", code: "E-VIZ-003", evidence: norm.evidence };
    });

    // ③ create → persist → inspect.charts 往返
    await runCheck(context, { id: "viz.inspect-roundtrip", subsystem: "viz", title: "created charts appear in inspect.charts", code: "E-VIZ-002" }, async () => {
      const ids = await listChartIds();
      const missing = PROBE_IDS.filter((id) => !ids.includes(id));
      if (missing.length) return { status: "fail", evidence: `inspect.charts missing ${missing.join(",")}; present=[${ids.join(", ")}]` };
      return `inspect.charts shows both probe charts among ${ids.length} total`;
    });

    // ④ 非法 spec 被拒（validateChartSpec 门）
    await runCheck(context, { id: "viz.reject-malformed", subsystem: "viz", title: "malformed chart spec is refused (validateChartSpec gate)", code: "E-VIZ-003" }, async () => {
      const res = await createChart(buildMalformedSpec());
      if (res?.ok === false && res?.error) return `malformed spec refused: ${String(res.error).slice(0, 120)}`;
      return { status: "fail", evidence: `malformed spec was accepted: ${JSON.stringify(res).slice(0, 200)}` };
    });

    // ⑤ delete 清理 → inspect.charts 不再含探针图
    await runCheck(context, { id: "viz.delete-cleanup", subsystem: "viz", title: "apply.chart_delete removes the probe charts", code: "E-VIZ-004" }, async () => {
      for (const id of PROBE_IDS) await deleteChart(id);
      const ids = await listChartIds();
      const lingering = PROBE_IDS.filter((id) => ids.includes(id));
      if (lingering.length) return { status: "fail", evidence: `charts still present after delete: ${lingering.join(",")}` };
      return "both probe charts removed from inspect.charts";
    });
  } catch (error) {
    context.addCheck({
      id: "viz.suite-driver", subsystem: "viz", title: "Viz suite driver",
      status: "fail", code: "E-RUNNER-001", evidence: `threw: ${error?.message || error}`, durationMs: 0,
    });
  } finally {
    // 兜底清理（幂等）——即使中途失败也绝不把探针图留在用户看板上。
    for (const id of PROBE_IDS) {
      try { await deleteChart(id); } catch { /* idempotent; cleanup best-effort */ }
    }
  }
}
