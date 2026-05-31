import test from "node:test";
import assert from "node:assert/strict";

import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import { listCliSystemSurfaces } from "../lib/cli-system/cli-surface-registry.js";
import { CLI_SYSTEM_STATIC_SURFACES } from "../lib/cli-system/cli-surface-catalog.js";

// ── 正向测试：所有 static + admin surfaces 必须通过 ─────────────────────────

test("all registered cli-system surfaces (static + admin) pass schema validation", () => {
  const surfaces = listCliSystemSurfaces();
  assert.ok(surfaces.length > 0, "registry must return at least one surface");

  const failures = [];
  for (const surface of surfaces) {
    const { ok, problems } = validateCliSurface(surface);
    if (!ok) {
      failures.push(`${surface.id}: ${problems.join("; ")}`);
    }
  }
  assert.deepEqual(failures, [], `surfaces that failed validation: ${failures.join("\n")}`);
});

test("all static catalog surfaces pass schema validation before normalization", () => {
  const failures = [];
  for (const surface of CLI_SYSTEM_STATIC_SURFACES) {
    const { ok, problems } = validateCliSurface(surface);
    if (!ok) {
      failures.push(`${surface.id}: ${problems.join("; ")}`);
    }
  }
  assert.deepEqual(failures, [], `raw static surfaces that failed: ${failures.join("\n")}`);
});

test("registry surfaces have all four required fields populated", () => {
  const surfaces = listCliSystemSurfaces();
  for (const surface of surfaces) {
    assert.ok(typeof surface.id === "string" && surface.id !== "", `surface.id missing for: ${JSON.stringify(surface)}`);
    assert.ok(typeof surface.family === "string" && surface.family !== "", `surface.family missing for id=${surface.id}`);
    assert.ok(typeof surface.source === "string" && surface.source !== "", `surface.source missing for id=${surface.id}`);
    assert.ok(typeof surface.status === "string" && surface.status !== "", `surface.status missing for id=${surface.id}`);
  }
});

// ── 负向测试：非法形状必须被拒绝 ───────────────────────────────────────────

test("validateCliSurface rejects non-object input", () => {
  assert.equal(validateCliSurface(null).ok, false);
  assert.equal(validateCliSurface(undefined).ok, false);
  assert.equal(validateCliSurface("string").ok, false);
  assert.equal(validateCliSurface(42).ok, false);
  assert.equal(validateCliSurface([]).ok, false);
});

test("validateCliSurface rejects surface missing required id", () => {
  const { ok, problems } = validateCliSurface({
    family: "hook",
    source: "runtime_hook",
    status: "active",
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("id")), `expected id problem, got: ${problems.join("; ")}`);
});

test("validateCliSurface rejects surface with invalid family value", () => {
  const { ok, problems } = validateCliSurface({
    id: "test.surface",
    family: "unknown_family",
    source: "test",
    status: "active",
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("family")), `expected family problem, got: ${problems.join("; ")}`);
});

test("validateCliSurface rejects surface missing source", () => {
  const { ok, problems } = validateCliSurface({
    id: "test.surface",
    family: "inspect",
    status: "active",
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("source")), `expected source problem, got: ${problems.join("; ")}`);
});

test("validateCliSurface rejects surface missing status", () => {
  const { ok, problems } = validateCliSurface({
    id: "test.surface",
    family: "apply",
    source: "admin_surface",
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("status")), `expected status problem, got: ${problems.join("; ")}`);
});

test("validateCliSurface accepts minimal valid surface", () => {
  const { ok, problems } = validateCliSurface({
    id: "test.surface",
    family: "verify",
    source: "test_source",
    status: "active",
  });
  assert.equal(ok, true, `unexpected problems: ${problems.join("; ")}`);
  assert.deepEqual(problems, []);
});

test("validateCliSurface accepts all valid family values", () => {
  for (const family of ["hook", "observe", "inspect", "apply", "verify"]) {
    const { ok } = validateCliSurface({
      id: `test.${family}`,
      family,
      source: "test_source",
      status: "active",
    });
    assert.equal(ok, true, `family="${family}" should be valid`);
  }
});

test("validateCliSurface returns all problems at once for multiple missing fields", () => {
  const { ok, problems } = validateCliSurface({});
  assert.equal(ok, false);
  assert.ok(problems.length >= 4, `expected at least 4 problems for empty object, got: ${problems.join("; ")}`);
});
