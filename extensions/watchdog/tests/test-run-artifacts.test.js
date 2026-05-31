import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildTestRunReportText,
  writeTestRunArtifacts,
} from "../lib/test-run-artifacts.js";

function buildRun(overrides = {}) {
  return {
    id: "TR-ARTIFACT",
    startedAt: 1000,
    finishedAt: 3500,
    caseResults: [
      {
        pass: true,
        blocked: false,
        duration: "1.0",
        testCase: {
          id: "simple-03",
          message: "你好",
        },
        results: [],
      },
    ],
    reportFile: null,
    rawReportFile: null,
    reportText: "",
    ...overrides,
  };
}

function snapshotRun(run) {
  return {
    id: run.id,
    reportText: run.reportText,
    caseResults: run.caseResults,
  };
}

test("buildTestRunReportText selects the formal report generator for static suites", () => {
  const report = buildTestRunReportText({
    run: buildRun(),
    preset: { id: "single", suite: "single" },
  });

  assert.match(report, /OPENCLAW TEST REPORT/);
  assert.match(report, /Suite: devtool:single/);
  assert.match(report, /你好/);
});

test("writeTestRunArtifacts writes stable text and raw artifacts once paths exist", async () => {
  const reportsDir = await mkdtemp(join(tmpdir(), "openclaw-test-run-artifacts-"));
  const run = buildRun();

  try {
    const written = await writeTestRunArtifacts({
      run,
      preset: { id: "single", suite: "single" },
      reportsDir,
      nowTs: () => "2026-05-17-03-00-00",
      snapshotRun,
    });

    assert.equal(written.reportFile, join(reportsDir, "devtool-single-2026-05-17-03-00-00.txt"));
    assert.equal(written.rawReportFile, join(reportsDir, "devtool-single-2026-05-17-03-00-00.json"));
    assert.equal(run.reportFile, written.reportFile);
    assert.equal(run.rawReportFile, written.rawReportFile);
    assert.equal(run.reportText, await readFile(written.reportFile, "utf8"));

    const raw = JSON.parse(await readFile(written.rawReportFile, "utf8"));
    assert.equal(raw.id, "TR-ARTIFACT");
    assert.equal(raw.reportText, run.reportText);

    const second = await writeTestRunArtifacts({
      run,
      preset: { id: "single", suite: "single" },
      reportsDir,
      nowTs: () => "ignored",
      snapshotRun,
    });
    assert.deepEqual(second, written);
  } finally {
    await rm(reportsDir, { recursive: true, force: true });
  }
});
