import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import { buildSoulTemplate } from "../lib/soul-template-builder.js";
import {
  buildAgentsTemplate,
  buildBuildingMapTemplate,
  buildCollaborationGraphTemplate,
  buildDeliveryTemplate,
  buildHeartbeatTemplate,
  buildPlatformGuideTemplate,
} from "../lib/platform-doc-builder.js";

const NEGATIVE_TUTORING_PATTERN = /\b[Dd]o not\b|\bdon't\b|DON'T|不要|禁止|反例|错误示例|重度\s*API/u;
const LEGACY_ROUTE_PATTERN = /fast[-_ ]?track|full[-_ ]?path|short[-_ ]?contract|short[-_ ]?route|isFastTrack|fastTrack|FAST-TRACK|FULL-PATH/u;
const ACTIVE_OPENCLAW_SKILL_IDS = [
  "agent-bootstrap-designer",
  "error-avoidance",
  "operator-admin",
  "operator-tooling",
  "platform-map",
  "platform-tools",
  "prompt-craft",
  "system-action",
];

async function readRepoFile(relativePath) {
  return readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

function buildActivePromptDocuments() {
  const agentEntries = [
    { id: "controller", role: AGENT_ROLE.BRIDGE, gateway: true, ingressSource: "webui", skills: ["system-action"] },
    { id: "planner", role: AGENT_ROLE.PLANNER, skills: [] },
    { id: "worker1", role: AGENT_ROLE.EXECUTOR, skills: [] },
  ];
  const graph = { edges: [{ from: "controller", to: "planner" }, { from: "planner", to: "worker1" }] };
  return {
    "SOUL.executor": buildSoulTemplate("worker1", AGENT_ROLE.EXECUTOR),
    "SOUL.planner": buildSoulTemplate("planner", AGENT_ROLE.PLANNER),
    "HEARTBEAT": buildHeartbeatTemplate(),
    "AGENTS": buildAgentsTemplate("controller", AGENT_ROLE.BRIDGE, ["system-action"]),
    "BUILDING-MAP": buildBuildingMapTemplate("controller", AGENT_ROLE.BRIDGE, ["system-action"], agentEntries),
    "COLLABORATION-GRAPH": buildCollaborationGraphTemplate("controller", AGENT_ROLE.BRIDGE, graph, []),
    "DELIVERY": buildDeliveryTemplate(),
    "PLATFORM-GUIDE": buildPlatformGuideTemplate("controller", AGENT_ROLE.BRIDGE, ["system-action"], graph, []),
  };
}

test("prompt-craft skill is the OpenClaw prompt standard", async () => {
  const skill = await readRepoFile("skills/prompt-craft/SKILL.md");

  assert.match(skill, /OpenClaw Prompt Standard|OpenClaw 提示词标准/u);
  assert.match(skill, /最小有用/u);
  assert.match(skill, /正向/u);
  assert.match(skill, /runtime.*stores|stores.*runtime|typed envelopes|policy|surface/u);
  assert.match(skill, /\[ACTION\].*JSON|JSON.*\[ACTION\]/u);

  assert.doesNotMatch(skill, /Anthropic\/OpenAI\/DeepSeek\/DeepMind/u);
  assert.doesNotMatch(skill, /MiniMax-M2\.5/u);
  assert.doesNotMatch(skill, /think step by step/i);
});

test("active generated prompts use minimal positive task language", () => {
  const documents = buildActivePromptDocuments();
  for (const [name, content] of Object.entries(documents)) {
    assert.doesNotMatch(content, NEGATIVE_TUTORING_PATTERN, `${name} contains negative tutorial wording`);
    assert.doesNotMatch(content, LEGACY_ROUTE_PATTERN, `${name} contains legacy route wording`);
  }
});

test("active prompt and UI sources no longer expose legacy route split wording", async () => {
  const sources = await Promise.all([
    readRepoFile("extensions/watchdog/lib/ingress/dispatch-entry.js"),
    readRepoFile("extensions/watchdog/lib/ingress/dispatch-execution-contract-entry.js"),
    readRepoFile("extensions/watchdog/lib/ingress/ingress-classification.js"),
    readRepoFile("extensions/watchdog/dashboard.js"),
    readRepoFile("extensions/watchdog/dashboard-flow-visuals.js"),
    readRepoFile("extensions/watchdog/tests/suite-model.js"),
    readRepoFile("extensions/watchdog/tests/suite-benchmark.js"),
  ]);

  for (const source of sources) {
    assert.doesNotMatch(source, LEGACY_ROUTE_PATTERN);
  }
});

test("active docs no longer teach retired prompt protocol surfaces", async () => {
  const docs = await Promise.all([
    readRepoFile("README.md"),
    readRepoFile("SYSTEM_MAP.md"),
    readRepoFile("wiki/concepts/workspace-guidance.md"),
    readRepoFile("wiki/concepts/loop.md"),
    readRepoFile("wiki/decisions/agent-as-classifier.md"),
  ]);

  for (const doc of docs) {
    assert.doesNotMatch(doc, /outbox\/system_action\.json/);
    assert.doesNotMatch(doc, /RUNTIME-RETURN\.md|runtime-return-tickets/);
    assert.doesNotMatch(doc, /\bstart_pipeline\b|\badvance_pipeline\b/);
    assert.doesNotMatch(doc, LEGACY_ROUTE_PATTERN);
  }
});

test("active OpenClaw skills use the prompt-craft standard", async () => {
  for (const skillId of ACTIVE_OPENCLAW_SKILL_IDS) {
    const skill = await readRepoFile(`skills/${skillId}/SKILL.md`);

    assert.doesNotMatch(skill, NEGATIVE_TUTORING_PATTERN, `${skillId} contains negative tutorial wording`);
    assert.doesNotMatch(skill, LEGACY_ROUTE_PATTERN, `${skillId} contains legacy route wording`);
    assert.doesNotMatch(skill, /outbox\/system_action\.json/, `${skillId} teaches file-based system action`);
    assert.doesNotMatch(skill, /RUNTIME-RETURN\.md|runtime-return-tickets/, `${skillId} teaches retired return surface`);
    assert.doesNotMatch(skill, /\bstart_pipeline\b|\badvance_pipeline\b/, `${skillId} teaches retired pipeline action`);
  }
});
