// session-trace-reader.js — 证据账的宽容读取器(spec §8 B5;文件账退役批起读 records DB)。
// agent_end 读本会话 trace 时 close 哨兵还没写(它在 lifecycle 之后落账),
// 所以这里只做宽验:行可解析、open 在场。
// 任何异常都退化为空数组——证据面严格弱于执行面,读不动不挡终态。

import { TRACE_EVENT_KINDS } from "./trace-event-schema.js";
import { tryReadTraceEventsFromDb } from "../record-plane/record-reader.js";

// → [{ name, args, receipt, outcome, seq, ts }](仅 kind:collab,按 seq 序)
// contractId 必须定界:一个 sessionKey 可被多份合约复用(resume/直投),事件
// 追加进同一本账。不按 contractId 过滤会把【上一合约】的受理事实带进本轮,
// 导致本轮同 (intent,target) 的标记被误判为"已执行"而静默丢弃。
export async function readSessionCollabFacts(sessionKey, { contractId = null } = {}) {
  try {
    const records = tryReadTraceEventsFromDb(sessionKey);
    if (records === null || records.length === 0) return [];
    return records
      .filter((record) => record.kind === TRACE_EVENT_KINDS.COLLAB
        && (!contractId || record.contractId === contractId))
      .map((record) => ({
        name: record.name || null,
        args: record.args && typeof record.args === "object" ? record.args : {},
        receipt: record.result?.receipt && typeof record.result.receipt === "object"
          ? record.result.receipt
          : null,
        outcome: record.outcome || null,
        seq: record.seq,
        ts: record.ts || null,
      }));
  } catch {
    return [];
  }
}
