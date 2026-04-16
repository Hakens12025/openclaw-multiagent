import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { agentWorkspace } from "../lib/state.js";
import {
  changeAgentRole,
  createAgentDefinition,
  deleteAgentDefinition,
} from "../lib/agent/agent-admin-agent-operations.js";
import { joinLocalAgentDefinition } from "../lib/agent/agent-enrollment.js";
import { isSupportedAgentRole } from "../lib/agent/agent-identity.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("isSupportedAgentRole accepts canonical roles only", () => {
  assert.equal(isSupportedAgentRole("planner"), true);
  assert.equal(isSupportedAgentRole("reviewer"), true);
  assert.equal(isSupportedAgentRole("federated_reviewer"), false);
  assert.equal(isSupportedAgentRole(""), false);
});

test("createAgentDefinition rejects unsupported role strings", async () => {
  const tempAgentId = `role-invalid-create-${Date.now()}`;

  try {
    await assert.rejects(
      () => createAgentDefinition({
        id: tempAgentId,
        role: "federated_reviewer",
        model: "ark-anthropic/deepseek-v3.2",
        logger,
      }),
      /unsupported role/i,
    );
  } finally {
    await deleteAgentDefinition({
      agentId: tempAgentId,
      logger,
    }).catch(() => {});
    await rm(agentWorkspace(tempAgentId), { recursive: true, force: true });
  }
});

test("changeAgentRole rejects unsupported role strings", async () => {
  const tempAgentId = `role-invalid-change-${Date.now()}`;

  try {
    await createAgentDefinition({
      id: tempAgentId,
      role: "executor",
      model: "ark-anthropic/deepseek-v3.2",
      logger,
    });

    await assert.rejects(
      () => changeAgentRole({
        agentId: tempAgentId,
        role: "meta_planner",
        logger,
      }),
      /unsupported role/i,
    );
  } finally {
    await deleteAgentDefinition({
      agentId: tempAgentId,
      logger,
    }).catch(() => {});
    await rm(agentWorkspace(tempAgentId), { recursive: true, force: true });
  }
});

test("joinLocalAgentDefinition rejects unsupported role strings", async () => {
  const tempAgentId = `role-invalid-join-${Date.now()}`;

  try {
    await createAgentDefinition({
      id: tempAgentId,
      role: "executor",
      model: "ark-anthropic/deepseek-v3.2",
      logger,
    });

    await assert.rejects(
      () => joinLocalAgentDefinition({
        payload: {
          agentId: tempAgentId,
          role: "federated_reviewer",
        },
        logger,
      }),
      /unsupported role/i,
    );
  } finally {
    await deleteAgentDefinition({
      agentId: tempAgentId,
      logger,
    }).catch(() => {});
    await rm(agentWorkspace(tempAgentId), { recursive: true, force: true });
  }
});
