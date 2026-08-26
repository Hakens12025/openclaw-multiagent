// lib/formal-runtime/suite-unit.js — unit 套件：把 npm test 收口进统一 runner
//
// spawn `npm test`（node --test 全部 tests/*.test.js，cwd = extensions/watchdog，
// 600s 硬超时杀进程组），解析 stdout 尾部的 node --test totals 块
// （`ℹ tests/pass/fail/cancelled/skipped` 行；TAP 的 `# tests` 前缀同样兼容），产出：
//   ① unit.npm-test 汇总 CheckResult：fail/cancelled>0 → fail E-UNIT-001（evidence 列
//      ✖ 行提取的失败用例名）；spawn 失败/超时/totals 不可解析/退出码异常 → fail E-UNIT-002。
//   ② totals.skipped>0 时补一条 pass 级注记 unit.env-gated-skips（环境门跳过数说明）。
//
// 防互踩护栏（2026-08-11 事故教训）：单测会直写真实 control-plane。跑前快照
// control-plane/agent-graph.json 内容，finally 里无条件写回 —— 即刻恢复，不等
// test-runs.js 的 withPreservedRuntimeGraph 在整个 run 结束时才还原（那层只在
// runner 路径存在，且恢复点太晚；本护栏保证 npm test 一结束图就复原）。
//
// 纯函数（parseNodeTestTotals / extractFailedTestNames / classifyNpmTestRun）由
// tests/suite-unit-units.test.js 锁定，零 spawn。

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


// suite-unit.js 位于 <watchdog>/lib/formal-runtime/ → 上两级 = 扩展根（npm test 的 cwd）。
const WATCHDOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 图快照护栏已随店根门卫退役(2026-08-26,§13):spawn 出的 node --test 子进程带
// NODE_TEST_CONTEXT,店根解析结构性落沙箱,单测碰不到生产图——双保险摘除。

// 600s：全量单测（~1600 用例，--test-concurrency=1）实测数分钟级；超时按 E-UNIT-002 处理。
export const UNIT_SUITE_NPM_TEST_TIMEOUT_MS = 600000;
const MAX_LISTED_FAILURES = 15;

// evidence 用的输出尾巴：截尾 + 空白折叠成单行。
function collapseTail(text, maxChars = 600) {
  const s = String(text || "").trim();
  return (s.length > maxChars ? s.slice(-maxChars) : s).replace(/\s+/g, " ").trim();
}

// 纯函数：解析 node --test 的 totals 块。spec reporter 前缀 `ℹ`（Node 25 管道输出实测），
// TAP 前缀 `# ` 一并兼容。同键多次出现取最后一次（尾部 totals 为准）。
// 至少要有 tests/pass/fail 三行才算解析成功，否则返回 null（输出被截断/reporter 变了）。
export function parseNodeTestTotals(output) {
  const found = {};
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const match = /^\s*(?:ℹ|#)\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(rawLine);
    if (match) found[match[1]] = Number(match[2]);
  }
  if (!("tests" in found) || !("pass" in found) || !("fail" in found)) return null;
  return {
    tests: found.tests,
    suites: found.suites ?? 0,
    pass: found.pass,
    fail: found.fail,
    cancelled: found.cancelled ?? 0,
    skipped: found.skipped ?? 0,
    todo: found.todo ?? 0,
    durationMs: found.duration_ms ?? 0,
  };
}

// 纯函数：从 spec reporter 输出提取失败用例名（✖ 行）。
// 失败名会出现两次（内联 + 尾部 "✖ failing tests:" 复述段）→ 按名去重保序；
// 段标题行 "✖ failing tests:" 本身与行尾时长 "(1.23ms)" 剥掉。
export function extractFailedTestNames(output) {
  const names = [];
  const seen = new Set();
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("✖")) continue;
    const name = line.slice(1).trim().replace(/\s*\([0-9.]+ms\)$/, "");
    if (!name || name === "failing tests:" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

// 纯函数：spawn 结果 → CheckResult 载荷。返回 { check, totals, failedTests }。
// 判定序：spawn 错/超时（E-UNIT-002）→ totals 不可解析（E-UNIT-002）→
// fail/cancelled>0（E-UNIT-001，列名）→ 退出码非 0 但 totals 干净（E-UNIT-002，矛盾态）→ pass。
export function classifyNpmTestRun({
  spawnError = null,
  timedOut = false,
  exitCode = null,
  stdout = "",
  stderr = "",
  timeoutMs = UNIT_SUITE_NPM_TEST_TIMEOUT_MS,
} = {}) {
  const tail = collapseTail(`${stdout}\n${stderr}`);
  const infraFail = (evidence) => ({ check: { status: "fail", code: "E-UNIT-002", evidence }, totals: null, failedTests: [] });

  if (spawnError) {
    return infraFail(`npm test spawn failed: ${spawnError}${tail ? ` — output tail: ${tail}` : ""}`);
  }
  if (timedOut) {
    return infraFail(`npm test exceeded ${timeoutMs}ms and was killed — output tail: ${tail}`);
  }
  const totals = parseNodeTestTotals(stdout);
  if (!totals) {
    return infraFail(`npm test exited ${exitCode} but no node --test totals block found in stdout — output tail: ${tail}`);
  }

  const failedTests = extractFailedTestNames(stdout);
  if (totals.fail > 0 || totals.cancelled > 0) {
    const shown = failedTests.slice(0, MAX_LISTED_FAILURES);
    const more = failedTests.length - shown.length;
    const names = shown.length > 0
      ? `failing: ${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`
      : `failing test names not found in output — tail: ${tail}`;
    return {
      check: {
        status: "fail",
        code: "E-UNIT-001",
        evidence: `${totals.fail} fail / ${totals.cancelled} cancelled of ${totals.tests} tests (${totals.pass} pass, ${totals.skipped} skipped) — ${names}`,
      },
      totals,
      failedTests,
    };
  }
  if (exitCode !== 0) {
    return {
      check: {
        status: "fail",
        code: "E-UNIT-002",
        evidence: `npm test exited ${exitCode} although parsed totals report no failures (${totals.tests} tests, ${totals.pass} pass) — output tail: ${tail}`,
      },
      totals,
      failedTests,
    };
  }
  return {
    check: {
      status: "pass",
      evidence: `${totals.tests} tests: ${totals.pass} pass, ${totals.fail} fail, ${totals.skipped} skipped, ${totals.cancelled} cancelled (${(totals.durationMs / 1000).toFixed(1)}s)`,
    },
    totals,
    failedTests,
  };
}

// IO：spawn npm test，收 stdout/stderr，超时杀整个进程组（npm 会再 spawn node --test，
// 只杀 npm 会留孤儿 → detached + kill(-pid)）。永不 reject。
function spawnNpmTest({ cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn("npm", ["test"], {
        cwd,
        // OPENCLAW_TEST_ENV_LOCK_OWNER_PID:锁可重入凭据(2026-08-16 死锁修缮)——
        // formal run 在整个 run 期间持有 global-test-environment 锁,单测扫里 19 个
        // 文件会再抢同一把锁;凭据让子进程识别"锁就是我爹持的"直接透传,否则必等到
        // suite 600s 预算爆掉。(worker argv 上的一串诊断旗标是 Node 25 物化默认值的
        // 固有行为,与超时无关,勿再当嫌疑。)NODE_OPTIONS 置空是保险清洗:单测扫
        // 应跑在素净 node 上,不继承宿主环境可能设置的任何 node 旗标。
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          OPENCLAW_TEST_ENV_LOCK_OWNER_PID: String(process.pid),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      settle({ spawnError: error?.message || String(error), timedOut: false, exitCode: null, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ spawnError: error?.message || String(error), timedOut, exitCode: null, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ spawnError: null, timedOut, exitCode: code, stdout, stderr });
    });
  });
}

// suite 入口（契约：只 addCheck，不写报告，不抛顶层异常）。
export async function runUnitSuite(run, context) {
  const startedAt = Date.now();
  if (run) {
    run.currentCaseId = "npm-test";
    run.currentCaseMessage = `spawn npm test (node --test, ${UNIT_SUITE_NPM_TEST_TIMEOUT_MS / 1000}s budget)`;
  }

  const outcome = await spawnNpmTest({ cwd: WATCHDOG_DIR, timeoutMs: UNIT_SUITE_NPM_TEST_TIMEOUT_MS });
  const { check, totals } = classifyNpmTestRun(outcome);
  context.addCheck({
    id: "unit.npm-test",
    subsystem: "unit",
    title: "npm test (full node --test unit sweep) passes",
    durationMs: Date.now() - startedAt,
    ...check,
  });
  if (totals && totals.skipped > 0) {
    context.addCheck({
      id: "unit.env-gated-skips",
      subsystem: "unit",
      title: "Environment-gated unit skips (informational)",
      status: "pass",
      evidence: `${totals.skipped} of ${totals.tests} tests skipped by environment gates (node --test skip directives, e.g. optional local deps offline) — skip is not failure`,
      durationMs: 0,
    });
  }
}
