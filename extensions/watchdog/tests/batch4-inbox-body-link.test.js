// Tests: inbox 本体链守卫(批④刀2审查修缮锁,2026-08-16)。
//   inbox 本体的设计态恒为真目录;本体出现 dir-level 链时,cleanInbox 的 readdir 会
//   跟链进树逐文件删穿正本、直达队列 reset 的 rm 会经链删树内文件——两处都必须
//   "摘链本体+恢复真目录,树内内容原封"。
//
// Run: node --test tests/batch4-inbox-body-link.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { cleanInbox } from "../lib/routing/mailbox/runtime-mailbox-transport.js";
import { clearRuntimeDirectEnvelopeStores } from "../lib/routing/runtime-direct-envelope-queue.js";

const logger = { info() {}, warn() {}, error() {} };
const tempRoots = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

function setupLinkedInbox(prefix, agentId) {
  const ws = makeTempDir(`${prefix}ws-`);
  const treeDir = makeTempDir(`${prefix}tree-`);
  writeFileSync(join(treeDir, "contract.json"), JSON.stringify({ id: "TC-TREE-CANON" }), "utf8");
  writeFileSync(join(treeDir, "note.md"), "canonical\n", "utf8");
  symlinkSync(treeDir, join(ws, "inbox")); // 非设计态:本体 dir-level 链
  registerRuntimeAgents({
    agents: { list: [{ id: agentId, role: "executor", workspace: ws, model: { primary: "demo/worker" } }] },
  });
  return { ws, treeDir };
}

test("cleanInbox:inbox 本体链 → 摘链恢复真目录,树内正本原封不动", async () => {
  const agentId = "worker-bodylink-clean";
  const { ws, treeDir } = setupLinkedInbox("bodylink-clean-", agentId);

  await cleanInbox(agentId, logger, {});

  assert.equal(lstatSync(join(ws, "inbox")).isSymbolicLink(), false, "本体链必须被摘除");
  assert.equal(lstatSync(join(ws, "inbox")).isDirectory(), true, "必须恢复真目录");
  assert.equal(existsSync(join(treeDir, "contract.json")), true, "树内正本被删穿=审查案①回归");
  assert.equal(existsSync(join(treeDir, "note.md")), true, "树内正本被删穿=审查案①回归");
});

test("clearRuntimeDirectEnvelopeStores:inbox 本体链 → 摘链恢复真目录,树内文件不被 rm", async () => {
  const agentId = "worker-bodylink-reset";
  const { ws, treeDir } = setupLinkedInbox("bodylink-reset-", agentId);
  mkdirSync(join(treeDir, ".runtime-direct-envelope-queue"), { recursive: true });
  writeFileSync(join(treeDir, ".runtime-direct-envelope-queue", "contract-1-1-X.json"), "{}", "utf8");

  await clearRuntimeDirectEnvelopeStores([agentId], { logger });

  assert.equal(lstatSync(join(ws, "inbox")).isSymbolicLink(), false, "本体链必须被摘除");
  assert.equal(existsSync(join(treeDir, "contract.json")), true, "树内 contract.json 被 rm=审查案②回归");
  assert.equal(
    existsSync(join(treeDir, ".runtime-direct-envelope-queue", "contract-1-1-X.json")),
    true,
    "树内队列目录被 rm=审查案②回归",
  );
});

test("inbox 快照撞悬链:悬挂条目跳过,健在条目物化,不整体中断", async () => {
  const { snapshotInboxToRunTree } = await import("../lib/lifecycle/run-tree-snapshot.js");
  const { symlinkSync, readFileSync } = await import("node:fs");
  const agentId = "worker-danglingsnap";
  const ws = makeTempDir("danglingsnap-ws-");
  registerRuntimeAgents({
    agents: { list: [{ id: agentId, role: "executor", workspace: ws, model: { primary: "demo/worker" } }] },
  });
  const inboxDir = join(ws, "inbox");
  mkdirSync(join(inboxDir, "upstream"), { recursive: true });
  writeFileSync(join(inboxDir, "contract.json"), JSON.stringify({ id: "TC-DSNAP" }), "utf8");
  const healthyTarget = makeTempDir("danglingsnap-healthy-");
  writeFileSync(join(healthyTarget, "brief.md"), "content\n", "utf8");
  symlinkSync(healthyTarget, join(inboxDir, "upstream", "healthy"));
  symlinkSync(join(ws, "gone-target"), join(inboxDir, "upstream", "dangling")); // 悬链

  const lineage = { threadId: "t-dsnap", runId: "r-1-dsnap" };
  const result = await snapshotInboxToRunTree({ lineage, contractId: "TC-DSNAP", agentId, inboxDir });

  assert.equal(result.snapshotted, true, "悬链在场不得让快照整体中断");
  const snapDir = result.dest;
  assert.equal(existsSync(join(snapDir, "contract.json")), true);
  assert.equal(
    readFileSync(join(snapDir, "upstream", "healthy", "brief.md"), "utf8"),
    "content\n",
    "健在链必须物化为自足内容",
  );
  assert.equal(existsSync(join(snapDir, "upstream", "dangling")), false, "悬挂条目跳过不入快照");
});
