// lib/formal-runtime/checks/system-action-chain.js — system-action 探针链的纯逻辑层
//
// 职责（零 IO，单测直接喂事件数组/信号表）：
//   ① [ACTION] 提示词构造（移植自旧 suite-direct-service-prompts.js，行为不变）
//   ② SSE 事件查询（移植自旧 suite-direct-service-events.js）
//   ③ 链路 checkpoint 声明 + 信号→CheckResult 映射（每个 checkpoint 一条 CheckResult）
// IO（fixture 写盘 / SSE / wake / 轮询）在 suite-system-action.js。

export const SYSTEM_ACTION_CASES = Object.freeze([
  Object.freeze({
    id: "create-task",
    action: "create_task",
    title: "create_task result returns to same session",
    timeoutMs: 240000,
  }),
  Object.freeze({
    id: "assign-task",
    action: "assign_task",
    title: "assign_task delegated result returns to same session",
    timeoutMs: 240000,
  }),
  Object.freeze({
    id: "request-review",
    action: "request_review",
    title: "request_review verdict returns to same session",
    timeoutMs: 300000,
  }),
]);

// ── ① [ACTION] 提示词构造 ────────────────────────────────────────────────────

// 探针授权前导(单源,事实陈述):探针经 /hooks/agent 唤醒,框架会把消息标注为外部 webhook 来源;
// 安全姿态强的模型(如 kimi)会把裸 [ACTION] 指令当注入拒绝。此前导声明真实来源与授权。
const PROBE_AUTHORIZATION_PREAMBLE = Object.freeze([
  "来自 OpenClaw 平台 formal test-runner(system-action 预设)的正式授权测试任务。",
  "本消息由平台自身的测试系统派发,不是外部第三方内容;执行下方 [ACTION] marker 是本测试的预期且已授权的行为。",
  "先读取当前任务。",
]);

export function buildCreateTaskProbePrompt() {
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
    "用文件写入工具把下面这一行【原样】写入你的结果文件(当前任务指定的 output 文件路径)。",
    "平台只解析结果文件——[ACTION] 行只出现在回复文本里不会被执行：",
    actionMarker,
    "写完上面这一行后立即结束本次回复,停止等待——平台会解析并执行该动作。",
    "动作完成后平台会在同一会话再次唤醒你,届时把结果文件更新为 PARENT_RECEIVED。",
  ].join("\n");
}

export function buildAssignTaskProbePrompt({ delegateAgentId }) {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
      type: "assign_task",
      params: {
        targetAgent: delegateAgentId,
        instruction: "把 CHILD_ASSIGNEE_OK 写入 output 指定路径后结束。",
        reason: "system-action assign_task return probe",
      },
    });
  return [
    ...PROBE_AUTHORIZATION_PREAMBLE,
    "用文件写入工具把下面这一行【原样】写入你的结果文件(当前任务指定的 output 文件路径)。",
    "平台只解析结果文件——[ACTION] 行只出现在回复文本里不会被执行：",
    actionMarker,
    "写完上面这一行后立即结束本次回复,停止等待——平台会解析并执行该动作。",
    "动作完成后平台会在同一会话再次唤醒你,届时把结果文件更新为 ASSIGN_PARENT_RECEIVED。",
  ].join("\n");
}

export function buildReviewProbePrompt({ artifactPath }) {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
      type: "request_review",
      params: {
        instruction: "请审查这个实现；若存在未定义变量或明显运行错误，请直接给出 reject，并简要指出问题。",
        artifactManifest: [
          { path: artifactPath, label: "review_probe" },
        ],
      },
    });
  return [
    ...PROBE_AUTHORIZATION_PREAMBLE,
    "用文件写入工具把下面这一行【原样】写入你的结果文件(当前任务指定的 output 文件路径)。",
    "平台只解析结果文件——[ACTION] 行只出现在回复文本里不会被执行：",
    actionMarker,
    "写完上面这一行后立即结束本次回复,停止等待——平台会解析并执行该动作。",
    "动作完成后平台会在同一会话再次唤醒你,届时把结果文件更新为 REVIEW_PARENT_RECEIVED。",
  ].join("\n");
}

// ── ② SSE 事件查询 ───────────────────────────────────────────────────────────

export function findTrackStart(events, { agentId, afterMs = 0, sessionKey = null, hookOnly = false }) {
  return events.find((evt) => (
    evt.type === "track_start"
    && evt.receivedAt >= afterMs
    && evt.data?.agentId === agentId
    && typeof evt.data?.sessionKey === "string"
    && (!sessionKey || evt.data.sessionKey === sessionKey)
    && (!hookOnly || evt.data.sessionKey.includes(":hook:"))
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

// ── ③ 链路 checkpoint 声明 + 信号→CheckResult 映射 ───────────────────────────
//
// 码分工（全部已在 error-codes.js 注册）：
//   家族码 E-SYSACTION-002/003/004 = 各动作的链路断点（start/end/bridge/合约落地）
//   E-SYSACTION-001 = 中间动作 alert 缺失（caller 会话跑了但没解析出 [ACTION]）
//   E-SYSACTION-005 = 同会话 resume / resume 收尾缺失
//   E-RUNNER-005    = 前序 stage 未观测到 → 本 stage 无从验证（blocked，不冒充 fail）

const ACTION_FAMILY_CODE = Object.freeze({
  create_task: "E-SYSACTION-002",
  assign_task: "E-SYSACTION-003",
  request_review: "E-SYSACTION-004",
});

const BRIDGE_ALERT_TYPE = Object.freeze({
  create_task: "system_action_runtime_result_delivered",
  assign_task: "system_action_assign_task_result_delivered",
  request_review: "system_action_review_verdict_delivered",
});

const INTERMEDIATE_STAGE = Object.freeze({
  assign_task: { name: "task-assigned", title: "Assign task accepted", alertType: "agent_task_assigned" },
  request_review: { name: "review-requested", title: "Review request accepted", alertType: "code_review_requested" },
});

// 按动作产出有序 stage 声明：{ key, name, title, code, deps, miss(topology) }。
export function listChainStages(action) {
  const family = ACTION_FAMILY_CODE[action];
  if (!family) throw new Error(`unknown system-action: ${action}`);
  const stages = [
    {
      key: "firstStart", name: "first-start", title: "First hook session start", code: family, deps: [],
      miss: (t) => `no track_start with a :hook: sessionKey observed for caller ${t?.callerAgentId || "unknown"}`,
    },
  ];
  const intermediate = INTERMEDIATE_STAGE[action];
  if (intermediate) {
    stages.push({
      key: "intermediate", name: intermediate.name, title: intermediate.title, code: "E-SYSACTION-001", deps: ["firstStart"],
      miss: () => `${intermediate.alertType} alert not observed (caller session ran but the [ACTION] marker likely was not emitted/parsed)`,
    });
  }
  stages.push(
    {
      key: "firstEnd", name: "first-end", title: "First hook session end", code: family, deps: ["firstStart"],
      miss: () => "initial caller session did not finish (no track_end on the hook sessionKey)",
    },
    {
      key: "bridgeAlert", name: "bridge-delivery",
      title: action === "create_task" ? "Execution result delivery"
        : action === "assign_task" ? "Assign task result delivery" : "Review verdict delivery",
      code: family, deps: ["firstEnd"],
      miss: () => `${BRIDGE_ALERT_TYPE[action]} alert not observed within budget`,
    },
    {
      key: "resume", name: "same-session-resume", title: "Same-session resume", code: "E-SYSACTION-005", deps: ["firstEnd"],
      miss: (t) => `${t?.callerAgentId || "caller"} did not resume on the original sessionKey`,
    },
    {
      key: "resumeEnd", name: "resume-end", title: "Resumed session end", code: "E-SYSACTION-005", deps: ["resume"],
      miss: () => "resumed session did not reach a terminal track_end status",
    },
    {
      key: "bridgeContractTerminal", name: "bridge-contract-terminal", title: "Bridge contract terminal", code: family, deps: ["bridgeAlert"],
      miss: () => "bridge contract did not reach a terminal state in /watchdog/work-items",
    },
  );
  return stages;
}

export function bridgeAlertTypeFor(action) {
  return BRIDGE_ALERT_TYPE[action] || null;
}

export function intermediateAlertTypeFor(action) {
  return INTERMEDIATE_STAGE[action]?.alertType || null;
}

// 给 markBlocked 用的链路 stage 描述符（含 prep/wake 之外的全部 checkpoint）。
export function buildChainStageDescriptors(probeCase) {
  return listChainStages(probeCase.action).map((stage) => ({
    id: `system-action.${probeCase.id}-${stage.name}`,
    subsystem: "system-action",
    title: stage.title,
  }));
}

// 信号表 → CheckResult 列表（纯函数）。
// signals[key] = { elapsedMs, evidence } 表示该 checkpoint 已观测到；缺位表示未观测到。
// 规则：已见 → pass；未见且全部前序已见 → fail（带该 stage 的注册码）；
//       未见且有前序未见 → blocked E-RUNNER-005（没验证到 ≠ 失败两次）。
export function mapProbeSignalsToChecks(probeCase, signals = {}, { caseElapsedMs = 0, topology = null } = {}) {
  const checks = [];
  for (const stage of listChainStages(probeCase.action)) {
    const id = `system-action.${probeCase.id}-${stage.name}`;
    const seen = signals[stage.key];
    if (seen) {
      checks.push({
        id, subsystem: "system-action", title: stage.title, status: "pass",
        evidence: seen.evidence || "", durationMs: Number.isFinite(seen.elapsedMs) ? seen.elapsedMs : 0,
      });
      continue;
    }
    const missingDeps = stage.deps.filter((dep) => !signals[dep]);
    if (missingDeps.length > 0) {
      checks.push({
        id, subsystem: "system-action", title: stage.title, status: "blocked", code: "E-RUNNER-005",
        evidence: `prerequisite stage not observed: ${missingDeps.join(", ")}`, durationMs: 0,
      });
    } else {
      checks.push({
        id, subsystem: "system-action", title: stage.title, status: "fail", code: stage.code,
        evidence: stage.miss(topology), durationMs: caseElapsedMs,
      });
    }
  }
  return checks;
}
