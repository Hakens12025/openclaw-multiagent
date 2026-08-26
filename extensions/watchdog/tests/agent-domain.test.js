// tests/agent-domain.test.js — 域属主(lib/security/agent-domain.js)对全部挂载形态的判定。
// 测试重心迁移(备忘录157 §二动作4):挂载形态在这里测一次;守卫规则只测"问了域"。
// 形态:①真目录 ②邮箱软链进树(合约轮) ③上游链(只读别名) ④缺席 ⑤mode 方向性。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentDomain, isInAgentDomain, isOwnUpstreamTarget } from "../lib/security/agent-domain.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { resolvePhysicalWorkspacePath } from "../lib/state.js";

// 谓词契约:目标必须已物理化(生产端=守卫链 resolvedInputPath)。
const phys = (p) => resolvePhysicalWorkspacePath(p);
import { runtimeAgentConfigs } from "../lib/state.js";

const tempRoots = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function registerAgent(agentId, workspace) {
  registerRuntimeAgents({
    agents: { list: [{ id: agentId, role: "planner", workspace, model: { primary: "demo/x" } }] },
  });
}

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

test("形态①真目录:ws/inbox/outbox 全在域内(读写皆可),工作区外不在", async () => {
  const ws = makeTempDir("domain-realdir-");
  const outside = makeTempDir("domain-outside-");
  registerAgent("dom-real", ws);
  mkdirSync(join(ws, "inbox"), { recursive: true });
  mkdirSync(join(ws, "outbox"), { recursive: true });
  const domain = await resolveAgentDomain("dom-real");
  for (const p of [ws, join(ws, "inbox"), join(ws, "outbox"), join(ws, "notes.md")]) {
    assert.equal(isInAgentDomain(domain, phys(p), { mode: "read" }), true, `read 域含 ${p}`);
    assert.equal(isInAgentDomain(domain, phys(p), { mode: "write" }), true, `write 域含 ${p}`);
  }
  assert.equal(isInAgentDomain(domain, phys(outside), { mode: "read" }), false, "工作区外不在读域");
  assert.equal(isInAgentDomain(domain, phys(outside), { mode: "write" }), false, "工作区外不在写域");
});

test("形态②邮箱软链进树(合约轮):链目标的物理落点在域内——曾经的裸 ws 单锚误拦无从发生", async () => {
  const ws = makeTempDir("domain-symlink-");
  const treeRoot = makeTempDir("domain-tree-");
  registerAgent("dom-sym", ws);
  const treeOutbox = join(treeRoot, "participants", "dom-sym", "outbox-TC-1");
  const treeInbox = join(treeRoot, "participants", "dom-sym", "inbox-TC-1");
  mkdirSync(treeOutbox, { recursive: true });
  mkdirSync(treeInbox, { recursive: true });
  writeFileSync(join(treeOutbox, "brief.md"), "自己写的\n");
  symlinkSync(treeOutbox, join(ws, "outbox"), "dir");
  symlinkSync(treeInbox, join(ws, "inbox"), "dir");
  const domain = await resolveAgentDomain("dom-sym");
  // 物理落点(树内)与词法拼写(ws 下)都在域内
  assert.equal(isInAgentDomain(domain, phys(join(treeOutbox, "brief.md")), { mode: "read" }), true, "树内物理 outbox 文件在读域");
  assert.equal(isInAgentDomain(domain, phys(join(treeOutbox, "brief.md")), { mode: "write" }), true, "自己的 outbox 物理落点在写域");
  assert.equal(isInAgentDomain(domain, phys(treeInbox), { mode: "read" }), true, "树内物理 inbox 在读域");
  // 树里别人的目录不在域
  const foreign = join(treeRoot, "participants", "someone-else", "outbox-TC-9");
  mkdirSync(foreign, { recursive: true });
  assert.equal(isInAgentDomain(domain, phys(foreign), { mode: "read" }), false, "树内别人的目录不在域");
});

test("形态③上游链:目标(产者树 outbox)在读域、恒不在写域;isOwnUpstreamTarget 子域谓词", async () => {
  const ws = makeTempDir("domain-upstream-");
  const producerTree = makeTempDir("domain-producer-");
  registerAgent("dom-up", ws);
  mkdirSync(join(ws, "inbox", "upstream"), { recursive: true });
  const producerOutbox = join(producerTree, "participants", "producer", "outbox-TC-2");
  mkdirSync(producerOutbox, { recursive: true });
  writeFileSync(join(producerOutbox, "report.md"), "上游正本\n");
  symlinkSync(producerOutbox, join(ws, "inbox", "upstream", "producer"), "dir");
  const domain = await resolveAgentDomain("dom-up");
  const target = join(producerOutbox, "report.md");
  assert.equal(isInAgentDomain(domain, phys(target), { mode: "read" }), true, "上游链目标在读域");
  assert.equal(isInAgentDomain(domain, phys(target), { mode: "write" }), false, "上游链目标恒不在写域(只读别名,写=篡改别家封包)");
  assert.equal(isOwnUpstreamTarget(domain, phys(target)), true, "子域谓词命中");
  assert.equal(isOwnUpstreamTarget(domain, phys(join(ws, "notes.md"))), false, "工作区自有文件非上游");
  // includeUpstream:false 时上游不进域(纯写规则省 IO)
  const noUp = await resolveAgentDomain("dom-up", { includeUpstream: false });
  assert.equal(isInAgentDomain(noUp, phys(target), { mode: "read" }), false, "关上游枚举时链目标不在域");
});

test("形态④缺席/边界:未注册 agent 空域不炸;空目标恒 false", async () => {
  const domain = await resolveAgentDomain("dom-ghost-never-registered");
  assert.equal(isInAgentDomain(domain, "/tmp/x", { mode: "read" }), false, "幽灵 agent 空域");
  const ws = makeTempDir("domain-empty-");
  registerAgent("dom-min", ws); // 无 inbox/outbox 目录
  const min = await resolveAgentDomain("dom-min");
  assert.equal(isInAgentDomain(min, phys(join(ws, "a.md")), { mode: "read" }), true, "无邮箱目录时 ws 锚仍立");
  assert.equal(isInAgentDomain(min, "", { mode: "read" }), false, "空目标 false");
  assert.equal(isInAgentDomain(null, "/tmp/x"), false, "空域 false");
});
