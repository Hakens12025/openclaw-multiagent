/**
 * harness-catalog-inspect.test.js — inspect.harness_catalog 发现面
 *
 * operator/dashboard 组装 harness 前发现可用模块与方案的正式 inspect 入口。
 * 复用 summarizeHarnessRegistry(零重派生)。验证 surface 注册 + 返回 {counts,modules,profiles}。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-inspector.js";

test("inspect.harness_catalog 已注册为 inspect 家族只读面", () => {
  const s = getCliSystemSurface("inspect.harness_catalog");
  assert.ok(s, "surface 应注册");
  assert.equal(s.family, "inspect");
  assert.equal(s.risk, "read");
  assert.equal(s.executable, true);
});

test("inspect.harness_catalog 返回 {counts, modules, profiles}(全 10 模块)", async () => {
  const data = await inspectCliSystemSurface({ surfaceId: "inspect.harness_catalog" });
  assert.ok(data && typeof data === "object");
  assert.ok(Array.isArray(data.modules), "modules 应为数组");
  assert.ok(Array.isArray(data.profiles), "profiles 应为数组");
  assert.equal(data.modules.length, 10, "目录应含 10 个 harness 模块");
  assert.equal(data.counts?.modules, 10);
  // 模块条目带 id/kind
  assert.ok(data.modules.every((m) => m.id && m.kind));
});
