// tests/discovery-toolface.test.js — D-G:ls/grep 发现工具面的原生最小实现。
// 语义对齐上游 pi-coding-agent:ls 列目录排序(大小写不敏感)、目录带 / 后缀、
// 含 dotfiles、默认 500 条上限;grep 返回 `路径:行号: 命中行`、默认 100 条上限。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { buildDiscoveryTools, listDiscoveryToolNames } from "../lib/system-action/discovery-toolface.js";
import { runtimeAgentConfigs } from "../lib/state.js";

const tempRoots = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function registerAgent(agentId, workspace) {
  registerRuntimeAgents({
    agents: {
      list: [{ id: agentId, role: "executor", workspace, model: { primary: "demo/worker" } }],
    },
  });
}

function buildTools(agentId) {
  const tools = buildDiscoveryTools({ agentId });
  return {
    ls: tools.find((tool) => tool.name === "ls"),
    grep: tools.find((tool) => tool.name === "grep"),
  };
}

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  while (tempRoots.length) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

test("工具族形状:注册 ls/grep 两个名字,未知 agent 物化空数组", () => {
  assert.deepEqual(listDiscoveryToolNames(), ["ls", "grep"]);
  assert.deepEqual(buildDiscoveryTools({ agentId: "agent-not-registered" }), []);

  const ws = makeTempDir("discovery-shape-");
  registerAgent("worker-discovery-shape", ws);
  const tools = buildDiscoveryTools({ agentId: "worker-discovery-shape" });
  assert.deepEqual(tools.map((tool) => tool.name), ["ls", "grep"]);
});

test("ls:列目录含 dotfiles、目录带 / 后缀、按大小写不敏感字母序", async () => {
  const ws = makeTempDir("discovery-ls-");
  registerAgent("worker-discovery-ls", ws);
  writeFileSync(join(ws, "Beta.txt"), "b\n");
  writeFileSync(join(ws, "alpha.txt"), "a\n");
  writeFileSync(join(ws, ".hidden"), "h\n");
  mkdirSync(join(ws, "sub"));

  const { ls } = buildTools("worker-discovery-ls");
  const result = await ls.execute("t1", {});
  const lines = result.content[0].text.split("\n");
  assert.ok(lines.includes(".hidden"), "dotfiles 必须列出");
  assert.ok(lines.includes("sub/"), "目录必须带 / 后缀");
  assert.ok(lines.includes("alpha.txt") && lines.includes("Beta.txt"));
  assert.ok(
    lines.indexOf("alpha.txt") < lines.indexOf("Beta.txt"),
    "大小写不敏感字母序:alpha 在 Beta 前",
  );
  assert.equal(result.details.ok, true);
  assert.equal(result.details.entryCount, 4);
});

test("ls:limit 截断带 details 标记;路径不存在/非目录返回错误 payload 而不抛", async () => {
  const ws = makeTempDir("discovery-ls-limit-");
  registerAgent("worker-discovery-limit", ws);
  for (const name of ["f1", "f2", "f3"]) writeFileSync(join(ws, name), "x\n");

  const { ls } = buildTools("worker-discovery-limit");
  const limited = await ls.execute("t1", { limit: 2 });
  assert.equal(limited.details.entryCount, 2);
  assert.equal(limited.details.entryLimitReached, 2);
  assert.match(limited.content[0].text, /entries limit reached/u);

  const missing = await ls.execute("t2", { path: join(ws, "no-such-dir") });
  assert.equal(missing.details.ok, false);
  assert.match(missing.details.error, /Path not found/u);

  const notDir = await ls.execute("t3", { path: join(ws, "f1") });
  assert.equal(notDir.details.ok, false);
  assert.match(notDir.details.error, /Not a directory/u);
});

test("grep:命中带 相对路径:行号,ignoreCase/literal/glob/limit 各语义正确", async () => {
  const ws = makeTempDir("discovery-grep-");
  registerAgent("worker-discovery-grep", ws);
  writeFileSync(join(ws, "a.md"), "hello world\nfoo bar\n");
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "b.md"), "HELLO again\n");
  writeFileSync(join(ws, "c.txt"), "foo in txt\n");

  const { grep } = buildTools("worker-discovery-grep");

  const hit = await grep.execute("t1", { pattern: "foo" });
  assert.equal(hit.details.ok, true);
  assert.equal(hit.details.matchCount, 2);
  assert.ok(hit.content[0].text.includes("a.md:2: foo bar"));
  assert.ok(hit.content[0].text.includes("c.txt:1: foo in txt"));

  const insensitive = await grep.execute("t2", { pattern: "hello", ignoreCase: true });
  assert.equal(insensitive.details.matchCount, 2);
  assert.ok(insensitive.content[0].text.includes("sub/b.md:1: HELLO again"));

  // literal:正则元字符按字面处理,"a.c" 只命中字面 a.c,不命中 abc
  writeFileSync(join(ws, "d.txt"), "a.c\nabc\n");
  const literal = await grep.execute("t3", { pattern: "a.c", literal: true });
  assert.equal(literal.details.matchCount, 1);
  assert.ok(literal.content[0].text.includes("d.txt:1: a.c"));

  // glob:不带 / 的模式按 basename 过滤
  const globbed = await grep.execute("t4", { pattern: "hello", ignoreCase: true, glob: "*.md" });
  assert.equal(globbed.details.matchCount, 2);

  const globTxt = await grep.execute("t5", { pattern: "foo", glob: "*.txt" });
  assert.equal(globTxt.details.matchCount, 1);
  assert.ok(globTxt.content[0].text.includes("c.txt:1:"));

  // limit:截断并给 details 标记
  const limited = await grep.execute("t6", { pattern: "hello", ignoreCase: true, limit: 1 });
  assert.equal(limited.details.matchCount, 1);
  assert.equal(limited.details.matchLimitReached, 1);

  const none = await grep.execute("t7", { pattern: "definitely-not-here" });
  assert.equal(none.details.ok, true);
  assert.equal(none.details.matchCount, 0);
  assert.match(none.content[0].text, /No matches found/u);

  // 无效正则返回错误 payload 而不抛
  const badRegex = await grep.execute("t8", { pattern: "([" });
  assert.equal(badRegex.details.ok, false);

  const missing = await grep.execute("t9", { pattern: "foo", path: join(ws, "no-such-dir") });
  assert.equal(missing.details.ok, false);
  assert.match(missing.details.error, /Path not found/u);
});

test("grep:相对 path 按 agent 工作区解析;node_modules/.git 与符号链接不进入搜索面", async () => {
  const ws = makeTempDir("discovery-grep-scope-");
  const outside = makeTempDir("discovery-grep-outside-");
  registerAgent("worker-discovery-gscope", ws);
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "inner.md"), "needle here\n");
  mkdirSync(join(ws, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(ws, "node_modules", "dep", "x.js"), "needle in dep\n");
  mkdirSync(join(ws, ".git"));
  writeFileSync(join(ws, ".git", "config"), "needle in git\n");
  writeFileSync(join(outside, "leak.md"), "needle outside\n");
  symlinkSync(outside, join(ws, "linked-outside"));

  const { grep } = buildTools("worker-discovery-gscope");

  // 相对 path 落到工作区下
  const relative = await grep.execute("t1", { pattern: "needle", path: "sub" });
  assert.equal(relative.details.matchCount, 1);
  assert.ok(relative.content[0].text.includes("inner.md:1: needle here"));

  // 全目录搜:node_modules/.git 排除,符号链接目录不跟随
  const wide = await grep.execute("t2", { pattern: "needle" });
  assert.equal(wide.details.matchCount, 1);
  assert.ok(!wide.content[0].text.includes("dep"));
  assert.ok(!wide.content[0].text.includes("git"));
  assert.ok(!wide.content[0].text.includes("leak"));
});
