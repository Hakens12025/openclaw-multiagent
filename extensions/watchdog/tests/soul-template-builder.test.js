import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import { renderRolePersonaBlock } from "../lib/role-spec-registry.js";

// 六层模型重构后 soul-template-builder.js 已删除；④role persona 改由 renderRolePersonaBlock 渲染，
// 写进 IDENTITY.md(系统托管)并在系统派工路内联进合约提示词。本文件守护 persona 块的渲染契约。

test("renderRolePersonaBlock renders the role persona block (## Role + summary + 姿态/底线/倾向)", () => {
  const block = renderRolePersonaBlock(AGENT_ROLE.EXECUTOR);
  assert.match(block, /^## Role/, "persona 块以 ## Role 开头");
  assert.match(block, /Mindset:/, "含思考姿态");
  assert.match(block, /Quality bar:/, "含质量底线");
  assert.match(block, /Decision style:/, "含决策倾向");
  assert.match(block, /Principle 1:/, "含默认准则编号");
  assert.doesNotMatch(block, /managed-by-watchdog/, "persona 块本身不带 marker(marker 由 IDENTITY 写入器添加)");
});

test("renderRolePersonaBlock(BRIDGE) carries the bridge persona, distinct from executor", () => {
  const bridge = renderRolePersonaBlock(AGENT_ROLE.BRIDGE);
  const executor = renderRolePersonaBlock(AGENT_ROLE.EXECUTOR);
  assert.match(bridge, /Bridge node/, "bridge persona mentions bridge semantics");
  assert.notEqual(bridge, executor, "different roles render different persona blocks");
});

test("renderRolePersonaBlock(PLANNER) describes the brief-and-stage planner stance", () => {
  const planner = renderRolePersonaBlock(AGENT_ROLE.PLANNER);
  assert.match(planner, /^## Role/);
  assert.match(planner, /Planner node|blueprint|stage/i, "planner persona keeps the planning stance");
  // planner persona is identity-level (stance/quality), NOT the [STAGE]/brief output protocol
  // (that lives in getRoleOutputDirectives / ⑥wake layer).
  assert.doesNotMatch(planner, /\[STAGE\]/, "persona 块不含产出协议([STAGE] 属 ⑥wake 层)");
});

test("renderRolePersonaBlock returns persona content for every supported role", () => {
  for (const role of [
    AGENT_ROLE.BRIDGE,
    AGENT_ROLE.PLANNER,
    AGENT_ROLE.EXECUTOR,
    AGENT_ROLE.RESEARCHER,
    AGENT_ROLE.REVIEWER,
    AGENT_ROLE.AGENT,
  ]) {
    const block = renderRolePersonaBlock(role);
    assert.ok(block.startsWith("## Role"), `${role} persona block is non-empty and well-formed`);
  }
});
