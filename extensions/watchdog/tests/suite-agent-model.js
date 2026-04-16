import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeDefaultSkillRefs,
  composeEffectiveSkillRefs,
  splitConfiguredDefaultSkillRefs,
} from "../lib/agent/agent-binding-policy.js";
import { resolveRouterHandlerForAgent } from "../lib/routing/runtime-mailbox-handler-registry.js";
import {
  normalizeStoredAgentConfig,
  normalizeStoredAgentBindings,
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../lib/agent/agent-binding-store.js";
import { composeDefaultCapabilityProjection } from "../lib/agent/agent-capability-policy.js";
import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { buildAgentDefaultsSnapshot } from "../lib/agent/agent-admin-defaults.js";
import { getCapabilityPreset } from "../lib/capability/capability-preset-registry.js";
import {
  composeAgentCardBase,
  composeAgentCardProjection,
} from "../lib/agent/agent-card-composer.js";
import { composeAgentBinding, composeEffectiveProfile } from "../lib/effective-profile-composer.js";
import {
  AGENT_ROLE,
  getAgentIdentitySnapshot,
  listGatewayAgentIds,
  registerRuntimeAgents,
  resolveGatewayAgentIdForSource,
} from "../lib/agent/agent-identity.js";
import { normalizeGraphEdges } from "../lib/agent/agent-graph.js";
import { buildManagementRegistry } from "../lib/management-registry-view.js";
import {
  getRoleSoulProfile,
  getRoleSpec,
  getRoleSummary,
} from "../lib/role-spec-registry.js";
import { runtimeAgentConfigs } from "../lib/state.js";

export const AGENT_MODEL_CASES = [
  {
    id: "binding-policy-default-skills",
    message: "默认 skill 装配来自 binding policy，而不是 bootstrap projection",
  },
  {
    id: "agent-card-base-separates-skills",
    message: "agent card 基底不再混入 capability，默认能力只存在于投影层",
  },
  {
    id: "effective-profile-derives-capability-skills",
    message: "effective profile 从 binding 组合出 capability skills",
  },
  {
    id: "role-spec-separates-capability-presets",
    message: "role spec 只保留角色语义，默认能力只存在于 capability preset",
  },
  {
    id: "executor-capability-preset-includes-network-search-tools",
    message: "executor 默认能力直接包含 web_search/web_fetch，新增 worker 不再额外补工具",
  },
  {
    id: "role-summary-stays-short-while-soul-profile-gets-richer",
    message: "短摘要继续服务卡片/UI， richer role profile 单独服务 SOUL",
  },
  {
    id: "planner-legacy-soul-upgrades-to-managed-template",
    message: "旧 planner SOUL 会被 guidance sync 自动升级到受管模板",
  },
  {
    id: "agents-guidance-reading-order-splits-self-directory-graph-and-return",
    message: "AGENTS 读取顺序改成 SOUL/contract/PLATFORM-GUIDE 常读，其余文档按需读",
  },
  {
    id: "legacy-generic-agents-upgrades-to-managed-template",
    message: "旧通用工作区 AGENTS 不再被 guidance sync 当作平台模板自动升级",
  },
  {
    id: "agent-binding-normalized-shape",
    message: "agent binding 以嵌套结构暴露 workspace/skills/capabilities，而不是散乱临时字段",
  },
  {
    id: "stored-binding-prefers-nested-config",
    message: "readStoredAgentBinding 以顶层 runtime 配置为真值，仅对 watchdog 专属残差回退到 binding",
  },
  {
    id: "stored-binding-write-keeps-binding-truth-only",
    message: "写入 binding 时把 runtime 共享字段投影回顶层，binding 只保留无顶层宿主的残差",
  },
  {
    id: "runtime-register-prefers-stored-binding",
    message: "runtime 注册优先读取 binding，而不是继续散读旧字段",
  },
  {
    id: "config-normalization-adds-binding",
    message: "整份 config 标准化时保留顶层 runtime 真值，并把 binding 里的重复字段收回去",
  },
  {
    id: "stored-binding-omits-implicit-false",
    message: "未声明的布尔策略不会在 binding 里被误写成 false",
  },
  {
    id: "identity-policies-not-inferred-from-role-or-skill",
    message: "gateway 和 specialized 只来自实例 policy，不再从 role 或 skill 反推",
  },
  {
    id: "router-handler-requires-capability-truth",
    message: "router handler 只来自 capability truth，不再按旧角色样式兜底",
  },
  {
    id: "effective-profile-exposes-policy-convenience",
    message: "effective profile 暴露实例 policy 便利字段，前端不必自行深挖 binding",
  },
  {
    id: "management-target-carries-policy-snapshot",
    message: "management target 直接携带 agent policy 摘要与快照，前端与 registry 共用同一真相",
  },
  {
    id: "management-target-carries-automation-harness-snapshot",
    message: "automation management target 会直接携带 harness 塑形摘要与运行快照",
  },
  {
    id: "test-source-requires-explicit-gateway-binding",
    message: "`source=test` 不再解析到内建 gateway，只有显式 binding 才能承接",
  },
  {
    id: "identity-requires-runtime-config-truth",
    message: "没有 runtime/card truth 时，不再按 legacy id 合成 role/gateway/protected/specialized",
  },
  {
    id: "worker-effective-profile-exposes-network-search-tools",
    message: "worker effective profile 从运行真值直接投影出 web_search/web_fetch",
  },
  {
    id: "graph-edge-dedupes-directed-pairs",
    message: "图边模型会折叠重复有向边，前端和 runtime 都只看到一条关系",
  },
];

function elapsedSeconds(startMs) {
  return ((Date.now() - startMs) / 1000).toFixed(1);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function passResult(testCase, results, startMs) {
  return {
    testCase,
    results,
    duration: elapsedSeconds(startMs),
    pass: true,
  };
}

function failResult(testCase, results, startMs) {
  return {
    testCase,
    results,
    duration: elapsedSeconds(startMs),
    pass: false,
  };
}

export async function runAgentModelCase(testCase) {
  const startMs = Date.now();
  const results = [];
  runtimeAgentConfigs.clear();

  try {
    if (testCase.id === "binding-policy-default-skills") {
      const config = {
        agents: {
          defaults: {
            skills: ["model-switcher", "platform-map"],
          },
        },
      };
      const split = splitConfiguredDefaultSkillRefs(config.agents.defaults.skills);
      const defaults = composeDefaultSkillRefs(config, "researcher");
      const snapshot = buildAgentDefaultsSnapshot(config);
      const effective = composeEffectiveSkillRefs({
        config,
        role: "researcher",
        configuredSkills: ["browser-automation"],
      });

      assert(split.configured.includes("model-switcher"), "configured defaults should preserve non-reserved skills");
      assert(split.ignored.includes("platform-map"), "reserved defaults should be filtered before persistence");
      assert(defaults.includes("platform-tools"), "default skills should include public platform tool guidance");
      assert(defaults.includes("error-avoidance"), "default skills should include forced platform skills");
      assert(defaults.includes("system-action"), "researcher role should inject system-action");
      assert(snapshot.effectivePlatformDefaultSkills.includes("platform-tools"), "defaults snapshot should expose public platform tool guidance");
      assert(snapshot.reservedConfiguredSkillIds.includes("platform-tools"), "semantic defaults should be reserved from configured defaults");
      assert(snapshot.roleInjectedDefaultSkills["system-action"]?.includes("researcher"), "defaults snapshot should expose role-scoped semantic injection");
      assert(effective.includes("browser-automation"), "effective skills should include configured agent skills");
      results.push({ id: 1, name: "Compose default skills", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Compose effective skills", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "agent-card-base-separates-skills") {
      const baseCard = composeAgentCardBase({
        agentId: "worker-z",
        role: "executor",
      });
      const defaultCapabilities = composeDefaultCapabilityProjection({
        role: "executor",
        skills: ["platform-map", "browser-automation"],
      });
      const projection = composeAgentCardProjection({
        agentId: "worker-z",
        role: "executor",
        skills: ["platform-map", "browser-automation"],
      });

      assert(baseCard.capabilities == null, "base card should not contain capability projection");
      assert(Array.isArray(defaultCapabilities.tools), "default capability policy should provide tool defaults");
      assert(Array.isArray(projection.capabilities?.skills), "projection should contain skills");
      assert(Array.isArray(projection.capabilities?.tools), "projection should contain default tools");
      assert(projection.capabilities.skills.includes("browser-automation"), "projection should preserve injected skills");
      assert(projection.capabilities.tools.length === defaultCapabilities.tools.length, "projection should use capability policy defaults");
      results.push({ id: 1, name: "Keep base clean", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Project capabilities separately", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "effective-profile-derives-capability-skills") {
      const profile = composeEffectiveProfile({
        config: {
          agents: {
            defaults: {
              skills: ["model-switcher"],
            },
          },
        },
        agentConfig: {
          id: "worker-z",
          binding: {
            roleRef: "researcher",
            workspace: { configured: "~/.openclaw/workspaces/worker-z" },
            model: { ref: "demo/model" },
            skills: { configured: ["browser-automation"] },
          },
        },
        card: null,
      });

      assert(profile.defaultSkills.includes("model-switcher"), "profile should preserve default skill refs");
      assert(profile.effectiveSkills.includes("browser-automation"), "profile should include configured skill refs");
      assert(Array.isArray(profile.capabilities?.skills), "capability projection should expose effective skills");
      assert(profile.capabilities.skills.length === profile.effectiveSkills.length, "capability skills should mirror effective skills");
      results.push({ id: 1, name: "Derive effective profile", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Project capability skills", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "role-spec-separates-capability-presets") {
      const roleSpec = getRoleSpec("researcher");
      const capabilityPreset = getCapabilityPreset("researcher");

      assert(roleSpec.soulTemplateId === "researcher-v1", "role spec should keep soul template semantics");
      assert(!Object.prototype.hasOwnProperty.call(roleSpec, "tools"), "role spec should not contain default tools");
      assert(!Object.prototype.hasOwnProperty.call(roleSpec, "routerHandlerId"), "role spec should not contain router defaults");
      assert(Array.isArray(capabilityPreset.tools), "capability preset should contain default tools");
      assert(Array.isArray(capabilityPreset.outboxCommitKinds), "capability preset should contain outbox commit defaults");
      assert(capabilityPreset.routerHandlerId === "research_search_space", "capability preset should keep router default");
      results.push({ id: 1, name: "Keep role spec semantic", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Move defaults into capability preset", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "executor-capability-preset-includes-network-search-tools") {
      const capabilityPreset = getCapabilityPreset("executor");

      assert(Array.isArray(capabilityPreset.tools), "executor capability preset should contain default tools");
      assert(capabilityPreset.tools.includes("web_search"), "executor capability preset should include web_search");
      assert(capabilityPreset.tools.includes("web_fetch"), "executor capability preset should include web_fetch");
      results.push({ id: 1, name: "Include web_search by default", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Include web_fetch by default", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "role-summary-stays-short-while-soul-profile-gets-richer") {
      const roleSpec = getRoleSpec("researcher");
      const soulProfile = getRoleSoulProfile("researcher");
      const card = composeAgentCardBase({
        agentId: "researcher",
        role: "researcher",
      });

      assert(card.description === getRoleSummary("researcher"), "agent card should continue using short role summary");
      assert(card.description === roleSpec.summary, "card description should match role spec summary");
      assert(typeof soulProfile.persona === "string" && soulProfile.persona.length > 0, "soul profile should expose persona");
      assert(typeof soulProfile.qualityBar === "string" && soulProfile.qualityBar.length > 0, "soul profile should expose quality bar");
      assert(Array.isArray(soulProfile.operatingPrinciples) && soulProfile.operatingPrinciples.length >= 3, "soul profile should expose operating principles");
      assert(card.description !== soulProfile.persona, "persona should not leak into card summary");
      results.push({ id: 1, name: "Keep card summary short", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Expose richer soul profile separately", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "planner-legacy-soul-upgrades-to-managed-template") {
      const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-planner-soul-"));
      const legacySoul = `# Contractor

任务规划者。职责：读取 Contract，判断该任务应走标准一次性执行链路，还是应交给已登记的 graph-backed loop；然后把决定写到 outbox。

## 状态机

\`\`\`
唤醒
├─ inbox/ 有 contract.json → 判断路径 → 写协作动作或 outbox/result.json → 停止
└─ inbox/ 为空 → HEARTBEAT_OK → 停止
\`\`\`
`;

      try {
        await writeFile(join(workspaceDir, "SOUL.md"), legacySoul, "utf8");
        const updates = await syncAgentWorkspaceGuidance({
          agentId: "contractor",
          role: "planner",
          skills: ["platform-map", "platform-tools", "system-action"],
          workspaceDir,
          graph: { edges: [] },
          loops: [],
        });
        const soul = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
        const soulUpdate = updates.find((entry) => entry.name === "SOUL.md");

        assert(soulUpdate?.updated === true, "legacy planner soul should be reported as updated");
        assert(soul.includes("<!-- managed-by-watchdog:agent-bootstrap -->"), "planner soul should gain managed marker");
        assert(soul.includes("## 工作原则"), "planner soul should include role principles section");
        assert(soul.includes("规划节点。负责把任务拆成可执行阶段，不直接越权执行。"), "planner soul should use new short role summary");
        assert(soul.includes("规划只负责把工作说清楚，不替代 runtime 决定协作真值"), "planner soul should use new planner boundary");
        results.push({ id: 1, name: "Upgrade legacy planner soul", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Render managed planner template", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }

    if (testCase.id === "agents-guidance-reading-order-splits-self-directory-graph-and-return") {
      const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-guidance-order-"));

      try {
        runtimeAgentConfigs.set("controller", { id: "controller", role: "bridge", gateway: true, ingressSource: "webui", specialized: false, skills: ["system-action"] });
        runtimeAgentConfigs.set("bridge-office", { id: "bridge-office", role: "bridge", gateway: false, ingressSource: null, specialized: false, skills: [] });
        runtimeAgentConfigs.set("worker-a", { id: "worker-a", role: "executor", gateway: false, ingressSource: null, specialized: false, skills: [] });
        runtimeAgentConfigs.set("evaluator", { id: "evaluator", role: "evaluator", gateway: false, ingressSource: null, specialized: false, skills: ["system-action"] });

        await syncAgentWorkspaceGuidance({
          agentId: "bridge-office",
          role: "bridge",
          skills: ["platform-map", "platform-tools", "system-action"],
          workspaceDir,
          graph: {
            edges: [
              { from: "bridge-office", to: "worker-a", label: "assign", gates: [], metadata: {} },
              { from: "worker-a", to: "evaluator", label: "review", gates: [], metadata: {} },
            ],
          },
          loops: [],
        });

        const agents = await readFile(join(workspaceDir, "AGENTS.md"), "utf8");
        const buildingMap = await readFile(join(workspaceDir, "BUILDING-MAP.md"), "utf8");
        const collaborationGraph = await readFile(join(workspaceDir, "COLLABORATION-GRAPH.md"), "utf8");
        const delivery = await readFile(join(workspaceDir, "DELIVERY.md"), "utf8");

        assert(agents.includes("1. `SOUL.md`"), "agents doc should keep SOUL as first read");
        assert(agents.includes("2. `inbox/contract.json`"), "agents doc should read current contract before guidance docs");
        assert(agents.includes("3. `PLATFORM-GUIDE.md`"), "agents doc should read platform guide before on-demand docs");
        assert(agents.includes("需要找协作者时再查 `BUILDING-MAP.md`"), "agents doc should make building map on-demand");
        assert(agents.includes("准备显式协作时再查 `COLLABORATION-GRAPH.md`"), "agents doc should make graph guidance on-demand");
        assert(agents.includes("处理 delivery 语义时再查 `DELIVERY.md`"), "agents doc should make delivery guidance on-demand");
        assert(!buildingMap.includes("- Agent:"), "building map should not carry self identity");
        assert(!buildingMap.includes("你可直接调用"), "building map should not carry graph permission text");
        assert(!buildingMap.includes("协作入口:"), "building map should not carry action entry text");
        assert(!buildingMap.includes("已知 skills:"), "building map should not carry skill inventory");
        assert(!buildingMap.includes("replyTo"), "building map should not carry delivery routing fields");
        assert(!buildingMap.includes("upstreamReplyTo"), "building map should not carry upstream delivery routing fields");
        assert(!buildingMap.includes("systemActionDeliveryTicket"), "building map should not carry runtime ticket fields");
        assert(!buildingMap.includes("system_action delivery"), "building map should not describe delivery routing");
        assert(collaborationGraph.includes("你可直接调用"), "collaboration graph should carry graph permission text");
        assert(delivery.includes("replyTo"), "delivery doc should explain replyTo");

        results.push({ id: 1, name: "Split AGENTS reading order", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Split map/graph/return docs", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }

    if (testCase.id === "legacy-generic-agents-upgrades-to-managed-template") {
      const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-legacy-agents-"));
      const legacyAgents = `# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Every Session

1. Read \`SOUL.md\` — this is who you are
2. Read \`USER.md\` — this is who you're helping
`;

      try {
        await writeFile(join(workspaceDir, "AGENTS.md"), legacyAgents, "utf8");
        const updates = await syncAgentWorkspaceGuidance({
          agentId: "worker-d",
          role: "executor",
          skills: ["platform-tools"],
          workspaceDir,
          graph: { edges: [] },
          loops: [],
        });
        const agents = await readFile(join(workspaceDir, "AGENTS.md"), "utf8");
        const agentUpdate = updates.find((entry) => entry.name === "AGENTS.md");

        assert(agentUpdate?.updated === false, "legacy generic agents doc should no longer be auto-updated");
        assert(!agents.includes("<!-- managed-by-watchdog:agent-bootstrap -->"), "legacy generic agents doc should remain unmanaged");
        assert(agents.includes("This folder is home. Treat it that way."), "legacy generic agents doc should remain untouched");
        results.push({ id: 1, name: "Reject legacy generic AGENTS auto-upgrade", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Leave unmanaged AGENTS untouched", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }

    if (testCase.id === "agent-binding-normalized-shape") {
      const binding = composeAgentBinding({
        config: {
          agents: {
            defaults: {
              skills: ["model-switcher"],
            },
          },
        },
        agentConfig: {
          id: "worker-z",
          binding: {
            roleRef: "researcher",
            workspace: { configured: "~/.openclaw/workspaces/worker-z" },
            model: { ref: "demo/model" },
            heartbeat: { configuredEvery: "12h" },
            skills: { configured: ["browser-automation"] },
            capabilities: {
              configured: {
                tools: ["read", "write"],
              },
            },
          },
        },
        card: {
          capabilities: {
            outputFormats: ["markdown"],
          },
        },
      });

      assert(binding.workspace?.configured?.includes("workspaces/worker-z"), "binding should expose configured workspace");
      assert(binding.workspace?.effective?.includes("workspaces/worker-z"), "binding should expose effective workspace");
      assert(binding.model?.ref === "demo/model", "binding should expose model ref");
      assert(binding.heartbeat?.configuredEvery === "12h", "binding should expose configured heartbeat");
      assert(Array.isArray(binding.skills?.effective), "binding should expose effective skills");
      assert(Array.isArray(binding.capabilities?.defaults?.tools), "binding should expose default capability projection");
      assert(Array.isArray(binding.capabilities?.configured?.tools), "binding should expose configured capability overrides");
      assert(Array.isArray(binding.capabilities?.projected?.outputFormats), "binding should expose projected capability overrides");
      assert(!Object.prototype.hasOwnProperty.call(binding, "configuredWorkspace"), "binding should not expose legacy flat workspace fields");
      assert(!Object.prototype.hasOwnProperty.call(binding, "configuredCapabilities"), "binding should not expose legacy flat capability fields");
      results.push({ id: 1, name: "Expose nested binding sections", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Drop flat legacy fields", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "stored-binding-prefers-nested-config") {
      const agentConfig = {
        id: "worker-z",
        role: "executor",
        workspace: "~/.openclaw/workspaces/legacy-worker-z",
        model: { primary: "demo/legacy-model" },
        heartbeat: { every: "24h" },
        skills: ["legacy-skill"],
        tools: {
          allow: ["write"],
        },
        binding: {
          roleRef: "researcher",
          workspace: { configured: "~/.openclaw/workspaces/worker-z" },
          model: { ref: "demo/binding-model" },
          heartbeat: { configuredEvery: "8h" },
          skills: { configured: ["browser-automation"] },
          capabilities: {
            configured: {
              tools: ["Read", "web_fetch"],
              routerHandlerId: "binding_route",
              outboxCommitKinds: ["research_search_space"],
            },
          },
          policies: {
            ingressSource: "qq",
            specialized: true,
          },
        },
      };
      const storedBinding = readStoredAgentBinding(agentConfig);
      const effectiveBinding = composeAgentBinding({
        config: {
          agents: {
            defaults: {
              skills: ["model-switcher"],
            },
          },
        },
        agentConfig,
        card: null,
      });

      assert(storedBinding.roleRef === "executor", "stored binding should prefer top-level roleRef");
      assert(storedBinding.workspace?.configured?.endsWith("/legacy-worker-z"), "stored binding should prefer top-level workspace");
      assert(storedBinding.model?.ref === "demo/legacy-model", "stored binding should prefer top-level model ref");
      assert(storedBinding.heartbeat?.configuredEvery === "24h", "stored binding should prefer top-level heartbeat");
      assert(storedBinding.skills?.configured?.includes("legacy-skill"), "stored binding should prefer top-level configured skills");
      assert(!storedBinding.skills?.configured?.includes("browser-automation"), "stored binding should not shadow top-level skills with nested duplicates");
      assert(storedBinding.capabilities?.configured?.tools?.includes("write"), "stored binding should normalize top-level tool overrides");
      assert(storedBinding.capabilities?.configured?.routerHandlerId === "binding_route", "stored binding should keep watchdog-only router handler residue");
      assert(effectiveBinding.roleRef === "executor", "effective binding should use runtime role truth");
      assert(effectiveBinding.model?.ref === "demo/legacy-model", "effective binding should use runtime model truth");
      assert(effectiveBinding.heartbeat?.configuredEvery === "24h", "effective binding should use runtime heartbeat truth");
      assert(effectiveBinding.skills?.configured?.includes("legacy-skill"), "effective binding should use runtime skills truth");
      assert(effectiveBinding.policies?.ingressSource === "qq", "effective binding should expose stored ingress policy");
      assert(effectiveBinding.policies?.specialized === true, "effective binding should expose stored specialized policy");
      results.push({ id: 1, name: "Prefer runtime top-level truth", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Compose effective binding from unified config", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "stored-binding-write-keeps-binding-truth-only") {
      const agent = { id: "worker-z" };
      writeStoredAgentBinding(agent, {
        roleRef: "evaluator",
        workspace: {
          configured: "~/.openclaw/workspaces/worker-z",
        },
        model: {
          ref: "demo/evaluator-model",
        },
        heartbeat: {
          configuredEvery: "6h",
        },
        skills: {
          configured: ["model-switcher"],
        },
        capabilities: {
          configured: {
            tools: ["Read", "Write"],
            inputFormats: ["json"],
            routerHandlerId: "evaluation_route",
            outboxCommitKinds: ["evaluation_result"],
          },
        },
        policies: {
          protected: true,
          specialized: false,
          ingressSource: "qq",
        },
      });
      const roundTrip = readStoredAgentBinding(agent);

      assert(agent.role === "evaluator", "runtime role truth should live at top-level");
      assert(agent.workspace === "~/.openclaw/workspaces/worker-z", "runtime workspace truth should live at top-level");
      assert(agent.model?.primary === "demo/evaluator-model", "runtime model truth should live at top-level");
      assert(agent.heartbeat?.every === "6h", "runtime heartbeat truth should live at top-level");
      assert(Array.isArray(agent.skills) && agent.skills.includes("model-switcher"), "runtime skills truth should live at top-level");
      assert(agent.tools?.allow?.includes("read"), "runtime tool overrides should live at top-level");
      assert(agent.routerHandlerId === "evaluation_route", "router handler should live at top-level");
      assert(agent.outboxCommitKinds?.includes("evaluation_result"), "outbox kinds should live at top-level");
      assert(agent.protected === true, "runtime protected policy should live at top-level");
      assert(agent.ingressSource === "qq", "runtime ingress policy should live at top-level");
      assert(agent.binding?.roleRef == null, "binding should not shadow top-level role truth");
      assert(agent.binding?.workspace == null, "binding should not shadow top-level workspace truth");
      assert(agent.binding?.model == null, "binding should not shadow top-level model truth");
      assert(agent.binding?.heartbeat == null, "binding should not shadow top-level heartbeat truth");
      assert(agent.binding?.capabilities?.configured?.inputFormats?.includes("json"), "binding should keep watchdog-only capability residue");
      assert(roundTrip.model?.ref === "demo/evaluator-model", "round-trip should preserve model ref");
      assert(roundTrip.capabilities?.configured?.tools?.length === 2, "round-trip should preserve tool overrides");
      assert(roundTrip.policies?.ingressSource === "qq", "round-trip should preserve policies inside binding");
      results.push({ id: 1, name: "Project runtime truth to top-level", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Round-trip stored binding view", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "runtime-register-prefers-stored-binding") {
      registerRuntimeAgents({
        agents: {
          list: [
            {
              id: "worker-z",
              role: "executor",
              skills: ["legacy-skill"],
              binding: {
                roleRef: "researcher",
                workspace: { configured: "~/.openclaw/workspaces/worker-z" },
                skills: { configured: ["model-switcher"] },
                capabilities: {
                  configured: {
                    routerHandlerId: "binding_route",
                    outboxCommitKinds: ["research_search_space"],
                  },
                },
                policies: {
                  gateway: true,
                  protected: true,
                  ingressSource: "qq",
                },
              },
            },
          ],
        },
      });
      const runtime = runtimeAgentConfigs.get("worker-z");

      assert(runtime?.role === "researcher", "runtime registration should prefer stored binding role");
      assert(runtime?.workspace?.endsWith("/worker-z"), "runtime registration should prefer stored binding workspace");
      assert(runtime?.skills?.includes("model-switcher"), "runtime registration should prefer stored binding skills");
      assert(runtime?.gateway === true, "runtime registration should prefer stored binding gateway policy");
      assert(runtime?.protected === true, "runtime registration should prefer stored binding protected policy");
      assert(runtime?.ingressSource === "qq", "runtime registration should prefer stored binding ingress policy");
      assert(runtime?.capabilities?.routerHandlerId === "binding_route", "runtime registration should prefer stored binding router handler");
      assert(runtime?.capabilities?.outboxCommitKinds?.includes("research_search_space"), "runtime registration should prefer stored binding outbox kinds");
      runtimeAgentConfigs.clear();
      results.push({ id: 1, name: "Register runtime from stored binding", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "config-normalization-adds-binding") {
      const config = {
        agents: {
          list: [
            {
              id: "controller",
              role: "bridge",
              gateway: true,
              ingressSource: "webui",
              protected: true,
              workspace: "~/.openclaw/workspaces/controller",
              model: { primary: "demo/controller" },
              heartbeat: { every: "2h" },
              skills: ["system-action"],
              tools: { allow: ["Read", "Write"] },
              binding: {
                roleRef: "bridge",
                workspace: { configured: "~/.openclaw/workspaces/controller" },
                model: { ref: "demo/controller" },
                heartbeat: { configuredEvery: "2h" },
                skills: { configured: ["system-action"] },
                capabilities: {
                  configured: {
                    tools: ["read", "write"],
                  },
                },
                policies: {
                  gateway: true,
                  ingressSource: "webui",
                  protected: true,
                },
              },
            },
            {
              id: "worker-z",
              role: "executor",
              workspace: "~/.openclaw/workspaces/worker-z",
              model: { primary: "demo/worker" },
              specialized: true,
              binding: {
                roleRef: "executor",
                workspace: { configured: "~/.openclaw/workspaces/worker-z" },
                model: { ref: "demo/worker" },
                policies: {
                  specialized: true,
                },
              },
            },
          ],
        },
      };
      const changed = normalizeStoredAgentBindings(config);
      const controller = config.agents.list[0];
      const worker = config.agents.list[1];

      assert(changed === true, "config normalization should report structural change");
      assert(controller.role === "bridge", "controller should keep runtime role truth at top-level");
      assert(controller.workspace === "~/.openclaw/workspaces/controller", "controller should keep runtime workspace truth at top-level");
      assert(controller.model?.primary === "demo/controller", "controller should keep runtime model truth at top-level");
      assert(controller.heartbeat?.every === "2h", "controller should keep runtime heartbeat truth at top-level");
      assert(Array.isArray(controller.skills) && controller.skills.includes("system-action"), "controller should keep runtime skills truth at top-level");
      assert(controller.tools?.allow?.includes("read"), "controller should keep runtime tool truth at top-level");
      assert(controller.gateway === true, "controller should keep runtime gateway truth at top-level");
      assert(controller.protected === true, "controller should keep runtime protected truth at top-level");
      assert(controller.ingressSource === "webui", "controller should keep runtime ingress truth at top-level");
      assert(controller.binding?.roleRef == null, "controller binding should drop duplicated role truth");
      assert(controller.binding?.workspace == null, "controller binding should drop duplicated workspace truth");
      assert(controller.binding?.model == null, "controller binding should drop duplicated model truth");
      assert(controller.binding?.heartbeat == null, "controller binding should drop duplicated heartbeat truth");
      assert(controller.binding?.skills == null, "controller binding should drop duplicated skills truth");
      assert(controller.binding?.capabilities == null, "controller binding should drop duplicated tool truth");
      assert(controller.binding?.policies == null, "controller binding should drop duplicated policy truth");
      assert(worker.role === "executor", "worker should keep runtime role truth at top-level");
      assert(worker.workspace === "~/.openclaw/workspaces/worker-z", "worker should keep runtime workspace truth at top-level");
      assert(worker.model?.primary === "demo/worker", "worker should keep runtime model truth at top-level");
      assert(worker.specialized === true, "worker should keep runtime specialized truth at top-level");
      assert(worker.binding?.roleRef == null, "worker binding should drop duplicated role truth");
      assert(worker.binding?.model == null, "worker binding should drop duplicated model truth");
      assert(worker.binding?.policies == null, "worker binding should drop duplicated specialized truth");
      results.push({ id: 1, name: "Keep top-level runtime truth and strip binding shadows", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "stored-binding-omits-implicit-false") {
      const agent = normalizeStoredAgentConfig({
        id: "researcher",
        binding: {
          roleRef: "researcher",
          workspace: { configured: "~/.openclaw/workspaces/researcher" },
          model: { ref: "demo/researcher" },
        },
      });

      assert(!Object.prototype.hasOwnProperty.call(agent, "gateway"), "legacy gateway false should not be synthesized");
      assert(!Object.prototype.hasOwnProperty.call(agent, "protected"), "legacy protected false should not be synthesized");
      assert(!Object.prototype.hasOwnProperty.call(agent, "specialized"), "legacy specialized false should not be synthesized");
      assert(!Object.prototype.hasOwnProperty.call(agent.binding?.policies || {}, "gateway"), "binding gateway false should not be synthesized");
      assert(!Object.prototype.hasOwnProperty.call(agent.binding?.policies || {}, "protected"), "binding protected false should not be synthesized");
      assert(!Object.prototype.hasOwnProperty.call(agent.binding?.policies || {}, "specialized"), "binding specialized false should not be synthesized");
      results.push({ id: 1, name: "Keep implicit false absent", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "identity-policies-not-inferred-from-role-or-skill") {
      registerRuntimeAgents({
        agents: {
          list: [
            {
              id: "bridge-office",
              binding: {
                roleRef: "bridge",
                workspace: { configured: "~/.openclaw/workspaces/bridge-office" },
                model: { ref: "demo/bridge" },
              },
            },
            {
              id: "worker-z",
              binding: {
                roleRef: "executor",
                workspace: { configured: "~/.openclaw/workspaces/worker-z" },
                model: { ref: "demo/worker" },
                skills: { configured: ["browser-automation"] },
              },
            },
          ],
        },
      });
      const deliveryIdentity = getAgentIdentitySnapshot("bridge-office");
      const workerIdentity = getAgentIdentitySnapshot("worker-z");
      const gatewayIds = listGatewayAgentIds();

      assert(deliveryIdentity.role === "bridge", "bridge office should keep bridge role");
      assert(deliveryIdentity.gateway === false, "bridge role alone should not imply gateway");
      assert(deliveryIdentity.gatewaySource === "default", "bridge role gateway should stay default when policy absent");
      assert(workerIdentity.role === "executor", "worker should keep executor role");
      assert(workerIdentity.specialized === false, "browser-automation skill alone should not imply specialized");
      assert(workerIdentity.specializedSource === "default", "skill-based specialized inference should be removed");
      assert(!gatewayIds.includes("bridge-office"), "nongateway bridge should not appear in gateway list");
      results.push({ id: 1, name: "Do not infer gateway from role", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Do not infer specialized from skill", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "router-handler-requires-capability-truth") {
      const legacyHandler = resolveRouterHandlerForAgent("researcher");
      assert(legacyHandler === null, "researcher should not get router handler from legacy role matching");

      registerRuntimeAgents({
        agents: {
          list: [
            {
              id: "researcher",
              binding: {
                roleRef: "researcher",
                workspace: { configured: "~/.openclaw/workspaces/researcher" },
                model: { ref: "demo/researcher" },
                capabilities: {
                  configured: {
                    routerHandlerId: "research_search_space",
                    outboxCommitKinds: ["research_search_space"],
                  },
                },
              },
            },
          ],
        },
      });
      const configuredHandler = resolveRouterHandlerForAgent("researcher");
      assert(configuredHandler?.id === "research_search_space", "researcher should resolve router handler from capability truth");
      results.push({ id: 1, name: "Remove role-style router fallback", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Honor capability router truth", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "effective-profile-exposes-policy-convenience") {
      const profile = composeEffectiveProfile({
        config: {
          agents: {
            defaults: {
              skills: ["browser-automation"],
            },
          },
        },
        agentConfig: {
          id: "worker-z",
          binding: {
            roleRef: "executor",
            workspace: { configured: "~/.openclaw/workspaces/worker-z" },
            model: { ref: "demo/executor" },
            policies: {
              gateway: true,
              protected: true,
              ingressSource: "qq",
              specialized: true,
            },
          },
        },
      });

      assert(profile.gateway === true, "effective profile should expose gateway convenience field");
      assert(profile.protected === true, "effective profile should expose protected convenience field");
      assert(profile.ingressSource === "qq", "effective profile should expose ingressSource convenience field");
      assert(profile.specialized === true, "effective profile should expose specialized convenience field");
      assert(profile.policies?.gateway === true, "effective profile should expose policies snapshot");
      results.push({ id: 1, name: "Expose top-level policy fields", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Preserve binding policy snapshot", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "management-target-carries-policy-snapshot") {
      const agent = composeEffectiveProfile({
        config: {
          agents: {
            defaults: {
              skills: ["browser-automation"],
            },
          },
        },
        agentConfig: {
          id: "worker-z",
          binding: {
            roleRef: "executor",
            workspace: { configured: "~/.openclaw/workspaces/worker-z" },
            model: { ref: "demo/executor" },
            policies: {
              gateway: true,
              ingressSource: "webui",
              specialized: true,
            },
          },
        },
        card: {
          name: "Worker Z",
          description: "Executes coding tasks",
        },
      });
      const registry = buildManagementRegistry({
        agents: [agent],
        models: [],
        agentDefaults: { ok: true },
      });
      const subject = registry.management.subjects.find((entry) => entry.kind === "agent");
      const target = subject?.targets?.find((entry) => entry.id === "worker-z");

      assert(target, "agent management subject should expose worker-z target");
      assert(target.policies?.gateway === true, "management target should expose policy snapshot");
      assert(target.policies?.ingressSource === "webui", "management target should expose ingress source");
      assert(target.policySummary?.includes("gateway:webui"), "management target should expose readable policy summary");
      assert(target.applySurfaceIds?.includes("agents.policy"), "management target should expose agents.policy apply surface");
      assert(target.snapshot?.binding?.policies?.specialized === true, "management target snapshot should preserve binding policies");
      results.push({ id: 1, name: "Build target policy summary", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Preserve snapshot for frontend", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "management-target-carries-automation-harness-snapshot") {
      const registry = buildManagementRegistry({
        agents: [],
        models: [],
        automations: [{
          id: "loop-automation",
          objective: {
            summary: "Loop Automation",
            domain: "generic",
          },
          entry: {
            targetAgent: "researcher",
          },
          runtime: {
            status: "running",
            currentRound: 7,
            activeHarnessRun: {
              id: "harness:loop-automation:round:7",
              round: 7,
              status: "running",
              gateSummary: {
                verdict: "pending",
                pendingModuleIds: ["harness:gate.artifact"],
              },
              moduleCounts: {
                pending: 2,
                failed: 0,
              },
            },
          },
          summary: {
            objectiveSummary: "Loop Automation",
            objectiveDomain: "generic",
            targetAgent: "researcher",
            runtimeStatus: "running",
            currentRound: 7,
            executionMode: "hybrid",
            assuranceLevel: "medium_assurance",
            harnessEnabled: true,
            harnessProfileId: "experiment.research_cycle",
            harnessProfileTrustLevel: "provisional",
            harnessCoverage: {
              hardShaped: ["artifact_capture"],
              softGuided: ["experiment_memo"],
              freeform: ["research_reasoning"],
            },
            harnessCoverageCounts: {
              hardShaped: 1,
              softGuided: 1,
              freeform: 1,
            },
            activeHarnessGateVerdict: "pending",
            activeHarnessPendingModuleCount: 2,
            activeHarnessFailedModuleCount: 0,
            recentHarnessRunCount: 3,
          },
        }],
        agentDefaults: { ok: true },
      });
      const subject = registry.management.subjects.find((entry) => entry.kind === "automation");
      const target = subject?.targets?.find((entry) => entry.id === "loop-automation");

      assert(target, "automation management subject should expose loop-automation target");
      assert(target.meta?.includes("researcher"), "automation target should expose target agent in meta");
      assert(target.detail?.includes("profile:experiment.research_cycle"), "automation target should expose harness profile in detail");
      assert(target.applySurfaceIds?.includes("automations.run"), "automation target should expose automations.run surface");
      assert(target.snapshot?.summary?.harnessCoverage?.hardShaped?.includes("artifact_capture"), "automation target snapshot should preserve hard-shaped coverage");
      assert(target.snapshot?.runtime?.activeHarnessRun?.gateSummary?.verdict === "pending", "automation target snapshot should preserve active gate verdict");
      assert(target.snapshot?.management?.selector?.value === "loop-automation", "automation target snapshot should preserve management selector");
      results.push({ id: 1, name: "Build automation target summary", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Preserve harness snapshot for frontend", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "test-source-requires-explicit-gateway-binding") {
      const legacyTestGateway = resolveGatewayAgentIdForSource("test");
      const legacyGatewayIds = listGatewayAgentIds();

      assert(legacyTestGateway === null, "test source should not resolve to a built-in gateway");
      assert(!legacyGatewayIds.includes("test"), "gateway list should not contain removed built-in test agent");

      registerRuntimeAgents({
        agents: {
          list: [
            {
              id: "qa-gateway",
              binding: {
                roleRef: "bridge",
                workspace: { configured: "~/.openclaw/workspaces/qa-gateway" },
                model: { ref: "demo/qa-gateway" },
                policies: {
                  gateway: true,
                  ingressSource: "test",
                },
              },
            },
          ],
        },
      });
      const configuredTestGateway = resolveGatewayAgentIdForSource("test");
      const configuredGatewayIds = listGatewayAgentIds();

      assert(configuredTestGateway === "qa-gateway", "explicit gateway binding should own test source");
      assert(configuredGatewayIds.includes("qa-gateway"), "explicit test gateway should appear in gateway list");
      results.push({ id: 1, name: "Remove built-in test gateway", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Honor explicit test gateway binding", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "identity-requires-runtime-config-truth") {
      const unknownController = getAgentIdentitySnapshot("controller");
      const unknownWorker = getAgentIdentitySnapshot("worker-d");

      assert(unknownController.role === AGENT_ROLE.AGENT, "controller should stay generic without runtime/card truth");
      assert(unknownController.roleSource === "default", "controller role should no longer come from legacy id");
      assert(unknownController.gateway === false, "controller should not synthesize gateway without policy truth");
      assert(unknownController.gatewaySource === "default", "controller gateway should stay default without policy truth");
      assert(unknownController.protected === false, "controller should not synthesize protected without policy truth");
      assert(unknownController.protectedSource === "default", "controller protected should stay default without policy truth");
      assert(unknownWorker.role === AGENT_ROLE.AGENT, "worker should stay generic without runtime/card truth");
      assert(unknownWorker.roleSource === "default", "worker role should no longer come from legacy id");
      assert(unknownWorker.specialized === false, "worker should not synthesize specialized without policy truth");
      assert(unknownWorker.specializedSource === "default", "worker specialized should stay default without policy truth");

      registerRuntimeAgents({
        agents: {
          list: [
            {
              id: "controller",
              binding: {
                roleRef: "bridge",
                workspace: { configured: "~/.openclaw/workspaces/controller" },
                model: { ref: "demo/controller" },
              },
            },
            {
              id: "worker-d",
              binding: {
                roleRef: "executor",
                workspace: { configured: "~/.openclaw/workspaces/worker-d" },
                model: { ref: "demo/worker-d" },
              },
            },
          ],
        },
      });
      const configuredController = getAgentIdentitySnapshot("controller");
      const configuredWorker = getAgentIdentitySnapshot("worker-d");

      assert(configuredController.role === "bridge", "runtime config should set controller role explicitly");
      assert(configuredController.roleSource === "config", "runtime-configured controller role should be config");
      assert(configuredController.gateway === false, "runtime config without gateway policy should stay nongateway");
      assert(configuredController.gatewaySource === "default", "runtime-configured controller without policy should stay default");
      assert(configuredController.protected === false, "runtime config without protected policy should stay unprotected");
      assert(configuredWorker.role === "executor", "runtime config should set worker role explicitly");
      assert(configuredWorker.roleSource === "config", "runtime-configured worker role should be config");
      assert(configuredWorker.specialized === false, "runtime config without specialized policy should stay nonspecialized");
      assert(configuredWorker.specializedSource === "default", "runtime-configured worker without policy should stay default");
      results.push({ id: 1, name: "Require explicit runtime identity truth", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Honor configured identity truth", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "worker-effective-profile-exposes-network-search-tools") {
      const profile = composeEffectiveProfile({
        config: {
          agents: {
            defaults: {
              skills: ["platform-map"],
            },
          },
        },
        agentConfig: {
          id: "worker-d",
          binding: {
            roleRef: "executor",
            workspace: { configured: "~/.openclaw/workspaces/worker-d" },
            model: { ref: "demo/worker-d" },
          },
        },
      });

      assert(Array.isArray(profile.capabilities?.tools), "worker effective profile should expose capability tools");
      assert(profile.capabilities.tools.includes("web_search"), "worker effective profile should include web_search");
      assert(profile.capabilities.tools.includes("web_fetch"), "worker effective profile should include web_fetch");
      results.push({ id: 1, name: "Project worker web_search", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Project worker web_fetch", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "graph-edge-dedupes-directed-pairs") {
      const edges = normalizeGraphEdges([
        { from: "worker-d", to: "evaluator" },
        { from: "worker-d", to: "evaluator", label: "review" },
        { from: "worker-d", to: "evaluator", metadata: { source: "ui" } },
        { from: "evaluator", to: "worker-d" },
        { from: "worker-d", to: "" },
      ]);

      assert(edges.length === 2, "duplicate or invalid edges should be collapsed");
      assert(edges[0].from === "worker-d" && edges[0].to === "evaluator", "first directed pair should be preserved");
      assert(edges[1].from === "evaluator" && edges[1].to === "worker-d", "reverse directed pair should remain distinct");
      results.push({ id: 1, name: "Collapse duplicate directed edges", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Preserve reverse direction", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    throw new Error(`unknown agent-model case: ${testCase.id}`);
  } catch (error) {
    runtimeAgentConfigs.clear();
    results.push({
      id: 99,
      name: "Agent model case",
      status: "FAIL",
      errorCode: "E_AGENT_MODEL_CASE",
      elapsed: elapsedSeconds(startMs),
      detail: error.message,
    });
    return failResult(testCase, results, startMs);
  }
}
