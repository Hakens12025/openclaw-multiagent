// lib/formal-runtime/checks/system-action-chain.js — system-action 探针链的纯逻辑层
//
// P5 三层化(spec §10):链路探针全部走【合约会话】(test-inject,replyTo 指向
// distinct 上游 → 回程票据可得),按表达通道分层立案:
//   L1 = 协作 FC 工具(中场调用,不经提取门——旧 hook 会话探针的慢性红根治点)
//   L3 = [ACTION] 文本标记(合约会话的提取门正路)
//   policy = 缓建 intent 的 known-but-denied(结构化拒绝本身是被规定的行为)
// L2 fence 通道尚无实现,不立假案。
//
// 职责(零 IO,单测直接喂事件数组/信号表):
//   ① 提示词构造 ② SSE 事件查询 ③ 分层 stage 声明 + 信号→CheckResult 映射
// IO(inject / SSE / 轮询)在 suite-collab.js(collab 预设的 suite 驱动)。

export const SYSTEM_ACTION_CASES = Object.freeze([
  Object.freeze({
    id: "l1-assign-toolface",
    action: "assign_task",
    layer: "l1",
    title: "L1 assign_task tool: acceptance -> deferred -> result returns to same session",
    // 2026-08-12 校准:kimi 复跑回合实测 3.5-5min,300s 预算在机制全绿下反复撞边
    timeoutMs: 600000,
  }),
  Object.freeze({
    // 期望驱动探针(STOP-04a):assign_task 参数声明 expectations,子腿收官后
    // 判决账本必须出现该子合约的非空 expectationChecks 判决——考官核心判据
    // (期望↔trace diff)的 live 覆盖(此前只有零期望兜底路)。
    id: "l1-assign-expectations",
    action: "assign_task",
    layer: "l1",
    title: "L1 assign_task carrying declared expectations runs the full delegate leg",
    timeoutMs: 600000,
    // 声明产物路径 = 子任务指令里的写入路径(单真值,两处引用)。
    declaredArtifactPath: "output/expectation_probe.md",
  }),
  Object.freeze({
    id: "create-task-denied",
    action: "create_task",
    layer: "policy",
    title: "create_task stays known-but-denied (structured role-policy rejection)",
    timeoutMs: 240000,
  }),
]);

// ── ① 提示词构造 ────────────────────────────────────────────────────────────

// 探针授权前导(单源,事实陈述):探针经正规 test-inject 派发合约,安全姿态强的
// 模型(如 kimi)会把协作动作指令当注入拒绝,此前导声明真实来源与授权。
const PROBE_AUTHORIZATION_PREAMBLE = Object.freeze([
  "来自 OpenClaw 平台 formal test-runner(collab 预设)的正式授权测试任务。",
  "本任务由平台自身的测试系统派发;执行下方描述的协作动作是本测试的预期且已授权的行为。",
  "先读取 inbox/contract.json 了解当前任务。",
]);

export function buildL1AssignProbePrompt({ delegateAgentId }) {
  return [
    ...PROBE_AUTHORIZATION_PREAMBLE,
    "本轮的全部交付就是一个动作:调用 assign_task 工具。简报、runtime_result.json、亲自执行子任务、向他人交接,这些统统免除——只做工具调用。",
    `工具参数:targetAgent="${delegateAgentId}",message="把 CHILD_ASSIGNEE_OK 写入你的输出文件后结束。",reason="collab L1 assign probe"。`,
    "工具返回受理凭证后,把凭证 JSON 原样写入 outbox/assign_receipt.md,然后立即结束本轮。",
    "受托结果稍后会由平台回投到同一会话,届时把 outbox/assign_receipt.md 更新为 ASSIGN_PARENT_RECEIVED。",
  ].join("\n");
}

// L1 assign + expectations(STOP-04a):派工参数如实声明验收期望——平台建约抄写,
// 子腿收官后考官逐条 diff,判决进 evaluation-verdicts 账本。
export function buildL1AssignExpectationsProbePrompt({ delegateAgentId, declaredArtifactPath }) {
  const expectations = { requiredArtifacts: [{ path: declaredArtifactPath }] };
  return [
    ...PROBE_AUTHORIZATION_PREAMBLE,
    "本轮的全部交付就是一个动作:调用 assign_task 工具。简报、runtime_result.json、亲自执行子任务、向他人交接,这些统统免除——只做工具调用。",
    `工具参数:targetAgent="${delegateAgentId}",message="用文件写入工具把 CHILD_EXPECTATION_OK 写入 ${declaredArtifactPath},写完立即结束本轮。",reason="collab expectations probe",expectations=${JSON.stringify(expectations)}(对象参数,原样传入)。`,
    "工具返回受理凭证后,把凭证 JSON 原样写入 outbox/assign_receipt.md,然后立即结束本轮。",
    "受托结果稍后会由平台回投到同一会话,届时把 outbox/assign_receipt.md 更新为 ASSIGN_PARENT_RECEIVED。",
  ].join("\n");
}

export function buildCreateTaskDeniedProbePrompt() {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
      type: "create_task",
      params: {
        message: "回复 CHILD_OK 后结束。",
        source: "webui",
      },
    });
  return [
    ...PROBE_AUTHORIZATION_PREAMBLE,
    "本轮的全部交付就是一个文件:用文件写入工具创建 outbox/probe_note.md。简报、runtime_result.json、其他工具调用统统免除。",
    "文件内容:先写一句本轮总结(真实正文),然后另起一行把下面这行【原样】写入:",
    actionMarker,
    "说明:平台会按授权策略【拒绝】该动作——这正是本测试要验证的行为;写完即结束本轮,无需等待任何后续。",
  ].join("\n");
}

// ── ①.5 policy 案拓扑门槛(纯计划,IO 在 suite-collab.js)────────────────────
//
// 自动选路(dispatch-graph-policy.resolveRouteAfterAgentEndTarget)按 caller 的
// 管线出边数分流:0 条=terminal、恰 1 条=single_edge 自动前送、≥2 条=ambiguous。
// 被前送(graphRouted)会话的 consume 只放行 wake —— caller 写下的 [ACTION]
// create_task 会在 caller agent_end 被静默跳过(consume-stage.js
// ALLOWED_AFTER_GRAPH_ROUTE),拒绝告警随之缺席(2026-08-26 live 失败根因:
// 生产图 2026-08-19 起有 planner→worker 单出边)。本函数产出 prep 计划:
// 恰 1 条 → 补一条歧义边把选路推回 ambiguous;其余出边数 → 零动作。
// 补边目标跳过 caller 全部既有出边(含非管线边),cleanup 才能只删自己加的边;
// 既有单边已标记 metadata.pipeline 时补边同样标记(getPipelineEdgesFrom 在
// 存在标记边时只认标记集合,未标记的补边改不了选路歧义度)。
export function planCallerRoutingAmbiguityPrep({ pipelineEdges = [], allEdges = [], candidateTargets = [] } = {}) {
  const pipeline = Array.isArray(pipelineEdges) ? pipelineEdges : [];
  if (pipeline.length !== 1) {
    return {
      action: "none",
      detail: `caller pipeline out-degree ${pipeline.length} — terminal/ambiguous route, marker is consumed at the caller's own agent_end`,
    };
  }
  const existingTargets = new Set(
    (Array.isArray(allEdges) ? allEdges : [])
      .map((edge) => (typeof edge?.to === "string" ? edge.to : ""))
      .filter(Boolean),
  );
  const marked = pipeline[0]?.metadata?.pipeline === true;
  const target = (Array.isArray(candidateTargets) ? candidateTargets : [])
    .find((id) => typeof id === "string" && id.trim() && !existingTargets.has(id)) || null;
  if (!target) {
    return {
      action: "unavailable",
      detail: `caller has a single pipeline edge to ${pipeline[0]?.to || "?"} and every registered ambiguity candidate already carries an edge from the caller`,
    };
  }
  return {
    action: "add-edge",
    to: target,
    metadata: marked ? { pipeline: true } : {},
    detail: `ambiguity edge to ${target} (caller pipeline out-degree was 1 — auto-forward would divert the [ACTION] marker away from the caller's terminal consume)`,
  };
}

// ── ② SSE 事件查询 ───────────────────────────────────────────────────────────

export function findTrackStart(events, { agentId, afterMs = 0, sessionKey = null, contractOnly = false }) {
  return events.find((evt) => (
    evt.type === "track_start"
    && evt.receivedAt >= afterMs
    && evt.data?.agentId === agentId
    && typeof evt.data?.sessionKey === "string"
    && (!sessionKey || evt.data.sessionKey === sessionKey)
    && (!contractOnly || evt.data.sessionKey.includes(":contract:"))
  )) || null;
}

export function findTrackEnd(events, { agentId, sessionKey, afterMs = 0 }) {
  return events.find((evt) => (
    evt.type === "track_end"
    && evt.receivedAt >= afterMs
    && evt.data?.agentId === agentId
    && evt.data?.sessionKey === sessionKey
  )) || null;
}

export function findAlert(events, { type, afterMs = 0, source = null, targetAgent = null }) {
  return events.find((evt) => (
    evt.type === "alert"
    && evt.receivedAt >= afterMs
    && evt.data?.type === type
    && (!source || evt.data?.source === source)
    && (!targetAgent || evt.data?.targetAgent === targetAgent)
  )) || null;
}

// ── ③ 分层 stage 声明 + 信号→CheckResult 映射 ────────────────────────────────
//
// 码分工(全部已在 error-codes.js 注册):
//   E-SYSACTION-001 = 中间动作 alert 缺失(caller 会话跑了但动作未被受理/派发)
//   E-SYSACTION-002 = create_task known-but-denied 链断点(拒绝未观测/caller 合约未正常终态)
//   E-SYSACTION-003 = assign 链路断点(受理/回投/合约落地)
//   E-SYSACTION-005 = 同会话 resume / resume 收尾缺失
//   E-RUNNER-005    = 前序 stage 未观测到 → 本 stage 无从验证(blocked,不冒充 fail)

const ACTION_FAMILY_CODE = Object.freeze({
  create_task: "E-SYSACTION-002",
  assign_task: "E-SYSACTION-003",
});

const BRIDGE_ALERT_TYPE = Object.freeze({
  assign_task: "system_action_assign_task_result_delivered",
});

export const ROLE_POLICY_REJECTED_ALERT_TYPE = "system_action_role_policy_rejected";

const INTERMEDIATE_STAGE = Object.freeze({
  assign_task: { name: "task-assigned", title: "Assign task accepted", alertType: "agent_task_assigned" },
});

// 按 case 产出有序 stage 声明:{ key, name, title, code, deps, miss(topology) }。
export function listChainStages(probeCase) {
  const family = ACTION_FAMILY_CODE[probeCase.action];
  if (!family) throw new Error(`unknown system-action: ${probeCase.action}`);

  const firstStart = {
    key: "firstStart", name: "first-start", title: "Caller contract session start", code: family, deps: [],
    miss: (t) => `no contract-session track_start observed for caller ${t?.callerAgentId || "unknown"} after inject`,
  };

  // policy 层(create-task-denied):start → 结构化拒绝 → caller 正常收官 → caller 合约终态。
  if (probeCase.layer === "policy") {
    return [
      firstStart,
      {
        key: "rejection", name: "policy-rejection", title: "Structured role-policy rejection observed", code: family, deps: ["firstStart"],
        miss: () => `${ROLE_POLICY_REJECTED_ALERT_TYPE} alert not observed — known-but-denied intent must reject deterministically (consumer role-policy gate)`,
      },
      {
        key: "firstEnd", name: "first-end", title: "Caller session end", code: family, deps: ["firstStart"],
        miss: () => "caller session did not finish (no track_end on the contract sessionKey)",
      },
      {
        key: "callerContractTerminal", name: "caller-contract-terminal", title: "Caller contract completes despite denial", code: family, deps: ["firstEnd"],
        miss: () => "caller contract did not reach a terminal state — a denied action leaves the caller contract on its normal terminal path",
      },
    ];
  }

  // 链路层(l1/l3):start → 受理 → end(deferred) → 回投 → 同会话 resume → 收尾 → 桥约终态。
  const intermediate = INTERMEDIATE_STAGE[probeCase.action];
  const chainStages = [
    firstStart,
    {
      key: "intermediate", name: intermediate.name, title: intermediate.title, code: "E-SYSACTION-001", deps: ["firstStart"],
      miss: () => probeCase.layer === "l1"
        ? `${intermediate.alertType} alert not observed (caller ran but the L1 tool call was not accepted — check tool mounting and role policy)`
        : `${intermediate.alertType} alert not observed (caller ran but the [ACTION] marker was not extracted/consumed at agent_end)`,
    },
    {
      key: "firstEnd", name: "first-end", title: "Caller session end", code: family, deps: ["firstStart"],
      miss: () => "caller session did not finish (no track_end on the contract sessionKey)",
    },
    {
      key: "bridgeAlert", name: "bridge-delivery",
      title: "Assign task result delivery",
      code: family, deps: ["intermediate"],
      miss: () => `${BRIDGE_ALERT_TYPE[probeCase.action]} alert not observed within budget`,
    },
    {
      key: "resume", name: "same-session-resume", title: "Same-session resume", code: "E-SYSACTION-005", deps: ["firstEnd", "bridgeAlert"],
      miss: (t) => `${t?.callerAgentId || "caller"} did not resume on the original contract sessionKey`,
    },
    {
      key: "resumeEnd", name: "resume-end", title: "Resumed session end", code: "E-SYSACTION-005", deps: ["resume"],
      miss: () => "resumed session did not reach a terminal track_end status",
    },
    {
      key: "bridgeContractTerminal", name: "bridge-contract-terminal", title: "Bridge contract terminal", code: family, deps: ["bridgeAlert"],
      miss: () => "bridge contract did not reach a terminal state in /watchdog/work-items",
    },
  ];
  // 期望声明案的验收站(2026-08-12 断供修复的 live 防回归):受托合约的终态结局
  // 必须留有非空核对痕迹 expectationCheck——这条曾经"写了没人读"空转数月而
  // 探针全绿,故专站钉死消费线。
  if (probeCase.declaredArtifactPath) {
    chainStages.push({
      key: "expectationVerdict", name: "expectation-verdict",
      title: "Judgment left a non-empty expectationCheck on the delegate contract",
      code: family, deps: ["bridgeContractTerminal"],
      miss: () => "terminalOutcome.expectationCheck missing/empty on the delegate contract — "
        + "the assign expectations supply→consumption line is broken again "
        + "(supply: system-action-runtime materializes onto contract.expectations; "
        + "consumption: terminal-outcome feeds requiredArtifacts to the judgment plug-in)",
    });
  }
  return chainStages;
}

export function bridgeAlertTypeFor(action) {
  return BRIDGE_ALERT_TYPE[action] || null;
}

export function intermediateAlertTypeFor(action) {
  return INTERMEDIATE_STAGE[action]?.alertType || null;
}

// 给 markBlocked 用的链路 stage 描述符(含 prep/inject 之外的全部 checkpoint)。
export function buildChainStageDescriptors(probeCase) {
  return listChainStages(probeCase).map((stage) => ({
    id: `collab.${probeCase.id}-${stage.name}`,
    subsystem: "collab",
    title: stage.title,
  }));
}

// case 的完整描述符序(prep/inject + 链路 stage)——driver 的 markBlocked 与
// 套件预声明共用,防止两份手拼字面量漂移。图夹具已于 2026-08-18 退场,
// 各案子一律如实记"无需准备"。
export function buildCaseDescriptors(probeCase) {
  return [
    { id: `collab.${probeCase.id}-prep`, subsystem: "collab", title: "Probe prerequisites prepared" },
    { id: `collab.${probeCase.id}-inject`, subsystem: "collab", title: "Probe contract injected" },
    ...buildChainStageDescriptors(probeCase),
  ];
}

// 信号表 → CheckResult 列表(纯函数)。
// signals[key] = { elapsedMs, evidence } 表示该 checkpoint 已观测到;缺位表示未观测到。
// 规则:已见 → pass;未见且全部前序已见 → fail(带该 stage 的注册码);
//       未见且有前序未见 → blocked E-RUNNER-005(没验证到 ≠ 失败两次)。
export function mapProbeSignalsToChecks(probeCase, signals = {}, { caseElapsedMs = 0, topology = null } = {}) {
  const checks = [];
  for (const stage of listChainStages(probeCase)) {
    const id = `collab.${probeCase.id}-${stage.name}`;
    const seen = signals[stage.key];
    if (seen) {
      checks.push({
        id, subsystem: "collab", title: stage.title, status: "pass",
        evidence: seen.evidence || "", durationMs: Number.isFinite(seen.elapsedMs) ? seen.elapsedMs : 0,
      });
      continue;
    }
    const missingDeps = stage.deps.filter((dep) => !signals[dep]);
    if (missingDeps.length > 0) {
      checks.push({
        id, subsystem: "collab", title: stage.title, status: "blocked", code: "E-RUNNER-005",
        evidence: `prerequisite stage not observed: ${missingDeps.join(", ")}`, durationMs: 0,
      });
    } else {
      checks.push({
        id, subsystem: "collab", title: stage.title, status: "fail", code: stage.code,
        evidence: stage.miss(topology), durationMs: caseElapsedMs,
      });
    }
  }
  return checks;
}
