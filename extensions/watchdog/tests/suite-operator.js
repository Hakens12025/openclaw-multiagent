import { unlink } from "node:fs/promises";
import { buildOperatorSnapshot } from "../lib/operator/operator-snapshot.js";
import { buildOperatorPlanningFocus } from "../lib/operator/operator-brain.js";
import { getContractPath, persistContractById } from "../lib/contracts.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import { excludeDeliveryTargets, normalizeDeliveryTargets } from "../lib/routing/delivery-targets.js";
import { executeOperatorExecutablePlan } from "../lib/operator/operator-executor.js";
import {
  buildOperatorAdviceFallback,
  buildOperatorInvalidPlanFallback,
} from "../lib/operator-fallback.js";
import { normalizeOperatorBrainPlanResult, normalizeOperatorPlan } from "../lib/operator/operator-plan.js";
import { normalizeScheduleSpec } from "../lib/schedule/schedule-registry.js";
import {
  invalidateCapabilityRegistryCache,
  loadCapabilityRegistry,
} from "../lib/capability/capability-registry.js";
import {
  deleteAgentJoinSpec,
  upsertAgentJoinSpec,
} from "../lib/agent/agent-join-registry.js";
import {
  deleteAutomationSpec,
  normalizeAutomationSpec,
  upsertAutomationSpec,
} from "../lib/automation/automation-registry.js";
import {
  deleteAutomationRuntimeState,
  ensureAutomationRuntimeState,
  upsertAutomationRuntimeState,
} from "../lib/automation/automation-runtime.js";
import {
  handleAutomationContractTerminal,
  startAutomationRound,
} from "../lib/automation/automation-executor.js";
import { isOperatorExecutableSurfaceId, listOperatorExecutableSurfaceIds } from "../lib/operator/operator-surface-policy.js";
import { summarizeHarnessDashboard } from "../lib/harness/harness-dashboard.js";

export const OPERATOR_CASES = [
  {
    id: "operator-fallback-advice",
    message: "brain 挂了时 operator 只能 advice_only",
  },
  {
    id: "operator-plan-normalize",
    message: "operator 会把合法 brain plan 规范化成可执行步骤",
  },
  {
    id: "operator-plan-reject-illegal-surface",
    message: "operator 拒绝未开放的 surface",
  },
  {
    id: "operator-invalid-plan-fallback",
    message: "brain 输出非法 plan 时 operator 不会伪装成 brain 掉线",
  },
  {
    id: "operator-executor-dry-run",
    message: "operator dryRun 只做归一化和图摘要，不真正执行",
  },
  {
    id: "operator-surface-policy-from-catalog",
    message: "operator 可执行 surface 来自 catalog 元数据，而不是 helper 自带名单",
  },
  {
    id: "operator-snapshot-actions-aligned",
    message: "operator snapshot 的动作列表来自 operatorExecutable 集合",
  },
  {
    id: "operator-snapshot-surfaces-pipeline-progression",
    message: "operator snapshot 会暴露最新的 pipeline 自动推进诊断摘要",
  },
  {
    id: "operator-plan-soft-action-keeps-execution",
    message: "operator 不会把修复/优化类软表达误降级成 advice_only",
  },
  {
    id: "operator-focus-carries-referents",
    message: "operator focus 会保留最近 agent/loop 指代，方便后续模糊表达",
  },
  {
    id: "schedule-spec-separates-system-action-delivery-and-delivery",
    message: "schedule spec 显式区分 systemActionDelivery 和 deliveryTargets，避免把 system_action delivery 和渠道投递混写",
  },
  {
    id: "operator-snapshot-includes-schedules",
    message: "operator snapshot 会暴露 schedules 摘要与入口链接",
  },
  {
    id: "operator-snapshot-includes-agent-joins",
    message: "operator snapshot 和 management registry 会暴露 agent join 摘要与目标对象",
  },
  {
    id: "automation-spec-normalizes-governance-and-wake-policy",
    message: "automation spec 会规范化 objective、wake policy、governance 与 system_action delivery",
  },
  {
    id: "automation-spec-normalizes-optional-harness-profile",
    message: "automation spec 会规范化可选 harness profile、coverage 与 assurance",
  },
  {
    id: "automation-spec-normalizes-explicit-harness-modules-and-module-config",
    message: "automation spec 会规范化显式 harness modules 与 moduleConfig",
  },
  {
    id: "operator-snapshot-includes-automations",
    message: "operator snapshot 会暴露 automations 摘要与入口链接",
  },
  {
    id: "automation-executor-starts-round-and-persists-runtime",
    message: "automation executor 能启动 round 并把 automationContext / runtime 写对",
  },
  {
    id: "automation-executor-continues-after-terminal-contract",
    message: "automation contract 终态后会回写 runtime 并按 wake policy 续跑",
  },
  {
    id: "automation-harness-run-lifecycle-persists-runtime-evidence",
    message: "automation harness run 会持久化 round 级运行对象、证据和完成态",
  },
  {
    id: "automation-harness-module-runner-evaluates-gates-and-collectors",
    message: "automation harness module runner 会评估 gate/collector 并暴露 verdict",
  },
  {
    id: "automation-harness-static-guards-detect-policy-drift",
    message: "automation harness static guards 会检测工具/网络/workspace/sandbox 策略漂移",
  },
  {
    id: "operator-snapshot-surfaces-harness-attention-and-counts",
    message: "operator snapshot 会把 harness pending/failure 转成摘要计数和 attention",
  },
  {
    id: "harness-dashboard-summarizes-catalog-and-placement",
    message: "harness dashboard 会聚合 catalog 与 placement 供前端可视化",
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

function buildTestLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function buildUniqueAutomationId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildUniqueJoinId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildUniqueContractId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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

export async function runOperatorCase(testCase) {
  const startMs = Date.now();
  const results = [];

  try {
    if (testCase.id === "operator-fallback-advice") {
      results.push({ id: 1, name: "Build fallback", status: "PASS", elapsed: elapsedSeconds(startMs) });
      const payload = buildOperatorAdviceFallback({
        requestText: "给 worker-d 连 evaluator",
        error: new Error("planner offline"),
      });
      assert(payload.intent === "advice_only", "fallback intent should be advice_only");
      assert(payload.canExecute === false, "fallback should not be executable");
      assert(Array.isArray(payload.plan?.steps) && payload.plan.steps.length === 0, "fallback should not contain steps");
      results.push({ id: 2, name: "Advice only", status: "PASS", elapsed: elapsedSeconds(startMs), detail: payload.reply });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-plan-normalize") {
      const payload = normalizeOperatorBrainPlanResult({
        source: "operator_brain_llm",
        plannerModel: "test/planner",
        plan: {
          intent: "create_agent",
          summary: "创建 news-watcher",
          reply: "会创建一个新的研究 agent。",
          steps: [
            {
              surfaceId: "agents.create",
              title: "创建 news-watcher",
              summary: "创建新 agent",
              payload: {
                agentId: "news-watcher",
                role: "researcher",
                model: "provider/demo-model",
              },
            },
            {
              surfaceId: "agents.name",
              title: "写名称",
              summary: "写显示名",
              payload: {
                agentId: "news-watcher",
                name: "News Watcher",
              },
            },
          ],
        },
      }, "创建一个新的新闻 agent");
      assert(payload.canExecute === true, "normalized operator plan should be executable");
      assert(payload.plan?.steps?.[0]?.payload?.id === "news-watcher", "agents.create payload should normalize agentId alias into id");
      assert(payload.plan?.derived?.agentId === "news-watcher", "derived agentId should be present");
      assert(payload.plan?.derived?.displayName === "News Watcher", "derived displayName should be present");
      results.push({ id: 1, name: "Normalize plan", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Derived fields", status: "PASS", elapsed: elapsedSeconds(startMs), detail: "agentId + displayName extracted" });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-plan-reject-illegal-surface") {
      let rejected = false;
      try {
        normalizeOperatorPlan({
          intent: "platform_mutation",
          summary: "危险计划",
          steps: [
            {
              surfaceId: "runtime.reset",
              title: "reset runtime",
              summary: "should be rejected",
              payload: {},
            },
          ],
        });
      } catch (error) {
        rejected = /unsupported operator step/i.test(error.message);
      }
      assert(rejected, "illegal surface should be rejected by operator plan validation");
      results.push({ id: 1, name: "Reject illegal surface", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-invalid-plan-fallback") {
      const payload = buildOperatorInvalidPlanFallback({
        requestText: "把 worker-a 连到 evaluator",
        error: new Error("unsupported operator step at index 0"),
        brainResult: {
          source: "operator_brain_llm",
          plannerModel: "test/planner",
        },
      });
      assert(payload.intent === "advice_only", "invalid-plan fallback should be advice_only");
      assert(payload.canExecute === false, "invalid-plan fallback should not be executable");
      assert(payload.plan?.derived?.reason === "operator_plan_validation_failed", "invalid-plan fallback should expose validation reason");
      assert(payload.reply !== buildOperatorAdviceFallback({
        requestText: "x",
        error: new Error("planner offline"),
      }).reply, "invalid-plan fallback should not reuse brain-unavailable reply");
      results.push({ id: 1, name: "Classify invalid plan", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Keep planner identity", status: "PASS", elapsed: elapsedSeconds(startMs), detail: payload.plan?.derived?.plannerModel || "--" });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-executor-dry-run") {
      const payload = await executeOperatorExecutablePlan({
        plan: {
          intent: "graph_mutation",
          summary: "dry-run graph add",
          steps: [
            {
              surfaceId: "graph.edge.add",
              title: "connect controller -> worker-a",
              summary: "dry-run only",
              payload: {
                from: "controller",
                to: "worker-a",
              },
            },
          ],
        },
        dryRun: true,
      });
      assert(payload.ok === true, "dry-run result should be ok");
      assert(payload.dryRun === true, "dry-run flag should be true");
      assert(payload.graph && typeof payload.graph.edgeCount === "number", "dry-run should include graph summary");
      results.push({ id: 1, name: "Dry run execute", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-surface-policy-from-catalog") {
      const surfaceIds = listOperatorExecutableSurfaceIds();
      assert(surfaceIds.includes("agents.policy"), "agents.policy should be operator executable from catalog metadata");
      assert(surfaceIds.includes("graph.edge.add"), "graph.edge.add should be operator executable from catalog metadata");
      assert(surfaceIds.includes("runtime.loop.resume"), "runtime.loop.resume should be operator executable from catalog metadata");
      assert(!surfaceIds.includes("runtime.reset"), "runtime.reset should not be operator executable");
      assert(isOperatorExecutableSurfaceId("agents.policy") === true, "agents.policy should resolve through metadata");
      assert(isOperatorExecutableSurfaceId("graph.edge.add") === true, "graph.edge.add should resolve through metadata");
      assert(isOperatorExecutableSurfaceId("runtime.reset") === false, "runtime.reset should be rejected through metadata");
      assert(surfaceIds.includes("hook.before_tool_call") === false, "operator apply surface list should exclude hook families");
      results.push({ id: 1, name: "Read catalog metadata", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Reject destructive reset", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-snapshot-actions-aligned") {
      const payload = await buildOperatorSnapshot({
        listLimit: 2,
      });
      assert(payload.surfaces?.counts?.operatorExecutable >= 2, "fixture expects at least two operator-executable surfaces");
      assert(Array.isArray(payload.surfaces?.actions), "snapshot should include actions list");
      assert(payload.surfaces.actions.length === 2, "snapshot should fill action list from operator-executable surfaces before slicing");
      assert(payload.surfaces.actions.every((surface) => surface?.operatorExecutable === true), "snapshot actions should all be operator-executable");
      assert(payload.cliSystem?.counts?.byFamily?.hook > 0, "snapshot should expose CLI hook summary");
      assert(payload.cliSystem?.counts?.byFamily?.observe > 0, "snapshot should expose CLI observe summary");
      results.push({ id: 1, name: "Align action slice", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Filter operator actions", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-snapshot-surfaces-pipeline-progression") {
      const contractId = buildUniqueContractId("operator-progress");
      try {
        await persistContractById({
          id: contractId,
          task: "Expose runtime-owned pipeline progression in operator snapshot",
          assignee: "evaluator",
          status: "completed",
          createdAt: Date.now() - 3000,
          updatedAt: Date.now(),
          runtimeDiagnostics: {
            pipelineProgression: {
              attempted: true,
              action: "advanced",
              from: "worker-d",
              to: "evaluator",
              pipelineId: "PIPE-TEST-1",
              loopId: "LOOP-TEST-1",
              loopSessionId: "SESSION-TEST-1",
              round: 2,
              ts: Date.now(),
            },
          },
        }, buildTestLogger());

        const payload = await buildOperatorSnapshot({
          listLimit: 10,
        });
        const latestProgression = payload?.loops?.latestProgression || null;
        const recentProgressions = Array.isArray(payload?.loops?.recentProgressions)
          ? payload.loops.recentProgressions
          : [];

        assert(latestProgression?.contractId === contractId, "snapshot should expose latest progression contract id");
        assert(latestProgression?.action === "advanced", "snapshot should expose progression action");
        assert(latestProgression?.from === "worker-d", "snapshot should expose progression source stage");
        assert(latestProgression?.to === "evaluator", "snapshot should expose progression target stage");
        assert(payload?.summary?.latestPipelineProgressionContractId === contractId, "snapshot summary should point to latest progression contract");
        assert(recentProgressions.some((entry) => entry?.contractId === contractId), "snapshot should keep recent progression list");
        results.push({ id: 1, name: "Expose latest loop progression", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Expose progression summary pointer", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        evictContractSnapshotByPath(getContractPath(contractId));
        await unlink(getContractPath(contractId)).catch(() => {});
      }
    }

    if (testCase.id === "operator-plan-soft-action-keeps-execution") {
      const payload = normalizeOperatorBrainPlanResult({
        source: "operator_brain_llm",
        plannerModel: "test/planner",
        plan: {
          intent: "graph_mutation",
          summary: "修复当前 loop",
          reply: "会先修复当前 loop。",
          steps: [
            {
              surfaceId: "graph.loop.repair",
              title: "修 loop",
              summary: "补齐缺失边",
              payload: {},
            },
          ],
        },
      }, "帮我整理一下当前这个 loop，看看怎么修");
      assert(payload.intent !== "advice_only", "soft action request should stay executable");
      assert(payload.canExecute === true, "soft action request should remain executable");
      results.push({ id: 1, name: "Keep executable intent", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-focus-carries-referents") {
      const focus = buildOperatorPlanningFocus({
        agents: [
          { id: "controller", gateway: true },
          { id: "worker-a", gateway: false },
        ],
        loops: [
          { id: "review-loop" },
        ],
        loopSessions: [
          { loopId: "review-loop", runtimeStatus: "broken", currentStage: "evaluator" },
        ],
        conversation: [
          { role: "user", text: "把 worker-a 调整得更适合做前台" },
          { role: "assistant", text: "我可以先给 worker-a 做前台化调整。" },
        ],
        currentPlan: {
          derived: {
            agentId: "worker-a",
          },
        },
      });
      assert(focus.defaults?.controllerAgentId === "controller", "focus should expose controller default");
      assert(Array.isArray(focus.recentReferents?.agentIds) && focus.recentReferents.agentIds.includes("worker-a"), "focus should retain recent agent referent");
      assert(focus.loopHints?.repairCandidateLoopId === "review-loop", "focus should expose repair candidate loop");
      results.push({ id: 1, name: "Expose controller default", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Retain referents", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 3, name: "Expose loop hint", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "schedule-spec-separates-system-action-delivery-and-delivery") {
      const spec = normalizeScheduleSpec({
        id: "daily-loop",
        enabled: "false",
        trigger: {
          type: "cron",
          expr: "0 8 * * *",
          tz: "Asia/Shanghai",
        },
        entry: {
          type: "workflow",
          targetAgent: "controller",
          message: "执行今天的研究日报",
          routeHint: "standard",
        },
        systemActionDelivery: {
          agentId: "controller",
        },
        deliveryTargets: [
          { channel: "qqbot", target: "c2c:user-1" },
          { channel: "qqbot", target: "c2c:user-1", mode: "proactive" },
          { channel: "feishu", target: "chat:abc" },
        ],
      });
      assert(spec?.enabled === false, "schedule enabled should normalize from string false");
      assert(spec?.systemActionDelivery?.agentId === "controller", "systemActionDelivery should preserve internal delivery owner");
      assert(spec?.systemActionDelivery?.sessionKey === "agent:controller:main", "systemActionDelivery should default session key");
      assert(Array.isArray(spec?.deliveryTargets) && spec.deliveryTargets.length === 2, "deliveryTargets should be deduped independently");

      const remainingTargets = excludeDeliveryTargets(
        normalizeDeliveryTargets(spec.deliveryTargets),
        [{ channel: "qqbot", target: "c2c:user-1" }],
      );
      assert(remainingTargets.length === 1 && remainingTargets[0]?.channel === "feishu", "excluding primary delivery should preserve external fanout");
      results.push({ id: 1, name: "Normalize schedule spec", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Separate delivery fanout", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-snapshot-includes-schedules") {
      const payload = await buildOperatorSnapshot({
        listLimit: 2,
      });
      assert(payload.summary && typeof payload.summary.enabledSchedules === "number", "snapshot summary should expose enabled schedule count");
      assert(payload.schedules?.counts && typeof payload.schedules.counts.total === "number", "snapshot should expose schedule counts");
      assert(Array.isArray(payload.schedules?.recent), "snapshot should expose recent schedules");
      assert(payload.links?.schedules === "/watchdog/schedules", "snapshot should expose schedules link");
      results.push({ id: 1, name: "Expose schedule counts", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Expose schedules link", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-snapshot-includes-agent-joins") {
      const joinId = buildUniqueJoinId("operator-agent-join-snapshot");
      try {
        const agentJoin = await upsertAgentJoinSpec({
          id: joinId,
          localAgentId: "external-agent-join-tester",
          platformRole: "agent",
          name: "Operator Agent Join Snapshot",
          protocolType: "a2a",
          baseUrl: "http://127.0.0.1:3999",
          adapterKind: "a2a_proxy",
          description: "test operator snapshot agent join",
        });
        invalidateCapabilityRegistryCache();

        const payload = await buildOperatorSnapshot({
          listLimit: 5,
        });
        const snapshotJoin = (payload.agentJoins?.recent || []).find((entry) => entry?.id === joinId) || null;
        assert(agentJoin?.summary?.status === "ready", "agent join summary should normalize to ready");
        assert(payload.summary && typeof payload.summary.readyAgentJoins === "number", "snapshot summary should expose ready agent join count");
        assert(payload.agentJoins?.counts && typeof payload.agentJoins.counts.total === "number", "snapshot should expose agent join counts");
        assert(Array.isArray(payload.agentJoins?.recent), "snapshot should expose recent agent joins");
        assert(snapshotJoin?.protocolType === "a2a", "snapshot recent item should expose protocol type");
        assert(snapshotJoin?.adapterKind === "a2a_proxy", "snapshot recent item should expose adapter kind");
        assert(payload.links?.agentJoins === "/watchdog/agent-joins/registry", "snapshot should expose non-conflicting agent joins link");

        const registry = await loadCapabilityRegistry();
        const subject = (registry.management?.subjects || []).find((entry) => entry?.kind === "agent_join") || null;
        const target = (subject?.targets || []).find((entry) => entry?.id === joinId) || null;
        assert(subject?.inspectSurfaces?.[0]?.path === "/watchdog/agent-joins/registry", "management subject should expose agent join registry path");
        assert(target?.snapshot?.summary?.status === "ready", "management target should project normalized join summary");
        results.push({ id: 1, name: "Expose snapshot summary", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Expose management target", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        invalidateCapabilityRegistryCache();
        await deleteAgentJoinSpec(joinId);
        invalidateCapabilityRegistryCache();
      }
    }

    if (testCase.id === "automation-spec-normalizes-governance-and-wake-policy") {
      const spec = normalizeAutomationSpec({
        id: "loop-automation",
        enabled: "true",
        objective: {
          summary: "持续改进当前策略",
          instruction: "围绕本地代码和实验结果持续优化当前策略",
          domain: "generic",
        },
        entry: {
          targetAgent: "controller",
          routeHint: "standard",
        },
        wakePolicy: {
          type: "hybrid",
          scheduleId: "daily-loop",
          cooldownSeconds: "600",
          onResult: "true",
        },
        governance: {
          maxRounds: "200",
          checkpointEvery: "10",
          earlyStopPatience: "12",
          allowChildAutomations: "true",
          maxChildAutomations: "3",
        },
        systemActionDelivery: {
          agentId: "controller",
        },
      });
      assert(spec?.entry?.message === "围绕本地代码和实验结果持续优化当前策略", "entry message should default from objective instruction");
      assert(spec?.wakePolicy?.type === "hybrid", "wake policy type should normalize");
      assert(spec?.wakePolicy?.scheduleId === "daily-loop", "wake policy should preserve schedule id");
      assert(spec?.governance?.maxRounds === 200, "governance maxRounds should normalize");
      assert(spec?.governance?.allowChildAutomations === true, "governance should normalize child automation flag");
      assert(spec?.systemActionDelivery?.sessionKey === "agent:controller:main", "system_action delivery should default session key");
      results.push({ id: 1, name: "Normalize automation spec", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Default entry/system_action delivery", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "automation-spec-normalizes-optional-harness-profile") {
      const spec = normalizeAutomationSpec({
        id: "loop-automation-harness",
        objective: {
          summary: "持续改进当前策略",
          instruction: "围绕本地代码和实验结果持续优化当前策略",
        },
        entry: {
          targetAgent: "controller",
        },
        harness: {
          mode: "hybrid",
          profileId: "experiment.research_cycle",
          assuranceLevel: "medium_assurance",
          coverage: {
            softGuided: ["memo_required"],
            freeform: ["manual_strategy_tuning"],
          },
        },
      });
      assert(spec?.harness?.mode === "hybrid", "harness mode should normalize");
      assert(spec?.harness?.profileId === "experiment.research_cycle", "harness profile should preserve id");
      assert(spec?.harness?.profileTrustLevel === "provisional", "profile trust should come from harness registry");
      assert(spec?.harness?.moduleRefs?.includes("harness:collector.trace"), "profile should project module refs");
      assert(spec?.harness?.coverage?.hardShaped?.includes("artifact_capture"), "profile coverage should include hard-shaped areas");
      assert(spec?.harness?.coverage?.softGuided?.includes("memo_required"), "custom softGuided coverage should merge");
      assert(spec?.harness?.coverage?.freeform?.includes("manual_strategy_tuning"), "custom freeform coverage should merge");
      results.push({ id: 1, name: "Normalize harness selection", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Merge harness coverage", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "automation-spec-normalizes-explicit-harness-modules-and-module-config") {
      const spec = normalizeAutomationSpec({
        id: "explicit-harness-modules",
        objective: {
          summary: "测试显式 harness modules",
          instruction: "测试显式 harness modules 和 moduleConfig",
        },
        entry: {
          targetAgent: "worker-a",
        },
        harness: {
          mode: "guarded",
          moduleRefs: [
            "harness:guard.tool_access",
            "harness:guard.scope",
          ],
          moduleConfig: {
            "harness:guard.tool_access": {
              allowedTools: ["web_search", "read", "write"],
              allowNetwork: true,
              mode: "exact",
              allowedDomains: ["docs.openai.com"],
            },
            "harness:guard.scope": {
              policy: "workspace_local_only",
              allowedWorkspaceRoots: ["~/.openclaw/workspaces/worker-a"],
            },
          },
        },
      });
      assert(spec?.harness?.moduleRefs?.includes("harness:guard.tool_access"), "explicit harness module should normalize");
      assert(spec?.harness?.moduleRefs?.includes("harness:guard.scope"), "explicit scope guard should normalize");
      assert(spec?.harness?.coverage?.hardShaped?.includes("network_boundary"), "explicit module should project hard-shaped coverage");
      assert(spec?.harness?.moduleConfig?.["harness:guard.tool_access"]?.allowedTools?.includes("web_search"), "tool whitelist config should normalize allowed tools");
      assert(spec?.harness?.moduleConfig?.["harness:guard.tool_access"]?.mode === "exact", "tool whitelist mode should normalize");
      assert(spec?.harness?.moduleConfig?.["harness:guard.tool_access"]?.allowNetwork === true, "network allow flag should normalize");
      assert(spec?.harness?.moduleConfig?.["harness:guard.scope"]?.allowedWorkspaceRoots?.includes("~/.openclaw/workspaces/worker-a"), "workspace roots should normalize");
      results.push({ id: 1, name: "Normalize explicit modules", status: "PASS", elapsed: elapsedSeconds(startMs) });
      results.push({ id: 2, name: "Normalize module config", status: "PASS", elapsed: elapsedSeconds(startMs) });
      return passResult(testCase, results, startMs);
    }

    if (testCase.id === "operator-snapshot-includes-automations") {
      const automationId = buildUniqueAutomationId("operator-automation-snapshot");
      try {
        await upsertAutomationSpec({
          id: automationId,
          objective: {
            summary: "测试 automation snapshot",
            instruction: "测试 operator snapshot automations",
          },
          entry: {
            targetAgent: "controller",
          },
          harness: {
            mode: "guarded",
            profileId: "coding.patch_and_test",
          },
        });
        const payload = await buildOperatorSnapshot({
          listLimit: 5,
        });
        const snapshotAutomation = (payload.automations?.recent || []).find((entry) => entry?.id === automationId) || null;
        assert(payload.summary && typeof payload.summary.enabledAutomations === "number", "snapshot summary should expose enabled automation count");
        assert(payload.summary && typeof payload.summary.guardedAutomations === "number", "snapshot summary should expose guarded automation count");
        assert(payload.automations?.counts && typeof payload.automations.counts.total === "number", "snapshot should expose automation counts");
        assert(payload.automations?.counts?.byExecutionMode && typeof payload.automations.counts.byExecutionMode.guarded === "number", "snapshot should expose automation execution mode counts");
        assert(Array.isArray(payload.automations?.recent), "snapshot should expose recent automations");
        assert(snapshotAutomation?.executionMode === "hybrid", "snapshot recent item should expose execution mode");
        assert(snapshotAutomation?.harnessProfileId === "coding.patch_and_test", "snapshot recent item should expose harness profile id");
        assert(Number.isFinite(snapshotAutomation?.harnessCoverageCounts?.hardShaped), "snapshot recent item should expose coverage counts");
        assert(payload.links?.automations === "/watchdog/automations", "snapshot should expose automations link");
        results.push({ id: 1, name: "Expose automation counts", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Expose harness summary", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(automationId);
        await deleteAutomationSpec(automationId);
      }
    }

    if (testCase.id === "automation-executor-starts-round-and-persists-runtime") {
      const automationId = buildUniqueAutomationId("operator-automation-start");
      const logger = buildTestLogger();
      let capturedOptions = null;
      try {
        await upsertAutomationSpec({
          id: automationId,
          objective: {
            summary: "测试 automation start",
            instruction: "测试 automation executor start round",
            domain: "generic",
          },
          entry: {
            targetAgent: "controller",
            routeHint: "long",
          },
          wakePolicy: {
            type: "manual",
            onResult: false,
          },
          harness: {
            mode: "guarded",
            profileId: "coding.patch_and_test",
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });

        const payload = await startAutomationRound(automationId, {
          api: {},
          enqueue: () => {},
          wakePlanner: async () => null,
          logger,
          dispatchAcceptIngressMessageFn: async (_message, options) => {
            capturedOptions = options;
            return {
              ok: true,
              route: "long",
              contractId: "TC-AUTOMATION-TEST-1",
            };
          },
        });

        assert(payload.ok === true && payload.skipped === false, "automation round should start");
        assert(payload.runtime?.status === "running", "runtime should be running after start");
        assert(payload.runtime?.currentRound === 1, "runtime should advance to round 1");
        assert(payload.runtime?.activeContractId === "TC-AUTOMATION-TEST-1", "runtime should track active contract");
        assert(payload.runtime?.activeHarnessSpec?.round === 1, "runtime should persist active harness spec");
        assert(payload.runtime?.activeHarnessRun?.status === "running", "runtime should persist active harness run");
        assert(payload.runtime?.activeHarnessRun?.contractId === "TC-AUTOMATION-TEST-1", "active harness run should bind contract id");
        assert(payload.runtime?.activeHarnessRun?.moduleCounts?.pending >= 1, "active harness run should initialize module runs");
        assert(payload.runtime?.activeHarnessRun?.gateSummary?.verdict === "pending", "active harness gate summary should be pending at round start");
        assert(capturedOptions?.automationContext?.automationId === automationId, "automationContext should carry automation id");
        assert(capturedOptions?.automationContext?.round === 1, "automationContext should carry round number");
        assert(capturedOptions?.automationContext?.executionMode === "hybrid", "automationContext should expose execution mode");
        assert(capturedOptions?.automationContext?.harness?.profileId === "coding.patch_and_test", "automationContext should expose harness profile");
        assert(capturedOptions?.automationContext?.harnessSpec?.round === 1, "automationContext should carry harness spec");
        assert(capturedOptions?.automationContext?.harnessRunId === payload.runtime?.activeHarnessRun?.id, "automationContext should carry harness run id");
        results.push({ id: 1, name: "Start automation round", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Persist runtime + harness context", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(automationId);
        await deleteAutomationSpec(automationId);
      }
    }

    if (testCase.id === "automation-executor-continues-after-terminal-contract") {
      const automationId = buildUniqueAutomationId("operator-automation-terminal");
      try {
        const automation = await upsertAutomationSpec({
          id: automationId,
          objective: {
            summary: "测试 automation terminal",
            instruction: "测试 automation executor terminal continuation",
            domain: "generic",
          },
          entry: {
            targetAgent: "controller",
            routeHint: "long",
          },
          wakePolicy: {
            type: "result",
            onResult: true,
            cooldownSeconds: 30,
          },
          governance: {
            maxRounds: 3,
            earlyStopPatience: 5,
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });
        const runtime = await ensureAutomationRuntimeState(automation);
        await upsertAutomationRuntimeState({
          ...runtime,
          status: "running",
          currentRound: 1,
          activeContractId: "TC-AUTOMATION-TEST-2",
        });

        const payload = await handleAutomationContractTerminal({
          id: "TC-AUTOMATION-TEST-2",
          status: "completed",
          output: "/tmp/factor-output.md",
          terminalOutcome: {
            reason: "round completed",
            score: 0.18,
          },
          automationContext: {
            automationId,
            round: 1,
          },
        }, {
          logger: buildTestLogger(),
        });

        assert(payload.handled === true, "terminal handler should accept automation contract");
        assert(payload.runtime?.status === "idle", "runtime should return to idle for next wake");
        assert(Number.isFinite(payload.runtime?.nextWakeAt), "runtime should schedule next wake");
        assert(payload.runtime?.bestScore === 0.18, "bestScore should update from semantic score");
        assert(payload.runtime?.recentRounds?.[0]?.decision === "continue", "terminal decision should continue");
        results.push({ id: 1, name: "Handle terminal contract", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Schedule follow-up wake", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(automationId);
        await deleteAutomationSpec(automationId);
      }
    }

    if (testCase.id === "automation-harness-run-lifecycle-persists-runtime-evidence") {
      const automationId = buildUniqueAutomationId("operator-automation-harness-run");
      try {
        await upsertAutomationSpec({
          id: automationId,
          objective: {
            summary: "测试 automation harness run lifecycle",
            instruction: "测试 automation harness run lifecycle evidence persistence",
            domain: "generic",
          },
          entry: {
            targetAgent: "controller",
            routeHint: "standard",
          },
          wakePolicy: {
            type: "result",
            onResult: true,
            cooldownSeconds: 45,
          },
          harness: {
            mode: "hybrid",
            profileId: "experiment.research_cycle",
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });

        const startPayload = await startAutomationRound(automationId, {
          api: {},
          enqueue: () => {},
          wakePlanner: async () => null,
          logger: buildTestLogger(),
          dispatchAcceptIngressMessageFn: async () => ({
            ok: true,
            route: "standard",
            contractId: "TC-AUTOMATION-TEST-3",
          }),
        });

        assert(startPayload.ok === true && startPayload.skipped === false, "automation harness round should start");
        assert(startPayload.runtime?.activeHarnessRun?.status === "running", "active harness run should be running");
        assert(startPayload.runtime?.activeHarnessRun?.profileId === "experiment.research_cycle", "active harness run should preserve profile");
        assert(startPayload.runtime?.activeHarnessRun?.coverageCounts?.hardShaped >= 1, "active harness run should preserve coverage counts");

        const terminalPayload = await handleAutomationContractTerminal({
          id: "TC-AUTOMATION-TEST-3",
          status: "completed",
          output: "/tmp/factor-harness-output.md",
          terminalOutcome: {
            reason: "factor round converged",
            score: 0.21,
            summary: "factor round converged",
          },
          executionObservation: {
            stageRunResult: {
              version: 1,
              stage: "review",
              status: "completed",
              summary: "factor round converged",
              primaryArtifactPath: "/tmp/factor-harness-output.md",
              artifacts: [
                {
                  type: "text_output",
                  path: "/tmp/factor-harness-output.md",
                  required: true,
                  primary: true,
                },
              ],
              metadata: {
                schemaValid: true,
                schema: "review_finding_v1",
              },
            },
          },
          automationContext: {
            automationId,
            round: 1,
          },
        }, {
          logger: buildTestLogger(),
        });

        const snapshot = await buildOperatorSnapshot({
          listLimit: 8,
        });
        const snapshotAutomation = (snapshot.automations?.recent || []).find((entry) => entry?.id === automationId) || null;

        assert(terminalPayload.handled === true, "terminal payload should finalize harness run");
        assert(terminalPayload.runtime?.activeHarnessRun == null, "runtime should clear active harness run after finalize");
        assert(terminalPayload.runtime?.lastHarnessRun?.status === "completed", "runtime should persist finalized harness run");
        assert(terminalPayload.runtime?.lastHarnessRun?.decision === "continue", "finalized harness run should persist decision");
        assert(terminalPayload.runtime?.lastHarnessRun?.artifact === "/tmp/factor-harness-output.md", "finalized harness run should persist artifact evidence");
        assert(terminalPayload.runtime?.lastHarnessRun?.score === 0.21, "finalized harness run should persist score evidence");
        assert(terminalPayload.runtime?.lastHarnessRun?.gateSummary?.verdict === "passed", "factor mining harness gate summary should pass");
        assert(
          terminalPayload.runtime?.lastHarnessRun?.moduleRuns?.some((entry) => entry?.moduleId === "harness:gate.artifact" && entry?.status === "passed"),
          "artifact gate should pass when factor artifact exists",
        );
        assert(terminalPayload.runtime?.recentHarnessRuns?.[0]?.id === terminalPayload.runtime?.lastHarnessRun?.id, "runtime should keep finalized harness run in recent list");
        assert(snapshotAutomation?.lastHarnessStatus === "completed", "snapshot should expose last harness status");
        assert(snapshotAutomation?.lastHarnessDecision === "continue", "snapshot should expose last harness decision");
        assert(snapshotAutomation?.lastHarnessGateVerdict === "passed", "snapshot should expose last harness gate verdict");
        assert(snapshotAutomation?.recentHarnessRunCount === 1, "snapshot should expose recent harness run count");
        results.push({ id: 1, name: "Persist active harness run", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Finalize harness evidence", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 3, name: "Expose harness run in snapshot", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(automationId);
        await deleteAutomationSpec(automationId);
      }
    }

    if (testCase.id === "automation-harness-module-runner-evaluates-gates-and-collectors") {
      const automationId = buildUniqueAutomationId("operator-automation-harness-modules");
      try {
        await upsertAutomationSpec({
          id: automationId,
          objective: {
            summary: "测试 harness module runner",
            instruction: "测试 harness module runner gates and collectors",
            domain: "coding",
          },
          entry: {
            targetAgent: "controller",
            routeHint: "long",
          },
          wakePolicy: {
            type: "result",
            onResult: true,
            cooldownSeconds: 60,
          },
          governance: {
            budgetSeconds: 300,
          },
          harness: {
            mode: "guarded",
            profileId: "coding.patch_and_test",
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });

        const startPayload = await startAutomationRound(automationId, {
          api: {},
          enqueue: () => {},
          wakePlanner: async () => null,
          logger: buildTestLogger(),
          dispatchAcceptIngressMessageFn: async () => ({
            ok: true,
            route: "long",
            contractId: "TC-AUTOMATION-TEST-4",
          }),
        });
        assert(startPayload.runtime?.activeHarnessRun?.gateSummary?.verdict === "pending", "coding harness gates should start pending");

        const terminalPayload = await handleAutomationContractTerminal({
          id: "TC-AUTOMATION-TEST-4",
          status: "completed",
          terminalOutcome: {
            summary: "patch applied and tests green",
            artifact: "/tmp/fix.patch",
            testsPassed: true,
          },
          automationContext: {
            automationId,
            round: 1,
          },
        }, {
          logger: buildTestLogger(),
        });

        const snapshot = await buildOperatorSnapshot({
          listLimit: 8,
        });
        const snapshotAutomation = (snapshot.automations?.recent || []).find((entry) => entry?.id === automationId) || null;

        assert(terminalPayload.runtime?.lastHarnessRun?.gateSummary?.verdict === "passed", "coding harness gates should pass");
        assert(terminalPayload.runtime?.lastHarnessRun?.gateSummary?.failed === 0, "coding harness should have zero failed gates");
        assert(
          terminalPayload.runtime?.lastHarnessRun?.moduleRuns?.some((entry) => entry?.moduleId === "harness:collector.artifact" && entry?.status === "passed"),
          "artifact collector should capture emitted patch",
        );
        assert(
          terminalPayload.runtime?.lastHarnessRun?.moduleRuns?.some((entry) => entry?.moduleId === "harness:gate.test" && entry?.status === "passed"),
          "test gate should pass on explicit test signal",
        );
        assert(
          terminalPayload.runtime?.lastHarnessRun?.moduleRuns?.some((entry) => entry?.moduleId === "harness:gate.artifact" && entry?.status === "passed"),
          "artifact gate should pass on explicit artifact",
        );
        assert(snapshotAutomation?.lastHarnessGateVerdict === "passed", "snapshot should expose passed harness gate verdict");
        assert(snapshotAutomation?.lastHarnessFailedModuleCount === 0, "snapshot should expose zero failed harness gates");
        results.push({ id: 1, name: "Initialize coding harness gates", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Evaluate collectors and gates", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 3, name: "Expose gate verdict in snapshot", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(automationId);
        await deleteAutomationSpec(automationId);
      }
    }

    if (testCase.id === "automation-harness-static-guards-detect-policy-drift") {
      const automationId = buildUniqueAutomationId("operator-automation-harness-guards");
      try {
        await upsertAutomationSpec({
          id: automationId,
          objective: {
            summary: "测试 harness static guards",
            instruction: "测试 harness static guards detect policy drift",
            domain: "coding",
          },
          entry: {
            targetAgent: "worker-a",
            routeHint: "long",
          },
          wakePolicy: {
            type: "result",
            onResult: true,
            cooldownSeconds: 60,
          },
          harness: {
            mode: "guarded",
            moduleRefs: [
              "harness:guard.tool_access",
              "harness:guard.scope",
            ],
            moduleConfig: {
              "harness:guard.tool_access": {
                allowedTools: ["web_search", "web_fetch", "exec", "read", "write", "edit"],
                mode: "subset",
                allowNetwork: false,
              },
              "harness:guard.scope": {
                policy: "workspace_local_only",
                allowedWorkspaceRoots: ["~/.openclaw/workspaces/controller"],
              },
            },
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });

        const startPayload = await startAutomationRound(automationId, {
          api: {},
          enqueue: () => {},
          wakePlanner: async () => null,
          logger: buildTestLogger(),
          dispatchAcceptIngressMessageFn: async () => ({
            ok: true,
            route: "long",
            contractId: "TC-AUTOMATION-TEST-5",
          }),
        });

        const activeRun = startPayload.runtime?.activeHarnessRun;
        assert(activeRun?.moduleCounts?.failed === 2, "static guard drift should fail two canonical guard modules at round start");
        assert(
          activeRun?.moduleRuns?.some((entry) => entry?.moduleId === "harness:guard.tool_access" && entry?.status === "failed"),
          "tool whitelist guard should fail on browser drift",
        );
        assert(
          activeRun?.moduleRuns?.some((entry) => entry?.moduleId === "harness:guard.scope" && entry?.status === "failed"),
          "workspace guard should fail on root mismatch",
        );

        const terminalPayload = await handleAutomationContractTerminal({
          id: "TC-AUTOMATION-TEST-5",
          status: "completed",
          terminalOutcome: {
            reason: "guard drift scenario concluded",
          },
          automationContext: {
            automationId,
            round: 1,
          },
        }, {
          logger: buildTestLogger(),
        });

        const snapshot = await buildOperatorSnapshot({
          listLimit: 8,
        });
        const snapshotAutomation = (snapshot.automations?.recent || []).find((entry) => entry?.id === automationId) || null;

        assert(terminalPayload.runtime?.lastHarnessRun?.moduleCounts?.failed === 4, "failed guard count should persist after finalize");
        assert(snapshotAutomation?.lastHarnessFailedModuleCount === 4, "snapshot should expose failed harness module count");
        results.push({ id: 1, name: "Detect static guard drift", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Persist failed guard count", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 3, name: "Expose drift in snapshot", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(automationId);
        await deleteAutomationSpec(automationId);
      }
    }

    if (testCase.id === "operator-snapshot-surfaces-harness-attention-and-counts") {
      const pendingAutomationId = buildUniqueAutomationId("operator-automation-harness-pending");
      const failingAutomationId = buildUniqueAutomationId("operator-automation-harness-failing");
      try {
        await upsertAutomationSpec({
          id: pendingAutomationId,
          objective: {
            summary: "测试 harness pending snapshot",
            instruction: "测试 harness pending snapshot",
            domain: "coding",
          },
          entry: {
            targetAgent: "controller",
            routeHint: "long",
          },
          wakePolicy: {
            type: "result",
            onResult: true,
          },
          harness: {
            mode: "guarded",
            profileId: "coding.patch_and_test",
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });
        await upsertAutomationSpec({
          id: failingAutomationId,
          objective: {
            summary: "测试 harness failing snapshot",
            instruction: "测试 harness failing snapshot",
            domain: "coding",
          },
          entry: {
            targetAgent: "worker-a",
            routeHint: "long",
          },
          wakePolicy: {
            type: "result",
            onResult: true,
          },
          harness: {
            mode: "guarded",
            moduleRefs: [
              "harness:guard.tool_access",
              "harness:guard.scope",
            ],
            moduleConfig: {
              "harness:guard.tool_access": {
                allowedTools: ["web_search", "web_fetch", "exec", "read", "write", "edit"],
                allowNetwork: false,
              },
              "harness:guard.scope": {
                policy: "workspace_local_only",
                allowedWorkspaceRoots: ["~/.openclaw/workspaces/controller"],
              },
            },
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });

        await startAutomationRound(pendingAutomationId, {
          api: {},
          enqueue: () => {},
          wakePlanner: async () => null,
          logger: buildTestLogger(),
          dispatchAcceptIngressMessageFn: async () => ({
            ok: true,
            route: "long",
            contractId: "TC-AUTOMATION-TEST-6",
          }),
        });
        await startAutomationRound(failingAutomationId, {
          api: {},
          enqueue: () => {},
          wakePlanner: async () => null,
          logger: buildTestLogger(),
          dispatchAcceptIngressMessageFn: async () => ({
            ok: true,
            route: "long",
            contractId: "TC-AUTOMATION-TEST-7",
          }),
        });

        const snapshot = await buildOperatorSnapshot({
          listLimit: 10,
        });
        const pendingAutomation = (snapshot.automations?.recent || []).find((entry) => entry?.id === pendingAutomationId) || null;
        const failingAutomation = (snapshot.automations?.recent || []).find((entry) => entry?.id === failingAutomationId) || null;
        const automationAttention = (snapshot.attention || []).filter((entry) => entry?.area === "automations");

        assert(snapshot.summary?.pendingHarnessAutomations >= 1, "snapshot summary should expose pending harness automation count");
        assert(snapshot.summary?.failingHarnessAutomations >= 1, "snapshot summary should expose failing harness automation count");
        assert(snapshot.summary?.failedHarnessModules >= 1, "snapshot summary should expose failed harness module count");
        assert(snapshot.automations?.counts?.byHarnessGateVerdict?.pending >= 1, "snapshot counts should expose pending harness verdicts");
        assert(pendingAutomation?.activeHarnessGateVerdict === "pending", "pending automation should expose pending active harness verdict");
        assert(failingAutomation?.activeHarnessFailedModuleCount === 1, "failing automation should expose active failed harness module count");
        assert(automationAttention.some((entry) => entry?.severity === "error"), "snapshot attention should include harness error item");
        assert(automationAttention.some((entry) => entry?.severity === "info"), "snapshot attention should include harness pending item");
        results.push({ id: 1, name: "Expose harness summary counts", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Expose harness attention items", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(pendingAutomationId);
        await deleteAutomationSpec(pendingAutomationId);
        await deleteAutomationRuntimeState(failingAutomationId);
        await deleteAutomationSpec(failingAutomationId);
      }
    }

    if (testCase.id === "harness-dashboard-summarizes-catalog-and-placement") {
      const pendingAutomationId = buildUniqueAutomationId("harness-dashboard-pending");
      const failingAutomationId = buildUniqueAutomationId("harness-dashboard-failing");
      const now = Date.now();
      try {
        await upsertAutomationSpec({
          id: pendingAutomationId,
          objective: {
            summary: "测试 harness dashboard pending",
            instruction: "测试 harness dashboard placement pending view",
            domain: "coding",
          },
          entry: {
            targetAgent: "worker-a",
            routeHint: "long",
          },
          harness: {
            mode: "guarded",
            profileId: "coding.patch_and_test",
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });
        await upsertAutomationSpec({
          id: failingAutomationId,
          objective: {
            summary: "测试 harness dashboard failing",
            instruction: "测试 harness dashboard placement failing view",
            domain: "generic",
          },
          entry: {
            targetAgent: "controller",
            routeHint: "standard",
          },
          harness: {
            mode: "hybrid",
            profileId: "experiment.research_cycle",
          },
          systemActionDelivery: {
            agentId: "controller",
          },
        });

        await upsertAutomationRuntimeState({
          automationId: pendingAutomationId,
          status: "running",
          currentRound: 1,
          activeHarnessRun: {
            automationId: pendingAutomationId,
            round: 1,
            requestedAt: now,
            enabled: true,
            executionMode: "guarded",
            assuranceLevel: "high_assurance",
            profileId: "coding.patch_and_test",
            profileTrustLevel: "stable",
            moduleRefs: [
              "harness:guard.tool_access",
              "harness:collector.trace",
              "harness:gate.artifact",
              "harness:gate.test",
            ],
            coverage: {
              hardShaped: [
                "tool_surface_whitelist",
                "trace_capture",
                "required_artifact_gate",
                "test_gate",
              ],
              softGuided: [
                "change_summary",
                "handoff_note",
              ],
              freeform: [
                "implementation_strategy",
              ],
            },
            status: "running",
            moduleRuns: [
              {
                moduleId: "harness:guard.tool_access",
                kind: "guard",
                status: "passed",
              },
              {
                moduleId: "harness:collector.trace",
                kind: "collector",
                status: "pending",
              },
              {
                moduleId: "harness:gate.artifact",
                kind: "gate",
                status: "pending",
              },
              {
                moduleId: "harness:gate.test",
                kind: "gate",
                status: "pending",
              },
            ],
          },
          createdAt: now,
          updatedAt: now,
        });

        await upsertAutomationRuntimeState({
          automationId: failingAutomationId,
          status: "idle",
          currentRound: 2,
          lastHarnessRun: {
            automationId: failingAutomationId,
            round: 2,
            requestedAt: now - 1000,
            enabled: true,
            executionMode: "hybrid",
            assuranceLevel: "medium_assurance",
            profileId: "experiment.research_cycle",
            profileTrustLevel: "provisional",
            moduleRefs: [
              "harness:guard.budget",
              "harness:gate.artifact",
              "harness:normalizer.failure",
            ],
            coverage: {
              hardShaped: [
                "timeout_budget",
                "required_artifact_gate",
                "failure_classification",
              ],
              softGuided: [
                "experiment_memo",
                "structured_handoff",
              ],
              freeform: [
                "research_reasoning",
              ],
            },
            status: "failed",
            decision: "continue",
            moduleRuns: [
              {
                moduleId: "harness:guard.budget",
                kind: "guard",
                status: "passed",
              },
              {
                moduleId: "harness:gate.artifact",
                kind: "gate",
                status: "failed",
                reason: "missing_artifact",
              },
              {
                moduleId: "harness:normalizer.failure",
                kind: "normalizer",
                status: "passed",
              },
            ],
          },
          recentHarnessRuns: [
            {
              automationId: failingAutomationId,
              round: 2,
              requestedAt: now - 1000,
              enabled: true,
              executionMode: "hybrid",
              assuranceLevel: "medium_assurance",
              profileId: "experiment.research_cycle",
              profileTrustLevel: "provisional",
              moduleRefs: [
                "harness:guard.budget",
                "harness:gate.artifact",
                "harness:normalizer.failure",
              ],
              coverage: {
                hardShaped: [
                  "timeout_budget",
                  "required_artifact_gate",
                  "failure_classification",
                ],
                softGuided: [
                  "experiment_memo",
                  "structured_handoff",
                ],
                freeform: [
                  "research_reasoning",
                ],
              },
              status: "failed",
              decision: "continue",
              moduleRuns: [
                {
                  moduleId: "harness:guard.budget",
                  kind: "guard",
                  status: "passed",
                },
                {
                  moduleId: "harness:gate.artifact",
                  kind: "gate",
                  status: "failed",
                  reason: "missing_artifact",
                },
                {
                  moduleId: "harness:normalizer.failure",
                  kind: "normalizer",
                  status: "passed",
                },
              ],
            },
            {
              automationId: failingAutomationId,
              round: 1,
              requestedAt: now - 7000,
              startedAt: now - 6900,
              finalizedAt: now - 6400,
              enabled: true,
              executionMode: "hybrid",
              assuranceLevel: "medium_assurance",
              profileId: "experiment.research_cycle",
              profileTrustLevel: "provisional",
              moduleRefs: [
                "harness:guard.budget",
                "harness:gate.artifact",
              ],
              coverage: {
                hardShaped: [
                  "timeout_budget",
                  "required_artifact_gate",
                ],
                softGuided: [
                  "experiment_memo",
                ],
                freeform: [
                  "research_reasoning",
                ],
              },
              status: "completed",
              decision: "retry",
              score: 0.11,
              artifact: "reports/factor-round-1.md",
              moduleRuns: [
                {
                  moduleId: "harness:guard.budget",
                  kind: "guard",
                  status: "passed",
                },
                {
                  moduleId: "harness:gate.artifact",
                  kind: "gate",
                  status: "passed",
                },
              ],
            },
          ],
          createdAt: now - 2000,
          updatedAt: now,
        });

        const payload = await summarizeHarnessDashboard();
        const pendingPlacement = (payload.placements || []).find((entry) => entry?.id === pendingAutomationId) || null;
        const failingPlacement = (payload.placements || []).find((entry) => entry?.id === failingAutomationId) || null;
        const codingFamily = (payload.catalog?.families || []).find((entry) => entry?.id === "coding") || null;
        const experimentFamily = (payload.catalog?.families || []).find((entry) => entry?.id === "experiment") || null;
        const codingProfile = (payload.catalog?.profiles || []).find((entry) => entry?.id === "coding.patch_and_test") || null;
        const pendingCompletionStage = (pendingPlacement?.stages || []).find((entry) => entry?.id === "completion") || null;
        const failingCompletionStage = (failingPlacement?.stages || []).find((entry) => entry?.id === "completion") || null;

        assert(payload.counts?.profiles >= 3, "dashboard should expose harness profile count");
        assert(payload.counts?.pendingHarnessAutomations >= 1, "dashboard should expose pending harness automation count");
        assert(payload.counts?.failingHarnessAutomations >= 1, "dashboard should expose failing harness automation count");
        assert(codingFamily?.automationCount >= 1, "coding family should expose automation count");
        assert(experimentFamily?.automationCount >= 1, "experiment family should expose automation count");
        assert(codingProfile?.usageCount >= 1, "catalog profile should expose usage count");
        assert(Array.isArray(codingProfile?.hardShaped) && codingProfile.hardShaped.includes("test_gate"), "catalog profile should expose derived hard-shaped coverage");
        assert(pendingPlacement?.selectedRunMode === "active", "pending placement should prefer active harness run");
        assert(failingPlacement?.selectedRunMode === "last", "failing placement should fall back to last harness run");
        assert(Array.isArray(pendingPlacement?.recentRuns) && pendingPlacement.recentRuns[0]?.sourceTags?.includes("active"), "pending placement should expose active run in recent runs track");
        assert(Array.isArray(failingPlacement?.recentRuns) && failingPlacement.recentRuns.length >= 2, "failing placement should expose recent runs track");
        assert(failingPlacement?.recentRuns?.[0]?.round === 2, "recent runs should be ordered with latest round first");
        assert(failingPlacement?.recentRuns?.[0]?.sourceTags?.includes("last"), "latest failing run should keep last-run source tag");
        assert(failingPlacement?.recentRuns?.[1]?.round === 1, "older failing run should remain in recent runs track");
        assert(pendingCompletionStage?.lanes?.hardShaped?.some((entry) => entry.id === "harness:gate.test" && entry.status === "pending"), "pending placement should expose pending completion gate");
        assert(failingCompletionStage?.lanes?.hardShaped?.some((entry) => entry.id === "harness:gate.artifact" && entry.status === "failed"), "failing placement should expose failed completion gate");
        results.push({ id: 1, name: "Summarize harness catalog", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 2, name: "Expose placement stage lanes", status: "PASS", elapsed: elapsedSeconds(startMs) });
        results.push({ id: 3, name: "Expose recent harness run track", status: "PASS", elapsed: elapsedSeconds(startMs) });
        return passResult(testCase, results, startMs);
      } finally {
        await deleteAutomationRuntimeState(pendingAutomationId);
        await deleteAutomationSpec(pendingAutomationId);
        await deleteAutomationRuntimeState(failingAutomationId);
        await deleteAutomationSpec(failingAutomationId);
      }
    }

    throw new Error(`unknown operator case: ${testCase.id}`);
  } catch (error) {
    results.push({
      id: 99,
      name: "Operator case",
      status: "FAIL",
      errorCode: "E_OPERATOR_CASE",
      elapsed: elapsedSeconds(startMs),
      detail: error.message,
    });
    return failResult(testCase, results, startMs);
  }
}
