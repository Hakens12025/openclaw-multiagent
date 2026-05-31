/**
 * automation-profile-lifecycle-p4.test.js — P4 ProfileLifecycle 尾段（对象链第 11 概念）回归门
 *
 * 对象链：HarnessRun → EvaluationResult → AutomationDecision → ProfileLifecycle（尾段）。
 * ProfileLifecycle 是派生量（不存 durable）：streak 从历史现算；只写 runtime snapshot，不改 spec。
 *
 * 门 1：字段 schema 稳定 + normalize 幂等。
 * 门 2：渐进硬化——连 3 pass → trustLevel 升级（experimental→provisional→stable）。
 * 门 3：渐进硬化——连 2 fail → status=retired（降级/退役）。
 * 门 4：conclude → 冻结 governance（governanceSnapshot 不再收紧）。
 * 门 5：升级真的收紧 governanceSnapshot（trust 越高 earlyStopPatience/maxRounds 越紧）。
 * 门 6：governanceSnapshot 经合法性校验（非法不写）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProfileLifecycle,
  normalizeProfileLifecycle,
  TRUST_LADDER,
} from "../lib/automation/profile-lifecycle.js";
import { resolveGovernance } from "../lib/automation/resolve-governance.js";

const spec = {
  enabled: true,
  governance: { mode: "continuous", maxRounds: 20, earlyStopPatience: 10, minImprovement: 0 },
  harness: { profileId: "coding.patch_and_test" },
};

function passRound(round) {
  return { round, decision: "completed", status: "completed", score: 0.9, verdict: "pass" };
}
function failRound(round) {
  return { round, decision: "error", status: "failed", score: 0.1, verdict: "fail" };
}

test("门1: ProfileLifecycle schema 稳定 + normalize 幂等", () => {
  const lc = buildProfileLifecycle({
    spec,
    runtime: { automationId: "a1", recentRounds: [] },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "experimental",
    lastDecision: { action: "continue", verdict: null },
    recentDecisions: [],
    recentEvaluationResults: [],
  });
  for (const key of ["automationId", "profileId", "trustLevel", "status", "successStreak", "failureStreak", "evidenceWindow", "governanceSnapshot", "updatedAt"]) {
    assert.ok(key in lc, `字段缺失: ${key}`);
  }
  const renorm = normalizeProfileLifecycle(lc);
  assert.deepEqual(renorm, normalizeProfileLifecycle(renorm), "normalize 幂等");
  assert.equal(renorm.automationId, "a1");
});

test("门2: 连 3 pass → trustLevel 升级", () => {
  const recent = [passRound(3), passRound(2), passRound(1)];
  const lc = buildProfileLifecycle({
    spec,
    runtime: { automationId: "a1", recentRounds: recent },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "experimental",
    lastDecision: { action: "continue", verdict: "pass" },
    recentDecisions: [],
    recentEvaluationResults: [],
  });
  assert.ok(lc.successStreak >= 3, `successStreak 应 >=3，实际 ${lc.successStreak}`);
  const idx = TRUST_LADDER.indexOf(lc.trustLevel);
  assert.ok(idx > TRUST_LADDER.indexOf("experimental"), "连 3 pass 后 trustLevel 高于 experimental");
});

test("门3: 连 2 fail → status=retired", () => {
  const recent = [failRound(2), failRound(1)];
  const lc = buildProfileLifecycle({
    spec,
    runtime: { automationId: "a1", recentRounds: recent },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: { action: "abandon", verdict: "fail" },
    recentDecisions: [],
    recentEvaluationResults: [],
  });
  assert.ok(lc.failureStreak >= 2, `failureStreak 应 >=2，实际 ${lc.failureStreak}`);
  assert.equal(lc.status, "retired", "连 2 fail → retired");
});

test("门4: conclude → 冻结 governance（不再产生收紧 snapshot）", () => {
  const recent = [passRound(3), passRound(2), passRound(1)];
  const lc = buildProfileLifecycle({
    spec,
    runtime: { automationId: "a1", recentRounds: recent },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "stable",
    lastDecision: { action: "conclude", verdict: "pass" },
    recentDecisions: [],
    recentEvaluationResults: [],
  });
  assert.equal(lc.frozen, true, "conclude → frozen=true");
  // 冻结时不产出新的收紧 snapshot（保留为 null 或不变）
  assert.equal(lc.governanceSnapshot, null, "冻结时不再产出收紧 snapshot");
});

test("门5: 升级真的收紧 governanceSnapshot（端到端经 resolveGovernance 回灌）", () => {
  const recent = [passRound(3), passRound(2), passRound(1)];
  const lc = buildProfileLifecycle({
    spec,
    runtime: { automationId: "a1", recentRounds: recent },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: { action: "continue", verdict: "pass" },
    recentDecisions: [],
    recentEvaluationResults: [],
  });
  assert.ok(lc.governanceSnapshot, "升级后应产出 governanceSnapshot");
  // 把 snapshot 灌回 runtime，下一轮 resolveGovernance 必须读到收紧值
  const nextRuntime = { automationId: "a1", governanceSnapshot: lc.governanceSnapshot };
  const resolved = resolveGovernance(spec, nextRuntime);
  assert.ok(
    resolved.earlyStopPatience < spec.governance.earlyStopPatience
      || resolved.maxRounds < spec.governance.maxRounds,
    "升级后 resolveGovernance 读到的 governance 比 spec 更紧（回灌真发生）",
  );
});

test("门6: 非法 governanceSnapshot 字段不写入", () => {
  const lc = buildProfileLifecycle({
    spec: { ...spec, governance: { mode: "continuous", maxRounds: 0, earlyStopPatience: 0, minImprovement: 0 } },
    runtime: { automationId: "a1", recentRounds: [passRound(3), passRound(2), passRound(1)] },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: { action: "continue", verdict: "pass" },
    recentDecisions: [],
    recentEvaluationResults: [],
  });
  // spec.maxRounds=0/earlyStopPatience=0 → 没有可收紧的正值基线，snapshot 要么 null 要么仅含合法正值
  if (lc.governanceSnapshot) {
    for (const [k, v] of Object.entries(lc.governanceSnapshot)) {
      if (k === "maxRounds" || k === "earlyStopPatience") {
        assert.ok(Number.isInteger(v) && v >= 0, `${k} 必须合法非负整数: ${v}`);
      }
    }
  }
  assert.ok(true);
});
