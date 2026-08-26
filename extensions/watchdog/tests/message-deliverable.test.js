// tests/message-deliverable.test.js — 双面交付行为锁(消息面缺省路 / 文件面既有路)。
//
// 交付有两种形态:agent 直接回复的正文(消息面),与写进 outbox 的文件(文件面)。
// 平台侧只有一个采集入口,入口内分两路:有文件走文件路,零文件且正文在场走消息路
// (正文物化成 message.md 进 outbox 链,此后与普通交付物同权:封条/判定/搬运零特例)。
//
// 锁七件事:
//   ①零文件 + 正文 → 物化 message.md,封条 primary 指它,收口 completed;
//   ②文件在场 → 文件优先,正文不参与,message.md 不生成(消息不与文件并列成产物);
//   ③崩溃轮(turnSucceeded=false)不物化 —— 半截轮的正文不是交付;
//   ④无合约轮(activeContract 缺席)不物化 —— 消息面只服务合约交付;
//   ⑤声明了 requiredFiles 的合约只回消息 → 仍判 failed(消息不顶替声明的文件产出);
//   ⑥空白正文不物化(空消息不是交付);
//   ⑦extractFinalAssistantText:倒序取最后一段 assistant 正文,纯 toolCall 尾轮继续前找;
//   ⑧流程就绪门:合约轮从未读到信封的轮次不进消息路(受阻说明不得封成交付=假成功回归锁)。
//
// Run: node --test tests/message-deliverable.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { bindParticipantOutbox } from "../lib/routing/mailbox/runtime-mailbox.js";
import { collectWorkerOutbox } from "../lib/routing/mailbox/runtime-mailbox-outbox-handlers.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { readOutboxSeal } from "../lib/archive/outbox-seal.js";
import { resolvePhysicalWorkspacePath } from "../lib/state/state-agent-helpers.js";
import { resolveTerminalOutcome } from "../lib/contract/terminal-outcome.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { extractFinalAssistantText } from "../lib/delivery/runtime-user-facing-output.js";
import { MESSAGE_DELIVERABLE_FILE } from "../lib/protocol/protocol-primitives.js";
import { resolveMessageDeliverableText } from "../lib/lifecycle/agent-end/transport.js";

const logger = { info() {}, warn() {}, error() {} };
const sandbox = mkdtempSync(join(tmpdir(), "message-deliverable-"));
const REPLY = "17 加 25 等于 42。这是一句直接答复,没有文件产出。";

function wsFor(agentId) {
  return join(sandbox, "workspaces", agentId);
}

function registerSandboxAgents(ids) {
  registerRuntimeAgents({
    agents: {
      list: ids.map((id) => ({
        id,
        role: "executor",
        workspace: wsFor(id),
        model: { primary: "demo/worker" },
      })),
    },
  });
}

let seq = 0;
async function seedContract({ agentId, contractId, completionCriteria = null }) {
  seq += 1;
  const contract = {
    id: contractId,
    task: "双面交付行为锁",
    assignee: agentId,
    status: "running",
    createdAt: Date.now() - 1000,
    ...(completionCriteria ? { completionCriteria } : {}),
    lineage: { threadId: "t-msgdeliver", runId: `r-${Date.now()}-${seq}` },
  };
  await persistContractById(contract, logger);
  return contract;
}

async function setupRound(tag, { completionCriteria = null } = {}) {
  const agentId = `msg-${tag}-agent`;
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const cid = `TC-MSG-${tag.toUpperCase()}-${Date.now()}`;
  const contract = await seedContract({ agentId, contractId: cid, completionCriteria });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId: cid, logger });
  assert.equal(bind.linked, true, "切链是本组用例的前提");
  return {
    agentId,
    outboxDir,
    cid,
    contract,
    tree: resolvePhysicalWorkspacePath(bind.treeOutboxDir),
  };
}

test("①零文件 + 正文 → 物化 message.md 并封包,收口按交付事实判 completed", async () => {
  const { agentId, outboxDir, cid, contract, tree } = await setupRound("plain");

  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: [],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:r1`,
    messageText: REPLY,
  });

  assert.equal(result.collected, true, "消息路也是一次成功采集");
  assert.equal(result.messageDeliverable, true, "本轮走的是消息路 — 标记随观测上行");
  assert.deepEqual(result.files, [MESSAGE_DELIVERABLE_FILE], "消息物化成唯一交付物");
  assert.ok(existsSync(join(tree, MESSAGE_DELIVERABLE_FILE)), "正文落在树内 outbox 链");

  const seal = readOutboxSeal(tree);
  assert.ok(seal, "消息交付同样封包 — 封条是终局凭据,不分两面");
  assert.equal(seal.primary, MESSAGE_DELIVERABLE_FILE);
  assert.equal(seal.messageDeliverable, true);

  const { terminalStatus } = await resolveTerminalOutcome({
    trackingState: { contract },
    contractData: contract,
    executionObservation: result,
    logger,
  });
  assert.equal(terminalStatus, CONTRACT_STATUS.COMPLETED, "纯对话交付不再是 missing_file");
});

test("②文件在场 → 文件优先,正文不物化成第二份产物", async () => {
  const { agentId, outboxDir, cid, tree } = await setupRound("withfile");
  await writeFile(join(outboxDir, "report.md"), "# 真交付\n完整成果\n", "utf8");

  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: ["report.md"],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:r1`,
    messageText: REPLY,
  });

  assert.deepEqual(result.files, ["report.md"], "文件路原样,消息不并列");
  assert.equal(result.messageDeliverable, undefined);
  assert.equal(existsSync(join(tree, MESSAGE_DELIVERABLE_FILE)), false, "有文件轮零物化");
  assert.equal(readOutboxSeal(tree)?.primary, "report.md");
});

test("③崩溃轮不物化 —— 半截轮的正文不是交付", async () => {
  const { agentId, outboxDir, cid, tree } = await setupRound("crash");

  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: [],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:r1`,
    turnSucceeded: false,
    messageText: REPLY,
  });

  assert.equal(result.messageDeliverable, undefined);
  assert.equal(existsSync(join(tree, MESSAGE_DELIVERABLE_FILE)), false);
  assert.equal(readOutboxSeal(tree), null, "崩溃轮照旧零封条");
});

test("④无合约轮不物化 —— 消息面只服务合约交付", async () => {
  const { agentId, outboxDir, tree } = await setupRound("nocontract");

  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: [],
    logger,
    boundContractId: null,
    sessionKey: `agent:${agentId}:r1`,
    messageText: REPLY,
  });

  assert.equal(result.messageDeliverable, undefined);
  assert.equal(existsSync(join(tree, MESSAGE_DELIVERABLE_FILE)), false);
});

test("⑤声明了 requiredFiles 的合约只回消息 → 仍判 failed(消息不顶替声明的文件产出)", async () => {
  const missingPath = join(sandbox, "declared-but-never-written.md");
  const { agentId, outboxDir, cid, contract } = await setupRound("declared", {
    completionCriteria: { requiredFiles: [missingPath] },
  });

  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: [],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:r1`,
    messageText: REPLY,
  });
  assert.equal(result.messageDeliverable, true, "物化照做 — 拦截发生在判决面而非采集面");

  const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
    trackingState: { contract },
    contractData: contract,
    executionObservation: result,
    logger,
  });
  assert.equal(terminalStatus, CONTRACT_STATUS.FAILED, "声明的文件缺席,消息救不了它");
  assert.equal(terminalOutcome.source, "expectation_check");
});

test("⑥空白正文不物化(空消息不是交付)", async () => {
  const { agentId, outboxDir, cid, tree } = await setupRound("blank");

  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: [],
    logger,
    boundContractId: cid,
    sessionKey: `agent:${agentId}:r1`,
    messageText: "   \n  ",
  });

  assert.equal(result.messageDeliverable, undefined);
  assert.equal(existsSync(join(tree, MESSAGE_DELIVERABLE_FILE)), false);
});

test("⑦extractFinalAssistantText 倒序取最后一段正文,纯 toolCall 尾轮继续前找", () => {
  assert.equal(extractFinalAssistantText([
    { message: { role: "user", content: [{ type: "text", text: "问题" }] } },
    { message: { role: "assistant", content: [{ type: "text", text: "早先的话" }] } },
    { message: { role: "assistant", content: [{ type: "thinking", thinking: "内心戏" }, { type: "text", text: "最终答复" }] } },
  ]), "最终答复");

  // 尾消息是纯工具调用(无正文)→ 继续向前找最后一段说给人听的话
  assert.equal(extractFinalAssistantText([
    { message: { role: "assistant", content: [{ type: "text", text: "答复正文" }] } },
    { message: { role: "toolResult", toolName: "write", content: [{ type: "text", text: "写好了" }] } },
    { message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: {} }] } },
  ]), "答复正文");

  assert.equal(extractFinalAssistantText([{ message: { role: "assistant", content: "裸字符串正文" } }]), "裸字符串正文");
  assert.equal(extractFinalAssistantText([]), "");
  assert.equal(extractFinalAssistantText(null), "");
  assert.equal(extractFinalAssistantText([{ message: { role: "user", content: [{ type: "text", text: "只有用户说话" }] } }]), "");
});

// ⑧流程就绪门(2026-08-18 回归锁,live 实证 TC-…495631):合约轮里 agent 从未成功读到
// 自己的 inbox/contract.json(信封 TOCTOU 缺席)时,它根本不知道任务是什么,收官正文
// 是"我干不了这活"的受阻说明 —— 物化它会把失败说明封成合格交付物判成 completed
// (假成功比假失败更危险:坏结果会顺传送带流到下游)。判据取平台自证的流程事实
// (ownInboxContractReadAt = before-tool-call 1b 闸同一真值),不看正文长相。
test("⑧未读合约的轮次不进消息路 —— 受阻说明不得封成交付物(假成功回归锁)", () => {
  const blockedReply = [{
    message: { role: "assistant", content: [{ type: "text", text: "Cannot continue contract: inbox/contract.json is missing." }] },
  }];

  // 合约轮 + 从未读到信封 → 正文无资格进消息路
  assert.equal(resolveMessageDeliverableText({
    event: { messages: blockedReply },
    trackingState: { contract: { id: "TC-blocked" } },
  }), null);

  // 合约轮 + 成功读过信封 → 正常交付
  assert.equal(resolveMessageDeliverableText({
    event: { messages: [{ message: { role: "assistant", content: [{ type: "text", text: "答案是 42。" }] } }] },
    trackingState: { contract: { id: "TC-ok" }, ownInboxContractReadAt: Date.now() },
  }), "答案是 42。");

  // 非合约轮无此前提(与 1b 闸放行条件对称)
  assert.equal(resolveMessageDeliverableText({
    event: { messages: [{ message: { role: "assistant", content: [{ type: "text", text: "闲聊回复" }] } }] },
    trackingState: {},
  }), "闲聊回复");
});
