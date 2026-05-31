import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OC, agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { composeAgentBinding } from "../lib/effective-profile-composer.js";

function clearRuntimeConfigs() {
  runtimeAgentConfigs.clear();
}

test("agentWorkspace prefers configured workspace over existing workspace alias directory", async () => {
  const agentId = `workspace-truth-configured-${Date.now()}`;
  const configuredWorkspace = join(tmpdir(), `${agentId}-configured`);
  const aliasedWorkspace = join(OC, `workspace-${agentId}`);

  try {
    clearRuntimeConfigs();
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role: "executor",
      workspace: configuredWorkspace,
    });
    await mkdir(aliasedWorkspace, { recursive: true });

    assert.equal(
      agentWorkspace(agentId),
      configuredWorkspace,
      "configured workspace must stay canonical even if workspace-* exists",
    );
  } finally {
    clearRuntimeConfigs();
    await rm(aliasedWorkspace, { recursive: true, force: true }).catch(() => {});
    await rm(configuredWorkspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("agentWorkspace ignores workspace-* aliases and keeps canonical workspaces paths for unconfigured agents", async () => {
  const agentId = `workspace-truth-canonical-${Date.now()}`;
  const aliasedWorkspace = join(OC, `workspace-${agentId}`);
  const canonicalWorkspace = join(OC, "workspaces", agentId);

  try {
    clearRuntimeConfigs();
    await mkdir(aliasedWorkspace, { recursive: true });

    assert.equal(
      agentWorkspace(agentId),
      canonicalWorkspace,
      "runtime path truth must stay in workspaces/* even if a legacy workspace-* alias exists",
    );
  } finally {
    clearRuntimeConfigs();
    await rm(aliasedWorkspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("profile composition uses the same default workspace overrides as runtime workspace resolution", () => {
  clearRuntimeConfigs();

  const controllerBinding = composeAgentBinding({
    config: { agents: { list: [] } },
    agentConfig: {
      id: "controller",
      role: "bridge",
    },
  });
  const operatorBinding = composeAgentBinding({
    config: { agents: { list: [] } },
    agentConfig: {
      id: "operator",
      role: "agent",
    },
  });

  assert.equal(controllerBinding.workspace.effective, agentWorkspace("controller"));
  assert.equal(operatorBinding.workspace.effective, agentWorkspace("operator"));
});
