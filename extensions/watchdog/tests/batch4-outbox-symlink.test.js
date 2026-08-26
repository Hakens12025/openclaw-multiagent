// tests/batch4-outbox-symlink.test.js — outbox 树链行为锁(staging 切链/树模式采集/
// seal 封包/交付判定树序)。
//   ①staging 切链:真目录空→链;非空→条目迁树后链;旧链重指;幂等;无谱系回退真目录。
//   ②树模式采集:零拷贝零删源零 contract.output 镜像 + seal 写成 + artifactPaths 指树。
//   ③seal 幂等:二次采集短路回放,封条不重写。
//   ④deliverable 判定读序:seal.primary 达标 > 观测 primaryPath > contract.output 回退 > missing_file。
//
// Run: node --test tests/batch4-outbox-symlink.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { bindParticipantOutbox } from "../lib/routing/mailbox/runtime-mailbox.js";
import { collectWorkerOutbox } from "../lib/routing/mailbox/runtime-mailbox-outbox-handlers.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { participantOutboxDirFor } from "../lib/archive/thread-tree-store.js";
import { readOutboxSeal } from "../lib/archive/outbox-seal.js";
import { resolvePhysicalWorkspacePath } from "../lib/state/state-agent-helpers.js";
import { resolveTerminalOutcome } from "../lib/contract/terminal-outcome.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const logger = { info() {}, warn() {}, error() {} };
const sandbox = mkdtempSync(join(tmpdir(), "batch4-outbox-symlink-"));

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
async function seedContract({ agentId, contractId, status = "running", output = null }) {
  seq += 1;
  const contract = {
    id: contractId,
    task: "树链行为锁",
    assignee: agentId,
    status,
    createdAt: Date.now() - 1000,
    ...(output ? { output } : {}),
    lineage: { threadId: "t-b4os", runId: `r-${Date.now()}-${seq}` },
  };
  await persistContractById(contract, logger);
  return contract;
}

test("①staging 切链:空真目录切链 / 非空迁移入树 / 旧链重指 / 幂等 / 无谱系回退真目录", async () => {
  const agentId = "b4os-bind-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");

  // 空真目录 → 链,目标 = 树 outbox 目录(绝对路径)
  const c1 = await seedContract({ agentId, contractId: "TC-B4OS-BIND1" });
  await mkdir(outboxDir, { recursive: true });
  const bind1 = await bindParticipantOutbox({ agentId, workspace: ws, contractId: c1.id, logger });
  const tree1 = participantOutboxDirFor(c1.lineage, agentId, c1.id);
  assert.equal(bind1.linked, true);
  assert.equal(bind1.treeOutboxDir, tree1);
  assert.equal((await lstat(outboxDir)).isSymbolicLink(), true, "outbox 本体应为链");
  assert.equal(await readlink(outboxDir), tree1, "树链规范 = 绝对路径目标");

  // 幂等:同合约重 bind,链不动
  const bindAgain = await bindParticipantOutbox({ agentId, workspace: ws, contractId: c1.id, logger });
  assert.equal(bindAgain.idempotent, true, "已指向正确目标的链原样保留");

  // 旧链重指:换下一份合约,链目标切到新树目录
  const c2 = await seedContract({ agentId, contractId: "TC-B4OS-BIND2" });
  const bind2 = await bindParticipantOutbox({ agentId, workspace: ws, contractId: c2.id, logger });
  const tree2 = participantOutboxDirFor(c2.lineage, agentId, c2.id);
  assert.equal(bind2.linked, true);
  assert.equal(await readlink(outboxDir), tree2, "旧合约链应重指新合约树目录");
  assert.equal(existsSync(tree1), true, "上一份合约的树目录原封不动");

  // 中场摘链守卫:链目标合约仍活跃(running)时,无谱系 staging 留链不摘
  const bindMidflight = await bindParticipantOutbox({ agentId, workspace: ws, contractId: null, logger });
  assert.equal(bindMidflight.linked, false);
  assert.equal(bindMidflight.reason, "active_contract_link_kept", "活跃合约的链在中场保持在位");
  assert.equal((await lstat(outboxDir)).isSymbolicLink(), true, "活跃合约轮进行中 outbox 链保持在位");

  // 无谱系(直达信封等非合约轮)+ 链目标合约已终态 → 摘链恢复真目录
  await persistContractById({ ...c2, status: "completed" }, logger);
  const bindNone = await bindParticipantOutbox({ agentId, workspace: ws, contractId: null, logger });
  assert.equal(bindNone.linked, false);
  const restoredStat = await lstat(outboxDir);
  assert.equal(restoredStat.isSymbolicLink(), false, "非合约轮 outbox 应为真目录");
  assert.equal(restoredStat.isDirectory(), true);

  // 非空真目录 → 条目迁进树目录 .migrated/ 隔离区再切链(staging 时刻在场的
  // 都是前轮残件,直迁 outbox 根会被封为本轮 primary=假完成)
  await writeFile(join(outboxDir, "leftover.md"), "残余", "utf8");
  await mkdir(join(outboxDir, ".stale"), { recursive: true });
  await writeFile(join(outboxDir, ".stale", "old.md"), "隔离残件", "utf8");
  const c3 = await seedContract({ agentId, contractId: "TC-B4OS-BIND3" });
  const bind3 = await bindParticipantOutbox({ agentId, workspace: ws, contractId: c3.id, logger });
  const tree3 = participantOutboxDirFor(c3.lineage, agentId, c3.id);
  assert.equal(bind3.linked, true);
  assert.equal((await lstat(outboxDir)).isSymbolicLink(), true);
  assert.equal(existsSync(join(tree3, "leftover.md")), false, "残件与树 outbox 根隔离");
  assert.equal(await readFile(join(tree3, ".migrated", "leftover.md"), "utf8"), "残余", "真目录条目应迁入 .migrated/ 隔离区");
  assert.equal(await readFile(join(tree3, ".migrated", ".stale", "old.md"), "utf8"), "隔离残件", "嵌套目录整体迁入隔离区");
});

test("②树模式采集:零拷贝零删源零镜像 + seal 写成 + artifactPaths 指树", async () => {
  const agentId = "b4os-collect-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  const outboxDir = join(ws, "outbox");
  const contractId = `TC-B4OS-COLLECT-${Date.now()}`;
  const mirrorPath = join(ws, "mirror", `${contractId}.md`);
  const artifactName = `b4os-artifact-${Date.now()}.md`;

  const contract = await seedContract({ agentId, contractId, output: mirrorPath });
  const bind = await bindParticipantOutbox({ agentId, workspace: ws, contractId, logger });
  assert.equal(bind.linked, true);
  // 采集登记的是物理路径(/var → /private/var 等 realpath 形态),比较基准同型
  const treeOutboxDir = resolvePhysicalWorkspacePath(bind.treeOutboxDir);

  // agent 视角:写 workspace outbox 相对路径,物理直落树内
  await writeFile(join(outboxDir, artifactName), "# 树内正本\n交付内容\n", "utf8");
  await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
    version: 1,
    status: "completed",
    summary: "done in tree",
    primaryArtifactPath: artifactName,
  }), "utf8");

  const sessionKey = `agent:${agentId}:b4os:${Date.now()}`;
  const result = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: ["runtime_result.json", artifactName],
    logger,
    boundContractId: contractId,
    sessionKey,
  });

  assert.equal(result.collected, true);
  assert.equal(result.explicitRuntimeResult, true);
  assert.equal(result.primaryOutputPath, join(treeOutboxDir, artifactName), "primary 必须指树内物理路径");
  assert.ok(result.artifactPaths.every((p) => p.startsWith(treeOutboxDir)), "全部产物路径指树");
  assert.equal(existsSync(join(treeOutboxDir, artifactName)), true, "零删源:树内正本在场");
  assert.equal(existsSync(join(treeOutboxDir, "runtime_result.json")), true, "声明文件随 run 归档,不删");
  assert.equal(existsSync(mirrorPath), false, "零镜像:contract.output 地址空置");
  assert.equal(
    existsSync(join(CONTROL_PLANE_PATHS.outputDir, artifactName)),
    false,
    "零拷贝:control-plane/output 无副本",
  );
  assert.equal(existsSync(join(treeOutboxDir, ".stale")), false, "树模式免 .stale 新鲜度隔离");

  const seal = readOutboxSeal(treeOutboxDir);
  assert.ok(seal, "采集成功当刻必须封包");
  assert.equal(seal.contractId, contractId);
  assert.equal(seal.sessionKey, sessionKey);
  assert.equal(seal.primary, artifactName);
  assert.deepEqual(seal.files, [artifactName]);
  assert.equal(seal.declaredStatus, "completed");

  // ③seal 幂等:同合约同会话的二次采集短路回放,封条不重写。
  // (同合约异会话 = 回投/loop 新轮,以新轮采集为准重封 —— 那条语义的锁在
  // batch4-seal-semantics.test.js ⑥。)
  const sealBefore = JSON.stringify(seal);
  const replay = await collectWorkerOutbox({
    agentId,
    outboxDir,
    files: ["runtime_result.json", artifactName, "seal.json"],
    logger,
    boundContractId: contractId,
    sessionKey,
  });
  assert.equal(replay.collected, true);
  assert.equal(replay.sealed, true, "封条在场的采集必须短路幂等");
  assert.equal(replay.primaryOutputPath, join(treeOutboxDir, artifactName));
  assert.equal(JSON.stringify(readOutboxSeal(treeOutboxDir)), sealBefore, "封条内容不得被二次采集改写");

  // ④a. deliverable 判定树序:seal.primary 在场且非空 → 达标(contract.output 缺席不碍事)
  const outcome = await resolveTerminalOutcome({
    trackingState: { contract },
    contractData: contract,
    executionObservation: { collected: true },
    logger,
  });
  assert.equal(outcome.terminalStatus, CONTRACT_STATUS.COMPLETED, "seal.primary 即交付达标");
  assert.equal(
    resolvePhysicalWorkspacePath(outcome.terminalOutcome.artifact),
    join(treeOutboxDir, artifactName),
    "交付凭据应指树 outbox 封包 primary(物理同一文件)",
  );

  await rm(ws, { recursive: true, force: true }).catch(() => {});
});

test("④b/c. deliverable 回退序:缺 seal 回退 contract.output;都缺 missing_file 照旧", async () => {
  const agentId = "b4os-outcome-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  await mkdir(ws, { recursive: true });

  // b. 无封包 + contract.output 在场(直写链路)→ completed
  const directId = `TC-B4OS-DIRECT-${Date.now()}`;
  const directOutput = join(ws, `${directId}.md`);
  await writeFile(directOutput, "直写链路交付物\n", "utf8");
  const directContract = await seedContract({ agentId, contractId: directId, output: directOutput });
  const directOutcome = await resolveTerminalOutcome({
    trackingState: { contract: directContract },
    contractData: directContract,
    executionObservation: { collected: false },
    logger,
  });
  assert.equal(directOutcome.terminalStatus, CONTRACT_STATUS.COMPLETED, "缺封包时 contract.output 回退仍达标");

  // c. 封包与落点都缺 → missing_file 照旧
  const missingId = `TC-B4OS-MISSING-${Date.now()}`;
  const missingContract = await seedContract({
    agentId,
    contractId: missingId,
    output: join(ws, `${missingId}.md`),
  });
  const missingOutcome = await resolveTerminalOutcome({
    trackingState: { contract: missingContract },
    contractData: missingContract,
    executionObservation: { collected: false },
    logger,
  });
  assert.equal(missingOutcome.terminalStatus, CONTRACT_STATUS.FAILED);
  assert.match(missingOutcome.terminalOutcome.reason, /missing_file/, "两级皆缺时保持 missing_file 语义");

  await rm(ws, { recursive: true, force: true }).catch(() => {});
});
