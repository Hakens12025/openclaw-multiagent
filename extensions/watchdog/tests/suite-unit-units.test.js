/**
 * suite-unit-units.test.js — unit 套件（npm test 收口）的纯逻辑单测
 *
 * 锁定 lib/formal-runtime/suite-unit.js 的三个纯函数（零 spawn）：
 *   ① parseNodeTestTotals — node --test 尾部 totals 块解析（spec `ℹ` / TAP `#` 前缀、
 *      尾部取胜、缺关键行返回 null）
 *   ② extractFailedTestNames — ✖ 行提取（内联 + 尾部复述段去重、剥时长、丢段标题）
 *   ③ classifyNpmTestRun — spawn 结果 → CheckResult 载荷（E-UNIT-001/002 分派）
 * IO 层（spawnNpmTest / runUnitSuite / graph 快照写回）不在本文件覆盖范围。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  UNIT_SUITE_NPM_TEST_TIMEOUT_MS,
  classifyNpmTestRun,
  extractFailedTestNames,
  parseNodeTestTotals,
} from "../lib/formal-runtime/suite-unit.js";

// 实测样例：Node v25.6.1 spec reporter 管道输出（1 pass / 1 fail / 1 skip），
// 失败用例内联一次 + 尾部 "✖ failing tests:" 段复述一次。
const SPEC_OUTPUT_WITH_FAILURE = `
> openclaw-multi-agent-system@1.0.0 test
> node --test tests/*.test.js

✔ passes fine (0.269792ms)
✖ fails badly (0.276208ms)
﹣ skipped one (0.034083ms) # env gate
ℹ tests 3
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 33.682125

✖ failing tests:

test at sample.test.js:4:1
✖ fails badly (0.276208ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2
`;

const SPEC_OUTPUT_ALL_GREEN = `
✔ a (0.1ms)
✔ b (0.2ms)
ℹ tests 1588
ℹ suites 0
ℹ pass 1587
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 412345.5
`;

// ── ① parseNodeTestTotals ────────────────────────────────────────────────────

test("parseNodeTestTotals parses the spec reporter totals block", () => {
  assert.deepEqual(parseNodeTestTotals(SPEC_OUTPUT_WITH_FAILURE), {
    tests: 3,
    suites: 0,
    pass: 1,
    fail: 1,
    cancelled: 0,
    skipped: 1,
    todo: 0,
    durationMs: 33.682125,
  });
});

test("parseNodeTestTotals accepts TAP-style `#` totals lines", () => {
  const tap = "# tests 5\n# suites 0\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12\n";
  const totals = parseNodeTestTotals(tap);
  assert.equal(totals.tests, 5);
  assert.equal(totals.pass, 4);
  assert.equal(totals.fail, 1);
  assert.equal(totals.durationMs, 12);
});

test("parseNodeTestTotals takes the LAST occurrence when a key repeats (tail totals win)", () => {
  const doubled = "ℹ tests 2\nℹ pass 1\nℹ fail 1\nnoise\nℹ tests 10\nℹ pass 10\nℹ fail 0\n";
  const totals = parseNodeTestTotals(doubled);
  assert.equal(totals.tests, 10);
  assert.equal(totals.pass, 10);
  assert.equal(totals.fail, 0);
});

test("parseNodeTestTotals returns null when the totals block is absent or truncated", () => {
  assert.equal(parseNodeTestTotals(""), null);
  assert.equal(parseNodeTestTotals("random npm noise\nnpm error something\n"), null);
  // 缺 fail 行（截断）→ null，不得猜
  assert.equal(parseNodeTestTotals("ℹ tests 3\nℹ pass 3\n"), null);
});

test("parseNodeTestTotals does not mistake test titles for totals lines", () => {
  const tricky = "✔ tests 5 (0.2ms)\n✖ pass 9 (0.1ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n";
  const totals = parseNodeTestTotals(tricky);
  assert.equal(totals.tests, 2);
  assert.equal(totals.pass, 1);
});

// ── ② extractFailedTestNames ─────────────────────────────────────────────────

test("extractFailedTestNames dedupes inline + tail-section repeats, strips durations, drops the section header", () => {
  assert.deepEqual(extractFailedTestNames(SPEC_OUTPUT_WITH_FAILURE), ["fails badly"]);
});

test("extractFailedTestNames preserves encounter order across multiple failures", () => {
  const output = "  ✖ first bad (1ms)\n✔ ok (1ms)\n    ✖ second bad (2.5ms)\n\n✖ failing tests:\n✖ first bad (1ms)\n✖ second bad (2.5ms)\n";
  assert.deepEqual(extractFailedTestNames(output), ["first bad", "second bad"]);
});

test("extractFailedTestNames returns [] on green output", () => {
  assert.deepEqual(extractFailedTestNames(SPEC_OUTPUT_ALL_GREEN), []);
});

// ── ③ classifyNpmTestRun ─────────────────────────────────────────────────────

test("classifyNpmTestRun: green run → pass without code, evidence carries the totals", () => {
  const { check, totals } = classifyNpmTestRun({ exitCode: 0, stdout: SPEC_OUTPUT_ALL_GREEN });
  assert.equal(check.status, "pass");
  assert.equal(check.code, undefined);
  assert.match(check.evidence, /1588 tests: 1587 pass, 0 fail, 1 skipped/);
  assert.equal(totals.skipped, 1); // suite 侧据此补 unit.env-gated-skips 注记
});

test("classifyNpmTestRun: failing tests → fail E-UNIT-001 listing the ✖ names", () => {
  const { check, failedTests } = classifyNpmTestRun({ exitCode: 1, stdout: SPEC_OUTPUT_WITH_FAILURE });
  assert.equal(check.status, "fail");
  assert.equal(check.code, "E-UNIT-001");
  assert.match(check.evidence, /1 fail \/ 0 cancelled of 3 tests/);
  assert.match(check.evidence, /failing: fails badly/);
  assert.deepEqual(failedTests, ["fails badly"]);
});

test("classifyNpmTestRun: spawn error → fail E-UNIT-002", () => {
  const { check } = classifyNpmTestRun({ spawnError: "spawn npm ENOENT" });
  assert.equal(check.status, "fail");
  assert.equal(check.code, "E-UNIT-002");
  assert.match(check.evidence, /spawn failed: spawn npm ENOENT/);
});

test("classifyNpmTestRun: timeout → fail E-UNIT-002 naming the budget", () => {
  const { check } = classifyNpmTestRun({ timedOut: true, stdout: "partial output" });
  assert.equal(check.status, "fail");
  assert.equal(check.code, "E-UNIT-002");
  assert.match(check.evidence, new RegExp(`exceeded ${UNIT_SUITE_NPM_TEST_TIMEOUT_MS}ms`));
});

test("classifyNpmTestRun: unparsable totals → fail E-UNIT-002 with the output tail", () => {
  const { check, totals } = classifyNpmTestRun({ exitCode: 1, stdout: "npm exploded before the reporter ran" });
  assert.equal(check.status, "fail");
  assert.equal(check.code, "E-UNIT-002");
  assert.match(check.evidence, /no node --test totals block/);
  assert.match(check.evidence, /npm exploded before the reporter ran/);
  assert.equal(totals, null);
});

test("classifyNpmTestRun: non-zero exit with clean totals → fail E-UNIT-002 (contradictory state)", () => {
  const { check } = classifyNpmTestRun({ exitCode: 7, stdout: SPEC_OUTPUT_ALL_GREEN });
  assert.equal(check.status, "fail");
  assert.equal(check.code, "E-UNIT-002");
  assert.match(check.evidence, /exited 7 although parsed totals report no failures/);
});
