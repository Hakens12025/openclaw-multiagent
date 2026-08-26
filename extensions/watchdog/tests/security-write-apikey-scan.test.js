// Tests: security.js write/edit tools must scan content for API keys
// Bug: containsApiKey was only called for sessions_send, not write/edit tools
// Fix: add content scanning to WRITE_TOOL_PATTERN branch

import test from "node:test";
import assert from "node:assert/strict";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { checkToolCall } from "../lib/security/security.js";
import { runtimeAgentConfigs } from "../lib/state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test.beforeEach(() => {
  runtimeAgentConfigs.clear();
  registerRuntimeAgents({
    agents: {
      list: [
        { id: "worker", role: "executor" },
      ],
    },
  });
});

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

test("write tool with API key in content is blocked", () => {
  const result = checkToolCall(
    "worker",
    "agent:worker:main",
    "write",
    {
      file_path: "/tmp/harmless.txt",
      content: "Here is my key: sk-proj-abc123456789012345678901234567890",
    },
    logger,
  );

  assert.equal(result?.block, true, "write with API key in content should be blocked");
  assert.ok(result?.blockReason, "should have a blockReason");
});

test("edit tool with API key in content is blocked", () => {
  const result = checkToolCall(
    "worker",
    "agent:worker:main",
    "edit",
    {
      file_path: "/tmp/harmless.txt",
      oldText: "placeholder",
      newText: "api_key = sk-1234567890abcdefghijklmnopqrstuvwxyz",
    },
    logger,
  );

  assert.equal(result?.block, true, "edit with API key in newText should be blocked");
  assert.ok(result?.blockReason, "should have a blockReason");
});

test("write tool with nvapi key in content is blocked", () => {
  const result = checkToolCall(
    "worker",
    "agent:worker:main",
    "Write",
    {
      file_path: "/tmp/config.txt",
      content: "NVIDIA_API_KEY=nvapi-abc123456789012345678901234567890",
    },
    logger,
  );

  assert.equal(result?.block, true, "write with nvapi key should be blocked");
  assert.ok(result?.blockReason, "should have a blockReason");
});

test("write tool to a non-sensitive path with safe content is allowed", () => {
  const result = checkToolCall(
    "worker",
    "agent:worker:main",
    "write",
    {
      file_path: "/tmp/output.md",
      content: "# Task completed\n\nAll done!",
    },
    logger,
  );

  assert.equal(result, null, "write with safe content should be allowed");
});

test("write tool with content field (not file_path) containing API key is blocked", () => {
  const result = checkToolCall(
    "worker",
    "agent:worker:main",
    "write",
    {
      content: "gateway_token: 'dsk-super-secret-key-0000000000000000000000000'",
    },
    logger,
  );

  assert.equal(result?.block, true, "write with API key in content should be blocked regardless of path");
  assert.ok(result?.blockReason, "should have a blockReason");
});

test("write to sensitive path still blocked even without API key in content", () => {
  const result = checkToolCall(
    "worker",
    "agent:worker:main",
    "write",
    {
      file_path: "~/.openclaw/openclaw.json",
      content: "safe content",
    },
    logger,
  );

  assert.equal(result?.block, true, "write to sensitive path should still be blocked");
  assert.ok(result?.blockReason, "should have a blockReason");
});
