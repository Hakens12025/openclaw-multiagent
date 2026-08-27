import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WATCHDOG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OPENCLAW_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function readWatchdogFile(...parts) {
  return readFile(join(WATCHDOG_ROOT, ...parts), "utf8");
}

async function readOpenClawFile(...parts) {
  return readFile(join(OPENCLAW_ROOT, ...parts), "utf8");
}

test("active protocol docs reference canonical dispatch and delivery truth", async () => {
  const [threeLayer, delivery, bridgeDecision, status] = await Promise.all([
    readOpenClawFile("wiki", "concepts", "three-layer-protocol.md"),
    readOpenClawFile("wiki", "concepts", "delivery.md"),
    readOpenClawFile("wiki", "decisions", "runtime-bridge-into-delivery.md"),
    readOpenClawFile("wiki", "status.md"),
  ]);

  assert.match(threeLayer, /dispatch-entry\.js/);
  assert.match(threeLayer, /dispatch-execution-contract-entry\.js/);
  assert.match(threeLayer, /dispatch-transport\.js/);
  assert.match(threeLayer, /dispatch-graph-policy\.js/);
  assert.doesNotMatch(threeLayer, /lib\/ingress\/ingress\.js/);
  assert.doesNotMatch(threeLayer, /lib\/ingress\/ingress-standard-route\.js/);
  assert.doesNotMatch(threeLayer, /lib\/routing\/dispatch\.js/);
  assert.doesNotMatch(threeLayer, /lib\/routing\/graph-router\.js/);

  assert.match(delivery, /delivery:terminal/);
  assert.match(delivery, /delivery:system_action_runtime_result/);
  assert.match(delivery, /delivery:system_action_assign_task_result/);
  assert.doesNotMatch(delivery, /delivery:systemaction\b/);
  assert.doesNotMatch(delivery, /收编被 session management 实现阻塞/);
  assert.doesNotMatch(delivery, /delivery\.js \+ delivery-targets\.js 合并尚未执行/);

  assert.doesNotMatch(bridgeDecision, /Session management 尚未实现/);
  assert.doesNotMatch(bridgeDecision, /依赖 session management 设计完成/);

  assert.doesNotMatch(status, /runtime-bridge 收编被阻塞/);
  assert.doesNotMatch(status, /delivery 统一被阻塞/);
});

test("active protocol consumers import protocol-registry instead of hardcoding runtime ids", async () => {
  // 旧 dashboard 前端已随批4 整删;协议 id 消费者收敛到 lib 两侧
  // (platform-doc-builder + delivery-protocols),registry 落 lib/protocol/。
  const [platformDocSource, deliveryProtocolsSource] = await Promise.all([
    readWatchdogFile("lib", "prompt", "platform-doc-builder.js"),
    readWatchdogFile("lib", "routing", "delivery", "delivery-protocols.js"),
  ]);

  assert.match(platformDocSource, /from ['"][^'"]*protocol\/protocol-registry\.js['"]/);
  assert.match(deliveryProtocolsSource, /from ['"][^'"]*protocol\/protocol-registry\.js['"]/);

  assert.doesNotMatch(platformDocSource, /`delivery:terminal`/);
  assert.doesNotMatch(platformDocSource, /`delivery:system_action_assign_task_result`/);
  assert.doesNotMatch(platformDocSource, /`delivery:system_action_runtime_result`/);
});

test("active operator prompt docs avoid retired topology and pipeline terms", async () => {
  const [operatorBrain, operatorKnowledge, promptCraft] = await Promise.all([
    readWatchdogFile("lib", "operator", "operator-brain.js"),
    readWatchdogFile("lib", "operator", "operator-knowledge.js"),
    readOpenClawFile("skills", "prompt-craft", "SKILL.md"),
  ]);

  for (const [label, content] of Object.entries({ operatorBrain, operatorKnowledge, promptCraft })) {
    assert.doesNotMatch(content, /graph-router|pipeline engine|start_pipeline|advance_pipeline/i, `${label} leaks retired routing terms`);
    assert.doesNotMatch(content, /fast-track|full-path|short contract/i, `${label} leaks retired contract split terms`);
  }
});

test("active runtime skill and action metadata avoids retired graph-router wording", async () => {
  const [semanticSkillRegistry, systemActionRuntime] = await Promise.all([
    readWatchdogFile("lib", "prompt", "semantic-skill-registry.js"),
    readWatchdogFile("lib", "system-action", "system-action-runtime.js"),
  ]);

  for (const [label, content] of Object.entries({ semanticSkillRegistry, systemActionRuntime })) {
    assert.doesNotMatch(content, /graph-router/i, `${label} leaks retired graph-router wording`);
  }
});

test("runtime diagnostics uses terminalDelivery instead of retired completionEgress naming", async () => {
  const files = {
    agentEndTerminal: await readWatchdogFile("lib", "lifecycle", "agent-end", "terminal.js"),
    suiteLink: await readWatchdogFile("lib", "formal-runtime", "suite-link.js"),
    runtimeDiagnosis: await readWatchdogFile("tests", "runtime-diagnosis.js"),
  };

  for (const [label, content] of Object.entries(files)) {
    assert.doesNotMatch(content, /completionEgress|completion-egress/u, `${label} leaks retired completion egress naming`);
  }
});

test("operator and admin surface copy avoids retired fast path and loop pipeline wording", async () => {
  const [adminCatalog, adminFields] = await Promise.all([
    readWatchdogFile("lib", "admin", "admin-surface-catalog.js"),
    readWatchdogFile("lib", "admin", "admin-surface-input-fields.js"),
  ]);

  for (const [label, content] of Object.entries({ adminCatalog, adminFields })) {
    assert.doesNotMatch(content, /fast-track|full-path|short contract/i, `${label} leaks retired contract split terms`);
    assert.doesNotMatch(content, /loop pipeline|pipeline progression|pipeline state/i, `${label} leaks retired loop-pipeline wording`);
  }
});

test("active wiki entrypoints avoid retired prompt and routing vocabulary", async () => {
  const files = {
    status: await readOpenClawFile("wiki", "status.md"),
    index: await readOpenClawFile("wiki", "index.md"),
    loop: await readOpenClawFile("wiki", "concepts", "loop.md"),
    conveyor: await readOpenClawFile("wiki", "concepts", "conveyor-belt.md"),
    layering: await readOpenClawFile("wiki", "concepts", "system-layering.md"),
    protocol: await readOpenClawFile("wiki", "concepts", "three-layer-protocol.md"),
  };

  for (const [label, content] of Object.entries(files)) {
    const visibleContent = content.replace(/\]\([^)]+\)/g, "]");
    assert.doesNotMatch(visibleContent, /graph-router|pipeline-engine|pipeline progression|fast-full-path|fast-track|full-path|short contract/i, `${label} leaks retired active-wiki vocabulary`);
  }
});

test("active implementation plans avoid executable retired contract-mode cleanup instructions", async () => {
  const topologyPlan = await readWatchdogFile(
    "docs",
    "superpowers",
    "plans",
    "2026-04-23-runtime-topology-truth-cleanup.md",
  );

  assert.doesNotMatch(topologyPlan, /For agentic workers|REQUIRED SUB-SKILL|^- \[ \]/m);
  assert.doesNotMatch(topologyPlan, /fastTrack|protocol\.route=short\|long|routeHint|short route|full-path|short contract/i);
});

test("root entry docs and root agent card avoid retired protocol vocabulary", async () => {
  // CODEX.md/agent-card.json 是私有策展/运行时件,公开树 fresh checkout 缺席=无物可守,
  // 逐文件剔除;在场文件照常全力(私有活树全员在场)。
  const readOptional = async (...parts) => {
    try {
      return await readOpenClawFile(...parts);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const files = Object.fromEntries(Object.entries({
    readme: await readOpenClawFile("README.md"),
    systemMap: await readOpenClawFile("SYSTEM_MAP.md"),
    claude: await readOpenClawFile("CLAUDE.md"),
    codex: await readOptional("CODEX.md"),
    agentCard: await readOptional("agent-card.json"),
    workspaceGuidance: await readOpenClawFile("wiki", "concepts", "workspace-guidance.md"),
  }).filter(([, content]) => content !== null));

  for (const [label, content] of Object.entries(files)) {
    assert.doesNotMatch(content, /fast-track|fast-full-path|full-path|short contract/i, `${label} leaks retired contract split vocabulary`);
    assert.doesNotMatch(content, /contract-result-json/i, `${label} leaks retired output format vocabulary`);
    assert.doesNotMatch(content, /runtimeReturn|runtimeReturnTicket|runtime return|RUNTIME-RETURN\.md/i, `${label} leaks retired runtime-return vocabulary`);
    assert.doesNotMatch(content, /start_pipeline|advance_pipeline/i, `${label} leaks retired loop intent vocabulary`);
    assert.doesNotMatch(content, /phaseFlows|dashboard\.js:67-76|graph-driven pipeline|pipeline \/ loop/i, `${label} leaks retired dashboard or loop wording`);
  }

  if (files.agentCard) assert.match(files.agentCard, /runtime-result-json/);
  await assert.rejects(readOpenClawFile("RUNTIME-RETURN.md"), /ENOENT/);
});
