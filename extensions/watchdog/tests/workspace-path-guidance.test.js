import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  syncAllRuntimeWorkspaceGuidance,
  syncAgentWorkspaceGuidance,
} from "../lib/workspace-guidance-writer.js";
import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";

test("execution-layer IDENTITY persona defers IO details to wake + platform docs", async () => {
  // 六层模型: ④role persona lives in managed IDENTITY.md and never hardcodes inbox/outbox paths.
  // Path truth lives in the ⑥wake layer (contract prompt) and platform managed docs.
  const roles = [
    { agentId: "planner-guidance", role: AGENT_ROLE.PLANNER },
    { agentId: "worker-guidance", role: AGENT_ROLE.EXECUTOR },
    { agentId: "researcher-guidance", role: AGENT_ROLE.RESEARCHER },
  ];

  for (const entry of roles) {
    const workspaceDir = await mkdtemp(join(tmpdir(), `openclaw-${entry.agentId}-`));
    try {
      await syncAgentWorkspaceGuidance({
        agentId: entry.agentId,
        role: entry.role,
        skills: [],
        workspaceDir,
        graph: { edges: [] },
        loops: [],
      });

      const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
      assert.match(identity, /## Role/);
      assert.doesNotMatch(identity, /read\(path: "inbox\/contract\.json"\)/);
      assert.doesNotMatch(identity, /inbox\/contract\.json/);
      assert.doesNotMatch(identity, /绝不能写成 `\/inbox\/contract\.json`/);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
});

test("watchdog managed guidance keeps path truth in wake and platform docs", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-path-guidance-"));
  try {
    await syncAgentWorkspaceGuidance({
      agentId: "controller",
      role: AGENT_ROLE.BRIDGE,
      skills: ["system-action"],
      workspaceDir,
      graph: { edges: [{ from: "controller", to: "planner" }] },
      loops: [],
    });

    const agents = await readFile(join(workspaceDir, "AGENTS.md"), "utf8");
    const platformGuide = await readFile(join(workspaceDir, "PLATFORM-GUIDE.md"), "utf8");

    assert.match(agents, /当前会话输入/);
    assert.match(platformGuide, /Contract、输出路径和正式提交方式，都以这轮系统唤醒和对应平台文档为准/);
    assert.doesNotMatch(`${agents}\n${platformGuide}`, /共享 contract|shared contract/i);
    assert.doesNotMatch(`${agents}\n${platformGuide}`, /\/inbox\/contract\.json/);
    assert.doesNotMatch(`${agents}\n${platformGuide}`, /\/outbox\/stage_result\.json/);
    assert.doesNotMatch(`${agents}\n${platformGuide}`, /\/outbox\/contract_result\.json/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("bulk workspace guidance sync skips hidden control-plane agents", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-guidance-plane-"));
  const runtimeWorkspace = join(rootDir, "controller");
  const operatorWorkspace = join(rootDir, "operator");

  try {
    await syncAllRuntimeWorkspaceGuidance({
      agents: {
        list: [
          {
            id: "controller",
            role: AGENT_ROLE.BRIDGE,
            workspace: runtimeWorkspace,
            gateway: true,
            ingressSource: "webui",
            binding: {
              roleRef: AGENT_ROLE.BRIDGE,
              workspace: { configured: runtimeWorkspace },
              policies: {
                gateway: true,
                ingressSource: "webui",
              },
            },
          },
          {
            id: "operator",
            role: AGENT_ROLE.AGENT,
            workspace: operatorWorkspace,
            binding: {
              roleRef: AGENT_ROLE.AGENT,
              workspace: { configured: operatorWorkspace },
            },
          },
        ],
      },
    }, { warn() {} });

    // Managed bulk sync writes IDENTITY (④role) for runtime agents; SOUL stays user-owned (bootstrap-seeded).
    const runtimeIdentity = await readFile(join(runtimeWorkspace, "IDENTITY.md"), "utf8");
    assert.match(runtimeIdentity, /# controller/);
    assert.match(runtimeIdentity, /## Role/);
    await assert.rejects(
      readFile(join(operatorWorkspace, "IDENTITY.md"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("heartbeat-driven control-plane agent gets HEARTBEAT.md only (memo149 phase-0)", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-guidance-heartbeat-"));
  const vizWorkspace = join(rootDir, "viz-master");
  const operatorWorkspace = join(rootDir, "operator");

  try {
    await syncAllRuntimeWorkspaceGuidance({
      agents: {
        list: [
          {
            id: "viz-master",
            role: AGENT_ROLE.AGENT,
            workspace: vizWorkspace,
            heartbeat: { every: "2h" },
            binding: {
              roleRef: AGENT_ROLE.AGENT,
              workspace: { configured: vizWorkspace },
            },
          },
          {
            id: "operator",
            role: AGENT_ROLE.AGENT,
            workspace: operatorWorkspace,
            binding: {
              roleRef: AGENT_ROLE.AGENT,
              workspace: { configured: operatorWorkspace },
            },
          },
        ],
      },
    }, { warn() {} });

    // 心跳驱动的 control-plane agent：补唤醒契约
    const heartbeat = await readFile(join(vizWorkspace, "HEARTBEAT.md"), "utf8");
    assert.match(heartbeat, /HEARTBEAT/);
    // 但不 seed runtime 全套 guidance
    await assert.rejects(readFile(join(vizWorkspace, "PLATFORM-GUIDE.md"), "utf8"), /ENOENT/);
    // 无心跳的 control-plane agent：原样跳过（设计不变）
    await assert.rejects(readFile(join(operatorWorkspace, "HEARTBEAT.md"), "utf8"), /ENOENT/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
