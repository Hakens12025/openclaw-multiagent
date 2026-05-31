/**
 * operator-low-risk-surfaces.test.js — 锁定 5 个低风险纯透传旁路迁移（P-D.2 续）
 *
 * 背景：operator-snapshot 原先直读以下 runtime store/registry：
 *   - listResolvedGraphLoops  (loop/graph-loop-registry)
 *   - listResolvedLoopSessions(loop/loop-session-store)
 *   - summarizeScheduleRegistry(schedule/schedule-registry)
 *   - summarizeAgentJoinRegistry(agent/agent-join-registry)
 *   - listTestRuns            (test-runs)
 * 均属绕过 CLI-system 的旁路。本次复用 inspect-surface 模式收口为：
 *   inspect.graph_loops / inspect.loop_sessions / inspect.schedules /
 *   inspect.agent_joins / inspect.test_runs
 *
 * 每个锁定三件事：
 *   ① 新 surface 存在且合规（冻结 schema 校验）
 *   ② 经 surface 读取与直读 store 深度等价（行为不变、同参数同返回）
 *   ③ operator-snapshot 不再直读对应 store
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  getCliSystemSurface,
  inspectCliSystemSurface,
} from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";

// 直读源（仅供等价性对照，不在 operator 路径中使用）
import { listResolvedGraphLoops } from "../lib/loop/graph-loop-registry.js";
import { listResolvedLoopSessions } from "../lib/loop/loop-session-store.js";
import { summarizeScheduleRegistry } from "../lib/schedule/schedule-registry.js";
import { summarizeAgentJoinRegistry } from "../lib/agent/agent-join-registry.js";
import { listTestRuns } from "../lib/test-runs.js";

// ── ① 5 个 surface 存在且合规 ────────────────────────────────────────────────

const EXPECTED_SURFACES = [
  "inspect.graph_loops",
  "inspect.loop_sessions",
  "inspect.schedules",
  "inspect.agent_joins",
  "inspect.test_runs",
];

for (const id of EXPECTED_SURFACES) {
  test(`${id} surface 存在于 CLI-system registry 且合规`, () => {
    const surface = getCliSystemSurface(id);
    assert.ok(surface, `${id} 必须可经 getCliSystemSurface 取到`);
    assert.equal(surface.family, "inspect", "family 应为 inspect");
    assert.equal(surface.status, "active");
    assert.equal(surface.source, "runtime_inspect");
    assert.equal(surface.operatorExecutable, false, "inspect surface 不应是 operator-executable");
    assert.equal(surface.displayId, `control:${id}`);

    const { ok, problems } = validateCliSurface(surface);
    assert.equal(ok, true, `${id} 必须通过冻结 schema 校验: ${problems.join("; ")}`);
  });
}

// ── ② 行为等价：经 surface 取到的数据与直读 store 深度相等 ──────────────────────

test("inspect.graph_loops 行为等价于 listResolvedGraphLoops({ graph: null })", async () => {
  const direct = await listResolvedGraphLoops({ graph: null });
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.graph_loops",
    params: { graph: null },
  });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.loop_sessions 行为等价于 listResolvedLoopSessions({ loops: null })", async () => {
  const direct = await listResolvedLoopSessions({ loops: null });
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.loop_sessions",
    params: { loops: null },
  });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.schedules 行为等价于 summarizeScheduleRegistry()", async () => {
  const direct = await summarizeScheduleRegistry();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.schedules" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.agent_joins 行为等价于 summarizeAgentJoinRegistry()", async () => {
  const direct = await summarizeAgentJoinRegistry();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.agent_joins" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.test_runs 行为等价于 listTestRuns()（同步源经 async dispatch）", async () => {
  const direct = listTestRuns();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.test_runs" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 registry 完全等价");
});

// ── ③ operator-snapshot 不再直读这 5 个 store ────────────────────────────────

test("operator-snapshot 经 inspect surface 读这 5 个数据源，不再直接 import store", async () => {
  const source = await readFile(
    new URL("../lib/operator/operator-snapshot.js", import.meta.url),
    "utf8",
  );

  // 不再直接调用/引用 5 个 store 函数（旁路已闭合）
  assert.doesNotMatch(source, /listResolvedGraphLoops/, "不应再直读 graph-loop-registry");
  assert.doesNotMatch(source, /listResolvedLoopSessions/, "不应再直读 loop-session-store");
  assert.doesNotMatch(source, /summarizeScheduleRegistry/, "不应再直读 schedule-registry");
  assert.doesNotMatch(source, /summarizeAgentJoinRegistry/, "不应再直读 agent-join-registry");
  assert.doesNotMatch(source, /listTestRuns/, "不应再直读 test-runs");

  // 不再 import 对应 store 模块
  assert.doesNotMatch(source, /loop\/graph-loop-registry/, "不应再 import graph-loop-registry");
  assert.doesNotMatch(source, /loop\/loop-session-store/, "不应再 import loop-session-store");
  assert.doesNotMatch(source, /schedule\/schedule-registry/, "不应再 import schedule-registry");
  assert.doesNotMatch(source, /agent\/agent-join-registry/, "不应再 import agent-join-registry");
  assert.doesNotMatch(source, /"\.\.\/test-runs/, "不应再 import test-runs");

  // 改为经 CLI-system inspect surface 读取
  assert.match(source, /inspect\.graph_loops/, "应引用 inspect.graph_loops");
  assert.match(source, /inspect\.loop_sessions/, "应引用 inspect.loop_sessions");
  assert.match(source, /inspect\.schedules/, "应引用 inspect.schedules");
  assert.match(source, /inspect\.agent_joins/, "应引用 inspect.agent_joins");
  assert.match(source, /inspect\.test_runs/, "应引用 inspect.test_runs");
});
