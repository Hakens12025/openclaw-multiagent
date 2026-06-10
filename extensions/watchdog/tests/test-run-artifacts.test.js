import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildTestRunReportText,
  writeTestRunArtifacts,
} from "../lib/test-run-artifacts.js";
import { FORMAL_REPORT_SCHEMA } from "../lib/formal-runtime/formal-report.js";

function buildRun(overrides = {}) {
  return {
    id: "TR-ARTIFACT",
    label: "系统健康体检",
    startedAt: 1000,
    finishedAt: 3500,
    checks: [
      {
        id: "config.parse",
        subsystem: "config",
        title: "openclaw.json parses",
        status: "pass",
        evidence: "你好",
        durationMs: 3,
      },
      {
        id: "graph.edges-exist",
        subsystem: "graph",
        title: "graph has edges",
        status: "fail",
        code: "E-GRAPH-001",
        evidence: "0 edges — 你好链路未建",
        durationMs: 5,
      },
    ],
    reportFile: null,
    rawReportFile: null,
    reportText: "",
    ...overrides,
  };
}

test("buildTestRunReportText renders the failures-first formal check report", () => {
  const report = buildTestRunReportText({
    run: buildRun(),
    preset: { id: "health", suite: "health" },
  });

  assert.match(report, /OPENCLAW FORMAL CHECK REPORT/);
  assert.match(report, /Preset: health/);
  assert.match(report, /VERDICT: FAIL \(1\/2 failed, 0 skipped, 0 blocked\)/);
  assert.match(report, /## FAILURES FIRST/);
  assert.match(report, /\[E-GRAPH-001\] graph has edges/);
  assert.match(report, /你好/);
});

test("writeTestRunArtifacts writes stable text and machine-readable mirror once paths exist", async () => {
  const reportsDir = await mkdtemp(join(tmpdir(), "openclaw-test-run-artifacts-"));
  const run = buildRun();

  try {
    const written = await writeTestRunArtifacts({
      run,
      preset: { id: "health", suite: "health" },
      reportsDir,
      nowTs: () => "2026-06-10-03-00-00",
    });

    assert.equal(written.reportFile, join(reportsDir, "devtool-health-2026-06-10-03-00-00.txt"));
    assert.equal(written.rawReportFile, join(reportsDir, "devtool-health-2026-06-10-03-00-00.json"));
    assert.equal(run.reportFile, written.reportFile);
    assert.equal(run.rawReportFile, written.rawReportFile);
    assert.equal(run.reportText, await readFile(written.reportFile, "utf8"));

    const raw = JSON.parse(await readFile(written.rawReportFile, "utf8"));
    assert.equal(raw.schema, FORMAL_REPORT_SCHEMA);
    assert.equal(raw.presetId, "health");
    assert.equal(raw.verdict, "FAIL");
    assert.deepEqual(
      { total: raw.totals.total, pass: raw.totals.pass, fail: raw.totals.fail },
      { total: 2, pass: 1, fail: 1 },
    );
    assert.equal(raw.checks.length, 2);
    assert.ok(raw.checks[1].hint, "non-pass check should carry a resolved hint in the mirror");

    const second = await writeTestRunArtifacts({
      run,
      preset: { id: "health", suite: "health" },
      reportsDir,
      nowTs: () => "ignored",
    });
    assert.deepEqual(second, written);
  } finally {
    await rm(reportsDir, { recursive: true, force: true });
  }
});
