/**
 * automation-resolve-governance-p4.test.js — P4 死链 c 合流点回归门
 *
 * 死链(c)：resolveGovernance 未定义；governanceSnapshot 读取点=0（写了没人读）。
 * P4 合流点：resolveGovernance(spec, runtime) 是 governance 的唯一读法。
 *   优先级：runtime.governanceSnapshot（经合法性校验）覆盖 spec.governance，否则用 spec。
 *   deriveDecision / computeImprovementState 全部经它读，governanceSnapshot 才不是死对象。
 *
 * 门 1：snapshot 覆盖 spec（断真值流向，不是字段被写）。
 * 门 2：无 snapshot 用 spec（默认路径不漂移）。
 * 门 3：deriveDecision 经 resolveGovernance 读到 snapshot 值 → 决策真受 snapshot 影响。
 * 门 4：安全阀——熔断（governanceSnapshotDisabled）→ 忽略 snapshot 回 spec。
 * 门 5：非法 snapshot 字段（类型/越界）→ 该字段回退 spec，不污染。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveGovernance } from "../lib/automation/resolve-governance.js";
import { deriveDecision } from "../lib/automation/automation-decision.js";

const baseSpec = {
  enabled: true,
  governance: {
    mode: "continuous",
    maxRounds: 10,
    earlyStopPatience: 5,
    minImprovement: 0.01,
  },
  wakePolicy: { type: "manual", cooldownSeconds: 300, onResult: false, onFailure: false },
};

test("门1: governanceSnapshot 覆盖 spec.governance 对应字段", () => {
  const runtime = {
    automationId: "a1",
    governanceSnapshot: { maxRounds: 3, earlyStopPatience: 2 },
  };
  const resolved = resolveGovernance(baseSpec, runtime);
  assert.equal(resolved.maxRounds, 3, "snapshot.maxRounds 覆盖 spec.maxRounds");
  assert.equal(resolved.earlyStopPatience, 2, "snapshot.earlyStopPatience 覆盖 spec");
  assert.equal(resolved.minImprovement, 0.01, "snapshot 未指定的字段保留 spec 值");
  assert.equal(resolved.mode, "continuous", "snapshot 未指定 mode → 保留 spec");
});

test("门2: 无 governanceSnapshot → 完全用 spec.governance", () => {
  const resolved = resolveGovernance(baseSpec, { automationId: "a1" });
  assert.equal(resolved.maxRounds, 10);
  assert.equal(resolved.earlyStopPatience, 5);
  assert.equal(resolved.minImprovement, 0.01);
  assert.equal(resolved.mode, "continuous");
});

test("门3: deriveDecision 经 resolveGovernance 读到 snapshot → 决策真受影响", () => {
  // spec.maxRounds=10，第 4 轮不应 conclude；但 snapshot 收紧 maxRounds=3 → 第 4 轮应 conclude
  const runtimeNoSnapshot = { automationId: "a1" };
  const d1 = deriveDecision(baseSpec, runtimeNoSnapshot, {
    round: 4,
    terminalStatus: "completed",
    score: null,
    noImprovementStreak: 0,
  });
  assert.notEqual(d1.reason, "max_rounds", "无 snapshot 时 round=4 < spec.maxRounds=10，不该 max_rounds");

  const runtimeWithSnapshot = { automationId: "a1", governanceSnapshot: { maxRounds: 3 } };
  const d2 = deriveDecision(baseSpec, runtimeWithSnapshot, {
    round: 4,
    terminalStatus: "completed",
    score: null,
    noImprovementStreak: 0,
  });
  assert.equal(d2.reason, "max_rounds", "snapshot.maxRounds=3 → round=4 触发 max_rounds（决策真受 snapshot 影响）");
  assert.equal(d2.action, "conclude");
});

test("门4: 安全阀——governanceSnapshotDisabled 熔断 → 忽略 snapshot 回 spec", () => {
  const runtime = {
    automationId: "a1",
    governanceSnapshotDisabled: true,
    governanceSnapshot: { maxRounds: 3, earlyStopPatience: 1 },
  };
  const resolved = resolveGovernance(baseSpec, runtime);
  assert.equal(resolved.maxRounds, 10, "熔断开 → 忽略 snapshot.maxRounds，回 spec");
  assert.equal(resolved.earlyStopPatience, 5, "熔断开 → 忽略 snapshot.earlyStopPatience，回 spec");
});

test("门5: 非法 snapshot 字段 → 该字段回退 spec，不污染", () => {
  const runtime = {
    automationId: "a1",
    governanceSnapshot: {
      maxRounds: -7,          // 非法：负数 → 回退
      earlyStopPatience: "x", // 非法：非数 → 回退
      minImprovement: 0.5,    // 合法 → 覆盖
      mode: "bogus_mode",     // 非法 enum → 回退
    },
  };
  const resolved = resolveGovernance(baseSpec, runtime);
  assert.equal(resolved.maxRounds, 10, "负 maxRounds 回退 spec");
  assert.equal(resolved.earlyStopPatience, 5, "非数 earlyStopPatience 回退 spec");
  assert.equal(resolved.minImprovement, 0.5, "合法 minImprovement 覆盖");
  assert.equal(resolved.mode, "continuous", "非法 mode 回退 spec");
});

test("门5b: spec.governance 缺失 → resolveGovernance 不抛，给安全默认", () => {
  const resolved = resolveGovernance({ enabled: true }, { automationId: "a1" });
  assert.equal(typeof resolved.mode, "string");
  assert.ok(resolved.maxRounds >= 0);
  assert.ok(resolved.earlyStopPatience >= 0);
});
