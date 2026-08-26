import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";

// 六层模型: ④role persona 写进 IDENTITY.md(系统托管)。shared-contract IO 协议属 ⑥wake 层(合约提示词),
// 不应渗进 IDENTITY persona。本文件守护 IDENTITY 只承载角色姿态、不硬编码协议 IO。
async function readManagedIdentity(role, agentId) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "identity-protocol-"));
  try {
    await syncAgentWorkspaceGuidance({
      agentId,
      role,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });
    return await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

function assertIdentityStaysRoleOnly(identity, agentId) {
  assert.match(identity, /## Role/, `${agentId} IDENTITY should carry the role persona`);
  assert.doesNotMatch(identity, /inbox\/contract\.json/, `${agentId} IDENTITY should not hardcode shared-contract input`);
  assert.doesNotMatch(identity, /outbox\/stage_result\.json/, `${agentId} IDENTITY should not teach legacy stage_result commit`);
  assert.doesNotMatch(identity, /outbox\/contract_result\.json/, `${agentId} IDENTITY should not teach legacy contract_result commit`);
  assert.doesNotMatch(identity, /HEARTBEAT_OK/, `${agentId} IDENTITY should not hardcode heartbeat stop protocol`);
}

test("executor IDENTITY keeps role persona while leaving shared-contract IO to the wake layer", async () => {
  assertIdentityStaysRoleOnly(await readManagedIdentity(AGENT_ROLE.EXECUTOR, "worker-x"), "worker-x");
});

test("researcher IDENTITY keeps role persona while leaving shared-contract IO to the wake layer", async () => {
  assertIdentityStaysRoleOnly(await readManagedIdentity(AGENT_ROLE.RESEARCHER, "researcher-x"), "researcher-x");
});
