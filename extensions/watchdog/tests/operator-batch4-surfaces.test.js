/**
 * operator-batch4-surfaces.test.js — 锁定第四批（最后一批高消费面）旁路迁移（P-D.2 续）
 *
 * 背景：operator-snapshot 原先直读以下高消费 runtime store/registry：
 *   - listLifecycleWorkItems        (contracts) — snapshot 多处派生 counts/active/failures/incidents/progressions
 *   - listAdminChangeSets           (admin/admin-change-sets) — draft relations 重度消费
 *   - listAutomationRuntimeStates   (automation/automation-runtime) — coreData.automationRuntimes，被 operator-brain 消费
 *   - summarizeAutomationRuntimeRegistry(automation/automation-runtime) — reviewer/decision 快照依赖
 * 均属绕过 CLI-system 的旁路。本次复用 inspect-surface 模式收口为：
 *   inspect.work_items / inspect.change_sets /
 *   inspect.automation_runtime / inspect.automation_runtime_summary
 *
 * 这批最危险：snapshot 从它们派生大量字段。等价测试不只测 list 本身，
 * 还测 snapshot 派生字段（counts / active / failures / reviewer / decision）迁移前后一致。
 *
 * 每个锁定：
 *   ① 新 surface 存在且合规（冻结 schema 校验）
 *   ② 经 surface 读取与直读 store 深度等价（行为不变、同参数同返回）
 *   ③ snapshot 关键派生字段在 直读 vs 经 surface 两条路径下一致
 *   ④ operator-snapshot 不再直读对应 store
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
import { listLifecycleWorkItems } from "../lib/contracts.js";
import { listAdminChangeSets } from "../lib/admin/admin-change-sets.js";
import {
  listAutomationRuntimeStates,
  summarizeAutomationRuntimeRegistry,
} from "../lib/automation/automation-runtime.js";

// snapshot 派生逻辑（用于验证派生字段等价）
import { summarizeWorkItem } from "../lib/operator/operator-snapshot-summarizers.js";
import {
  buildReviewerResultsSnapshot,
  buildAutomationDecisionsSnapshot,
} from "../lib/operator/operator-snapshot-runtime.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

// ── ① 4 个 surface 存在且合规 ────────────────────────────────────────────────

const EXPECTED_SURFACES = [
  "inspect.work_items",
  "inspect.change_sets",
  "inspect.automation_runtime",
  "inspect.automation_runtime_summary",
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

test("inspect.work_items 行为等价于 listLifecycleWorkItems()", async () => {
  const direct = await listLifecycleWorkItems();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.work_items" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.change_sets 行为等价于 listAdminChangeSets()", async () => {
  const direct = await listAdminChangeSets();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.change_sets" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.automation_runtime 行为等价于 listAutomationRuntimeStates()", async () => {
  const direct = await listAutomationRuntimeStates();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.automation_runtime" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.automation_runtime_summary 行为等价于 summarizeAutomationRuntimeRegistry()", async () => {
  const direct = await summarizeAutomationRuntimeRegistry();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.automation_runtime_summary" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

// ── ③ snapshot 派生字段等价（高消费面护栏） ──────────────────────────────────

function countBy(items, resolveKey, seed = []) {
  const counts = Object.fromEntries(seed.map((key) => [key, 0]));
  for (const item of Array.isArray(items) ? items : []) {
    const key = resolveKey(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

const CONTRACT_STATUS_ORDER = [
  CONTRACT_STATUS.PENDING,
  CONTRACT_STATUS.RUNNING,
  CONTRACT_STATUS.AWAITING_INPUT,
  CONTRACT_STATUS.COMPLETED,
  CONTRACT_STATUS.FAILED,
  CONTRACT_STATUS.ABANDONED,
  CONTRACT_STATUS.CANCELLED,
];

test("work_items 派生字段（counts/active/recentFailures）经 surface 与直读一致", async () => {
  const direct = await listLifecycleWorkItems();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.work_items" });
  const limit = 6;

  // counts（countBy by status，删 draft 键）
  const deriveCounts = (items) => {
    const c = countBy(items, (w) => w?.status, CONTRACT_STATUS_ORDER);
    delete c[CONTRACT_STATUS.DRAFT];
    return c;
  };
  assert.deepEqual(deriveCounts(viaSurface), deriveCounts(direct), "workItemCounts 应一致");

  // active（filter active status → slice → summarizeWorkItem）
  const deriveActive = (items) => items
    .filter((w) => [CONTRACT_STATUS.PENDING, CONTRACT_STATUS.RUNNING, CONTRACT_STATUS.AWAITING_INPUT].includes(w?.status))
    .slice(0, limit)
    .map(summarizeWorkItem);
  assert.deepEqual(deriveActive(viaSurface), deriveActive(direct), "workItems.active 应一致");

  // recentFailures（filter failed → slice → summarizeWorkItem）
  const deriveFailures = (items) => items
    .filter((w) => w?.status === CONTRACT_STATUS.FAILED)
    .slice(0, limit)
    .map(summarizeWorkItem);
  assert.deepEqual(deriveFailures(viaSurface), deriveFailures(direct), "workItems.recentFailures 应一致");
});

test("change_sets 派生字段（counts.total / byStatus）经 surface 与直读一致", async () => {
  const direct = await listAdminChangeSets();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.change_sets" });

  assert.equal(viaSurface.length, direct.length, "changeSets.counts.total 应一致");
  const byStatus = (items) => countBy(items, (d) => d?.status);
  assert.deepEqual(byStatus(viaSurface), byStatus(direct), "draftCounts 应一致");
});

test("automation_runtime_summary 派生字段（counts/reviewer/decision）经 surface 与直读一致", async () => {
  const direct = await summarizeAutomationRuntimeRegistry();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.automation_runtime_summary" });

  // counts 直接来自 summary
  assert.deepEqual(viaSurface.counts, direct.counts, "automations.counts 应一致");
  // reviewer / decision 快照派生
  assert.deepEqual(
    buildReviewerResultsSnapshot(viaSurface),
    buildReviewerResultsSnapshot(direct),
    "reviewerResults 快照应一致",
  );
  assert.deepEqual(
    buildAutomationDecisionsSnapshot(viaSurface),
    buildAutomationDecisionsSnapshot(direct),
    "automationDecisions 快照应一致",
  );
});

// ── ④ operator-snapshot 不再直读这 3 个 store ────────────────────────────────

test("operator-snapshot 经 inspect surface 读这 3 个高消费数据源，不再直接 import store", async () => {
  const source = await readFile(
    new URL("../lib/operator/operator-snapshot.js", import.meta.url),
    "utf8",
  );

  // 不再直接调用/引用这些 store 函数（旁路已闭合）
  assert.doesNotMatch(source, /listLifecycleWorkItems/, "不应再直读 contracts.listLifecycleWorkItems");
  assert.doesNotMatch(source, /listAdminChangeSets/, "不应再直读 admin-change-sets");
  assert.doesNotMatch(source, /listAutomationRuntimeStates/, "不应再直读 listAutomationRuntimeStates");
  assert.doesNotMatch(source, /summarizeAutomationRuntimeRegistry/, "不应再直读 summarizeAutomationRuntimeRegistry");

  // 不再 import 对应 store 模块
  assert.doesNotMatch(source, /"\.\.\/contracts/, "不应再 import contracts");
  assert.doesNotMatch(source, /admin\/admin-change-sets/, "不应再 import admin-change-sets");
  assert.doesNotMatch(source, /automation\/automation-runtime/, "不应再 import automation-runtime");

  // 改为经 CLI-system inspect surface 读取
  assert.match(source, /inspect\.work_items/, "应引用 inspect.work_items");
  assert.match(source, /inspect\.change_sets/, "应引用 inspect.change_sets");
  assert.match(source, /inspect\.automation_runtime/, "应引用 inspect.automation_runtime");
  assert.match(source, /inspect\.automation_runtime_summary/, "应引用 inspect.automation_runtime_summary");
});
