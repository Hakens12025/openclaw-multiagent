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

function assertPositiveAgentVisibleBlockReason(blockReason) {
  assert.doesNotMatch(
    blockReason || "",
    /未配置|缺少|未包含|不在|已关闭|非敏感|已拦截|不要|不得|不能/u,
  );
}

test("security block reasons use concise positive runtime guidance", () => {
  runtimeAgentConfigs.clear();
  registerRuntimeAgents({
    agents: {
      list: [
        { id: "controller", role: "bridge" },
        { id: "worker", role: "executor" },
      ],
    },
  });

  const cases = [
    checkToolCall("controller", "agent:controller:hook:test", "read", { path: "SOUL.md" }, logger),
    checkToolCall("worker", "agent:worker:main", "read", { path: "~/.openclaw/openclaw.json" }, logger),
    checkToolCall("worker", "agent:worker:main", "write", { path: "~/.openclaw/.env", content: "x" }, logger),
    checkToolCall("worker", "agent:worker:main", "sessions_send", { message: "token=sk-123456789012345678901234" }, logger),
    checkToolCall("worker", "agent:worker:main", "exec", { command: "cat ~/.ssh/id_rsa" }, logger),
  ];

  for (const result of cases) {
    assert.equal(result?.block, true);
    assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  }
  runtimeAgentConfigs.clear();
});
