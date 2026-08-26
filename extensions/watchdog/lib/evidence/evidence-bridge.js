// evidence-bridge.js — the ONLY seam hooks call into (spec §2/§3).
// Every export swallows its own failures: the evidence plane is strictly
// weaker than the execution plane, so a broken ledger must never block work.

import {
  TRACE_EVENT_KINDS, TRACE_EVENT_CHANNELS, TRACE_EVENT_OUTCOMES, buildTraceEvent,
} from "./trace-event-schema.js";
import {
  digestCollabToolArgs, digestCollabToolResult, digestToolArgs, digestToolResult,
} from "./tool-event-digest.js";
import { appendTraceEvent } from "./session-trace-store.js";
import { isToolOutcomeError } from "../delivery/runtime-user-facing-output.js";
import { listExposedToolIntents } from "../system-action/collaboration-intent-policy.js";
import { SYSTEM_ACTION_STATUS } from "../core/runtime-status.js";

// 协作 FC 与本地 FC 在钩子眼里同形——单桥分类,不造第二条记录路径。
const COLLAB_TOOL_NAMES = new Set(listExposedToolIntents());

function isCollabToolName(toolName) {
  return COLLAB_TOOL_NAMES.has(String(toolName || "").toLowerCase());
}

// ── 被拒调用的一事一记(2026-08-19)──────────────────────────────────────────
// 守卫拦下一次调用后,宿主仍会把 blockReason 当成工具错误回给 agent,于是
// after_tool_call 又看到一个 error 事件 —— 同一次调用、同一条理由,账上记两遍。
// live 实测:被拒调用的 83%(813/981)是重复行,占 trace 盘面 11.7%。
//
// 去重放在这里而不是钩子里:本文件是钩子唯一的接缝(见文件头),两个入口都经过它,
// 在别处各拦一次就又成了两条路径。
// 指纹消费即删;有界表防泄漏(after 未触发的残留由 FIFO 淘汰)。留 refused 那条,
// 因为它带 blockReason,语义严格强于降级后的 error。
const REFUSED_FINGERPRINT_CAP = 256;
const refusedFingerprints = new Map();

function fingerprintOf(sessionKey, toolName, argsDigest) {
  return `${sessionKey}|${String(toolName || "unknown")}|${JSON.stringify(argsDigest ?? null)}`;
}

function markRefused(fingerprint) {
  if (refusedFingerprints.has(fingerprint)) refusedFingerprints.delete(fingerprint);
  refusedFingerprints.set(fingerprint, Date.now());
  while (refusedFingerprints.size > REFUSED_FINGERPRINT_CAP) {
    const oldest = refusedFingerprints.keys().next().value;
    refusedFingerprints.delete(oldest);
  }
}

// 命中即消费:同一指纹只挡一次 error,连续两次被拒仍然记两条 refused。
function consumeRefused(fingerprint) {
  if (!refusedFingerprints.has(fingerprint)) return false;
  refusedFingerprints.delete(fingerprint);
  return true;
}

export async function recordToolCallEvidence({
  sessionKey, agentId, toolName, params = {}, event = {}, contractId = null, logger = null,
} = {}) {
  try {
    const collab = isCollabToolName(toolName);
    const argsDigest = collab ? digestCollabToolArgs(params) : digestToolArgs(toolName, params);
    const errored = isToolOutcomeError(event);
    // 这次"错误"如果就是刚才守卫拒掉的那次,账上已有一条语义更强的 refused,不再补记。
    if (errored && consumeRefused(fingerprintOf(sessionKey, toolName, argsDigest))) {
      return;
    }
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: collab ? TRACE_EVENT_KINDS.COLLAB : TRACE_EVENT_KINDS.INTERNAL,
      channel: TRACE_EVENT_CHANNELS.FC,
      name: toolName || "unknown",
      argsDigest,
      resultDigest: collab ? digestCollabToolResult(event) : digestToolResult(event),
      outcome: errored ? TRACE_EVENT_OUTCOMES.ERROR : TRACE_EVENT_OUTCOMES.OK,
      agentId, sessionKey, contractId,
    }));
  } catch (error) {
    logger?.warn?.(`[watchdog] evidence append failed (non-blocking): ${error.message}`);
  }
}

export async function recordRefusedToolCall({
  sessionKey, agentId, toolName, params = {}, blockReason = "", contractId = null, logger = null,
} = {}) {
  try {
    const collab = isCollabToolName(toolName);
    const argsDigest = collab ? digestCollabToolArgs(params) : digestToolArgs(toolName, params);
    // 先立指纹再落账:宿主把 blockReason 当工具错误回给 agent 后,after_tool_call
    // 会带着同一次调用再来一趟,那一趟凭这个指纹自行退让。
    markRefused(fingerprintOf(sessionKey, toolName, argsDigest));
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: collab ? TRACE_EVENT_KINDS.COLLAB : TRACE_EVENT_KINDS.INTERNAL,
      channel: TRACE_EVENT_CHANNELS.FC,
      name: toolName || "unknown",
      argsDigest,
      resultDigest: { blockReason: String(blockReason || "").slice(0, 200) },
      outcome: TRACE_EVENT_OUTCOMES.REFUSED,
      agentId, sessionKey, contractId,
    }));
  } catch (error) {
    logger?.warn?.(`[watchdog] refused-event append failed (non-blocking): ${error.message}`);
  }
}

// ── 合成事件(synthesized:true,spec 决议3 OMIT-01 / 决议22 OMIT-11)──────────
// 文本路 [ACTION] 到 agent_end 才被消费,钩子面没有对应 FC 事件——由 lifecycle
// 在执行后调这里合成入账,考官在同一本账里看到全部协作动作。

// 受理结果 → 账本 outcome:策略/门控拒绝 = refused;带 error 的失败 = error;
// 其余(dispatched/queued/busy…)= ok。rolePolicyRejected 结果同时带 error,
// 故 refused 判定先行。
function resolveSynthesizedCollabOutcome(result) {
  if (result?.rolePolicyRejected === true || result?.status === SYSTEM_ACTION_STATUS.GATE_REJECTED) {
    return TRACE_EVENT_OUTCOMES.REFUSED;
  }
  if (result?.error) return TRACE_EVENT_OUTCOMES.ERROR;
  return TRACE_EVENT_OUTCOMES.OK;
}

export async function recordSynthesizedCollabEvent({
  sessionKey, agentId, channel = TRACE_EVENT_CHANNELS.TEXT,
  name, args = {}, result = null, contractId = null, logger = null,
} = {}) {
  try {
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: TRACE_EVENT_KINDS.COLLAB,
      channel,
      name: name || "unknown",
      argsDigest: digestCollabToolArgs(args),
      // 与 FC 行同款约定:collab 的 result 槽放受理凭证。凭证刻意保持
      // systemActionConsume 的原形(无 accepted 字段)——B5 合流只认 toolface
      // 写入的 accepted:true,合成行对合流保持惰性,文本路重试语义原样。
      resultDigest: { receipt: digestCollabToolArgs(result || {}) },
      outcome: resolveSynthesizedCollabOutcome(result),
      synthesized: true,
      agentId, sessionKey, contractId,
    }));
  } catch (error) {
    logger?.warn?.(`[watchdog] synthesized collab event append failed (non-blocking): ${error.message}`);
  }
}

// runtime 内部事实的留痕入口(如 stage_plan_overwritten)。kind:internal 仅
// fc 通道合法;synthesized:true 即表明这是 runtime 合成记账而非真实 FC。
export async function recordSynthesizedInternalEvent({
  sessionKey, agentId, name, args = {}, contractId = null, logger = null,
} = {}) {
  try {
    await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: TRACE_EVENT_KINDS.INTERNAL,
      channel: TRACE_EVENT_CHANNELS.FC,
      name: name || "unknown",
      argsDigest: digestCollabToolArgs(args),
      outcome: TRACE_EVENT_OUTCOMES.OK,
      synthesized: true,
      agentId, sessionKey, contractId,
    }));
  } catch (error) {
    logger?.warn?.(`[watchdog] synthesized internal event append failed (non-blocking): ${error.message}`);
  }
}
