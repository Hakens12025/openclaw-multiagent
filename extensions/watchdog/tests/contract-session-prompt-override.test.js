import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildContractSessionSystemPrompt,
  shouldOverrideContractSessionPrompt,
} from "../lib/contract-session-prompt-override.js";

const NEGATIVE_PROMPT_PATTERNS = [
  /\bdo not\b/iu,
  /\bdon't\b/iu,
  /\bnever\b/iu,
  /\bmust not\b/iu,
  /\bshould not\b/iu,
  /不要/u,
  /禁止/u,
  /不得/u,
  /不能/u,
  /不可/u,
];

function assertNoNegativePromptCopy(content) {
  for (const pattern of NEGATIVE_PROMPT_PATTERNS) {
    assert.doesNotMatch(content, pattern, `prompt contains negative tutorial copy: ${pattern}`);
  }
}

test("contract session prompt override is scoped to exact contract sessions", () => {
  assert.equal(shouldOverrideContractSessionPrompt({ agentId: "worker", sessionKey: "agent:worker:contract:TC-1" }), true);
  assert.equal(shouldOverrideContractSessionPrompt({ agentId: "worker", sessionKey: "agent:planner:contract:TC-1" }), false);
  assert.equal(shouldOverrideContractSessionPrompt({ agentId: "worker", sessionKey: "agent:worker:main" }), false);
  assert.equal(shouldOverrideContractSessionPrompt({ agentId: "worker", sessionKey: "cron:worker:TC-1" }), false);
});

test("contract session prompt override keeps minimal runtime guidance + role persona + SOUL last", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-contract-prompt-"));
  try {
    // SOUL = user-owned persona body, appended verbatim at the very end of the dispatch prompt.
    const userSoulBody = [
      "# worker",
      "",
      "User-authored persona: always cite the dataset id.",
    ].join("\n");
    await writeFile(join(workspaceDir, "SOUL.md"), userSoulBody);
    await writeFile(join(workspaceDir, "HEARTBEAT.md"), [
      "# HEARTBEAT.md",
      "",
      "Runtime wake. Handle the current contract.",
    ].join("\n"));

    const prompt = await buildContractSessionSystemPrompt({
      agentId: "worker",
      role: "executor",
      workspaceDir,
      sessionKey: "agent:worker:contract:TC-1",
    });

    // role persona is inlined at the FRONT (system-dispatch path injects it; persona is English).
    assert.match(prompt, /## Role/, "role persona block is inlined at the front");
    assert.ok(prompt.indexOf("## Role") < prompt.indexOf("You are running inside OpenClaw"), "persona precedes the OpenClaw frame");

    assert.match(prompt, /You are running inside OpenClaw\./);
    assert.match(prompt, /Agent: `worker`/);
    assert.doesNotMatch(prompt, /Role:/);
    assert.doesNotMatch(prompt, /Contract: `TC-1`/, "contractId 不内联进系统提示词前缀(缓存稳定),由 inbox/wake 提供");
    assert.match(prompt, /Use the current wake message for wake metadata: contract id and output path\./);
    assert.match(prompt, /First read `inbox\/contract\.json` as the contract truth\./);
    assert.doesNotMatch(prompt, /Use the current wake message as the task source\./);
    assert.match(prompt, /Write the user-facing deliverable artifact\./);
    assert.match(prompt, /Write `outbox\/runtime_result\.json` for runtime status metadata\./);
    assert.match(prompt, /Runtime consumes status metadata; the user-facing answer lives in the artifact\./);
    assert.doesNotMatch(prompt, /protocol acknowledgement/);
    assert.doesNotMatch(prompt, /completion statement/);
    assert.doesNotMatch(prompt, /Sensitive external actions require human confirmation/);
    assert.doesNotMatch(prompt, /single-file|multi-file|simple questions|one-line answer/i);
    assert.match(prompt, /Use `runtimeContext\.currentTime` from that file for date\/time questions\./);
    assert.doesNotMatch(prompt, /wake includes `Current time`/);
    assert.doesNotMatch(prompt, /## Project Context/);
    assert.doesNotMatch(prompt, /## .*HEARTBEAT\.md/);
    assert.doesNotMatch(prompt, /Runtime wake\. Handle the current contract\./, "HEARTBEAT.md is not inlined");
    assert.doesNotMatch(prompt, /## Silent Replies/);
    assert.doesNotMatch(prompt, /## Heartbeats/);

    // SOUL user body is appended at the VERY END (\u88c1\u5b9a2: SOUL last for cache locality).
    assert.match(prompt, /User-authored persona: always cite the dataset id\./, "user SOUL body is appended");
    assert.ok(prompt.trimEnd().endsWith("User-authored persona: always cite the dataset id."), "SOUL body is last");
    assert.ok(prompt.indexOf("User-authored persona") > prompt.indexOf("## Tools"), "SOUL follows the wake/tools section");
    assertNoNegativePromptCopy(prompt);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("contract session prompt override gives planner a brief + stage directive (not the deliverable)", async () => {
  const prompt = await buildContractSessionSystemPrompt({
    agentId: "planner",
    role: "planner",
    workspaceDir: "/tmp/openclaw-planner-x",
    sessionKey: "agent:planner:contract:TC-9",
  });
  assert.match(prompt, /working brief/i, "planner 应被指示产工作简报");
  assert.match(prompt, /\[STAGE\]/, "planner 简报含 [STAGE] 阶段计划");
  assert.match(prompt, /executor reads your brief/i, "明确执行节点据简报产成品");
  // planner 不应拿到「直接产用户交付物」指令（那是它越界产报告的根因）
  assert.doesNotMatch(prompt, /Write the user-facing deliverable artifact\./);
  // ④role persona is inlined (English); the ⑥wake output directives stay English/positive.
  assert.match(prompt, /## Role/, "planner persona inlined at the front");
  assertNoNegativePromptCopy(prompt);
});

test("contract session prompt override tells executors to read upstream packages first", async () => {
  const prompt = await buildContractSessionSystemPrompt({
    agentId: "worker",
    role: "executor",
    workspaceDir: "/tmp/openclaw-worker-x",
    sessionKey: "agent:worker:contract:TC-9",
  });
  assert.match(prompt, /upstreamPackages/, "executor 应被指示先读上游产物包");
  assert.match(prompt, /Write the user-facing deliverable artifact\./, "executor 仍产用户交付物");
  assertNoNegativePromptCopy(prompt);
});

test("contract session prompt appends an optional per-agent WAKE.md override when present", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-wake-"));
  try {
    await writeFile(join(workspaceDir, "WAKE.md"), "Always cite the source dataset id in the deliverable.");
    const prompt = await buildContractSessionSystemPrompt({
      agentId: "worker", role: "executor", workspaceDir, sessionKey: "agent:worker:contract:TC-7",
    });
    assert.match(prompt, /## Dispatch guidance \(WAKE\.md override\)/, "platform header is present (English)");
    assert.match(prompt, /Always cite the source dataset id in the deliverable\./, "user WAKE.md body is appended verbatim");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("contract session prompt is unchanged when no WAKE.md exists (override is opt-in)", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-nowake-"));
  try {
    const prompt = await buildContractSessionSystemPrompt({
      agentId: "worker", role: "executor", workspaceDir, sessionKey: "agent:worker:contract:TC-8",
    });
    assert.doesNotMatch(prompt, /WAKE\.md override/, "no override block without a WAKE.md");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("WAKE.md is an OPTIONAL editable override — editable, but not expected/managed (no missing-nag)", async () => {
  const { EDITABLE_GUIDANCE_FILES, OPTIONAL_GUIDANCE_FILES, GUIDANCE_FILES, getManagedGuidanceFilesForRole } =
    await import("../lib/agent/agent-enrollment-discovery.js");
  const { MANAGED_GUIDANCE_FILE_NAMES } = await import("../lib/agent/managed-guidance-files.js");
  assert.ok(EDITABLE_GUIDANCE_FILES.includes("WAKE.md"), "in the read/write whitelist (editable)");
  assert.ok(OPTIONAL_GUIDANCE_FILES.includes("WAKE.md"), "classified as an optional override");
  assert.ok(!GUIDANCE_FILES.includes("WAKE.md"), "NOT in the expected/managed guidance set");
  assert.ok(!getManagedGuidanceFilesForRole("executor").includes("WAKE.md"), "not per-role expected → a missing WAKE.md is never flagged");
  assert.ok(!getManagedGuidanceFilesForRole("bridge").includes("WAKE.md"), "same for coordination roles");
  assert.ok(!MANAGED_GUIDANCE_FILE_NAMES.includes("WAKE.md"), "NOT auto-managed → writer never auto-writes/removes it");
});

test("watchdog plugin registers the contract prompt override hook", async () => {
  const indexSource = await readFile(fileURLToPath(new URL("../index.js", import.meta.url)), "utf8");
  assert.match(indexSource, /beforePromptBuildHook/);
  assert.match(indexSource, /beforePromptBuildHook\.register\(api,\s*logger\)/);
});
