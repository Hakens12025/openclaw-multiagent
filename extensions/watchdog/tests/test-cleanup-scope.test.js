/**
 * test-cleanup-scope.test.js — 测试清理不得抹掉生产记录
 *
 * 2026-08-19 live 实测:354 个 run 的 contracts/ 目录**全是空的**。根因是
 * fullReset → cleanTestArtifacts 按 `TC-` / `DL-` / `REQ-` 前缀盲删全树合约正本,
 * 而生产合约 id 恰好也是 `TC-<ts>-<hex>` —— 每跑一次 live 预设,所有历史 run 的
 * 合约层被删光。记录面从此缺一层,而且没有任何断言会红。
 *
 * 清理真正要防的是**活跃残留**:boot 时 recoverOrphanedContracts 扫全树补关
 * running 孤儿,上一轮跑剩的活跃合约会污染它。终态合约不在这个风险里,它们是
 * 那个 run 的记录,该随 run 的 30 天 TTL 走。
 *
 * 这个文件锁的就是这条边界:活跃的清掉、终态的留下。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { cleanTreeContractLeftovers } from "../lib/formal-runtime/infra.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { resolveSharedContractPathById } from "../lib/store/contract-store.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

const logger = { info() {}, warn() {}, error() {} };

async function seed(id, status, seq) {
  const contract = {
    id,
    task: "清理边界锁",
    assignee: "cleanup-scope-probe",
    status,
    createdAt: Date.now() - 1000,
    lineage: { threadId: "t-cleanup-scope", runId: `r-cleanup-${seq}` },
  };
  await persistContractById(contract, logger);
  return resolveSharedContractPathById(id);
}

test("树店清扫:清活跃残留,留终态合约(它们是 run 的记录)", async () => {
  const stamp = Date.now();
  const completedId = `TC-${stamp}-cleanupdone`;
  const failedId = `TC-${stamp}-cleanupfail`;
  const runningId = `TC-${stamp}-cleanuprun`;
  const pendingId = `TC-${stamp}-cleanupwait`;

  const completedPath = await seed(completedId, CONTRACT_STATUS.COMPLETED, 1);
  const failedPath = await seed(failedId, CONTRACT_STATUS.FAILED, 2);
  const runningPath = await seed(runningId, CONTRACT_STATUS.RUNNING, 3);
  const pendingPath = await seed(pendingId, CONTRACT_STATUS.PENDING, 4);

  for (const [label, p] of [["completed", completedPath], ["failed", failedPath],
    ["running", runningPath], ["pending", pendingPath]]) {
    assert.ok(p && existsSync(p), `前置:${label} 合约应已落树 (${p})`);
  }

  const stats = await cleanTreeContractLeftovers();

  // 终态 = run 的记录,清理不得碰。这两条一红就说明历史 run 又被抹平了。
  assert.equal(existsSync(completedPath), true, "completed 合约是 run 的记录,清理不得删");
  assert.equal(existsSync(failedPath), true, "failed 合约同样是记录,清理不得删");
  const kept = JSON.parse(await readFile(completedPath, "utf8"));
  assert.equal(kept.id, completedId, "留下的必须是原样正本,不是残壳");

  // 活跃 = 下一轮 boot 会被当孤儿补关的污染源,必须清。
  assert.equal(existsSync(runningPath), false, "running 残留会污染 boot 孤儿补关,应清");
  assert.equal(existsSync(pendingPath), false, "pending 残留同理,应清");
  assert.ok(stats.removed >= 2, `清掉的活跃残留应至少含本例两份,实得 ${stats.removed}`);
  assert.ok(stats.kept >= 2, `留下的终态合约应至少含本例两份,实得 ${stats.kept}`);
});

// 同一个病的第二处发作:/watchdog/reset 端点自己也删合约,而且跑在 cleanTestArtifacts
// **之前**。只修后者的话,reset 先把合约清空,清理日志会显示 "kept 0" —— 看起来像修好了,
// 实际记录照丢(2026-08-19 live 实测就是这么被骗过一次的)。
test("runtime reset:清活跃合约,终态合约作为 run 记录留下", async () => {
  const stamp = Date.now();
  const doneId = `TC-${stamp}-resetdone`;
  const runId = `TC-${stamp}-resetrun`;
  const donePath = await seed(doneId, CONTRACT_STATUS.COMPLETED, 11);
  const runPath = await seed(runId, CONTRACT_STATUS.RUNNING, 12);
  assert.ok(existsSync(donePath) && existsSync(runPath), "前置:两份合约都已落树");

  const { resetRuntimeState } = await import("../lib/admin/runtime-admin.js");
  await resetRuntimeState({ logger, resetSessionAgents: [] });

  assert.equal(existsSync(donePath), true, "终态合约是 run 的记录,reset 不得删");
  assert.equal(existsSync(runPath), false, "running 合约是运行时状态,reset 应清");
});
