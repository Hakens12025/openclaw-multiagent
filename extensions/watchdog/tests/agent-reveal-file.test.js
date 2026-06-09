import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { revealFileInFinder, isPathWithinAllowedRoots } from "../lib/agent/agent-reveal-file.js";

// reveal-file is security-sensitive: it shells out (execFile open -R) to a user-named path. The ~
// expansion (added so the agents-page can pass compactHomePath forms like ~/.openclaw/workspaces/…)
// must NOT widen access — the ALLOWED_ROOTS whitelist still gates the EXPANDED path. A fake exec
// records the call so we assert allow/deny without opening Finder.

const OC = join(homedir(), ".openclaw");

function fakeExec() {
  const calls = [];
  const exec = (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); };
  return { exec, calls };
}

test("reveal: ~-prefixed workspace path expands and is allowed (the agents-page case)", async () => {
  const { exec, calls } = fakeExec();
  const out = await revealFileInFinder("~/.openclaw/workspaces/agent-x/SOUL.md", { exec });
  assert.equal(out.ok, true);
  assert.equal(out.resolvedPath, join(OC, "workspaces", "agent-x", "SOUL.md"), "~ expanded to home, not cwd/~");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cmd: "open", args: ["-R", join(OC, "workspaces", "agent-x", "SOUL.md")] });
});

test("reveal: absolute workspace path still allowed (workflow-page case unchanged)", async () => {
  const { exec } = fakeExec();
  const out = await revealFileInFinder(join(OC, "control-plane", "snap.json"), { exec });
  assert.equal(out.ok, true);
});

test("reveal: ~ expansion does NOT widen access — outside-whitelist ~ path is rejected", async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(() => revealFileInFinder("~/.ssh/id_rsa", { exec }), /path not allowed/);
  assert.equal(calls.length, 0, "never shells out for a denied path");
});

test("reveal: .. escape out of a whitelisted root is rejected after resolve", async () => {
  const { exec } = fakeExec();
  await assert.rejects(() => revealFileInFinder("~/.openclaw/workspaces/../../.ssh/id_rsa", { exec }), /path not allowed/);
});

test("reveal: empty path rejected", async () => {
  const { exec } = fakeExec();
  await assert.rejects(() => revealFileInFinder("  ", { exec }), /path required/);
});

test("isPathWithinAllowedRoots: prefix-evil sibling is not matched", () => {
  assert.equal(isPathWithinAllowedRoots(join(OC, "workspaces")), true);
  assert.equal(isPathWithinAllowedRoots(join(OC, "workspaces-evil", "x")), false);
});
