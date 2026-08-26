// lib/formal-runtime/checks/concurrent-chain.js — concurrent 并发派工套件的纯逻辑层
//
// 实例测试(非连通性):N 份极简任务几乎同时注入、全部落到同一 caller(planner),
// 验证传送带在竞态下的排队纪律:受理创建、忙位唯一(1 running 其余 queued)、
// FIFO 激活序、无双绑(同一合约不被两个会话认领)、全终态与释放对账。
//
// 职责(零 IO,单测直接喂观测记录):
//   ① 探针消息构造 ② stage 声明(码/依赖) ③ 观测记录→verdict 的各评估器
//   ④ verdict 表→CheckResult 映射
// IO(inject / SSE / 轮询 /watchdog/runtime、/watchdog/work-items)在 suite-concurrent.js。
//
// 码分工(注册表 lib/formal-runtime/error-codes.js):
//   E-CONC-001 = 受理缺失(N 份注入未全部立约/合约 id 不唯一)
//   E-CONC-002 = 队序违反(忙位不唯一,或 FIFO 激活序被打破)
//   E-CONC-003 = 双绑(同一合约被两个不同会话认领)
//   E-CONC-004 = 终态缺失/释放不清(预算内未全终态,或结束后 caller 残留 busy)
//   E-RUNNER-005 = 前置 stage 未满足 → 本 stage 无从验证(blocked,不冒充 fail)

export const CONCURRENT_CASES = Object.freeze([
  Object.freeze({
    id: "conc-same-3",
    injectCount: 3,
    title: "3 near-simultaneous injects to one caller keep queue discipline",
    timeoutMs: 300000,
  }),
  Object.freeze({
    id: "conc-burst-5",
    injectCount: 5,
    title: "5-task burst to one caller keeps queue discipline and nothing stalls",
    timeoutMs: 300000,
  }),
]);

// ── ① 探针消息构造 ───────────────────────────────────────────────────────────

// marker 是每份任务的唯一标记,嵌入任务文本:受理兜底按 marker 在 /watchdog/work-items
// 的 task 文本里对号(inject 响应缺 contractId 时)。
export function buildProbeMarker(caseId, index, nonce) {
  return `CONC-${caseId}-${index + 1}-${nonce}`;
}

export function buildConcurrentProbeMessage({ marker, index, total }) {
  return [
    `并发探针任务 ${index + 1}/${total}(标记 ${marker})。`,
    `直接回答:OK ${marker}。一句话即可,不需要调用任何工具,不需要产出文件,回答后立即结束本轮。`,
  ].join("\n");
}

// ── ② stage 声明 ─────────────────────────────────────────────────────────────

// 有序 stage 声明:{ key, name, title, code, deps }。
// deps 未满足(缺位或 !ok)时该 stage blocked(映射规则见 mapConcurrentVerdictsToChecks)。
export function listConcurrentStages(probeCase) {
  const n = probeCase.injectCount;
  return [
    {
      key: "accepted", name: "accepted", code: "E-CONC-001", deps: [],
      title: `All ${n} contracts accepted and created`,
    },
    {
      key: "busyUnique", name: "busy-slot-unique", code: "E-CONC-002", deps: ["accepted"],
      title: "Caller busy slot stays unique (at most 1 running, rest queued)",
    },
    {
      key: "fifoOrder", name: "fifo-activation", code: "E-CONC-002", deps: ["accepted"],
      title: "Queued contracts activate in creation (FIFO) order",
    },
    {
      key: "noDoubleBind", name: "no-double-bind", code: "E-CONC-003", deps: ["accepted"],
      title: "No contract is claimed by two sessions",
    },
    {
      key: "allTerminal", name: "all-terminal", code: "E-CONC-004", deps: ["accepted"],
      title: `All ${n} contracts reach a terminal state within budget`,
    },
    {
      key: "releaseSettled", name: "release-reconciled", code: "E-CONC-004", deps: ["allTerminal"],
      title: "Caller busy slot released after all contracts settle",
    },
  ];
}

export function buildConcurrentStageDescriptors(probeCase) {
  return listConcurrentStages(probeCase).map((stage) => ({
    id: `concurrent.${probeCase.id}-${stage.name}`,
    subsystem: "concurrent",
    title: stage.title,
  }));
}

// case 的完整描述符序(inject + 链路 stage)——driver 的 markBlocked 与套件预声明
// 共用,防止两份手拼字面量漂移。prep 位已于 2026-08-18 随图夹具一并退场:本套件
// 不再有任何前置副作用,留一个永不产生结果的 descriptor 只会在报告里制造幽灵条目。
export function buildCaseDescriptors(probeCase) {
  return [
    { id: `concurrent.${probeCase.id}-inject`, subsystem: "concurrent", title: `${probeCase.injectCount} probe tasks injected to one caller` },
    ...buildConcurrentStageDescriptors(probeCase),
  ];
}

// ── ③ 观测记录 → verdict 的各评估器(全部纯函数,返回 { ok, evidence })──────────

// 受理:accepted = [{ marker, contractId|null }](注入序)。全员立约且 id 唯一才 ok。
export function evaluateAcceptance({ expectedCount, accepted = [] }) {
  const entries = Array.isArray(accepted) ? accepted : [];
  const ids = entries
    .map((entry) => (typeof entry?.contractId === "string" && entry.contractId.trim() ? entry.contractId.trim() : null))
    .filter(Boolean);
  if (entries.length !== expectedCount || ids.length !== expectedCount) {
    const missingMarkers = entries.filter((entry) => !entry?.contractId).map((entry) => entry?.marker || "?");
    return {
      ok: false,
      evidence: `${ids.length}/${expectedCount} contracts accepted`
        + (missingMarkers.length > 0 ? `; no contract observed for markers: ${missingMarkers.join(", ")}` : ""),
    };
  }
  if (new Set(ids).size !== expectedCount) {
    return { ok: false, evidence: `contract ids not distinct: ${ids.join(", ")}` };
  }
  return { ok: true, evidence: `${expectedCount}/${expectedCount} contracts accepted: ${ids.join(", ")}` };
}

// 忙位唯一:samples = [{ elapsedMs, runningContractIds, queuedContractIds }](已按探针合约定界)。
// 任一采样出现 >1 个 running 探针合约 = 违反;零采样 = 没验证到(如实 !ok)。
export function evaluateBusySlotUniqueness({ samples = [] }) {
  const list = Array.isArray(samples) ? samples : [];
  if (list.length === 0) {
    return { ok: false, evidence: "no dispatch-state samples captured — busy-slot uniqueness was never observed (poll GET /watchdog/runtime during the case)" };
  }
  let maxRunning = 0;
  let maxQueued = 0;
  const violations = [];
  for (const sample of list) {
    const running = Array.isArray(sample?.runningContractIds) ? sample.runningContractIds : [];
    const queued = Array.isArray(sample?.queuedContractIds) ? sample.queuedContractIds : [];
    maxRunning = Math.max(maxRunning, running.length);
    maxQueued = Math.max(maxQueued, queued.length);
    if (running.length > 1) {
      violations.push(`t+${sample?.elapsedMs ?? "?"}ms: ${running.length} running (${running.join(", ")})`);
    }
  }
  if (violations.length > 0) {
    return { ok: false, evidence: `busy slot shared in ${violations.length}/${list.length} samples — ${violations.slice(0, 3).join("; ")}` };
  }
  return { ok: true, evidence: `max concurrent running=${maxRunning} across ${list.length} samples; peak queue depth=${maxQueued}` };
}

// FIFO 激活:activationOrder 是首见 running 序(SSE track_start / 轮询首见),可能漏观测
// (合约在两次采样间跑完)——漏观测不算违反,只要已观测的激活相对序与创建序一致(子序列判定)。
export function evaluateFifoActivation({ creationOrder = [], activationOrder = [] }) {
  const creation = Array.isArray(creationOrder) ? creationOrder : [];
  const activationRaw = Array.isArray(activationOrder) ? activationOrder : [];
  const activation = [...new Set(activationRaw)];
  const indexByContract = new Map(creation.map((contractId, index) => [contractId, index]));
  const unknown = activation.filter((contractId) => !indexByContract.has(contractId));
  if (unknown.length > 0) {
    return { ok: false, evidence: `activation observed for contracts outside the probe set: ${unknown.join(", ")}` };
  }
  for (let i = 1; i < activation.length; i++) {
    const prevIndex = indexByContract.get(activation[i - 1]);
    const currIndex = indexByContract.get(activation[i]);
    if (currIndex < prevIndex) {
      return {
        ok: false,
        evidence: `FIFO violated: ${activation[i]} (created #${currIndex + 1}) activated after ${activation[i - 1]} (created #${prevIndex + 1});`
          + ` creation=[${creation.join(" -> ")}] activation=[${activation.join(" -> ")}]`,
      };
    }
  }
  return {
    ok: true,
    evidence: `activation order consistent with creation order (${activation.length}/${creation.length} activations observed): [${activation.join(" -> ")}]`,
  };
}

// 双绑:claims = { [contractId]: [sessionKey,...] }。同一合约的 distinct sessionKey
// 必须 ≤1(同 sessionKey 的 resume 不算双绑;探针经歧义边钉死单跳,第二个认领者即违规)。
export function evaluateNoDoubleBind({ claims = {} }) {
  const violations = [];
  let claimedCount = 0;
  for (const [contractId, sessionKeys] of Object.entries(claims && typeof claims === "object" ? claims : {})) {
    const distinct = [...new Set(Array.isArray(sessionKeys) ? sessionKeys : [])];
    if (distinct.length > 0) claimedCount += 1;
    if (distinct.length > 1) {
      violations.push(`${contractId} claimed by ${distinct.length} sessions: ${distinct.join(" | ")}`);
    }
  }
  if (violations.length > 0) {
    return { ok: false, evidence: violations.join("; ") };
  }
  return { ok: true, evidence: `${claimedCount} contracts each claimed by exactly one session (no double-bind)` };
}

// 全终态:每个探针合约都要在预算内到达终态(终态集 = lib/core/runtime-status.js,
// failed 也算终态——本套件测并发力学,不测任务成败;状态如实进 evidence)。
export function evaluateAllTerminal({ expectedContractIds = [], terminalStatuses = {}, timeoutMs = 0 }) {
  const expected = Array.isArray(expectedContractIds) ? expectedContractIds : [];
  const statuses = terminalStatuses && typeof terminalStatuses === "object" ? terminalStatuses : {};
  const stuck = expected.filter((contractId) => !statuses[contractId]);
  if (expected.length === 0) {
    return { ok: false, evidence: "no probe contract ids to await — acceptance produced an empty set" };
  }
  if (stuck.length > 0) {
    return {
      ok: false,
      evidence: `${expected.length - stuck.length}/${expected.length} contracts terminal within ${timeoutMs}ms; stuck: ${stuck.join(", ")}`,
    };
  }
  return {
    ok: true,
    evidence: `all ${expected.length} terminal: ${expected.map((contractId) => `${contractId}=${statuses[contractId]}`).join(", ")}`,
  };
}

// 释放对账:全终态后 caller 的 dispatch-state 不得残留 busy/探针合约。
// targetState = /watchdog/runtime 的 dispatchRuntime.targets[caller] 快照。
export function evaluateReleaseReconciled({ targetState = null, probeContractIds = [] }) {
  if (!targetState || typeof targetState !== "object") {
    return { ok: false, evidence: "caller dispatch-state unavailable after settlement (GET /watchdog/runtime dispatchRuntime.targets)" };
  }
  const probeSet = new Set(Array.isArray(probeContractIds) ? probeContractIds : []);
  const residue = [];
  if (targetState.busy === true) {
    residue.push(`busy=true (currentContract=${targetState.currentContract || "null"})`);
  }
  if (targetState.currentContract && probeSet.has(targetState.currentContract)) {
    residue.push(`currentContract still holds ${targetState.currentContract}`);
  }
  const queuedProbe = (Array.isArray(targetState.queue) ? targetState.queue : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.contractId))
    .filter((contractId) => probeSet.has(contractId));
  if (queuedProbe.length > 0) {
    residue.push(`queue still holds: ${queuedProbe.join(", ")}`);
  }
  const dispatchingContractId = targetState.dispatchingQueueEntry?.contractId;
  if (dispatchingContractId && probeSet.has(dispatchingContractId)) {
    residue.push(`dispatchingQueueEntry still holds ${dispatchingContractId}`);
  }
  if (residue.length > 0) {
    return { ok: false, evidence: `caller not released after all contracts terminal: ${residue.join("; ")}` };
  }
  return { ok: true, evidence: "caller released: busy=false, no probe contract residue in currentContract/queue/dispatching" };
}

// ── 观测记录 → verdict 表(聚合器,纯函数)────────────────────────────────────
//
// observed = {
//   accepted: [{ marker, contractId|null }](注入序 = 创建序),
//   samples: [{ elapsedMs, runningContractIds, queuedContractIds }],
//   activationOrder: [contractId...](首见 running 序),
//   claims: { [contractId]: [sessionKey,...] },
//   terminalStatuses: { [contractId]: status },
//   finalTargetState: dispatchRuntime.targets[caller] 快照 | null,
// }
// 受理不 ok 时不评下游(映射按 deps 判 blocked);全终态不 ok 时不评释放对账
// (caller 合法地仍忙,评了也是噪声)。
export function buildConcurrentVerdicts(probeCase, observed = {}) {
  const accepted = Array.isArray(observed.accepted) ? observed.accepted : [];
  const verdicts = {};
  verdicts.accepted = evaluateAcceptance({ expectedCount: probeCase.injectCount, accepted });
  if (!verdicts.accepted.ok) return verdicts;

  const probeContractIds = accepted.map((entry) => entry.contractId);
  verdicts.busyUnique = evaluateBusySlotUniqueness({ samples: observed.samples || [] });
  verdicts.fifoOrder = evaluateFifoActivation({
    creationOrder: probeContractIds,
    activationOrder: observed.activationOrder || [],
  });
  verdicts.noDoubleBind = evaluateNoDoubleBind({ claims: observed.claims || {} });
  verdicts.allTerminal = evaluateAllTerminal({
    expectedContractIds: probeContractIds,
    terminalStatuses: observed.terminalStatuses || {},
    timeoutMs: probeCase.timeoutMs,
  });
  if (verdicts.allTerminal.ok) {
    verdicts.releaseSettled = evaluateReleaseReconciled({
      targetState: observed.finalTargetState || null,
      probeContractIds,
    });
  }
  return verdicts;
}

// ── ④ verdict 表 → CheckResult 映射(纯函数)──────────────────────────────────
//
// 规则(先看前置再看本体——对不完整合约集算出的"不变量"不是所声明的检查点):
//   前置(deps)有未满足(缺位或 !ok) → blocked E-RUNNER-005;
//   已评估 → ok?pass:fail(带 stage 注册码);
//   前置全 ok 但缺位 → fail(观测循环没有产出 verdict,如实计败)。
export function mapConcurrentVerdictsToChecks(probeCase, verdicts = {}, { caseElapsedMs = 0 } = {}) {
  const checks = [];
  for (const stage of listConcurrentStages(probeCase)) {
    const id = `concurrent.${probeCase.id}-${stage.name}`;
    const unmetDeps = stage.deps.filter((dep) => verdicts[dep]?.ok !== true);
    if (unmetDeps.length > 0) {
      checks.push({
        id, subsystem: "concurrent", title: stage.title, status: "blocked", code: "E-RUNNER-005",
        evidence: `prerequisite stage not satisfied: ${unmetDeps.join(", ")}`, durationMs: 0,
      });
      continue;
    }
    const verdict = verdicts[stage.key];
    if (verdict?.ok === true) {
      checks.push({
        id, subsystem: "concurrent", title: stage.title, status: "pass",
        evidence: verdict.evidence || "", durationMs: Number.isFinite(verdict.elapsedMs) ? verdict.elapsedMs : 0,
      });
      continue;
    }
    checks.push({
      id, subsystem: "concurrent", title: stage.title, status: "fail", code: stage.code,
      evidence: verdict
        ? (verdict.evidence || "stage evaluated as violated")
        : "stage was not evaluated before the observation loop ended",
      durationMs: caseElapsedMs,
    });
  }
  return checks;
}
