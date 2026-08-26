// Tests: 批②审查修缮的两道行为门(2026-08-14)。
//   ①GC 关账门(审查②):事件账仍有 open 合约的 run,超龄超额也绝不整删——
//     旧版 TERMINAL_STATUSES 门的树店形态,mtime 只是近似不是终态证明。
//   ②孤儿事件门(审查④):running 合约若账上从无 turn_started/claimed = 排队未
//     开跑的信封,boot 扫描不得误杀(不置 failed/不落假 closed)。
//
// Run: node --test --experimental-test-module-mocks tests/run-gc-gates.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveThreadsRoot, runDirFor, ensureRunScaffold, recordContractHome } from "../lib/archive/thread-tree-store.js";
import { appendRunEvent, flushRunEvents } from "../lib/archive/run-event-recorder.js";
import { pruneTerminalContracts, recoverOrphanedContracts } from "../lib/lifecycle/crash-recovery.js";

const silentLogger = { info() {}, warn() {}, error() {} };
const FUTURE = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 天后:一切 run 都超龄

async function seedRun(threadId, runId, { contractId = null, closed = false } = {}) {
  const lineage = { threadId, runId };
  await ensureRunScaffold(lineage);
  if (contractId) {
    await appendRunEvent({ lineage, type: "contract_created", contractId, payload: {} });
    if (closed) {
      await appendRunEvent({ lineage, type: "closed", contractId, payload: { terminalStatus: "completed" } });
    }
    await flushRunEvents(lineage);
  }
  return lineage;
}

test("GC 关账门:账上有 open 合约的超龄 run 不删,已关账的删", async () => {
  const threadId = `t-gcgate${Date.now().toString(36)}`;
  // 22 个已关账 run(超出 20 上限)+ 1 个未关账 run
  for (let i = 0; i < 22; i++) {
    await seedRun(threadId, `r-100${String(i).padStart(2, "0")}-closed${i}`, {
      contractId: `TC-GCGATE-C${i}`, closed: true,
    });
  }
  const openLineage = await seedRun(threadId, "r-10099-openrun", { contractId: "TC-GCGATE-OPEN", closed: false });

  await pruneTerminalContracts({ logger: silentLogger, now: FUTURE });

  assert.equal(
    existsSync(runDirFor(openLineage)),
    true,
    "事件账仍有 open 合约的 run 被整删=审查②回归(合约+事件账一起蒸发)",
  );
  // 已关账的超额 run 至少删掉了一部分(保留窗=20,23 个 run 至少剪 3 个候选中的关账者)
  const runsDir = join(resolveThreadsRoot(), threadId, "runs");
  const { readdir } = await import("node:fs/promises");
  const left = await readdir(runsDir);
  assert.ok(left.length < 23, "关账超额 run 应被 GC 剪除");
});

test("孤儿事件门:从未开跑的排队信封不被 boot 扫描误杀;跑过的真孤儿照旧收口", async () => {
  const threadId = `t-orphan${Date.now().toString(36)}`;

  // A. 排队未开跑:running + 账上无 turn_started/claimed
  const queuedLineage = await seedRun(threadId, "r-20001-queued", { contractId: "DIRECT-ORPHAN-QUEUED", closed: false });
  const queuedDir = join(runDirFor(queuedLineage), "contracts");
  await mkdir(queuedDir, { recursive: true });
  const queuedPath = join(queuedDir, "DIRECT-ORPHAN-QUEUED.json");
  await writeFile(queuedPath, JSON.stringify({
    id: "DIRECT-ORPHAN-QUEUED", status: "running", task: "排队中", lineage: queuedLineage,
  }), "utf8");
  await recordContractHome("DIRECT-ORPHAN-QUEUED", queuedLineage);

  // B. 真孤儿:running + 账上有 turn_started
  const startedLineage = await seedRun(threadId, "r-20002-started", { contractId: "DIRECT-ORPHAN-STARTED", closed: false });
  await appendRunEvent({ lineage: startedLineage, type: "turn_started", contractId: "DIRECT-ORPHAN-STARTED", payload: {} });
  await flushRunEvents(startedLineage);
  const startedDir = join(runDirFor(startedLineage), "contracts");
  await mkdir(startedDir, { recursive: true });
  const startedPath = join(startedDir, "DIRECT-ORPHAN-STARTED.json");
  await writeFile(startedPath, JSON.stringify({
    id: "DIRECT-ORPHAN-STARTED", status: "running", task: "跑到一半", lineage: startedLineage,
  }), "utf8");
  await recordContractHome("DIRECT-ORPHAN-STARTED", startedLineage);

  await recoverOrphanedContracts({ logger: silentLogger });

  const queued = JSON.parse(await readFile(queuedPath, "utf8"));
  assert.equal(queued.status, "running", "排队未开跑的信封被误杀=审查④回归(假失败通知+假 closed)");

  const started = JSON.parse(await readFile(startedPath, "utf8"));
  assert.equal(started.status, "failed", "跑过的真孤儿必须照旧收口为 failed");
});
