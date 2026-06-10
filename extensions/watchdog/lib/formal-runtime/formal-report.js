// lib/formal-runtime/formal-report.js — CheckResult 报告渲染器（.txt + .json 镜像）
//
// 契约（下游 agent 据此消费）：
//   generateFormalReport({ run, checks }) → string（.txt 全文）
//   buildFormalReportJson({ run, checks }) → { schema, presetId, startedAt, finishedAt, verdict, totals, checks }
//   run = { presetId, label?, startedAt?, finishedAt?, gatewayPort? }
//         startedAt/finishedAt 接受 epoch ms 或 ISO 字符串；checks = CheckResult[]（见 checks/check-runner.js）。
// 布局：header → VERDICT 行 → "## FAILURES FIRST"（每个 fail/blocked 展开 evidence+hint）
//       → 按 subsystem 分节（pass 一行一条；skip 一行带码和原因）→ totals/durations 页脚。
// hint 解析优先级：check.hint（覆盖） > error-codes.js 注册表默认 > "--"。
// 文件命名与输出目录由 lib/test-run-artifacts.js 负责，本模块只渲染。

import { getErrorCode } from "./error-codes.js";
import { summarizeChecks } from "./checks/check-runner.js";

export const FORMAL_REPORT_SCHEMA = "formal-check-report/v1";

const BAR = "══════════════════════════════════════════════════";

function toIso(value) {
  if (Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function toEpochMs(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// 解析最终生效的 hint（覆盖 > 注册表默认）。
function resolveHint(check) {
  if (check.hint) return check.hint;
  return getErrorCode(check.code)?.hint || null;
}

function normalizeChecksInput(checks) {
  return Array.isArray(checks) ? checks.filter((c) => c && typeof c === "object") : [];
}

function wallDurationMs(run) {
  const start = toEpochMs(run.startedAt);
  const end = toEpochMs(run.finishedAt);
  if (start == null || end == null || end < start) return null;
  return end - start;
}

// ── JSON 镜像 ──────────────────────────────────────────────────────────────────

export function buildFormalReportJson({ run = {}, checks = [] } = {}) {
  const list = normalizeChecksInput(checks);
  const { verdict, ...totals } = summarizeChecks(list);
  return {
    schema: FORMAL_REPORT_SCHEMA,
    presetId: run.presetId || "unknown",
    startedAt: toIso(run.startedAt),
    finishedAt: toIso(run.finishedAt),
    verdict,
    totals,
    checks: list.map((check) => {
      const mirrored = { ...check };
      const hint = check.status === "pass" ? null : resolveHint(check);
      if (hint) mirrored.hint = hint;
      return mirrored;
    }),
  };
}

// ── .txt 渲染 ──────────────────────────────────────────────────────────────────

function renderHeader(run, summary) {
  const presetLine = run.label ? `${run.presetId || "unknown"} — ${run.label}` : (run.presetId || "unknown");
  const startedAt = toIso(run.startedAt) || "--";
  const finishedAt = toIso(run.finishedAt) || "--";
  const wall = wallDurationMs(run);
  const duration = wall != null ? formatMs(wall) : formatMs(summary.durationMs);
  const gateway = run.gatewayPort ? `localhost:${run.gatewayPort}` : "--";
  return [
    BAR,
    " OPENCLAW FORMAL CHECK REPORT",
    ` Preset: ${presetLine}`,
    ` Run: ${startedAt} → ${finishedAt}  Duration: ${duration}`,
    ` Gateway: ${gateway}`,
    BAR,
  ];
}

// fail/blocked 展开块：[码] 标题 / check 行 / evidence / hint。
function renderFailureEntry(check) {
  const lines = [`[${check.code}] ${check.title}`];
  lines.push(`  check: ${check.id} (${check.status}, ${check.durationMs}ms)`);
  const evidence = check.evidence || "(no evidence captured)";
  const [first, ...rest] = evidence.split("\n");
  lines.push(`  evidence: ${first}`);
  for (const line of rest) lines.push(`            ${line}`);
  lines.push(`  hint: ${resolveHint(check) || "--"}`);
  return lines;
}

const STATUS_TAG = { pass: "PASS   ", fail: "FAIL   ", skip: "SKIP   ", blocked: "BLOCKED" };

// 分节内单行：pass 一行；fail/blocked 一行带码（详情在 FAILURES FIRST）；skip 一行带码+原因。
function renderSubsystemRow(check) {
  const tag = STATUS_TAG[check.status];
  const code = check.code ? ` [${check.code}]` : "";
  let row = `  ${tag} ${check.id}${code} — ${check.title} (${check.durationMs}ms)`;
  if (check.status === "skip" && check.evidence) {
    row += ` — ${check.evidence.split("\n")[0]}`;
  }
  return row.replace(/\r?\n/g, " ");
}

export function generateFormalReport({ run = {}, checks = [] } = {}) {
  const list = normalizeChecksInput(checks);
  const summary = summarizeChecks(list);
  const lines = [...renderHeader(run, summary), ""];

  lines.push(`VERDICT: ${summary.verdict} (${summary.fail}/${summary.total} failed, ${summary.skip} skipped, ${summary.blocked} blocked)`);
  lines.push("");

  // 失败优先区：每个 fail/blocked 完整展开，读报告的 agent 先看这里。
  lines.push("## FAILURES FIRST");
  const failures = list.filter((c) => c.status === "fail" || c.status === "blocked");
  if (failures.length === 0) {
    lines.push("  (none)");
  } else {
    for (const check of failures) {
      lines.push("");
      lines.push(...renderFailureEntry(check));
    }
  }
  lines.push("");

  // 按 subsystem 分节（按首次出现顺序），通过的检查一行一条。
  const bySubsystem = new Map();
  for (const check of list) {
    const key = check.subsystem || "unknown";
    if (!bySubsystem.has(key)) bySubsystem.set(key, []);
    bySubsystem.get(key).push(check);
  }
  for (const [subsystem, members] of bySubsystem) {
    const counts = summarizeChecks(members);
    lines.push(`## SUBSYSTEM: ${subsystem} — ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ${counts.blocked} blocked`);
    for (const check of members) lines.push(renderSubsystemRow(check));
    lines.push("");
  }
  if (list.length === 0) {
    lines.push("(no checks recorded)");
    lines.push("");
  }

  lines.push(BAR);
  lines.push(` TOTALS: ${summary.total} checks | ${summary.pass} pass | ${summary.fail} fail | ${summary.skip} skip | ${summary.blocked} blocked`);
  const wall = wallDurationMs(run);
  lines.push(` DURATION: wall ${wall != null ? formatMs(wall) : "--"} | checks-sum ${formatMs(summary.durationMs)}`);
  lines.push(BAR);

  return lines.join("\n");
}
