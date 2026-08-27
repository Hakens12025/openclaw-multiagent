import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import {
  buildAgentsTemplate,
  buildBuildingMapTemplate,
  buildCollaborationGraphTemplate,
  buildDeliveryTemplate,
  buildHeartbeatTemplate,
  buildPlatformGuideTemplate,
} from "../lib/prompt/platform-doc-builder.js";
import { renderRolePersonaBlock } from "../lib/prompt/role-spec-registry.js";
import { OC } from "../lib/state.js";

const PROMPT_NEGATIVE_PATTERNS = [
  /不要/u,
  /禁止/u,
  /不得/u,
  /不能/u,
  /不应/u,
  /不该/u,
  /不许/u,
  /不再/u,
  /不直接/u,
  /不手工/u,
  /不自造/u,
  /不发明/u,
  /不固定/u,
  /不预设/u,
  /不属于/u,
  /不替代/u,
  /不负责/u,
  /不靠/u,
  /\bDo not\b/iu,
  /\bDon't\b/iu,
  /\bNever\b/iu,
  /\bmust not\b/iu,
  /\bshould not\b/iu,
  /\bcannot\b/iu,
  /\bcan't\b/iu,
];

function assertPositivePromptCopy(label, content) {
  for (const pattern of PROMPT_NEGATIVE_PATTERNS) {
    assert.doesNotMatch(content, pattern, `${label} contains prompt-negative pattern ${pattern}`);
  }
}

function assertNoAbsenceTutorialCopy(label, content) {
  for (const pattern of [
    /没有待处理工作/u,
    /当前未加载/u,
    /入口都不存在/u,
  ]) {
    assert.doesNotMatch(content, pattern, `${label} contains absence tutorial copy ${pattern}`);
  }
}

test("managed agent guidance uses positive minimal prompt copy", () => {
  const skills = ["platform-map", "platform-tools", "error-avoidance", "system-action"];
  const graph = {
    edges: [
      { from: "controller", to: "planner" },
      { from: "planner", to: "worker" },
    ],
  };
  const loops = [{ id: "main-loop", entryAgentId: "planner", nodes: ["planner", "worker"], active: false }];
  const generated = {
    heartbeat: buildHeartbeatTemplate(),
    agents: buildAgentsTemplate("worker", AGENT_ROLE.EXECUTOR, skills),
    buildingMap: buildBuildingMapTemplate("worker", AGENT_ROLE.EXECUTOR, skills, [
      { id: "controller", role: AGENT_ROLE.BRIDGE, gateway: true, ingressSource: "webui", skills },
      { id: "planner", role: AGENT_ROLE.PLANNER, skills },
      { id: "worker", role: AGENT_ROLE.EXECUTOR, skills },
    ]),
    collaborationGraph: buildCollaborationGraphTemplate("worker", AGENT_ROLE.EXECUTOR, graph, loops),
    delivery: buildDeliveryTemplate(),
    platformGuide: buildPlatformGuideTemplate("worker", AGENT_ROLE.EXECUTOR, skills, graph, loops),
    bridgePersona: renderRolePersonaBlock(AGENT_ROLE.BRIDGE),
    plannerPersona: renderRolePersonaBlock(AGENT_ROLE.PLANNER),
    executorPersona: renderRolePersonaBlock(AGENT_ROLE.EXECUTOR),
    researcherPersona: renderRolePersonaBlock(AGENT_ROLE.RESEARCHER),
  };

  for (const [label, content] of Object.entries(generated)) {
    assertPositivePromptCopy(label, content);
    assertNoAbsenceTutorialCopy(label, content);
  }

  // 协作的主教学是工具调用;降级的文本标记路只留一个指针,语法教程搬去
  // COLLABORATION-FALLBACK.md——两者并排会形成竞争性指令,实测 agent 会在已持有
  // 工具的情况下退回去写标记。
  assert.match(generated.platformGuide, /调用协作工具/);
  assert.match(generated.platformGuide, /COLLABORATION-FALLBACK\.md/);
  assert.doesNotMatch(generated.platformGuide, /\[ACTION\]/, "标记语法归降级页,主页只留指针");
  assert.doesNotMatch(generated.platformGuide, /## 协作命令[\s\S]*(常用写法|规则：)/u);
});

test("default OpenClaw skill docs avoid negative tutorial prompt copy", async () => {
  const skillIds = [
    "error-avoidance",
    "operator-admin",
    "operator-tooling",
    "platform-map",
    "platform-tools",
    "system-action",
  ];

  for (const skillId of skillIds) {
    const content = await readFile(join(OC, "skills", skillId, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(`name:\\s*${skillId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `skills/${skillId}/SKILL.md has loadable frontmatter name`);
    assertPositivePromptCopy(`skills/${skillId}/SKILL.md`, content);
  }
});

test("platform-tools skill teaches runtime_result metadata without outbox manifest residue", async () => {
  const content = await readFile(join(OC, "skills", "platform-tools", "SKILL.md"), "utf8");

  assert.match(content, /outbox\/runtime_result\.json/);
  assert.match(content, /runtime status metadata/i);
  assert.doesNotMatch(content, /Runtime reads[\s\S]*(routing|delivery|harness|operator|automation|CLI evidence)/i);
  assert.doesNotMatch(content, /manifest/i);
  assert.doesNotMatch(content, /structured result/i);
});

test("operator tooling skill uses current delivery ticket and runtime_result vocabulary", async () => {
  const content = await readFile(join(OC, "skills", "operator-tooling", "SKILL.md"), "utf8");

  assert.match(content, /system_action_delivery_tickets\.list/);
  assert.match(content, /runtime_result/);
  assert.doesNotMatch(content, /runtime-return|runtime return|runtimeReturn/u);
});

test("runtime prompt surfaces avoid negative tutorial prompt copy", async () => {
  const sourcePaths = [
    join("hooks", "before-tool-call.js"),
    join("lib", "security", "security.js"),
    join("lib", "formal-runtime", "checks", "system-action-chain.js"),
  ];

  for (const sourcePath of sourcePaths) {
    const content = await readFile(join(OC, "extensions", "watchdog", sourcePath), "utf8");
    assertPositivePromptCopy(sourcePath, content);
  }
});

test("prompt-craft is the OpenClaw minimal prompt standard", async () => {
  const content = await readFile(join(OC, "skills", "prompt-craft", "SKILL.md"), "utf8");

  assert.match(content, /OpenClaw Prompt Standard/, "prompt-craft should expose the OpenClaw prompt standard");
  assert.match(content, /minimal useful prompt/i, "prompt-craft should center minimal useful prompts");
  assert.match(content, /runtime truth/i, "prompt-craft should keep runtime truth out of prompt prose");
  assert.match(content, /\[ACTION\]/, "prompt-craft should preserve formal ACTION protocol guidance");
  assert.doesNotMatch(content, /推理模型|通用模型|few-shot|CoT|think step by step/i, "prompt-craft should not be broad model-prompting guidance");
});

test("operator brain prompt stays surface-bound and topology-neutral", async () => {
  const content = await readFile(join(OC, "extensions", "watchdog", "lib", "operator", "operator-brain.js"), "utf8");

  assert.doesNotMatch(content, /Hard rules|Rules:/, "operator prompt should not be a rules lecture");
  assert.doesNotMatch(content, /no markdown fences/i, "operator prompt should use positive JSON output wording");
  assert.doesNotMatch(content, /front-desk|controller\s*<->|reporting to controller/i, "operator prompt should not invent controller topology semantics");
  assert.match(content, /executableSurfaces/, "operator prompt should stay bound to formal surfaces");
  assert.match(content, /advice_only/, "operator prompt should retain the non-execution answer mode");
});

test("installed OpenClaw skill docs avoid negative tutorial prompt copy", async () => {
  const skillIds = [
    "agent-bootstrap-designer",
    "browser-automation",
    "multi-agent-comm",
    "openclaw-system",
    "prompt-craft",
    "research-methodology",
    "skill-deployer",
  ];

  for (const skillId of skillIds) {
    const content = await readFile(join(OC, "skills", skillId, "SKILL.md"), "utf8");
    assertPositivePromptCopy(`skills/${skillId}/SKILL.md`, content);
  }
});

test("root managed guidance avoids negative tutorial prompt copy", async () => {
  const rootGuidancePaths = [
    "AGENTS.md",
    "BUILDING-MAP.md",
    "COLLABORATION-GRAPH.md",
    "DELIVERY.md",
    "HEARTBEAT.md",
    "PLATFORM-GUIDE.md",
    "SOUL.md",
  ];

  for (const sourcePath of rootGuidancePaths) {
    // 根托管文档是运行时生成物(platform-doc-builder),fresh checkout(公开 CI)缺席
    // = 无物可守,逐文件跳过;私有活树文件在,守卫照常全力。
    let content;
    try {
      content = await readFile(join(OC, sourcePath), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    assertPositivePromptCopy(sourcePath, content);
  }
});

test("active wiki concepts avoid negative prompt-style copy", async () => {
  const wikiPaths = [
    "wiki/concepts/delivery.md",
    "wiki/concepts/runtime-dispatch-queue.md",
    "wiki/concepts/conveyor-belt.md",
    "wiki/schema.md",
  ];

  for (const sourcePath of wikiPaths) {
    const content = await readFile(join(OC, sourcePath), "utf8");
    assertPositivePromptCopy(sourcePath, content);
    assert.doesNotMatch(content, /runtime-return|runtime return|runtimeReturn/u);
    assert.doesNotMatch(content, /contract-result-json/u);
    assert.doesNotMatch(content, /main-view contract actors/u);
    assert.doesNotMatch(content, /反模式|绝对禁止/u);
  }
});

