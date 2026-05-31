import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  collectSingleCases,
  resolvePresetCases,
  normalizeTestRunCleanMode,
  resolveRequestedFormalPreset,
} from "../lib/test-run-presets.js";

test("resolveRequestedFormalPreset builds an ad hoc single-case preset for simple-02", () => {
  const preset = resolveRequestedFormalPreset({ caseId: "simple-02" });

  assert.equal(preset.id, "case-simple-02");
  assert.equal(preset.suite, "single");
  assert.equal(preset.transport, "isolated");
  assert.deepEqual(preset.caseIds, ["simple-02"]);
});

test("resolveRequestedFormalPreset rejects mixed preset and case inputs", () => {
  assert.throws(
    () => resolveRequestedFormalPreset({ presetId: "single", caseId: "simple-02" }),
    /either presetId or caseId/i,
  );
});

test("resolveRequestedFormalPreset does not expose legacy synthetic loop cases as ad hoc runs", () => {
  assert.throws(
    () => resolveRequestedFormalPreset({ caseId: "pipeline-basic" }),
    /unknown case: pipeline-basic/i,
  );
});

test("formal case collectors reject missing case ids instead of silently dropping them", () => {
  assert.throws(
    () => collectSingleCases(["simple-01", "missing-case"]),
    /unknown single case: missing-case/i,
  );
});

test("formal preset case resolution fails closed when preset ids drift from registered cases", () => {
  assert.throws(
    () => resolvePresetCases({
      id: "bad-preset",
      suite: "single",
      caseIds: ["simple-01", "missing-case"],
    }),
    /unknown single case: missing-case/i,
  );
});

test("normalizeTestRunCleanMode only accepts the canonical session clean mode", () => {
  assert.equal(normalizeTestRunCleanMode(null), "session-clean");
  assert.equal(normalizeTestRunCleanMode(" session-clean "), "session-clean");
  assert.throws(
    () => normalizeTestRunCleanMode("full-clean"),
    /unsupported test run cleanMode/i,
  );
});

test("test run HTTP route delegates start semantics to admin surface", async () => {
  const source = await readFile(new URL("../routes/test-runs.js", import.meta.url), "utf8");

  assert.match(source, /executeAdminSurfaceOperation/);
  assert.doesNotMatch(source, /import \{[^}]*startTestRun/u);
});

test("test_runs.start admin surface forwards ad hoc case id", async () => {
  const source = await readFile(new URL("../lib/admin/admin-surface-operations.js", import.meta.url), "utf8");

  assert.match(source, /caseId:\s*payload\.caseId/u);
});

test("change-set verification starts test runs through admin surface", async () => {
  const source = await readFile(new URL("../lib/admin/admin-change-set-executor.js", import.meta.url), "utf8");

  assert.match(source, /surfaceId:\s*"test_runs\.start"/u);
  assert.doesNotMatch(source, /import \{[^}]*startTestRun/u);
});
