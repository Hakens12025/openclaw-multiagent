// Tests: direct 信封队列的"终态残件清位"(2026-08-15 live l1-review 饿死修缮)。
//   占住 inbox/contract.json 的执行合约信封,其共享正本已终态 = 已消费残件(工作腿早已
//   结束,只是清道夫没碰巧删它)。旧行为把它当 occupied 永久排队——已退役的 request_review 判决
//   回投排在残件后面,caller 已 agent_end 无人再 drain,600s 超时。新行为:正本终态 →
//   清位放行队列;正本仍 active(pending/running)→ 照旧保守排队。
//
// Run: node --test tests/direct-queue-terminal-unblock.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { enqueueRuntimeDirectEnvelope } from "../lib/routing/runtime-direct-envelope-queue.js";
import { createDirectRequestEnvelope } from "../lib/protocol/protocol-primitives.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { agentWorkspace } from "../lib/state.js";

const logger = { info() {}, warn() {}, error() {} };

async function seedOccupiedInbox(agentId, tcId, canonicalStatus) {
  const inboxDir = join(agentWorkspace(agentId), "inbox");
  await mkdir(inboxDir, { recursive: true });
  // 共享正本(树内)
  await persistContractById({
    id: tcId,
    task: "caller 工作腿",
    assignee: agentId,
    status: canonicalStatus,
    createdAt: Date.now() - 5000,
    lineage: { threadId: "t-queueunblk", runId: `r-${Date.now()}-qub` },
  }, logger);
  // inbox 窄投影残件(非 direct 信封)
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify({
    id: tcId,
    task: "caller 工作腿",
    assignee: agentId,
    status: "running", // 投影可以是陈旧的 —— 判定必须以正本为准
  }, null, 2), "utf8");
  return inboxDir;
}

function buildVerdictEnvelope(agentId) {
  return createDirectRequestEnvelope({
    agentId,
    sessionKey: `agent:${agentId}:main`,
    message: "评审判决回投",
    outputDir: join(agentWorkspace(agentId), "output"),
    lineage: { threadId: "t-queueunblk", runId: `r-${Date.now()}-qubenv` },
  });
}

test("占位信封的正本已终态 → 清位放行,回投信封立即上位", async () => {
  const agentId = `planner-qunblock-${Date.now()}`;
  const tcId = `TC-QUNBLOCK-DONE-${Date.now()}`;
  try {
    const inboxDir = await seedOccupiedInbox(agentId, tcId, "completed");
    const envelope = buildVerdictEnvelope(agentId);

    const result = await enqueueRuntimeDirectEnvelope({ inboxDir, contract: envelope, agentId, logger });

    assert.equal(
      result.promoted,
      true,
      "终态残件必须被清位、回投信封立即上位 — 否则判决排队饿死(2026-08-15 live 回归)",
    );
    const active = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(active.id, envelope.id, "上位者必须是回投信封本体");
  } finally {
    await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
  }
});

test("终态 direct 残件占位 → 清位放行(terminal-commit 写回后清理段崩溃的形态)", async () => {
  const agentId = `planner-qdirect-${Date.now()}`;
  try {
    const inboxDir = join(agentWorkspace(agentId), "inbox");
    await mkdir(inboxDir, { recursive: true });
    // 已消费 direct 残件:terminal-commit 把终态写回信封本体
    const residue = buildVerdictEnvelope(agentId);
    residue.status = "completed";
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(residue, null, 2), "utf8");

    const envelope = buildVerdictEnvelope(agentId);
    const result = await enqueueRuntimeDirectEnvelope({ inboxDir, contract: envelope, agentId, logger });

    assert.equal(result.promoted, true, "终态 direct 残件必须清位,否则队列永久占死+rehydrate 复跑");
    const active = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(active.id, envelope.id, "上位者必须是新信封");
  } finally {
    await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
  }
});

test("占位信封的正本仍 active → 保守排队不清位", async () => {
  const agentId = `planner-qkeep-${Date.now()}`;
  const tcId = `TC-QUNBLOCK-LIVE-${Date.now()}`;
  try {
    const inboxDir = await seedOccupiedInbox(agentId, tcId, "running");
    const envelope = buildVerdictEnvelope(agentId);

    const result = await enqueueRuntimeDirectEnvelope({ inboxDir, contract: envelope, agentId, logger });

    assert.equal(result.promoted, false, "正本仍 running 的占位者不得被清位");
    const active = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(active.id, tcId, "running 占位信封必须原地保留");
  } finally {
    await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
  }
});
