/**
 * operator-low-risk-surfaces.test.js — 锁定低风险纯透传旁路迁移（P-D.2 续）
 *
 * 背景：operator-snapshot 原先直读以下 runtime store/registry：
 *   - summarizeScheduleRegistry(schedule/schedule-registry)
 *   - summarizeAgentJoinRegistry(agent/agent-join-registry)
 *   - listTestRuns            (test-runs)
 * 均属绕过 CLI-system 的旁路。本次复用 inspect-surface 模式收口为：
 *   inspect.schedules / inspect.agent_joins / inspect.test_runs
 *
 * 每个锁定三件事：
 *   ① 新 surface 存在且合规（冻结 schema 校验）
 *   ② 经 surface 读取与直读 store 深度等价（行为不变、同参数同返回）
 *   ③ operator-snapshot 不再直读对应 store
 *
 * 回路退役（B3/B4）：graph_loops / loop_sessions 两源先从 operator 面整条拆除（B3），
 * surface 本体随后从 catalog+inspector 摘除（B4）。① 与 ③ 中对这两源的锁方向一律反转为
 * 「不许回流」，② 的等价性用例随 surface 一起消失。
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
import { summarizeScheduleRegistry } from "../lib/schedule/schedule-registry.js";
import { summarizeAgentJoinRegistry } from "../lib/agent/admin/agent-join-registry.js";
import { listTestRuns } from "../lib/formal-runtime/test-runs.js";

// ── ① 3 个 surface 存在且合规 ────────────────────────────────────────────────

const EXPECTED_SURFACES = [
  "inspect.schedules",
  "inspect.agent_joins",
  "inspect.test_runs",
];

// 回路退役（B4）：这两个 surface 已从 catalog 摘除，锁方向反转为「不许回流」。
const RETIRED_SURFACES = ["inspect.graph_loops", "inspect.loop_sessions"];

for (const id of RETIRED_SURFACES) {
  test(`${id} 已退役：不在 CLI-system registry 中`, () => {
    assert.equal(getCliSystemSurface(id), null, `${id} 必须已从 catalog 摘除`);
  });
}

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

// ── ③ operator-snapshot 不再直读这些 store ──────────────────────────────────

test("operator-snapshot 经 inspect surface 读数据源，不再直接 import store", async () => {
  const source = await readFile(
    new URL("../lib/operator/operator-snapshot.js", import.meta.url),
    "utf8",
  );

  // 不再直接调用/引用这些 store 函数（旁路已闭合）
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

  // 回路退役（B3/B4）：graph loop / loop session 两个数据源整条读取链已从 operator 面移除，
  // surface 本体也已从 catalog 摘除；锁方向由「必须经 surface 读」反转为「一条都不许回流」。
  assert.doesNotMatch(source, /inspect\.graph_loops/, "回路已退役：不应再读 graph loop");
  assert.doesNotMatch(source, /inspect\.loop_sessions/, "回路已退役：不应再读 loop session");

  // 其余三源改为经 CLI-system inspect surface 读取
  assert.match(source, /inspect\.schedules/, "应引用 inspect.schedules");
  assert.match(source, /inspect\.agent_joins/, "应引用 inspect.agent_joins");
  assert.match(source, /inspect\.test_runs/, "应引用 inspect.test_runs");
});
