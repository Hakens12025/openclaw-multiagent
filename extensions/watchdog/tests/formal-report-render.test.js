/**
 * formal-report-render.test.js — 报告渲染契约
 *
 * .txt：VERDICT 行 → FAILURES FIRST（fail/blocked 展开 evidence+hint）→
 * 按 subsystem 分节（pass 一行一条）→ totals 页脚。
 * .json：{ schema, presetId, startedAt, finishedAt, verdict, totals, checks } 镜像。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { generateFormalReport, buildFormalReportJson, FORMAL_REPORT_SCHEMA } from "../lib/formal-runtime/formal-report.js";
import { getErrorCode } from "../lib/formal-runtime/error-codes.js";

const RUN = {
  presetId: "health",
  label: "零 LLM 健康检查",
  startedAt: "2026-06-10T01:00:00.000Z",
  finishedAt: "2026-06-10T01:00:42.000Z",
  gatewayPort: 18789,
};

// 2 pass + 1 fail（带 hint 覆盖）+ 1 skip + 1 blocked（吃注册表默认 hint）
const CHECKS = [
  { id: "gateway.auth-reject", subsystem: "gateway", title: "no-token request rejected", status: "pass", evidence: "401 Unauthorized", durationMs: 12 },
  { id: "graph.node-roster", subsystem: "graph", title: "edge endpoints are configured agents", status: "pass", evidence: "14 edges / 9 agents", durationMs: 8 },
  { id: "graph.edge-integrity", subsystem: "graph", title: "graph has edges", status: "fail", code: "E-GRAPH-002", evidence: "agent-graph.json contains 0 edges for 9 agents", hint: "override: rebuild D7 topology first", durationMs: 15 },
  { id: "knowledge.recall-floor", subsystem: "knowledge", title: "recall floors", status: "skip", code: "E-KNOWLEDGE-SKIP", evidence: "ollama not reachable", durationMs: 3 },
  { id: "sse.connect", subsystem: "sse", title: "stream connect", status: "blocked", code: "E-RUNNER-003", evidence: "gateway unreachable", durationMs: 0 },
];

test("txt：VERDICT 行精确（N/M failed, K skipped, J blocked）", () => {
  const report = generateFormalReport({ run: RUN, checks: CHECKS });
  assert.match(report, /^VERDICT: FAIL \(1\/5 failed, 1 skipped, 1 blocked\)$/m);
});

test("txt：header 含 preset/时间/gateway；FAILURES FIRST 区在 subsystem 分节之前", () => {
  const report = generateFormalReport({ run: RUN, checks: CHECKS });
  assert.match(report, /OPENCLAW FORMAL CHECK REPORT/);
  assert.match(report, /Preset: health — 零 LLM 健康检查/);
  assert.match(report, /Gateway: localhost:18789/);
  assert.ok(report.indexOf("## FAILURES FIRST") < report.indexOf("## SUBSYSTEM:"), "failures-first must precede subsystem sections");
});

test("txt：fail 与 blocked 都在 FAILURES FIRST 展开（码/evidence/hint），skip 不在", () => {
  const report = generateFormalReport({ run: RUN, checks: CHECKS });
  const failuresSection = report.slice(report.indexOf("## FAILURES FIRST"), report.indexOf("## SUBSYSTEM:"));

  assert.match(failuresSection, /\[E-GRAPH-002\] graph has edges/);
  assert.match(failuresSection, /check: graph\.edge-integrity \(fail, 15ms\)/);
  assert.match(failuresSection, /evidence: agent-graph\.json contains 0 edges for 9 agents/);
  assert.match(failuresSection, /hint: override: rebuild D7 topology first/, "check.hint must override registry default");

  assert.match(failuresSection, /\[E-RUNNER-003\] stream connect/, "blocked must be expanded too");
  assert.match(failuresSection, new RegExp(getErrorCode("E-RUNNER-003").hint.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "registry hint used when check has no override");

  assert.ok(!failuresSection.includes("knowledge.recall-floor"), "skip does not belong to failures-first");
});

test("txt：subsystem 分节里 pass 一行一条；skip 行带码与原因", () => {
  const report = generateFormalReport({ run: RUN, checks: CHECKS });
  const lines = report.split("\n");

  const passRows = lines.filter((line) => line.includes("graph.node-roster"));
  assert.equal(passRows.length, 1, "a passing check renders exactly one line");
  assert.match(passRows[0], /^ {2}PASS {4}graph\.node-roster — edge endpoints are configured agents \(8ms\)$/);

  const skipRow = lines.find((line) => line.includes("knowledge.recall-floor"));
  assert.match(skipRow, /SKIP {4}knowledge\.recall-floor \[E-KNOWLEDGE-SKIP\]/);
  assert.match(skipRow, /ollama not reachable/);

  assert.match(report, /## SUBSYSTEM: graph — 1 pass, 1 fail, 0 skip, 0 blocked/);
  assert.match(report, /TOTALS: 5 checks \| 2 pass \| 1 fail \| 1 skip \| 1 blocked/);
  assert.match(report, /DURATION: wall 42\.0s/);
});

test("txt：全 pass → VERDICT PASS 且 FAILURES FIRST 为 (none)", () => {
  const report = generateFormalReport({ run: { presetId: "health" }, checks: CHECKS.slice(0, 2) });
  assert.match(report, /^VERDICT: PASS \(0\/2 failed, 0 skipped, 0 blocked\)$/m);
  assert.match(report, /## FAILURES FIRST\n {2}\(none\)/);
});

test("json：镜像字段齐全，totals 正确，非 pass 的 hint 已解析", () => {
  const json = buildFormalReportJson({ run: RUN, checks: CHECKS });

  assert.equal(json.schema, FORMAL_REPORT_SCHEMA);
  assert.equal(json.presetId, "health");
  assert.equal(json.startedAt, "2026-06-10T01:00:00.000Z");
  assert.equal(json.finishedAt, "2026-06-10T01:00:42.000Z");
  assert.equal(json.verdict, "FAIL");
  assert.deepEqual(json.totals, { total: 5, pass: 2, fail: 1, skip: 1, blocked: 1, durationMs: 38 });
  assert.equal(json.checks.length, 5);

  const failCheck = json.checks.find((c) => c.id === "graph.edge-integrity");
  assert.equal(failCheck.code, "E-GRAPH-002");
  assert.equal(failCheck.hint, "override: rebuild D7 topology first");

  const blockedCheck = json.checks.find((c) => c.id === "sse.connect");
  assert.equal(blockedCheck.hint, getErrorCode("E-RUNNER-003").hint, "registry hint resolved into json mirror");

  const passCheck = json.checks.find((c) => c.id === "gateway.auth-reject");
  assert.equal(passCheck.hint, undefined, "pass carries no hint");
});

test("json/txt：epoch ms 时间被归一为 ISO；空 checks 不抛", () => {
  const json = buildFormalReportJson({ run: { presetId: "dispatch", startedAt: 1760000000000, finishedAt: 1760000005000 } });
  assert.equal(json.startedAt, new Date(1760000000000).toISOString());
  assert.equal(json.verdict, "PASS");
  assert.equal(json.totals.total, 0);

  const report = generateFormalReport({});
  assert.match(report, /VERDICT: PASS \(0\/0 failed, 0 skipped, 0 blocked\)/);
  assert.match(report, /\(no checks recorded\)/);
});
