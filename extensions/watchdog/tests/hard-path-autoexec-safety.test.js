// Tests: hard-path-autoexec.js must reject dangerous commands and run async
// Bug: execSync with 120s timeout blocked event loop; no command sanitization
// Fix: async exec with strict whitelist/sanitization, reject shell meta chars

import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runWorkerHardPathAutoExec } from "../lib/hard-path-autoexec.js";
import { agentWorkspace } from "../lib/state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function setupAgentInbox(agentId, contract) {
  const ws = agentWorkspace(agentId);
  await mkdir(join(ws, "inbox"), { recursive: true });
  await writeFile(join(ws, "inbox", "contract.json"), JSON.stringify(contract));
  return ws;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("command with semicolon shell injection is not executed as shell", async () => {
  const agentId = `worker-injection-${Date.now()}`;
  const ws = await setupAgentInbox(agentId, {
    id: "TC-injection",
    _hardPath: {
      // Attempt to chain a second command via semicolon
      command: `node --version; touch ${join(agentWorkspace(agentId), "injected.txt")}`,
    },
  });

  try {
    await runWorkerHardPathAutoExec({
      agentId,
      trackingState: { contract: { id: "TC-injection" } },
      logger,
    });

    const markerCreated = await fileExists(join(ws, "injected.txt"));
    assert.equal(markerCreated, false, "semicolon-injected side command must not execute");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("command with backtick substitution is rejected and not executed", async () => {
  const agentId = `worker-backtick-${Date.now()}`;
  const ws = await setupAgentInbox(agentId, {
    id: "TC-backtick",
    _hardPath: {
      command: `echo \`touch ${join(agentWorkspace(agentId), "backtick.txt")}\``,
    },
  });

  try {
    await runWorkerHardPathAutoExec({
      agentId,
      trackingState: { contract: { id: "TC-backtick" } },
      logger,
    });

    const markerCreated = await fileExists(join(ws, "backtick.txt"));
    assert.equal(markerCreated, false, "backtick injection must not execute");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("command with dollar-paren substitution is rejected", async () => {
  const agentId = `worker-dollar-${Date.now()}`;
  const ws = await setupAgentInbox(agentId, {
    id: "TC-dollar",
    _hardPath: {
      command: `echo $(touch ${join(agentWorkspace(agentId), "dollar.txt")})`,
    },
  });

  try {
    await runWorkerHardPathAutoExec({
      agentId,
      trackingState: { contract: { id: "TC-dollar" } },
      logger,
    });

    const markerCreated = await fileExists(join(ws, "dollar.txt"));
    assert.equal(markerCreated, false, "dollar-paren injection must not execute");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("runWorkerHardPathAutoExec returns a Promise (non-blocking)", async () => {
  const agentId = `worker-async-${Date.now()}`;
  const ws = await setupAgentInbox(agentId, {
    id: "TC-async",
    _hardPath: { command: "node --version" },
  });

  try {
    const ret = runWorkerHardPathAutoExec({
      agentId,
      trackingState: { contract: { id: "TC-async" } },
      logger,
    });

    assert.ok(
      ret && typeof ret.then === "function",
      "runWorkerHardPathAutoExec must return a Promise, not block synchronously",
    );
    await ret;
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("contract without _hardPath.command returns false immediately", async () => {
  const agentId = `worker-no-cmd-${Date.now()}`;
  const ws = await setupAgentInbox(agentId, { id: "TC-no-cmd" });

  try {
    const result = await runWorkerHardPathAutoExec({
      agentId,
      trackingState: { contract: { id: "TC-no-cmd" } },
      logger,
    });
    assert.equal(result, false, "no _hardPath.command should return false");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("no trackingState returns false immediately without reading disk", async () => {
  const result = await runWorkerHardPathAutoExec({
    agentId: "worker-no-tracking",
    trackingState: null,
    logger,
  });
  assert.equal(result, false, "null trackingState should return false without throwing");
});
