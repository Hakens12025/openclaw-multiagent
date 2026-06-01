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
import { getDispatchInstruction } from "../lib/role-spec-registry.js";

test("execution-layer soul guidance defers IO details to wake + platform docs", async () => {
  // v5.1 Task 1/7: SOUL no longer hardcodes inbox/outbox paths.
  // Path truth lives in the current-session-boundary section, pointing at
  // the runtime wake message and platform managed docs.
  const roles = [
    { agentId: "planner-guidance", role: AGENT_ROLE.PLANNER },
    { agentId: "worker-guidance", role: AGENT_ROLE.EXECUTOR },
    { agentId: "researcher-guidance", role: AGENT_ROLE.RESEARCHER },
    { agentId: "reviewer-guidance", role: AGENT_ROLE.REVIEWER },
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

      const soul = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
      assert.match(soul, /当前会话边界/);
      assert.match(soul, /以本轮系统唤醒信息和平台文档为准/);
      assert.doesNotMatch(soul, /read\(path: "inbox\/contract\.json"\)/);
      assert.doesNotMatch(soul, /绝不能写成 `\/inbox\/contract\.json`/);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
});

test("dispatch instructions carry minimal contract-session entrypoint", () => {
  const expectations = [
    { role: AGENT_ROLE.PLANNER, matcher: /stage plan/i },
    { role: AGENT_ROLE.EXECUTOR, matcher: /deliverable/i },
    { role: AGENT_ROLE.RESEARCHER, matcher: /research/i },
    { role: AGENT_ROLE.REVIEWER, matcher: /review/i },
  ];

  for (const entry of expectations) {
    const instruction = getDispatchInstruction(entry.role);
    assert.match(instruction, entry.matcher);
    assert.match(instruction, /Read inbox\/contract\.json/);
    assert.match(instruction, /upstreamPackages/u, "应提示读上游产物包（产物随 contract 流转）");
    assert.match(instruction, /outbox\/runtime_result\.json/u);
    assert.match(instruction, /Runtime consumes status metadata/u);
    assert.doesNotMatch(instruction, /outbox\/stage_result\.json/);
    assert.doesNotMatch(instruction, /outbox\/contract_result\.json/);
    assert.doesNotMatch(instruction, /不要写成/);
    assert.doesNotMatch(instruction, /[\u4e00-\u9fff]/u);
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

    const runtimeSoul = await readFile(join(runtimeWorkspace, "SOUL.md"), "utf8");
    assert.match(runtimeSoul, /# controller/);
    await assert.rejects(
      readFile(join(operatorWorkspace, "SOUL.md"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
