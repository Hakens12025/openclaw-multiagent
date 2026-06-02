import test from "node:test";
import assert from "node:assert/strict";

import { inspectCliSystemSurface, getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";

// inspect.structure_preview — projectStructureAfter 的 CLI-system inspect 封装。
// 让 operator / 守门方在 apply 前经 CLI 预览结构改动(非破坏性投影), 不碰 live。

test("inspect.structure_preview surface 存在且合规(inspect 家族, 只读)", () => {
  const surface = getCliSystemSurface("inspect.structure_preview");
  assert.ok(surface, "inspect.structure_preview 必须可取到");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.source, "runtime_inspect");
  assert.equal(surface.operatorExecutable, false);
  assert.equal(surface.executable, true);
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `必须通过冻结 schema: ${problems.join("; ")}`);
});

test("inspect.structure_preview 非 inspect 入口误用被拒(家族隔离)", async () => {
  await assert.rejects(
    () => inspectCliSystemSurface({ surfaceId: "graph.edge.add" }),
    /not inspect family|不是|inspect/i,
  );
});

test("inspect.structure_preview 投影边/环改动(非破坏性, 不碰 live)", async () => {
  const originalGraph = await loadGraph();
  try {
    await saveGraph({ edges: [] });
    // graph.edge.add 投影
    const addPreview = await inspectCliSystemSurface({
      surfaceId: "inspect.structure_preview",
      params: { surfaceId: "graph.edge.add", payload: { from: "planner", to: "worker" } },
    });
    assert.equal(addPreview.structural, true);
    assert.deepEqual(addPreview.edgeDiff.added, ["planner→worker"]);
    // live 未被改(投影只读)
    const liveAfter = await loadGraph();
    assert.equal(liveAfter.edges.length, 0, "预览不得改 live 图");

    // graph.loop.compose 投影
    const loopPreview = await inspectCliSystemSurface({
      surfaceId: "inspect.structure_preview",
      params: { surfaceId: "graph.loop.compose", payload: { agents: ["planner", "worker", "worker2"] } },
    });
    assert.equal(loopPreview.structural, true);
    assert.deepEqual(loopPreview.edgeDiff.added, ["planner→worker", "worker→worker2", "worker2→planner"]);

  } finally {
    await saveGraph(originalGraph);
  }
});

test("inspect.structure_preview agent 级 diff: create→added, role 改→modified(overlay 用)", async () => {
  // agents.create 新 id → agentDiff.added 含它(非破坏性, 不真建)
  const created = await inspectCliSystemSurface({
    surfaceId: "inspect.structure_preview",
    params: { surfaceId: "agents.create", payload: { id: "preview-probe-agent-xyz", role: "executor" } },
  });
  assert.equal(created.structural, true);
  assert.ok(created.agentDiff, "应返回 agentDiff");
  assert.ok(created.agentDiff.added.includes("preview-probe-agent-xyz"), "新建 agent 应进 added");
  assert.deepEqual(created.agentDiff.removed, []);

  // agents.<field> 修改 → modified 标记该 agent(供 overlay 扳手气泡); 用 config 内真实 agent
  const { loadOpenClawConfig } = await import("../lib/state.js").catch(() => ({}));
  const cfg = typeof loadOpenClawConfig === "function" ? await loadOpenClawConfig() : null;
  const realAgentId = cfg?.agents?.list?.[0]?.id;
  if (realAgentId) {
    const modified = await inspectCliSystemSurface({
      surfaceId: "inspect.structure_preview",
      params: { surfaceId: "agents.role", payload: { agentId: realAgentId, role: "researcher" } },
    });
    assert.ok(modified.agentDiff.modified.includes(realAgentId), "改 role 的 agent 应进 modified");
  }
});
