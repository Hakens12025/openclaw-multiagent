// lib/archive/run-event-wiring.js — 生命周期时刻 → run 事件账的接线面(备忘录142 §八/§十二,批②)。
//
// 职责:把执行面各时刻(建约/派工/认领/回合/申报/采集/收口/落票/投递)翻译成
// appendRunEvent 调用。全部 fire-and-forget:接线失败只 warn,【绝不拦执行面】——
// 事件账为真值、合约活文件为工作缓存(GAP-03),但记账不可反噬记录对象。
//
// causeRefs 尽力而为(§十/§十一钩①):同 run 内已知前因带上(per-contract 内存
// 簿记,进程重启后自然为空),未知 = 不带(不造假因果)。closed 的 causeRefs 按批②
// 裁定锚定本约 contract_created。
//
// GAP-02 run 关账:closed 落账后 deriveRunOpenContracts 现推导,空 → 追加
// run_closed(recorder 在含 run_closed 的批次落盘后自动必编投影,§十二.1)。
//
// 谱系缺席(过渡期旧约/无 lineage 的 tracking 投影)→ 静默跳线,不 fabricate。

import { RUN_EVENT_TYPES, appendRunEvent, deriveRunOpenContracts } from "./run-event-recorder.js";
import { runHasEvents } from "../record-plane/record-writer.js";
import { normalizeLineage } from "../contract/contract-lineage.js";
import { normalizeString } from "../core/normalize.js";

const MAX_TRACKED_CONTRACTS = 1000;
const MAX_TRACKED_RUNS = 500;

// contractId → { created, dispatched, claimed, turnStarted, declared, collected, closed, ticketWritten }
const contractRefs = new Map();
// runId → { chain: Promise, triggerRef, closed: boolean }
const runStates = new Map();

function trimMap(map, maxSize) {
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function getContractRefs(contractId) {
  let refs = contractRefs.get(contractId);
  if (!refs) {
    refs = {};
    contractRefs.set(contractId, refs);
    trimMap(contractRefs, MAX_TRACKED_CONTRACTS);
  }
  return refs;
}

function getRunState(runId) {
  let state = runStates.get(runId);
  if (!state) {
    state = { chain: Promise.resolve(), triggerRef: null, closed: false, seen: false };
    runStates.set(runId, state);
    trimMap(runStates, MAX_TRACKED_RUNS);
  }
  return state;
}

function resolveWireLineage(source) {
  const lineage = normalizeLineage(source?.lineage ?? source);
  if (!lineage?.threadId || !lineage?.runId) return null;
  return lineage;
}

function firstRef(...candidates) {
  const ref = candidates.find((candidate) => candidate && Number.isInteger(candidate.seq));
  return ref ? [ref] : null;
}

// 每时刻共用的落账通道:per-run promise 链串行(保 append 顺序 = 因果顺序),
// 失败 warn 后链复位,永不外抛。
function enqueueRunEvent(lineage, logger, task) {
  const state = getRunState(lineage.runId);
  const settled = state.chain
    .then(() => task(state))
    .catch((error) => {
      (logger?.warn ?? console.warn)(
        `[run-event-wiring] event append skipped for ${lineage.runId}: ${error?.message || error}`,
      );
    });
  state.chain = settled;
  return settled;
}

async function runHasDurableEvents(lineage) {
  // 文件账退役批:事件账唯一在 records DB,存在性 = 库里有行(原 stat 语义)。
  try {
    return runHasEvents(lineage.runId);
  } catch {
    return false;
  }
}

// ── 建约(工厂 persist 后) ────────────────────────────────────────────────────
//
// trigger 语义:
//   {origin,...}  — 调用方明确知道本次建约铸了新 run(触发点)→ 先落 run_triggered;
//   "auto"        — 调用方无法区分继承/孤儿铸线(DIRECT 信封工厂是同步纯函数)→
//                   run 账面尚无事件时补 run_triggered,否则跳过;
//   null          — 派生继承,不落 run_triggered。
export function wireContractCreated({ contract, trigger = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async (runState) => {
    let shouldTrigger = Boolean(trigger) && !runState.seen && !runState.triggerRef;
    if (shouldTrigger && trigger === "auto") {
      shouldTrigger = !(await runHasDurableEvents(lineage));
    }
    runState.seen = true;
    if (shouldTrigger) {
      const payload = trigger === "auto"
        ? { origin: normalizeString(contract?.protocol?.source) || "direct_intake" }
        : { ...(trigger && typeof trigger === "object" ? trigger : {}) };
      const triggered = await appendRunEvent({
        lineage,
        type: RUN_EVENT_TYPES.RUN_TRIGGERED,
        contractId,
        payload,
      });
      runState.triggerRef = triggered.ref;
    }
    const created = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.CONTRACT_CREATED,
      contractId,
      agentId: normalizeString(contract?.assignee),
      payload: { status: normalizeString(contract?.status) },
      causeRefs: firstRef(runState.triggerRef),
    });
    getContractRefs(contractId).created = created.ref;
  });
}

// ── 派工(传输原语出手时刻) ───────────────────────────────────────────────────
export function wireDispatched({ contract, contractId = null, from = null, to = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const normalizedContractId = normalizeString(contractId) || normalizeString(contract?.id);
  if (!lineage || !normalizedContractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async () => {
    const refs = getContractRefs(normalizedContractId);
    const dispatched = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.DISPATCHED,
      contractId: normalizedContractId,
      agentId: normalizeString(to),
      payload: { from: normalizeString(from), to: normalizeString(to) },
      causeRefs: firstRef(refs.created),
    });
    refs.dispatched = dispatched.ref;
  });
}

// ── 认领(tracker bind) ──────────────────────────────────────────────────────
export function wireClaimed({ contract, agentId = null, sessionKey = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async () => {
    const refs = getContractRefs(contractId);
    const claimed = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.CLAIMED,
      contractId,
      agentId: normalizeString(agentId),
      sessionKey: normalizeString(sessionKey),
      causeRefs: firstRef(refs.dispatched, refs.created),
    });
    refs.claimed = claimed.ref;
  });
}

// ── 回合开始(before-agent-start 绑定合约) ────────────────────────────────────
export function wireTurnStarted({ contract, agentId = null, sessionKey = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async () => {
    const refs = getContractRefs(contractId);
    const turnStarted = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.TURN_STARTED,
      contractId,
      agentId: normalizeString(agentId),
      sessionKey: normalizeString(sessionKey),
      causeRefs: firstRef(refs.claimed, refs.dispatched, refs.created),
    });
    refs.turnStarted = turnStarted.ref;
  });
}

// ── 申报(submit_output 落 trackingState) ─────────────────────────────────────
export function wireDeclared({ contract, agentId = null, sessionKey = null, status = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async () => {
    const refs = getContractRefs(contractId);
    const declared = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.DECLARED,
      contractId,
      agentId: normalizeString(agentId),
      sessionKey: normalizeString(sessionKey),
      payload: { status: normalizeString(status) },
      causeRefs: firstRef(refs.turnStarted, refs.claimed),
    });
    refs.declared = declared.ref;
  });
}

// ── 采集(agent_end collectOutbox 后) ─────────────────────────────────────────
export function wireCollected({ contract, agentId = null, sessionKey = null, collected = false, deliverableKind = null, executionModel = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  const normalizedKind = normalizeString(deliverableKind);
  // 执行模型(2026-08-27):本轮实际模型的观测值(转录提取),缺测不落键——事件形状按需增列。
  const normalizedModel = normalizeString(executionModel?.model);
  const normalizedProvider = normalizeString(executionModel?.provider);
  return enqueueRunEvent(lineage, logger, async () => {
    const refs = getContractRefs(contractId);
    const event = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.COLLECTED,
      contractId,
      agentId: normalizeString(agentId),
      sessionKey: normalizeString(sessionKey),
      // kind 只在非缺省路(消息面物化)时落键——文件路事件形状不变。
      payload: {
        collected: collected === true,
        ...(normalizedKind ? { kind: normalizedKind } : {}),
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(normalizedModel && normalizedProvider ? { provider: normalizedProvider } : {}),
      },
      causeRefs: firstRef(refs.declared, refs.turnStarted, refs.claimed),
    });
    refs.collected = event.ref;
  });
}

// ── 收口(commit 后)+ GAP-02 run 关账判定 ────────────────────────────────────
export function wireClosed({ contract, terminalStatus = null, reason = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async (runState) => {
    const refs = getContractRefs(contractId);
    const closed = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.CLOSED,
      contractId,
      payload: {
        terminalStatus: normalizeString(terminalStatus),
        ...(normalizeString(reason) ? { reason: normalizeString(reason) } : {}),
      },
      causeRefs: firstRef(refs.created),
    });
    refs.closed = closed.ref;

    // GAP-02:事件账现推导 contract_created 无对应 closed → 全关即落 run_closed。
    // recorder 对含 run_closed 的批次落盘后必编投影(§十二.1),此处不重复编译。
    if (!runState.closed) {
      const openContracts = await deriveRunOpenContracts(lineage);
      if (openContracts.length === 0) {
        await appendRunEvent({
          lineage,
          type: RUN_EVENT_TYPES.RUN_CLOSED,
          payload: { lastContractId: contractId },
          causeRefs: firstRef(refs.closed),
        });
        runState.closed = true;
      }
    }
  });
}

// ── 落票(收口写投递票据后) ───────────────────────────────────────────────────
export function wireTicketWritten({ contract, ticketId = null, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async () => {
    const refs = getContractRefs(contractId);
    const event = await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.TICKET_WRITTEN,
      contractId,
      payload: { ticketId: normalizeString(ticketId) },
      causeRefs: firstRef(refs.closed),
    });
    refs.ticketWritten = event.ref;
  });
}

// ── 投递(泵执行完票据载荷后) ─────────────────────────────────────────────────
export function wireDelivered({ contract, ticketId = null, suppressed = false, logger = null } = {}) {
  const lineage = resolveWireLineage(contract);
  const contractId = normalizeString(contract?.id);
  if (!lineage || !contractId) return Promise.resolve();

  return enqueueRunEvent(lineage, logger, async () => {
    const refs = getContractRefs(contractId);
    await appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.DELIVERED,
      contractId,
      payload: {
        ticketId: normalizeString(ticketId),
        suppressed: suppressed === true,
      },
      causeRefs: firstRef(refs.ticketWritten, refs.closed),
    });
  });
}

// 测试用:清空接线簿记(refs/run 链),不触碰盘上事件账。
export function clearRunEventWiringState() {
  contractRefs.clear();
  runStates.clear();
}
