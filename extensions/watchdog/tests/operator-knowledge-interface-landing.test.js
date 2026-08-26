import test from "node:test";
import assert from "node:assert/strict";

import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-inspector.js";
import { getCliSystemSurface, listCliSystemSurfaces } from "../lib/cli-system/cli-surface-registry.js";
import {
  isOperatorExecutableSurfaceId,
  listOperatorExecutableCliSystemSurfaces,
  listOperatorExecutableSurfaceIds,
} from "../lib/operator/operator-surface-policy.js";
import { buildOperatorKnowledgeContext } from "../lib/operator/operator-knowledge.js";

// ---------------------------------------------------------------------------
// P5 知识：可执行能力清单数据驱动（不再硬编码 surface 白名单）
// ---------------------------------------------------------------------------

test("knowledge capability fragment is data-driven over live surfaces (no hardcoded whitelist)", async () => {
  const surfaces = [
    { id: "agents.create", summary: "create agent" },
    { id: "schedules.create", summary: "create schedule" }, // 旧硬编码版本会漏掉这个
    { id: "automations.run", summary: "run automation" },
  ];
  const ctx = await buildOperatorKnowledgeContext({
    requestText: "operator surface 执行 能力 schedule automation",
    graph: { edges: [] },
    skills: [],
    surfaces,
  });
  const capFragment = ctx.selectedFragments.find((f) => f.id === "live-operator-capabilities");
  assert.ok(capFragment, "expected live-operator-capabilities fragment");
  // 数据驱动：schedules.create / automations.run 必须出现（硬编码版本会漏）。
  assert.match(capFragment.summary, /schedules\.create/);
  assert.match(capFragment.summary, /automations\.run/);
  assert.match(capFragment.summary, /共 3 个/);
});

test("knowledge static corpus carries autonomy-loop and inspect-apply-verify semantics", async () => {
  const ctx = await buildOperatorKnowledgeContext({
    requestText: "harness profile lifecycle 自治 回路 治理 trust verify",
    graph: { edges: [] },
    skills: [],
    surfaces: [],
  });
  const ids = ctx.selectedFragments.map((f) => f.id);
  assert.ok(ids.includes("autonomy-loop-semantics"), "operator must know harness/ProfileLifecycle semantics");
});

// ---------------------------------------------------------------------------
// P5 接口：inspect.profile_lifecycle 正式 surface（读路径，不碰执行）
// ---------------------------------------------------------------------------

test("inspect.profile_lifecycle is a formal read-only inspect surface", () => {
  const surface = getCliSystemSurface("inspect.profile_lifecycle");
  assert.ok(surface, "inspect.profile_lifecycle must be in the merged catalog");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.operatorExecutable, false, "read-only: never operator-executable");
  assert.equal(surface.executable, true, "has a data source");
  assert.equal(surface.source, "runtime_inspect");
});

test("inspect.profile_lifecycle projects lifecycle counts via the inspect read path", async () => {
  const result = await inspectCliSystemSurface({ surfaceId: "inspect.profile_lifecycle" });
  assert.ok(Array.isArray(result.profiles), "profiles is an array");
  assert.ok(result.counts && typeof result.counts.total === "number");
  assert.ok(result.counts.byTrustLevel, "exposes trust-level distribution");
  // 字段齐：每条 profile 有 automationId + profileLifecycle 槽位
  for (const entry of result.profiles) {
    assert.ok("automationId" in entry);
    assert.ok("profileLifecycle" in entry);
    assert.ok("governanceSnapshotDisabled" in entry);
  }
});

test("inspect.profile_lifecycle is rejected as an execution target (read path only)", async () => {
  // operator-executable check must NOT treat an inspect surface as executable.
  assert.equal(isOperatorExecutableSurfaceId("inspect.profile_lifecycle"), false);
});

// ---------------------------------------------------------------------------
// P5 落地：operator 可主动规划 inspect->apply->verify 闭环（verify 进可执行集）
// ---------------------------------------------------------------------------

test("operator executable surfaces now include both apply and verify families", () => {
  const surfaces = listOperatorExecutableCliSystemSurfaces();
  const families = new Set(surfaces.map((s) => s.family));
  assert.ok(families.has("apply"), "apply remains operator-executable");
  assert.ok(families.has("verify"), "verify is now operator-executable (active verify)");
  // 只允许 apply + verify，inspect/observe/hook 绝不入可执行集
  for (const family of families) {
    assert.ok(["apply", "verify"].includes(family), `unexpected executable family: ${family}`);
  }
});

test("operator can execute verify surfaces; non-operatorExecutable surfaces stay blocked", () => {
  assert.equal(isOperatorExecutableSurfaceId("test_runs.start"), true, "operator can actively verify");
  assert.equal(isOperatorExecutableSurfaceId("agents.policy"), true, "apply still executable");
  // attach_verification has no handler -> not executable (not a bypass)
  assert.equal(isOperatorExecutableSurfaceId("admin_change_sets.attach_verification"), false);
  // inspect surfaces never executable
  assert.equal(isOperatorExecutableSurfaceId("inspect.runtime_state"), false);
});

test("operator-executable id list and surface list agree", () => {
  const ids = new Set(listOperatorExecutableSurfaceIds());
  const surfaces = listOperatorExecutableCliSystemSurfaces();
  assert.equal(ids.size, surfaces.length);
  for (const surface of surfaces) {
    assert.ok(ids.has(surface.id), `${surface.id} missing from id list`);
  }
});

test("verify surfaces are real verify-family operator-executable, source admin", () => {
  // Guards the cli-surface-executor four-gate readiness for verify.
  const verifyExec = listCliSystemSurfaces({ family: "verify", operatorExecutable: true })
    .filter((s) => s.executable === true);
  assert.ok(verifyExec.length >= 2);
  for (const s of verifyExec) {
    assert.equal(s.source, "admin_surface", "verify execution sink is admin (single source)");
  }
});
