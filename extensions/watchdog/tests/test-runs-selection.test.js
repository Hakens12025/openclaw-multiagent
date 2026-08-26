import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  collectDispatchCases,
  collectPipelineCases,
  normalizeTestRunCleanMode,
  resolveRequestedFormalPreset,
} from "../lib/formal-runtime/test-run-presets.js";

test("resolveRequestedFormalPreset builds an ad hoc single-case preset for answer-direct", () => {
  const preset = resolveRequestedFormalPreset({ caseId: "answer-direct" });

  assert.equal(preset.id, "case-answer-direct");
  assert.equal(preset.suite, "single");
  assert.equal(preset.transport, "isolated");
  assert.deepEqual(preset.caseIds, ["answer-direct"]);
});

test("resolveRequestedFormalPreset builds an ad hoc pipeline-case preset for brief-to-deliverable", () => {
  const preset = resolveRequestedFormalPreset({ caseId: "brief-to-deliverable" });

  assert.equal(preset.id, "case-brief-to-deliverable");
  assert.equal(preset.suite, "pipeline");
  assert.deepEqual(preset.caseIds, ["brief-to-deliverable"]);
});

test("resolveRequestedFormalPreset rejects mixed preset and case inputs", () => {
  assert.throws(
    () => resolveRequestedFormalPreset({ presetId: "single", caseId: "answer-direct" }),
    /either presetId or caseId/i,
  );
});

test("resolveRequestedFormalPreset tombstones renamed preset ids with the new name", () => {
  for (const [oldId, newId] of [
    ["dispatch", "single"],
    ["system-action", "collab"],
    ["agent-group", "group"],
    ["providers", "model"],
  ]) {
    assert.throws(
      () => resolveRequestedFormalPreset({ presetId: oldId }),
      new RegExp(`renamed preset: "${oldId}" is now "${newId}"`),
    );
  }
});

test("resolveRequestedFormalPreset does not expose retired single-suite cases as ad hoc runs", () => {
  assert.throws(
    () => resolveRequestedFormalPreset({ caseId: "simple-03" }),
    /unknown case: simple-03/i,
  );
});

test("formal case collectors reject missing case ids instead of silently dropping them", () => {
  assert.throws(
    () => collectDispatchCases(["answer-direct", "missing-case"]),
    /unknown single case: missing-case/i,
  );
  assert.throws(
    () => collectPipelineCases(["missing-case"]),
    /unknown pipeline case: missing-case/i,
  );
});

test("normalizeTestRunCleanMode accepts session-clean and none, rejects everything else", () => {
  assert.equal(normalizeTestRunCleanMode(null), "session-clean");
  assert.equal(normalizeTestRunCleanMode(" session-clean "), "session-clean");
  assert.equal(normalizeTestRunCleanMode("none"), "none");
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
  const source = await readFile(new URL("../lib/admin/operations/admin-surface-operations.js", import.meta.url), "utf8");

  assert.match(source, /caseId:\s*payload\.caseId/u);
});

test("change-set verification starts test runs through admin surface", async () => {
  const source = await readFile(new URL("../lib/admin/change-sets/admin-change-set-executor.js", import.meta.url), "utf8");

  assert.match(source, /surfaceId:\s*"test_runs\.start"/u);
  assert.doesNotMatch(source, /import \{[^}]*startTestRun/u);
});
