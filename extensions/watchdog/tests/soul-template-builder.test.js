import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import {
  buildSoulTemplate,
  buildBridgeSoulTemplate,
} from "../lib/soul-template-builder.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../lib/managed-doc-markers.js";

test("buildSoulTemplate(BRIDGE) returns bridge template, not default", () => {
  const soul = buildSoulTemplate("bridge-x", AGENT_ROLE.BRIDGE);
  assert.ok(soul.startsWith(MANAGED_BOOTSTRAP_MARKER), "bridge SOUL carries managed marker");
  assert.match(soul, /桥接本地处理原则|# bridge-x/, "bridge SOUL mentions bridge role section or agent id");
});

test("bridge template keeps only a minimal formal dispatch entrypoint", () => {
  const soul = buildBridgeSoulTemplate("bridge-x", AGENT_ROLE.BRIDGE);
  assert.match(soul, /\[ACTION\] delegate/, "bridge SOUL exposes the formal dispatch entrypoint");
  assert.doesNotMatch(soul, /```[\s\S]*\[ACTION\] delegate/, "bridge SOUL should not include a protocol tutorial block");
  assert.doesNotMatch(soul, /\[DISPATCH\]/, "bridge SOUL should not teach [DISPATCH] tag");
  assert.doesNotMatch(soul, /IDENTITY\.md/, "bridge SOUL should not mention IDENTITY.md");
  assert.doesNotMatch(soul, /USER\.md/, "bridge SOUL should not mention USER.md");
});

test("bridge template describes scope boundaries instead of protocol tutorials", () => {
  const soul = buildBridgeSoulTemplate("bridge-x", AGENT_ROLE.BRIDGE);
  assert.match(soul, /bridge 工作面：当前会话、本 agent workspace、managed 平台文档/, "bridge SOUL should describe the positive work surface");
  assert.match(soul, /配置、其他 workspace、身份记忆文件由对应 runtime\/owner 管理/, "bridge SOUL should point owned surfaces to their runtime owner");
});

test("planner template does not encode simple or complex contract classes", () => {
  const soul = buildSoulTemplate("planner-x", AGENT_ROLE.PLANNER);
  assert.match(soul, /阶段数量按可验证交付边界划分/);
  assert.doesNotMatch(soul, /简单任务/);
  assert.doesNotMatch(soul, /复杂任务/);
});

test("planner template produces a working brief (not the final deliverable)", () => {
  const soul = buildSoulTemplate("planner-x", AGENT_ROLE.PLANNER);
  assert.match(soul, /工作简报/, "planner 应产工作简报（给执行节点的输入）");
  assert.match(soul, /最终答案与交付物由执行节点产出|本节点只交付简报/, "planner 应把最终成品交给执行节点");
  assert.match(soul, /\[STAGE\]/, "仍保留 [STAGE] 阶段标记（系统进度追踪）");
});

test("executor template stays role-only without runtime_result protocol branches", () => {
  const soul = buildSoulTemplate("worker-x", AGENT_ROLE.EXECUTOR);
  assert.doesNotMatch(soul, /runtime_result\.json/);
  assert.doesNotMatch(soul, /单文件|多文件|single-file|multi-file/i);
  assert.doesNotMatch(soul, /stage_result\.json|contract_result\.json/);
});

test("executor template treats upstream brief as working input", () => {
  const soul = buildSoulTemplate("worker-x", AGENT_ROLE.EXECUTOR);
  assert.match(soul, /上游.*工作简报|工作简报.*工作输入/, "executor 应把上游工作简报当作工作输入");
  assert.match(soul, /据此产出真正的交付物/, "executor 应据简报产真交付物");
});
