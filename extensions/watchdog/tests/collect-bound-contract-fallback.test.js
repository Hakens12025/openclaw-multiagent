// Tests: 采集侧"文件在场≠真值"回退(live 假失败防线)。
//   清道夫(hooks/after-tool-call.js)会在 agent 读过 inbox/contract.json 的 10 秒后删文件,
//   turn 长于该窗口时采集读不到信封 → 无 activeContract → 本轮归属缺席。
//   修法:agent_end 把绑定合约 id 传进采集链,inbox 文件缺席时按 id 回读共享正本。
//   树模式下归属正确的可观察结果 = 树 outbox 封包(seal.json)带绑定合约 id,
//   产物正本留在树内、零 contract.output 镜像(真目录回退轮才镜像)。
//
// Run: node --test tests/collect-bound-contract-fallback.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectWorkerOutbox } from "../lib/routing/mailbox/runtime-mailbox-outbox-handlers.js";
import { bindParticipantOutbox } from "../lib/routing/mailbox/runtime-mailbox.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { resolvePhysicalWorkspacePath } from "../lib/state/state-agent-helpers.js";

const logger = { info() {}, warn() {}, error() {} };
// 沙箱工作区(真值域同域纪律:种子树根配 tmp 工作区,切链才被 bind 放行;
// 真 workspaces 目录留给 live,测试零触碰)
const sandbox = mkdtempSync(join(tmpdir(), "collect-bound-fallback-"));

function agentWorkspace(agentId) {
  return join(sandbox, "workspaces", agentId);
}

function registerSandboxAgent(agentId) {
  registerRuntimeAgents({
    agents: {
      list: [{ id: agentId, role: "executor", workspace: agentWorkspace(agentId), model: { primary: "demo/worker" } }],
    },
  });
}

// staging 同款:正本落树 → outbox 切链到树 outbox 目录(bind 是 routeInbox 的原语)。
async function seedBoundTreeOutbox({ agentId, contractId, contract }) {
  registerSandboxAgent(agentId);
  await persistContractById(contract, logger);
  const bind = await bindParticipantOutbox({
    agentId,
    workspace: agentWorkspace(agentId),
    contractId,
    logger,
  });
  assert.equal(bind.linked, true, "谱系合约轮 staging 必须切链成功");
  // 采集登记物理路径(/var → /private/var 等 realpath 形态),比较基准同型
  return resolvePhysicalWorkspacePath(bind.treeOutboxDir);
}

test("inbox 信封被清道夫删走后,采集凭 boundContractId 回读正本并封包归属", async () => {
  const agentId = `worker-swept-${Date.now()}`;
  const contractId = `TC-SWEPT-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const mirrorPath = join(agentWorkspace(agentId), "mirror-target", `${contractId}.md`);

  try {
    // 正本落树(含 output/createdAt) + outbox 切链;inbox 不写 contract.json = 清道夫已删的现场
    const treeOutboxDir = await seedBoundTreeOutbox({
      agentId,
      contractId,
      contract: {
        id: contractId,
        task: "生成简报",
        assignee: agentId,
        status: "running",
        createdAt: Date.now() - 1000,
        output: mirrorPath,
        lineage: { threadId: "t-collectfb", runId: `r-${Date.now()}-cfb` },
      },
    });
    await writeFile(join(outboxDir, "brief.md"), "# 简报\n内容\n", "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["brief.md"],
      logger,
      boundContractId: contractId,
    });

    assert.equal(result.collected, true, "无 inbox 信封但有绑定 id,采集必须成功");
    assert.equal(
      result.primaryOutputPath,
      join(treeOutboxDir, "brief.md"),
      "树模式产物路径必须指向树内正本",
    );
    assert.equal(existsSync(join(treeOutboxDir, "brief.md")), true, "树内正本不得被采集删除");
    const seal = JSON.parse(await readFile(join(treeOutboxDir, "seal.json"), "utf8"));
    assert.equal(seal.contractId, contractId, "封包归属必须是绑定合约 id — 缺席即归属假失败回归");
    assert.equal(seal.primary, "brief.md");
    assert.equal(existsSync(mirrorPath), false, "树模式零镜像:contract.output 地址保持空置");
  } finally {
    await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
  }
});

test("inbox 占位者与绑定 id 错配(判决信封顶替上位)→ 采集按绑定正本归属,不误认占位者", async () => {
  const agentId = `worker-mismatch-${Date.now()}`;
  const contractId = `TC-MISMATCH-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const inboxDir = join(agentWorkspace(agentId), "inbox");

  try {
    const treeOutboxDir = await seedBoundTreeOutbox({
      agentId,
      contractId,
      contract: {
        id: contractId,
        task: "生成简报",
        assignee: agentId,
        status: "running",
        createdAt: Date.now() - 1000,
        output: join(agentWorkspace(agentId), "mirror-target", `${contractId}.md`),
        lineage: { threadId: "t-collectmm", runId: `r-${Date.now()}-cmm` },
      },
    });
    // 清道夫删旧信封后,判决 direct 信封顶替占住 inbox —— 与本轮绑定合约无关
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify({
      id: `DIRECT-INTRUDER-${Date.now()}`,
      task: "评审判决回投",
      status: "running",
    }, null, 2), "utf8");
    await writeFile(join(outboxDir, "brief.md"), "# 简报\n内容\n", "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["brief.md"],
      logger,
      boundContractId: contractId,
    });

    assert.equal(result.collected, true);
    const seal = JSON.parse(await readFile(join(treeOutboxDir, "seal.json"), "utf8"));
    assert.equal(
      seal.contractId,
      contractId,
      "占位者错配时封包归属必须回退绑定正本 — 误认占位者即 A 类假失败换门复发",
    );
  } finally {
    await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
  }
});

test("绑定正本已终态(外部判决)→ 迟到采集不封包不掏空树", async () => {
  const agentId = `worker-lateterm-${Date.now()}`;
  const contractId = `TC-LATETERM-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const mirrorPath = join(agentWorkspace(agentId), "mirror-target", `${contractId}.md`);

  try {
    const treeOutboxDir = await seedBoundTreeOutbox({
      agentId,
      contractId,
      contract: {
        id: contractId,
        task: "生成简报",
        assignee: agentId,
        status: "failed",
        createdAt: Date.now() - 1000,
        output: mirrorPath,
        lineage: { threadId: "t-collectlt", runId: `r-${Date.now()}-clt` },
      },
    });
    await writeFile(join(outboxDir, "brief.md"), "# 迟到产物\n", "utf8");

    await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["brief.md"],
      logger,
      boundContractId: contractId,
    });

    assert.equal(
      existsSync(mirrorPath),
      false,
      "已判决合约的产物证据不可变 — 迟到采集镜像覆写即审查案①回归",
    );
    assert.equal(
      existsSync(join(treeOutboxDir, "seal.json")),
      false,
      "终态轮迟到采集不得封包(封包会把迟到产物记成本轮交付)",
    );
    assert.equal(
      existsSync(join(treeOutboxDir, "brief.md")),
      true,
      "树链下的迟到采集不得删树内文件 — 删源即『采集掏空树』回归",
    );
    const outboxStat = await lstat(outboxDir);
    assert.equal(outboxStat.isSymbolicLink(), true, "采集不动 outbox 链本体");
  } finally {
    await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
  }
});
