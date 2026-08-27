import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { revealFileInFinder, revealCommandFor, isPathWithinAllowedRoots } from "../lib/agent/agent-reveal-file.js";

// reveal-file is security-sensitive: it shells out (execFile) to a user-named path. The ~
// expansion (added so the agents-page can pass compactHomePath forms like ~/.openclaw/workspaces/…)
// must NOT widen access — the ALLOWED_ROOTS whitelist still gates the EXPANDED path. A fake exec
// records the call so we assert allow/deny without opening a file manager. Platform is injected
// so these tests are deterministic on any host OS.

const OC = join(homedir(), ".openclaw");
const WATCHDOG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeExec() {
  const calls = [];
  const exec = (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); };
  return { exec, calls };
}

// ── revealCommandFor：平台分派纯函数 ─────────────────────────────────────────

test("revealCommandFor: darwin → open -R <path>", () => {
  const p = join(OC, "workspaces", "a", "f.md");
  assert.deepEqual(revealCommandFor("darwin", p), { cmd: "open", args: ["-R", p] });
});

test("revealCommandFor: linux → xdg-open <dir> (父目录,xdg-open 无选中语义)", () => {
  const p = join(OC, "workspaces", "a", "f.md");
  assert.deepEqual(revealCommandFor("linux", p), { cmd: "xdg-open", args: [join(OC, "workspaces", "a")] });
});

test("revealCommandFor: win32 → explorer /select,<path>", () => {
  const p = join(OC, "workspaces", "a", "f.md");
  assert.deepEqual(revealCommandFor("win32", p), { cmd: "explorer", args: [`/select,${p}`] });
});

test("revealCommandFor: 未知平台 → null (调用方降级)", () => {
  assert.equal(revealCommandFor("sunos", "/x"), null);
  assert.equal(revealCommandFor("", "/x"), null);
  assert.equal(revealCommandFor(undefined, "/x"), null);
});

// ── revealFileInFinder：白名单 + 分派 + 降级 ────────────────────────────────

test("reveal: ~-prefixed workspace path expands and is allowed (the agents-page case)", async () => {
  const { exec, calls } = fakeExec();
  const out = await revealFileInFinder("~/.openclaw/workspaces/agent-x/SOUL.md", { exec, platform: "darwin" });
  assert.equal(out.ok, true);
  assert.equal(out.resolvedPath, join(OC, "workspaces", "agent-x", "SOUL.md"), "~ expanded to home, not cwd/~");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cmd: "open", args: ["-R", join(OC, "workspaces", "agent-x", "SOUL.md")] });
});

test("reveal: linux 分派走 xdg-open 且开的是父目录", async () => {
  const { exec, calls } = fakeExec();
  const out = await revealFileInFinder(join(OC, "control-plane", "output", "x.md"), { exec, platform: "linux" });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0], { cmd: "xdg-open", args: [join(OC, "control-plane", "output")] });
});

test("reveal: 不支持的平台优雅降级 {ok:false,reason} 不抛、不 exec", async () => {
  const { exec, calls } = fakeExec();
  const out = await revealFileInFinder(join(OC, "control-plane", "snap.json"), { exec, platform: "freebsd" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /freebsd/);
  assert.equal(calls.length, 0, "unsupported platform never shells out");
});

test("reveal: absolute workspace path still allowed (workflow-page case unchanged)", async () => {
  const { exec } = fakeExec();
  const out = await revealFileInFinder(join(OC, "control-plane", "snap.json"), { exec, platform: "darwin" });
  assert.equal(out.ok, true);
});

test("reveal: ~ expansion does NOT widen access — outside-whitelist ~ path is rejected", async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(() => revealFileInFinder("~/.ssh/id_rsa", { exec, platform: "darwin" }), /path not allowed/);
  assert.equal(calls.length, 0, "never shells out for a denied path");
});

test("reveal: .. escape out of a whitelisted root is rejected after resolve", async () => {
  const { exec } = fakeExec();
  await assert.rejects(() => revealFileInFinder("~/.openclaw/workspaces/../../.ssh/id_rsa", { exec, platform: "darwin" }), /path not allowed/);
});

test("reveal: 白名单拒绝优先于平台降级 (未知平台+白名单外仍是 reject)", async () => {
  const { exec } = fakeExec();
  await assert.rejects(() => revealFileInFinder("/etc/passwd", { exec, platform: "freebsd" }), /path not allowed/);
});

test("reveal: empty path rejected", async () => {
  const { exec } = fakeExec();
  await assert.rejects(() => revealFileInFinder("  ", { exec, platform: "darwin" }), /path required/);
});

test("isPathWithinAllowedRoots: prefix-evil sibling is not matched", () => {
  assert.equal(isPathWithinAllowedRoots(join(OC, "workspaces")), true);
  assert.equal(isPathWithinAllowedRoots(join(OC, "workspaces-evil", "x")), false);
});

// ── 源码守卫：运维提示不得再指向僵尸路径/退役入口 ───────────────────────────
// /tmp/openclaw-gateway.log 是历史僵尸(真日志 ~/.openclaw/logs/gateway.log),
// bash start.sh 与 launchctl kickstart 已退役为 openclawctl.js(跨平台)。

test("guard: error-codes.js 提示不含僵尸日志路径与退役 start.sh", async () => {
  const src = await readFile(join(WATCHDOG_ROOT, "lib", "formal-runtime", "error-codes.js"), "utf8");
  assert.ok(!src.includes("/tmp/openclaw-gateway.log"), "error-codes.js 不得再引用 /tmp/openclaw-gateway.log");
  assert.ok(!src.includes("start.sh"), "error-codes.js 不得再引用退役的 start.sh");
});

test("guard: suite-knowledge.js 提示不含 mac 专属 launchctl kickstart", async () => {
  const src = await readFile(join(WATCHDOG_ROOT, "lib", "formal-runtime", "suite-knowledge.js"), "utf8");
  assert.ok(!src.includes("launchctl kickstart"), "suite-knowledge.js 重启提示须用跨平台的 openclawctl.js restart");
});
