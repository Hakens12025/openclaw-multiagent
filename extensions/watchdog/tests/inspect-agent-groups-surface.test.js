import test from "node:test";
import assert from "node:assert/strict";

import { inspectCliSystemSurface, getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import { listResolvedGroupSessions } from "../lib/agent/group-session-store.js";

// inspect.agent_groups — GroupSession 运行态只读 surface（沿用 v110-11 inspect 收口模式
// 只加条目）。AgentGroup 是宏，runtime 真值只在 GroupSession，此 surface 收口直读 store。

test("inspect.agent_groups surface 存在且合规（冻结 schema）", () => {
  const surface = getCliSystemSurface("inspect.agent_groups");
  assert.ok(surface, "inspect.agent_groups 必须可经 getCliSystemSurface 取到");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  assert.equal(surface.operatorExecutable, false);
  assert.equal(surface.displayId, "control:inspect.agent_groups");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `inspect.agent_groups 必须通过冻结 schema: ${problems.join("; ")}`);
});

test("inspect.agent_groups 行为等价于 listResolvedGroupSessions（无参，收口直读旁路）", async () => {
  const direct = await listResolvedGroupSessions();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.agent_groups" });
  assert.ok(Array.isArray(viaSurface), "应返回数组");
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");
});

test("inspect.agent_groups 非 inspect 家族误用被拒（apply/admin 不得经此调用）", async () => {
  // 经 inspect 入口取一个非 inspect surface 应抛错（家族隔离）
  await assert.rejects(
    () => inspectCliSystemSurface({ surfaceId: "hook.before_tool_call" }),
    /not inspect family/,
    "非 inspect 家族 surface 不得经 inspect 入口",
  );
});
