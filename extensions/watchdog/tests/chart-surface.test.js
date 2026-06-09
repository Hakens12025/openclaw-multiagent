/**
 * chart-surface.test.js — G4: chart 写/读控制面经现有 admin/cli-system 机器收口
 *
 * apply.chart_create / apply.chart_move 注册为 CLI-system apply 面(source:admin_surface,
 * operatorExecutable),executeAdminSurfaceOperation 端到端跑通(create → move → 经 inspect.charts 读到)。
 * inspect.charts 属 inspect 家族,经 inspectCliSystemSurface 返回 store。
 * NON_TRUTH_BACKED 谓词路径:apply.knowledge_remove(kind=knowledge)被 skip;agents.delete(kind=agent,真值)不 skip。
 *
 * charts.json 是非真值控制面(knowledge-bases.json 同级),写完清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";

import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { getAdminSurfaceInputFields } from "../lib/admin/admin-surface-registry.js";
import {
  getAdminSurfaceOperationHandler,
  executeAdminSurfaceOperation,
} from "../lib/admin/admin-surface-operations.js";
import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-inspector.js";
import {
  createChartDefinition,
  moveChartPosition,
} from "../lib/admin/chart-operations.js";
import {
  NON_TRUTH_BACKED_FAMILIES,
  resolveSurfaceFamily,
} from "../lib/cli-system/meta-agent-surface-ownership.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const CHART_APPLY_SURFACES = ["apply.chart_create", "apply.chart_move"];
const FILE = CONTROL_PLANE_PATHS.chartsRegistryFile;

function makeSpec(id) {
  return {
    id,
    type: "line",
    title: "Test Chart",
    series: [{ name: "s1", points: [{ x: "Mon", y: 12 }, { x: "Tue", y: 18 }] }],
  };
}

// Snapshot/restore the real (non-truth) store so this suite never clobbers existing
// charts.json data nor leaves a leftover file — mirrors chart-registry.test.js.
async function withCleanStore(body) {
  let priorContent = null;
  try {
    priorContent = await readFile(FILE, "utf8");
  } catch {
    priorContent = null;
  }
  await rm(FILE, { force: true });
  try {
    await body();
  } finally {
    if (priorContent === null) {
      await rm(FILE, { force: true });
    } else {
      await writeFile(FILE, priorContent, "utf8");
    }
  }
}

test("CLI-system:chart apply 面注册为 operator-executable(family=apply,有 handler)", () => {
  for (const id of CHART_APPLY_SURFACES) {
    const s = getCliSystemSurface(id);
    assert.ok(s, `${id} 应注册`);
    assert.equal(s.family, "apply", `${id} family 应为 apply`);
    assert.equal(s.operatorExecutable, true, `${id} 应 operator 可执行`);
    assert.equal(s.source, "admin_surface", `${id} 应来自 admin_surface`);
    assert.equal(typeof getAdminSurfaceOperationHandler(id), "function", `${id} 应有 handler`);
  }
  // chart_create / chart_move 都是 safe(charts.json 非真值,无破坏性结构变更)
  assert.equal(getCliSystemSurface("apply.chart_create").risk, "safe");
  assert.equal(getCliSystemSurface("apply.chart_move").risk, "safe");
});

test("apply.chart_create handler 解析到 createChartDefinition,chart_move 解析到 moveChartPosition", () => {
  assert.equal(getAdminSurfaceOperationHandler("apply.chart_create"), createChartDefinition);
  assert.equal(getAdminSurfaceOperationHandler("apply.chart_move"), moveChartPosition);
});

test("input fields:chart_create 必填 spec;chart_move 必填 chartId/x/y", () => {
  const createFields = Object.fromEntries(getAdminSurfaceInputFields("apply.chart_create").map((f) => [f.key, f]));
  assert.equal(createFields.spec?.required, true);

  const moveFields = Object.fromEntries(getAdminSurfaceInputFields("apply.chart_move").map((f) => [f.key, f]));
  assert.equal(moveFields.chartId?.required, true);
  assert.equal(moveFields.x?.required, true);
  assert.equal(moveFields.y?.required, true);
});

test("inspect.charts 属 inspect 家族,经 inspectCliSystemSurface 返回 store 列表", async () => {
  const s = getCliSystemSurface("inspect.charts");
  assert.ok(s, "inspect.charts 应注册");
  assert.equal(s.family, "inspect");
  assert.equal(s.operatorExecutable, false, "inspect 面不可由 operator 写执行");
  const charts = await inspectCliSystemSurface({ surfaceId: "inspect.charts", params: {} });
  assert.ok(Array.isArray(charts), "inspect.charts 应返回数组");
});

test("e2e:create → move → 经 inspect.charts 读到(executeAdminSurfaceOperation)", async () => {
  await withCleanStore(async () => {
    const id = `chartsurf-${Date.now()}`;
    const created = await executeAdminSurfaceOperation({
      surfaceId: "apply.chart_create",
      payload: { spec: makeSpec(id) },
    });
    assert.equal(created.ok, true);
    assert.equal(created.chart.id, id);
    assert.equal(created.chart.type ?? created.chart.spec.type, "line");

    const moved = await executeAdminSurfaceOperation({
      surfaceId: "apply.chart_move",
      payload: { chartId: id, x: 7, y: 13 },
    });
    assert.equal(moved.ok, true);
    assert.deepEqual(moved.chart.position, { x: 7, y: 13 });

    const charts = await inspectCliSystemSurface({ surfaceId: "inspect.charts", params: {} });
    const found = charts.find((c) => c.id === id) || null;
    assert.ok(found, "inspect.charts 应读到新建的 chart");
    assert.deepEqual(found.position, { x: 7, y: 13 });
  });
});

test("create:非法 spec → {ok:false,error}(不抛过 handler 边界)", async () => {
  const result = await executeAdminSurfaceOperation({
    surfaceId: "apply.chart_create",
    payload: { spec: { id: "bad", type: "line" /* missing series */ } },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error, "应带 error 文案");
});

test("move:未知 chart id → {ok:false,error}(不抛过 handler 边界)", async () => {
  const result = await executeAdminSurfaceOperation({
    surfaceId: "apply.chart_move",
    payload: { chartId: "does-not-exist-chart", x: 1, y: 2 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("NON_TRUTH_BACKED 谓词:knowledge_remove(kind=knowledge)命中 skip;agents.delete(kind=agent,真值)不命中", () => {
  // 这是 maybePreApplyStructureSnapshot 跳过非真值族快照的判定路径(单测谓词本身)。
  assert.equal(resolveSurfaceFamily("apply.knowledge_remove"), "knowledge");
  assert.equal(NON_TRUTH_BACKED_FAMILIES.has(resolveSurfaceFamily("apply.knowledge_remove")), true,
    "knowledge_remove 应被结构快照跳过(structure-snapshot 捕不到 KB 内容)");

  assert.equal(resolveSurfaceFamily("apply.chart_create"), "chart");
  assert.equal(NON_TRUTH_BACKED_FAMILIES.has(resolveSurfaceFamily("apply.chart_create")), true,
    "chart 面应被结构快照跳过");

  // 真值结构破坏性操作:agents.delete(kind=agent)不应被跳过——它有真实可回滚结构。
  assert.equal(resolveSurfaceFamily("agents.delete"), "agent");
  assert.equal(NON_TRUTH_BACKED_FAMILIES.has(resolveSurfaceFamily("agents.delete")), false,
    "agents.delete 是真值结构操作,不应被结构快照跳过");
});

// 非真值控制面 sanity:chart store 落在 charts.json(knowledge-bases.json 同级)。
test("chart store 路径为非真值控制面文件(charts.json)", () => {
  assert.ok(typeof CONTROL_PLANE_PATHS.chartsRegistryFile === "string");
  assert.ok(CONTROL_PLANE_PATHS.chartsRegistryFile.endsWith("charts.json"));
});
