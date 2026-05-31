/**
 * operator-harness-runs-surface.test.js — 锁定 harness_runs 旁路迁移（P-D.2）
 *
 * 背景：operator-snapshot 原先经 listRecentHarnessRuns 直读 HarnessRun store，
 * 属于绕过 CLI-system 的旁路。本次迁移把它收进正式 inspect surface
 * `inspect.harness_runs`，operator 经 getCliSystemSurface / inspectCliSystemSurface
 * 读取。
 *
 * 此测试锁定三件事：
 *   ① 新 surface 存在且合规（schema 冻结校验）
 *   ② operator-snapshot 的 harnessRuns 输出与迁移前等价（行为不变）
 *   ③ operator-snapshot 不再直读 store（该路径已收口）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  getCliSystemSurface,
  inspectCliSystemSurface,
} from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import { listRecentHarnessRuns } from "../lib/harness/harness-run-store.js";

// ── ① 新 surface 存在且合规 ──────────────────────────────────────────────────

test("inspect.harness_runs surface 存在于 CLI-system registry 且合规", () => {
  const surface = getCliSystemSurface("inspect.harness_runs");
  assert.ok(surface, "inspect.harness_runs 必须可经 getCliSystemSurface 取到");
  assert.equal(surface.family, "inspect", "family 应为 inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  assert.equal(surface.operatorExecutable, false, "inspect surface 不应是 operator-executable");
  assert.equal(surface.displayId, "control:inspect.harness_runs");

  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `surface 必须通过冻结 schema 校验: ${problems.join("; ")}`);
});

// ── ② 行为等价：经 surface 取到的 runs 与直接 store 调用一致 ───────────────────

test("inspectCliSystemSurface(inspect.harness_runs) 行为等价于 listRecentHarnessRuns", async () => {
  const limit = 6;
  const direct = await listRecentHarnessRuns(limit);
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.harness_runs",
    params: { limit },
  });

  // 同样的 runs、同样的字段、同样的 limit 语义（同一函数同一参数，结果应深度相等）
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
  assert.ok(Array.isArray(viaSurface), "结果必须是数组");
  assert.ok(viaSurface.length <= Math.max(1, limit), "limit 语义应保持");
});

test("inspectCliSystemSurface 透传不同 limit（limit 语义保持）", async () => {
  const direct = await listRecentHarnessRuns(1);
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.harness_runs",
    params: { limit: 1 },
  });
  assert.deepEqual(viaSurface, direct, "limit=1 时仍应等价");
});

// ── ③ operator-snapshot 不再直读 store ───────────────────────────────────────

test("operator-snapshot 经 inspect surface 读 HarnessRun，不再直接 import store", async () => {
  const source = await readFile(
    new URL("../lib/operator/operator-snapshot.js", import.meta.url),
    "utf8",
  );

  // 不再直接 import / 调用 listRecentHarnessRuns（旁路已收口）
  assert.doesNotMatch(
    source,
    /listRecentHarnessRuns/,
    "operator-snapshot 不应再引用 listRecentHarnessRuns（直读 store 旁路）",
  );
  assert.doesNotMatch(
    source,
    /harness\/harness-run-store/,
    "operator-snapshot 不应再 import harness-run-store",
  );

  // 改为经 CLI-system inspect surface 读取
  assert.match(
    source,
    /inspectCliSystemSurface/,
    "operator-snapshot 应经 inspectCliSystemSurface 读 HarnessRun",
  );
  assert.match(
    source,
    /inspect\.harness_runs/,
    "operator-snapshot 应引用 inspect.harness_runs surface id",
  );
});

// ── 不变性：cli-surface-inspector 是 inspect surface 的唯一 dispatch 点 ─────────

test("inspectCliSystemSurface 拒绝非 inspect family surface", async () => {
  await assert.rejects(
    () => inspectCliSystemSurface({ surfaceId: "observe.track_progress" }),
    /not inspect family/u,
    "observe surface 不应能经 inspect dispatch",
  );
});

test("inspectCliSystemSurface 拒绝未知 surface", async () => {
  await assert.rejects(
    () => inspectCliSystemSurface({ surfaceId: "inspect.does_not_exist" }),
    /unknown cli-system surface/u,
  );
});
