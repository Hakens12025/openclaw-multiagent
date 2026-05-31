/**
 * W2 修复验证测试 — agent-assembly 板块
 *
 * Bug 1 (audit 验证): changeAgentTools reset 语义 — 代码已正确实现，本测试补充覆盖
 * Bug 2 (实际修复): agent-binding-store 读写 skills 不一致
 *   — binding 文档存在但无 skills.configured 时，fallback 错误读取顶层 effective skills
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../lib/agent/agent-binding-store.js";
import { composeEffectiveSkillRefs } from "../lib/agent/agent-binding-policy.js";
import { composeDefaultCapabilityProjection } from "../lib/agent/agent-capability-policy.js";

// ---------------------------------------------------------------------------
// Helpers — mirror the binding mutation in changeAgentTools (production logic)
// so we can test it without the gateway/filesystem.
// ---------------------------------------------------------------------------

function mutateBindingForTools(agent, configuredTools) {
  const nextBinding = readStoredAgentBinding(agent);
  const nextConfiguredCapabilities = nextBinding.capabilities?.configured
    && typeof nextBinding.capabilities.configured === "object"
    ? { ...nextBinding.capabilities.configured }
    : {};

  if (configuredTools == null) {
    delete nextConfiguredCapabilities.tools;
  } else {
    nextConfiguredCapabilities.tools = configuredTools;
  }

  // Production code from changeAgentTools (agent-admin-agent-operations.js)
  if (configuredTools == null) {
    nextBinding.capabilities = { configured: nextConfiguredCapabilities };
  } else if (Object.keys(nextConfiguredCapabilities).length > 0) {
    nextBinding.capabilities = { configured: nextConfiguredCapabilities };
  } else {
    delete nextBinding.capabilities;
  }

  writeStoredAgentBinding(agent, nextBinding);
}

// ---------------------------------------------------------------------------
// Bug 1: changeAgentTools reset semantics
// Audit concern: reset path writes empty-shell { configured: {} } to nextBinding.
// Reality: this is the intentional shouldResetToolsToDefaults sentinel —
// buildStoredBindingDocument never persists it to the stored binding document.
// These tests verify the correct end-to-end behavior is preserved.
// ---------------------------------------------------------------------------

test("bug1-coverage: changeAgentTools set produces configured tools in top-level truth", () => {
  const agent = { id: "test-tools-set", role: "executor" };

  mutateBindingForTools(agent, ["read", "write"]);

  assert.deepEqual(
    agent.tools?.allow,
    ["read", "write"],
    "explicit tools should be written to top-level truth",
  );
  // Tools must NOT be persisted inside binding.capabilities.configured
  // (binding.capabilities is not written by buildStoredBindingDocument for tools)
  assert.equal(
    Object.prototype.hasOwnProperty.call(agent.binding?.capabilities?.configured || {}, "tools"),
    false,
    "tools must not be stored as binding residue inside binding.capabilities.configured",
  );
});

test("bug1-coverage: changeAgentTools reset restores default tools and leaves no binding capabilities residue", () => {
  const agent = { id: "test-tools-reset", role: "executor" };
  const defaultTools = composeDefaultCapabilityProjection({ role: "executor" }).tools;

  // Set tools first
  mutateBindingForTools(agent, ["read", "write"]);
  assert.deepEqual(agent.tools?.allow, ["read", "write"]);

  // Reset to defaults
  mutateBindingForTools(agent, null);

  assert.deepEqual(
    agent.tools?.allow,
    defaultTools,
    "resetting tools should restore the role default tools in top-level truth",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(agent.binding || {}, "capabilities"),
    false,
    "binding document must have no capabilities key after reset (empty-shell sentinel discarded by buildStoredBindingDocument)",
  );
});

test("bug1-coverage: changeAgentTools reset is idempotent", () => {
  const agent = { id: "test-tools-idempotent", role: "executor" };

  mutateBindingForTools(agent, null);
  const after1 = JSON.stringify(agent);

  mutateBindingForTools(agent, null);
  const after2 = JSON.stringify(agent);

  assert.equal(after1, after2, "consecutive resets must produce identical state");
});

// ---------------------------------------------------------------------------
// Bug 2: agent-binding-store skills read/write inconsistency
// Fix: when binding document exists but binding.skills has no 'configured' key,
// do NOT fall back to readTopLevelSkillRefs (which reads effective skills).
// Instead return [] as configured skills.
// ---------------------------------------------------------------------------

test("bug2: agent with binding doc but no skills.configured does not read top-level effective as configured", () => {
  // Simulates a legacy agent where source.binding exists (for capabilities/policies)
  // but binding.skills has no 'configured' key.
  // Pre-fix: readStoredAgentBinding falls back to readTopLevelSkillRefs, returning
  // the top-level effective skills as configured.
  // Post-fix: binding document present → configured skills are [] (not top-level effective).
  const effectiveSkills = composeEffectiveSkillRefs({ role: "executor", configuredSkills: [] });

  const agent = {
    id: "test-skills-legacy-binding",
    role: "executor",
    skills: effectiveSkills,           // top-level holds effective skills
    binding: {
      capabilities: { configured: {} }, // binding doc exists, but no skills
    },
  };

  const binding = readStoredAgentBinding(agent);

  // skills field should be absent (no configured skills, binding doc present)
  assert.equal(
    Object.prototype.hasOwnProperty.call(binding, "skills"),
    false,
    "when binding doc is present but skills.configured absent, skills key must not appear in binding snapshot",
  );

  // If somehow skills is present, it must not contain effective skills
  const configuredSkills = binding.skills?.configured;
  assert.equal(
    Array.isArray(configuredSkills) && configuredSkills.some((s) => effectiveSkills.includes(s)),
    false,
    "configured skills must not contain any effective (default) skills from the top-level fallback",
  );
});

test("bug2: write-read-write cycle does not expand configured skills", () => {
  const agent = { id: "test-skills-idempotent", role: "executor" };

  // Cycle 1
  writeStoredAgentBinding(agent, readStoredAgentBinding(agent));
  const afterCycle1 = JSON.stringify(agent);

  // Cycle 2 — must produce identical result
  writeStoredAgentBinding(agent, readStoredAgentBinding(agent));
  const afterCycle2 = JSON.stringify(agent);

  assert.equal(
    afterCycle1,
    afterCycle2,
    "repeated read→write cycles must be idempotent (no skills expansion)",
  );
});

test("bug2: write-then-read preserves configured=[] sentinel in binding document", () => {
  const agent = { id: "test-skills-sentinel", role: "executor" };

  writeStoredAgentBinding(agent, readStoredAgentBinding(agent));

  // binding.skills must carry the configured:[] sentinel so that read-back
  // does not fall through to top-level effective skills on agents with binding docs
  assert.deepEqual(
    agent.binding?.skills,
    { configured: [] },
    "binding document must store skills.configured=[] sentinel for agents with no explicit configured skills",
  );
});

test("bug2: explicit configured skills survive write-read round-trip without expansion", () => {
  const agent = { id: "test-skills-roundtrip", role: "executor" };
  const configuredSkills = ["model-switcher"];

  writeStoredAgentBinding(agent, {
    roleRef: "executor",
    skills: { configured: configuredSkills },
  });

  const effectiveSkills = composeEffectiveSkillRefs({ role: "executor", configuredSkills });
  assert.deepEqual(agent.skills, effectiveSkills, "top-level skills should be effective");

  const binding = readStoredAgentBinding(agent);
  assert.deepEqual(
    binding.skills?.configured,
    configuredSkills,
    "configured skills should survive write-read round-trip unchanged",
  );

  // Idempotence: second cycle must not expand
  writeStoredAgentBinding(agent, binding);
  const binding2 = readStoredAgentBinding(agent);
  assert.deepEqual(
    binding2.skills?.configured,
    configuredSkills,
    "configured skills must not expand on second read-write cycle",
  );
});
