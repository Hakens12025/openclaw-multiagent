/**
 * operator-batch3-surfaces.test.js — 锁定第三批 4 个旁路迁移（P-D.2 续）
 *
 * 背景：operator-snapshot 原先直读以下 runtime store/registry：
 *   - loadGraph                        (agent/agent-graph)
 *   - getGuidanceDriftState            (agent/agent-guidance-drift-state)
 *   - summarizeSystemActionDeliveryTickets(routing/delivery-system-action-ticket)
 *   - summarizePendingSignalRegistry   (runtime/pending-signal-registry)
 * 均属绕过 CLI-system 的旁路。本次复用 inspect-surface 模式收口为：
 *   inspect.agent_graph / inspect.guidance_drift /
 *   inspect.delivery_tickets / inspect.pending_signals
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
import { loadGraph } from "../lib/agent/agent-graph.js";
import { getGuidanceDriftState } from "../lib/agent/agent-guidance-drift-state.js";
import { summarizeSystemActionDeliveryTickets } from "../lib/routing/delivery-system-action-ticket.js";
import { summarizePendingSignalRegistry } from "../lib/runtime/pending-signal-registry.js";

// ── ① 4 个 surface 存在且合规 ────────────────────────────────────────────────

const EXPECTED_SURFACES = [
  "inspect.agent_graph",
  "inspect.guidance_drift",
  "inspect.delivery_tickets",
  "inspect.pending_signals",
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

test("inspect.agent_graph 行为等价于 loadGraph()", async () => {
  const direct = await loadGraph();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.agent_graph" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.guidance_drift 行为等价于 getGuidanceDriftState()", async () => {
  const direct = await getGuidanceDriftState();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.guidance_drift" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.delivery_tickets 行为等价于 summarizeSystemActionDeliveryTickets()", async () => {
  const direct = await summarizeSystemActionDeliveryTickets();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.delivery_tickets" });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 store 完全等价");
});

test("inspect.pending_signals 行为等价于 summarizePendingSignalRegistry()", async () => {
  // 固定 now 避免 Date.now() 时间偏移导致的伪差异（stale 计算依赖 now）。
  const now = 1_700_000_000_000;
  const direct = summarizePendingSignalRegistry({ now });
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.pending_signals",
    params: { now },
  });
  assert.deepEqual(viaSurface, direct, "经 surface 读取应与直读 registry 完全等价");
});

// ── ③ operator-snapshot 不再直读这 4 个 store ────────────────────────────────

test("operator-snapshot 经 inspect surface 读这 4 个数据源，不再直接 import store", async () => {
  const source = await readFile(
    new URL("../lib/operator/operator-snapshot.js", import.meta.url),
    "utf8",
  );

  // 不再直接调用/引用 4 个 store 函数（旁路已闭合）
  assert.doesNotMatch(source, /loadGraph/, "不应再直读 agent-graph.loadGraph");
  assert.doesNotMatch(source, /getGuidanceDriftState/, "不应再直读 agent-guidance-drift-state");
  assert.doesNotMatch(source, /summarizeSystemActionDeliveryTickets/, "不应再直读 delivery-system-action-ticket");
  assert.doesNotMatch(source, /summarizePendingSignalRegistry/, "不应再直读 pending-signal-registry");

  // 不再 import 对应 store 模块
  assert.doesNotMatch(source, /agent\/agent-graph/, "不应再 import agent-graph");
  assert.doesNotMatch(source, /agent\/agent-guidance-drift-state/, "不应再 import agent-guidance-drift-state");
  assert.doesNotMatch(source, /routing\/delivery-system-action-ticket/, "不应再 import delivery-system-action-ticket");
  assert.doesNotMatch(source, /runtime\/pending-signal-registry/, "不应再 import pending-signal-registry");

  // 改为经 CLI-system inspect surface 读取
  assert.match(source, /inspect\.agent_graph/, "应引用 inspect.agent_graph");
  assert.match(source, /inspect\.guidance_drift/, "应引用 inspect.guidance_drift");
  assert.match(source, /inspect\.delivery_tickets/, "应引用 inspect.delivery_tickets");
  assert.match(source, /inspect\.pending_signals/, "应引用 inspect.pending_signals");
});
