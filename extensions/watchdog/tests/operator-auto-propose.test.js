import test from "node:test";
import assert from "node:assert/strict";

import { operatorAutoPropose } from "../lib/operator/operator-auto-propose.js";

const NOW = 1717000000000;

test("规则①: stable + 连≥3 pass + governanceSnapshot → governance_hardening(guarded)", () => {
  const proposals = operatorAutoPropose({
    now: NOW,
    profiles: [{
      automationId: "auto-a",
      profileLifecycle: {
        trustLevel: "stable", status: "active", successStreak: 5, failureStreak: 0,
        governanceSnapshot: { maxRounds: 2 },
      },
    }],
  });
  const harden = proposals.find((p) => p.category === "governance_hardening");
  assert.ok(harden, "应产治理收紧提案");
  assert.equal(harden.riskLevel, "guarded");
  assert.equal(harden.confidence, "high"); // streak 5 >= 3+2 → high
  assert.equal(harden.suggestedPayload.governance.maxRounds, 2);
  assert.equal(harden.origin, "operator-auto");
});

test("规则②: retired 或 连≥2 fail → troubleshooting(guarded)", () => {
  const retired = operatorAutoPropose({
    now: NOW,
    profiles: [{ automationId: "auto-r", profileLifecycle: { trustLevel: "provisional", status: "retired", successStreak: 0, failureStreak: 2 } }],
  });
  assert.ok(retired.some((p) => p.category === "troubleshooting" && p.riskLevel === "guarded"));

  const failing = operatorAutoPropose({
    now: NOW,
    profiles: [{ automationId: "auto-f", profileLifecycle: { trustLevel: "experimental", status: "active", successStreak: 0, failureStreak: 3 } }],
  });
  assert.ok(failing.some((p) => p.category === "troubleshooting"));
});

test("规则③: stable + frozen(conclude) → skill_precipitation(safe)", () => {
  const proposals = operatorAutoPropose({
    now: NOW,
    profiles: [{ automationId: "auto-c", profileLifecycle: { trustLevel: "stable", status: "active", frozen: true, successStreak: 1, failureStreak: 0 } }],
  });
  const precip = proposals.find((p) => p.category === "skill_precipitation");
  assert.ok(precip, "应产技能沉淀提案");
  assert.equal(precip.riskLevel, "safe");
});

test("规则④(#47): harness 模块失败 → harness_authoring(guarded) + 失败模块证据", () => {
  const proposals = operatorAutoPropose({
    now: NOW,
    profiles: [{
      automationId: "auto-h",
      profileLifecycle: { trustLevel: "provisional", status: "active", successStreak: 1, failureStreak: 0 },
      harness: { failedModuleCount: 2, failedModules: ["mod-x", "mod-y"] },
    }],
  });
  const ha = proposals.find((p) => p.category === "harness_authoring");
  assert.ok(ha, "harness 模块失败应产 harness_authoring 提案");
  assert.equal(ha.riskLevel, "guarded");
  assert.equal(ha.confidence, "high"); // 2 个失败 ≥2 → high
  assert.equal(ha.suggestedPayload.harnessNeedsReshape, true);
  assert.ok(ha.proof.some((p) => p.kind === "failedModules"));
  // 生成层: 提案带具体推荐的 harness moduleRefs(非空, 全在 catalog 形如 harness:*)
  assert.ok(Array.isArray(ha.suggestedPayload.suggestedModuleRefs) && ha.suggestedPayload.suggestedModuleRefs.length >= 4);
  assert.ok(ha.suggestedPayload.suggestedModuleRefs.every((id) => /^harness:/.test(id)));
});

test("无信号不造提案: experimental/低 streak/无 snapshot/harness 0 失败 → 空", () => {
  const proposals = operatorAutoPropose({
    now: NOW,
    profiles: [{ automationId: "auto-q", profileLifecycle: { trustLevel: "experimental", status: "active", successStreak: 1, failureStreak: 0 } }],
  });
  assert.deepEqual(proposals, [], "无触发信号不应造提案(不无中生有)");
});

test("缺 profileLifecycle / 缺 automationId → 跳过(不抛)", () => {
  assert.deepEqual(operatorAutoPropose({ profiles: [{ automationId: "x" }, { profileLifecycle: {} }, null] }), []);
  assert.deepEqual(operatorAutoPropose({}), []);
  assert.deepEqual(operatorAutoPropose(), []);
});
