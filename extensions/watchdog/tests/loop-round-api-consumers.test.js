import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("runtime consumers use loop-round-runtime api instead of importing loop-engine directly", async () => {
  const files = [
    join(process.cwd(), "lib", "system-action", "system-action-consumer.js"),
    join(process.cwd(), "lib", "automation", "automation-executor.js"),
    join(process.cwd(), "lib", "admin", "admin-surface-loop-operations.js"),
    join(process.cwd(), "lib", "admin", "admin-surface-operations.js"),
    join(process.cwd(), "lib", "admin", "runtime-admin.js"),
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    assert.doesNotMatch(content, /from "\.\.\/loop\/loop-engine\.js"/, `${filePath} still imports loop-engine directly`);
    assert.match(content, /from "\.\.\/loop\/loop-round-runtime\.js"/, `${filePath} should import loop-round-runtime api`);
  }
});

test("loop-round-runtime owns active round reads instead of proxying through loop-session-store", async () => {
  const filePath = join(process.cwd(), "lib", "loop", "loop-round-runtime.js");
  const content = await readFile(filePath, "utf8");

  assert.doesNotMatch(content, /PIPELINE_STATE_FILE/, "loop-round-runtime should not expose pipeline state files");
  assert.match(content, /export async function loadActiveLoopRuntime\(/, "loop-round-runtime should export loadActiveLoopRuntime");
  assert.match(content, /export async function getActiveLoopRuntime\(/, "loop-round-runtime should export getActiveLoopRuntime");
  assert.match(content, /export async function startLoopRound\(/, "loop-round-runtime should export startLoopRound");
  assert.match(content, /export async function concludeLoopRound\(/, "loop-round-runtime should export concludeLoopRound");
  assert.match(content, /export async function interruptLoopRound\(/, "loop-round-runtime should export interruptLoopRound");
  assert.match(content, /export async function resumeLoopRound\(/, "loop-round-runtime should export resumeLoopRound");
});

test("loop-session-store no longer carries round runtime proxy exports", async () => {
  const filePath = join(process.cwd(), "lib", "loop", "loop-session-store.js");
  const content = await readFile(filePath, "utf8");

  assert.doesNotMatch(content, /await import\("\.\/loop-engine\.js"\)/, "loop-session-store still imports loop-engine");
  assert.doesNotMatch(content, /export async function startRound\(/, "loop-session-store still exports startRound");
  assert.doesNotMatch(content, /export async function requestAdvance\(/, "loop-session-store still exports requestAdvance");
  assert.doesNotMatch(content, /export async function concludeRound\(/, "loop-session-store still exports concludeRound");
  assert.doesNotMatch(content, /export async function interruptRound\(/, "loop-session-store still exports interruptRound");
  assert.doesNotMatch(content, /export async function resumeRound\(/, "loop-session-store still exports resumeRound");
  assert.doesNotMatch(content, /export async function getActiveRound\(/, "loop-session-store still exports getActiveRound");
});

test("loop-engine file has been retired as a runtime owner", async () => {
  const filePath = join(process.cwd(), "lib", "loop", "loop-engine.js");
  await assert.rejects(
    readFile(filePath, "utf8"),
    { code: "ENOENT" },
  );
});
