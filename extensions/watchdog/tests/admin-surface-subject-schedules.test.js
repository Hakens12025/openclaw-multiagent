/**
 * TDD: admin-surface-subject.js — schedules.* 归类 bug
 *
 * Bug: schedules.create/update/enable/disable/delete 落入 default 分支，
 *      被错分为 kind:"platform" 而非 kind:"schedule"。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildAdminSurfaceSubject } from "../lib/admin/admin-surface-subject.js";

// 已有正确分支（回归保护）
test("schedules.list => kind:schedule catalog", () => {
  const result = buildAdminSurfaceSubject("schedules.list");
  assert.equal(result.kind, "schedule");
  assert.equal(result.scope, "catalog");
  assert.equal(result.aspect, "registry");
  assert.equal(result.selectorKey, null);
});

// Bug: 下面五个被错分为 kind:"platform"
test("schedules.create => kind:schedule instance", () => {
  const result = buildAdminSurfaceSubject("schedules.create");
  assert.equal(result.kind, "schedule");
  assert.equal(result.scope, "instance");
  assert.equal(result.selectorKey, "scheduleId");
  assert.equal(result.aspect, "create");
});

test("schedules.update => kind:schedule instance", () => {
  const result = buildAdminSurfaceSubject("schedules.update");
  assert.equal(result.kind, "schedule");
  assert.equal(result.scope, "instance");
  assert.equal(result.selectorKey, "scheduleId");
  assert.equal(result.aspect, "update");
});

test("schedules.enable => kind:schedule instance", () => {
  const result = buildAdminSurfaceSubject("schedules.enable");
  assert.equal(result.kind, "schedule");
  assert.equal(result.scope, "instance");
  assert.equal(result.selectorKey, "scheduleId");
  assert.equal(result.aspect, "enable");
});

test("schedules.disable => kind:schedule instance", () => {
  const result = buildAdminSurfaceSubject("schedules.disable");
  assert.equal(result.kind, "schedule");
  assert.equal(result.scope, "instance");
  assert.equal(result.selectorKey, "scheduleId");
  assert.equal(result.aspect, "disable");
});

test("schedules.delete => kind:schedule instance", () => {
  const result = buildAdminSurfaceSubject("schedules.delete");
  assert.equal(result.kind, "schedule");
  assert.equal(result.scope, "instance");
  assert.equal(result.selectorKey, "scheduleId");
  assert.equal(result.aspect, "delete");
});

// automations.* 不受影响（回归保护）
test("automations.create still => kind:automation", () => {
  const result = buildAdminSurfaceSubject("automations.create");
  assert.equal(result.kind, "automation");
});

test("automations.list still => kind:automation catalog", () => {
  const result = buildAdminSurfaceSubject("automations.list");
  assert.equal(result.kind, "automation");
  assert.equal(result.scope, "catalog");
});
