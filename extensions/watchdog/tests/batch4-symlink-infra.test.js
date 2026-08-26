// tests/batch4-symlink-infra.test.js — 批④刀2 行为锁(symlink 基建,真目录期全 no-op)。
//   ①GC 摘链:待删 run 内目标的 workspace 链摘除+真目录恢复;树外链不动。
//   ②悬链自愈:ensureMailboxDirs/collectOutbox 遇悬链不炸并恢复真目录;健在链不动。
//   ③reset lstat 化:链下只摘链本体(树内文件原封);真目录照旧清内容。
//   ④preserve/restore 对链跳过:快照不进链,恢复不回灌链。
//
// Run: node --test tests/batch4-symlink-infra.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, readdir, readFile, lstat, rm, utimes } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import {
  runDirFor,
  ensureRunScaffold,
  participantOutboxDirFor,
  participantInboxSnapshotDirFor,
} from "../lib/archive/thread-tree-store.js";
import { appendRunEvent, flushRunEvents } from "../lib/archive/run-event-recorder.js";
import { pruneTerminalContracts } from "../lib/lifecycle/crash-recovery.js";
import { ensureMailboxDirs, healDanglingMailboxDir } from "../lib/routing/mailbox/runtime-mailbox-transport.js";
import { collectOutbox } from "../lib/routing/mailbox/runtime-mailbox.js";
import { clearMailboxDirSurface } from "../lib/admin/runtime-admin.js";
import { ensurePreservedWorkspaceSnapshot, restorePreservedWorkspaceState } from "../lib/formal-runtime/infra.js";

const silentLogger = { info() {}, warn() {}, error() {} };
const sandbox = mkdtempSync(join(tmpdir(), "batch4-symlink-"));
const FUTURE = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 天后:一切 run 超龄

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

async function seedClosedRun(threadId, runId, contractId) {
  const lineage = { threadId, runId };
  await ensureRunScaffold(lineage);
  await appendRunEvent({ lineage, type: "contract_created", contractId, payload: {} });
  await appendRunEvent({ lineage, type: "closed", contractId, payload: { terminalStatus: "completed" } });
  await flushRunEvents(lineage);
  return lineage;
}

test("①GC 摘链:指向待删 run 的 workspace 链摘除并恢复真目录,树外链不动", async () => {
  const agentId = "b4-gc-agent";
  registerSandboxAgents([agentId]);
  const threadId = `t-b4gc${Date.now().toString(36)}`;

  const victim = await seedClosedRun(threadId, "r-00001-victim", "TC-B4-VICTIM");
  const outboxCanon = participantOutboxDirFor(victim, agentId, "TC-B4-VICTIM");
  await mkdir(outboxCanon, { recursive: true });
  await writeFile(join(outboxCanon, "result.md"), "canon", "utf8");
  const inboxSnapCanon = participantInboxSnapshotDirFor(victim, agentId, "TC-B4-VICTIM");
  await mkdir(inboxSnapCanon, { recursive: true });
  // 受害 run 强制为最老(GC 候选按 dir mtime 排序,超出 20 上限的最老者出列)
  const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  await utimes(runDirFor(victim), oldDate, oldDate);

  let survivor = null;
  for (let i = 0; i < 20; i++) {
    survivor = await seedClosedRun(threadId, `r-1${String(i).padStart(4, "0")}-keep${i}`, `TC-B4-KEEP${i}`);
  }
  const outsideTarget = participantOutboxDirFor(survivor, agentId, "TC-B4-KEEP19");
  await mkdir(outsideTarget, { recursive: true });
  await writeFile(join(outsideTarget, "keep.md"), "keep", "utf8");

  const ws = wsFor(agentId);
  await mkdir(join(ws, "inbox", "upstream"), { recursive: true });
  await symlink(outboxCanon, join(ws, "outbox"));
  await symlink(inboxSnapCanon, join(ws, "inbox", "upstream", "pkg"));
  await symlink(outsideTarget, join(ws, "inbox", "upstream", "other"));

  await pruneTerminalContracts({ logger: silentLogger, now: FUTURE });

  assert.equal(existsSync(runDirFor(victim)), false, "受害 run 应被 GC 整删");
  const outboxStat = await lstat(join(ws, "outbox"));
  assert.equal(outboxStat.isSymbolicLink(), false, "outbox 链应在 rm 前被摘除");
  assert.equal(outboxStat.isDirectory(), true, "outbox 应恢复为真目录");
  const pkgStat = await lstat(join(ws, "inbox", "upstream", "pkg"));
  assert.equal(pkgStat.isSymbolicLink(), false, "inbox/upstream 一层的树链同样摘除");
  assert.equal(pkgStat.isDirectory(), true, "upstream 链位应恢复为真目录");
  const otherStat = await lstat(join(ws, "inbox", "upstream", "other"));
  assert.equal(otherStat.isSymbolicLink(), true, "目标在待删目录外的链必须原封不动");
  assert.equal(await readFile(join(outsideTarget, "keep.md"), "utf8"), "keep", "树外链目标内容不受影响");
});

test("②悬链自愈:ensureMailboxDirs/collectOutbox 遇悬链不炸并恢复真目录;健在链不动", async () => {
  const agentId = "b4-heal-agent";
  registerSandboxAgents([agentId]);
  const ws = wsFor(agentId);
  await mkdir(ws, { recursive: true });
  await symlink(join(sandbox, "gone", "outbox-x"), join(ws, "outbox")); // 目标不存在=悬链

  await ensureMailboxDirs(silentLogger, []);
  const ensuredStat = await lstat(join(ws, "outbox"));
  assert.equal(ensuredStat.isSymbolicLink(), false, "ensureMailboxDirs 应摘悬链");
  assert.equal(ensuredStat.isDirectory(), true, "ensureMailboxDirs 应恢复真目录");

  await rm(join(ws, "outbox"), { recursive: true, force: true });
  await symlink(join(sandbox, "gone2", "outbox-y"), join(ws, "outbox"));
  const result = await collectOutbox(agentId, silentLogger);
  assert.equal(result.collected, false, "自愈后的空 outbox 照常返回未采集");
  const healedStat = await lstat(join(ws, "outbox"));
  assert.equal(healedStat.isSymbolicLink(), false, "collectOutbox 应摘悬链");
  assert.equal(healedStat.isDirectory(), true, "collectOutbox 应恢复真目录");

  const aliveTarget = join(sandbox, "alive-target");
  await mkdir(aliveTarget, { recursive: true });
  await rm(join(ws, "outbox"), { recursive: true, force: true });
  await symlink(aliveTarget, join(ws, "outbox"));
  assert.equal(await healDanglingMailboxDir(join(ws, "outbox"), silentLogger, agentId), false);
  assert.equal((await lstat(join(ws, "outbox"))).isSymbolicLink(), true, "目标健在的链必须原样保留");
});

test("③reset 清理面 lstat 化:链下只摘链本体(树内文件原封),真目录照旧清内容", async () => {
  const treeHome = join(sandbox, "reset", "tree-home");
  await mkdir(treeHome, { recursive: true });
  await writeFile(join(treeHome, "canon.md"), "canon", "utf8");
  const linkDir = join(sandbox, "reset", "outbox");
  await symlink(treeHome, linkDir);

  const linkResult = await clearMailboxDirSurface(linkDir);
  assert.equal(linkResult.unlinkedSymlink, true, "链分支应只摘链本体");
  assert.equal(linkResult.removedFiles, 0, "链分支绝不 readdir 进链逐文件删");
  const restoredStat = await lstat(linkDir);
  assert.equal(restoredStat.isSymbolicLink(), false, "链位应恢复真目录");
  assert.equal(restoredStat.isDirectory(), true, "链位应恢复真目录");
  assert.equal(await readFile(join(treeHome, "canon.md"), "utf8"), "canon", "树内正本必须原封不动");

  const realDir = join(sandbox, "reset", "inbox");
  await mkdir(realDir, { recursive: true });
  await writeFile(join(realDir, "a.md"), "a", "utf8");
  await writeFile(join(realDir, "b.md"), "b", "utf8");
  const realResult = await clearMailboxDirSurface(realDir);
  assert.equal(realResult.unlinkedSymlink, false);
  assert.equal(realResult.removedFiles, 2, "真目录照旧逐文件清");
  assert.deepEqual(await readdir(realDir), [], "真目录清空后保留目录本体");
});

test("④preserve/restore 对链跳过:快照不进链,恢复不回灌链,树内容不动", async () => {
  const realDir = join(sandbox, "preserve", "real-inbox");
  await mkdir(realDir, { recursive: true });
  await writeFile(join(realDir, "keep.md"), "keep", "utf8");

  const treeHome = join(sandbox, "preserve", "tree-home");
  await mkdir(treeHome, { recursive: true });
  await writeFile(join(treeHome, "canon.md"), "canon", "utf8");
  const linkDir = join(sandbox, "preserve", "link-outbox");
  await symlink(treeHome, linkDir);

  const snapshot = await ensurePreservedWorkspaceSnapshot({ dirs: [realDir, linkDir] });
  assert.equal(snapshot.entries.length, 1, "链目录不得进入快照");
  assert.equal(snapshot.entries[0].sourceDir, realDir);

  await writeFile(join(realDir, "dirty.md"), "dirty", "utf8"); // 会话期污染真目录
  await writeFile(join(treeHome, "grown.md"), "grown", "utf8"); // 树内正本继续生长

  await restorePreservedWorkspaceState({ dirs: [realDir, linkDir] });

  assert.deepEqual((await readdir(realDir)).sort(), ["keep.md"], "真目录恢复到快照态");
  assert.equal((await lstat(linkDir)).isSymbolicLink(), true, "链本体必须原样保留");
  assert.deepEqual((await readdir(treeHome)).sort(), ["canon.md", "grown.md"], "树内正本不被恢复面回灌或清除");
});
