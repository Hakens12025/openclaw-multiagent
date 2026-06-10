// lib/formal-runtime/checks/check-runner.js — CheckResult 引擎（纯逻辑，无 IO）
//
// CheckResult 模型（系统的原子）：
//   { id: "subsys.check-name", subsystem, title, status: pass|fail|skip|blocked,
//     code?: "E-XXX-NNN"（fail/blocked/skip 必填且必须已注册；pass 必须省略）,
//     evidence: "观察到的具体数据", hint?: "覆盖注册表默认 hint", durationMs }
//
// suite 契约：每个 suite 导出 async runXxxSuite(run, context)，
// 通过 context.addCheck(check) / runCheck(context, descriptor, fn) 追加结果；
// suite 永远不自己写报告（报告由 lib/formal-runtime/formal-report.js 渲染）。

import { getErrorCode } from "../error-codes.js";

export const CHECK_STATUSES = Object.freeze(["pass", "fail", "skip", "blocked"]);

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function fail(message) {
  throw new TypeError(`check-runner: ${message}`);
}

// 校验码已注册（fail/blocked/skip 的硬要求；测试依赖这里抛错）。
function assertRegisteredCode(code, where) {
  if (typeof code !== "string" || !code) {
    fail(`${where} requires an error code`);
  }
  if (!getErrorCode(code)) {
    fail(`${where} references unregistered error code "${code}" (register it in lib/formal-runtime/error-codes.js)`);
  }
}

// add 时归一化 + 校验；返回冻结后的 CheckResult。
function normalizeCheck(raw) {
  if (!raw || typeof raw !== "object") fail("addCheck requires a check object");
  const { id, subsystem, title, status } = raw;

  if (typeof id !== "string" || !/^[^.\s]+\.[^\s]+$/.test(id)) {
    fail(`check id must look like "subsys.check-name", got ${JSON.stringify(id)}`);
  }
  if (typeof subsystem !== "string" || !subsystem.trim()) fail(`check "${id}" requires subsystem`);
  if (typeof title !== "string" || !title.trim()) fail(`check "${id}" requires title`);
  if (!CHECK_STATUSES.includes(status)) {
    fail(`check "${id}" has invalid status ${JSON.stringify(status)} (expected ${CHECK_STATUSES.join("|")})`);
  }

  if (status === "pass") {
    if (raw.code != null) fail(`check "${id}" is pass but carries code "${raw.code}" (pass must omit code)`);
  } else {
    assertRegisteredCode(raw.code, `check "${id}" (${status})`);
  }

  const evidence = raw.evidence == null ? "" : String(raw.evidence);
  const hint = typeof raw.hint === "string" && raw.hint.trim() ? raw.hint.trim() : undefined;
  const durationMs = Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.round(raw.durationMs) : 0;

  const check = {
    id,
    subsystem: subsystem.trim(),
    title: title.trim(),
    status,
    evidence,
    durationMs,
  };
  if (status !== "pass") check.code = raw.code;
  if (hint) check.hint = hint;
  return Object.freeze(check);
}

// 纯函数：统计 + 判定。verdict 语义：有 fail 或 blocked 即 FAIL（blocked = 没验证到，不能宣告 PASS）。
export function summarizeChecks(checks = []) {
  const totals = { total: 0, pass: 0, fail: 0, skip: 0, blocked: 0, durationMs: 0 };
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check || !CHECK_STATUSES.includes(check.status)) continue;
    totals.total += 1;
    totals[check.status] += 1;
    totals.durationMs += Number.isFinite(check.durationMs) ? check.durationMs : 0;
  }
  const verdict = totals.fail > 0 || totals.blocked > 0 ? "FAIL" : "PASS";
  return { ...totals, verdict };
}

// 检查上下文：suite 之间共享的唯一收集器。
export function createCheckContext({ presetId = "unknown" } = {}) {
  const checks = [];
  return {
    presetId,
    checks,
    addCheck(check) {
      const normalized = normalizeCheck(check);
      checks.push(normalized);
      return normalized;
    },
    summarize() {
      return summarizeChecks(checks);
    },
  };
}

// 计时 + 捕获式执行单个检查。
// descriptor = { id, subsystem, title, code } — code 是 fn 抛错/返回 fail 未带码时的默认失败码（入口即校验，typo 立刻暴露）。
// fn 返回值约定：undefined/null → pass；string → pass 且作为 evidence；
// object → { status?, code?, evidence?, hint? } 合并（非 pass 未带 code 时回落 descriptor.code）；抛错 → fail。
export async function runCheck(ctx, descriptor = {}, fn) {
  if (!ctx || typeof ctx.addCheck !== "function") fail("runCheck requires a check context");
  const { id, subsystem, title, code } = descriptor;
  assertRegisteredCode(code, `runCheck descriptor "${id}"`);
  if (typeof fn !== "function") fail(`runCheck "${id}" requires an async function`);

  const startedAt = now();
  let outcome;
  try {
    const result = await fn();
    if (result == null) {
      outcome = { status: "pass" };
    } else if (typeof result === "string") {
      outcome = { status: "pass", evidence: result };
    } else if (typeof result === "object") {
      outcome = {
        status: CHECK_STATUSES.includes(result.status) ? result.status : "pass",
        code: result.code,
        evidence: result.evidence,
        hint: result.hint,
      };
      if (outcome.status !== "pass" && outcome.code == null) outcome.code = code;
    } else {
      outcome = { status: "pass", evidence: String(result) };
    }
  } catch (error) {
    outcome = { status: "fail", code, evidence: `threw: ${error?.message || String(error)}` };
  }
  const durationMs = now() - startedAt;

  return ctx.addCheck({ id, subsystem, title, durationMs, ...outcome });
}

// 前置条件死亡时批量 blocked（如 gateway 不可达 → 全部 GW 检查标 blocked）。
// descriptors = [{ id, subsystem, title }]；reason 写进每条 evidence。
export function markBlocked(ctx, descriptors = [], code, reason = "") {
  if (!ctx || typeof ctx.addCheck !== "function") fail("markBlocked requires a check context");
  assertRegisteredCode(code, "markBlocked");
  const blocked = [];
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    blocked.push(ctx.addCheck({
      id: descriptor?.id,
      subsystem: descriptor?.subsystem,
      title: descriptor?.title,
      status: "blocked",
      code,
      evidence: reason,
      durationMs: 0,
    }));
  }
  return blocked;
}
