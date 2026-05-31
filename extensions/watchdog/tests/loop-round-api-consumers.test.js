import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_ROOT = join(TEST_DIR, "..");

test("runtime consumers use loop-round-runtime api instead of importing loop-engine directly", async () => {
  const files = [
    join(WATCHDOG_ROOT, "lib", "system-action", "system-action-consumer.js"),
    join(WATCHDOG_ROOT, "lib", "automation", "automation-start.js"),
    join(WATCHDOG_ROOT, "lib", "automation", "automation-reconcile.js"),
    join(WATCHDOG_ROOT, "lib", "admin", "admin-surface-loop-operations.js"),
    join(WATCHDOG_ROOT, "lib", "admin", "admin-surface-operations.js"),
    join(WATCHDOG_ROOT, "lib", "admin", "runtime-admin.js"),
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    assert.doesNotMatch(content, /from "\.\.\/loop\/loop-engine\.js"/, `${filePath} still imports loop-engine directly`);
    assert.match(content, /from "\.\.\/loop\/loop-round-runtime\.js"/, `${filePath} should import loop-round-runtime api`);
  }
});

test("loop-round-runtime owns active round reads instead of proxying through loop-session-store", async () => {
  const filePath = join(WATCHDOG_ROOT, "lib", "loop", "loop-round-runtime.js");
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
  const filePath = join(WATCHDOG_ROOT, "lib", "loop", "loop-session-store.js");
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
  const filePath = join(WATCHDOG_ROOT, "lib", "loop", "loop-engine.js");
  await assert.rejects(
    readFile(filePath, "utf8"),
    { code: "ENOENT" },
  );
});

test("loop start consumers delegate role-aware wake to dispatch runtime instead of embedding generic wake text", async () => {
  const adminSurfacePath = join(WATCHDOG_ROOT, "lib", "admin", "admin-surface-loop-operations.js");
  const systemActionPath = join(WATCHDOG_ROOT, "lib", "system-action", "system-action-consumer.js");

  const [adminSurfaceContent, systemActionContent] = await Promise.all([
    readFile(adminSurfacePath, "utf8"),
    readFile(systemActionPath, "utf8"),
  ]);

  assert.doesNotMatch(
    adminSurfaceContent,
    /loop 控制唤醒: 请读取 inbox\/contract\.json 并执行当前阶段/,
    "runtime.loop.start should not embed a generic loop wake prompt",
  );
  assert.match(
    adminSurfaceContent,
    /runtimeApi:\s*runtimeContext(?:\?\.|\.)api/,
    "runtime.loop.start should pass runtimeApi into startLoopRound",
  );

  assert.doesNotMatch(
    systemActionContent,
    /loop 启动: 请读取 inbox\/contract\.json 并执行当前合同/,
    "system_action start_loop should not embed a generic loop wake prompt",
  );
  assert.match(
    systemActionContent,
    /runtimeApi:\s*api/,
    "system_action start_loop should pass runtimeApi into startLoopRound",
  );
});
