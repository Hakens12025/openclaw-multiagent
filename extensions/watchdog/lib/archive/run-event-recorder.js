// lib/archive/run-event-recorder.js — run 事件账唯一写者(备忘录142 §八事件芯/§九时序/§十statement)。
//
// records DB 的 run_event 行 = run 的 RAW 真值(append-only,单写者=本模块;GAP-03:
// 事件账为真值,合约活文件是工作缓存)。文件账(events.jsonl)已随文件账退役批退役。
// 行 schema(payload 全文):
//   { seq, ts, threadId, runId, type, contractId?, sessionKey?, agentId?, payload?, causeRefs? }
//
// 四序纪律(§九/§十):seq=账主键(per-run 单调,1 起),ts=节点属性永不作排序键,
// causeRefs=[{runId,seq}] 因果边(复数,§十一钩①),全局地址={runId,seq} 二元组。
// 落账断言:同 run 内 causeRefs[].seq < seq —— 违反即 throw,这是 bug 不是容错。
//
// group commit(GAP-05 语义平移):微批(25ms 窗口/64 条上限)聚合,一批一个 DB
// 事务(writeRunEvents,COMMIT 即持久,WAL + synchronous=FULL)。失败 → 整批退回
// buffer 头重试(不弃内存座位:弃了会让重建座位与在链座位并行 = 同 run 双 seq 源)。
//
// seq 计数器常驻内存,首触从 DB 重建(getRunMaxSeq);状态按 runId 分键(测试换
// OPENCLAW_RECORD_DB 自动隔离)。
// 投影钩子:每批落库后标脏;批内含 run_closed → 必编投影(§十二.1)——编译失败
// 只记日志不拒事件(投影坏≠事实丢,重放即复原)。

import { requireRunLineage } from "./thread-tree-store.js";
import { compileRunProjections, markRunProjectionDirty } from "./run-projections.js";
import {
  deriveOpenContracts,
  getRunMaxSeq,
  hasRunEventForContract,
  writeRunEvents,
} from "../record-plane/record-writer.js";
import { normalizeString } from "../core/normalize.js";
import { broadcast } from "../transport/sse.js";

// ---- 事件类型注册表(§八事件族 + §十一钩③保留名单) ----

export const RUN_EVENT_TYPES = Object.freeze({
  RUN_TRIGGERED: "run_triggered",
  CONTRACT_CREATED: "contract_created",
  DISPATCHED: "dispatched",
  CLAIMED: "claimed",
  TURN_STARTED: "turn_started",
  DECLARED: "declared",
  COLLECTED: "collected",
  CLOSED: "closed",
  TICKET_WRITTEN: "ticket_written",
  DELIVERED: "delivered",
  RUN_CLOSED: "run_closed",
});

// §十一钩③:agent-group 事件族只占名不启用 —— 注册即禁他用,appendRunEvent 拒收。
export const RESERVED_RUN_EVENT_TYPES = Object.freeze([
  "group_expanded",
  "branch_opened",
  "joined",
  "branch_cancelled",
]);

const ACTIVE_TYPE_SET = new Set(Object.values(RUN_EVENT_TYPES));
const RESERVED_TYPE_SET = new Set(RESERVED_RUN_EVENT_TYPES);

const FLUSH_WINDOW_MS = 25;
const FLUSH_MAX_BATCH = 64;

// runId → { lineage, hydrated, nextSeq, chain, buffer, flushTimer, flushChain }
const runStates = new Map();

// runId → 已发行最新 seq(阶段2.2 锚点水位,内存计数)。发行点(appendRunEvent 取号)
// 与首触重建(hydrate 查出历史 maxSeq)双处维护;本进程未触达过的 run → 无记录。
// 与 runStates 同生命周期:常驻不封顶(runStates 本身即常驻,量级一致)。
const seqWatermarkByRunId = new Map();

function assertRunEventType(type) {
  const value = normalizeString(type);
  if (value && ACTIVE_TYPE_SET.has(value)) return value;
  if (value && RESERVED_TYPE_SET.has(value)) {
    throw new Error(`run event type "${value}" is reserved for agent-group (备忘录142 §十一.3) and not yet active`);
  }
  throw new Error(`unknown run event type ${JSON.stringify(type)} — register it in RUN_EVENT_TYPES first`);
}

function getRunState(runId, lineage) {
  let state = runStates.get(runId);
  if (!state) {
    state = {
      lineage,
      hydrated: false,
      nextSeq: 1,
      chain: Promise.resolve(),
      buffer: [],
      flushTimer: null,
      flushChain: Promise.resolve(),
    };
    runStates.set(runId, state);
  }
  return state;
}

// 首触重建:从 DB 取该 run 已落账的最大 seq(crash 恢复语义,原文件扫描平移)。
// DB 打不开 → 外抛(事实账不可无真值而运转),由 appendRunEvent 的 reject 透出。
function hydrateRunState(state) {
  const maxSeq = getRunMaxSeq(state.lineage.runId);
  state.nextSeq = maxSeq + 1;
  state.hydrated = true;
  // 锚点水位(阶段2.2):历史已发行的最大 seq 入账,重启后首触即恢复水位。
  if (maxSeq > 0) seqWatermarkByRunId.set(state.lineage.runId, maxSeq);
}

function normalizeCauseRefs(causeRefs, runId, seq) {
  if (causeRefs === null || causeRefs === undefined) return null;
  if (!Array.isArray(causeRefs)) {
    throw new Error("causeRefs must be an array of {runId, seq}");
  }
  if (!causeRefs.length) return null;
  return causeRefs.map((ref, index) => {
    const refRunId = normalizeString(ref?.runId);
    const refSeq = ref?.seq;
    if (!refRunId || !Number.isInteger(refSeq) || refSeq < 1) {
      throw new Error(`causeRefs[${index}] must be {runId, seq>=1}, got ${JSON.stringify(ref)}`);
    }
    if (refRunId === runId && refSeq >= seq) {
      // §十不变量:同 run 内因果先于结果入账。违反 = 调用方 bug,拒收不落账。
      throw new Error(`causeRefs[${index}].seq ${refSeq} violates causal order: must be < seq ${seq} within run ${runId}`);
    }
    return { runId: refRunId, seq: refSeq };
  });
}

// 唯一落账入口。谱系/类型非法【同步】抛(工厂兜底保证每约有家,缺谱系是 bug);
// 返回 promise 在事件持久化(本批 DB COMMIT 完成)后 resolve {seq, ref:{runId, seq}}。
export function appendRunEvent({
  lineage,
  type,
  contractId = null,
  sessionKey = null,
  agentId = null,
  payload = null,
  causeRefs = null,
} = {}) {
  const { threadId, runId } = requireRunLineage(lineage);
  const eventType = assertRunEventType(type);
  const state = getRunState(runId, { threadId, runId });

  return new Promise((resolve, reject) => {
    state.chain = state.chain.then(async () => {
      try {
        if (!state.hydrated) hydrateRunState(state);
        const seq = state.nextSeq;
        const refs = normalizeCauseRefs(causeRefs, runId, seq); // 违例在 seq 消耗前抛,不留空洞
        const normalizedContractId = normalizeString(contractId);
        const normalizedSessionKey = normalizeString(sessionKey);
        const normalizedAgentId = normalizeString(agentId);
        const entry = {
          seq,
          ts: Date.now(),
          threadId,
          runId,
          type: eventType,
          ...(normalizedContractId ? { contractId: normalizedContractId } : {}),
          ...(normalizedSessionKey ? { sessionKey: normalizedSessionKey } : {}),
          ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
          ...(payload !== null && payload !== undefined ? { payload } : {}),
          ...(refs ? { causeRefs: refs } : {}),
        };
        JSON.stringify(entry); // 不可序列化 payload 在此抛 = 调用方 bug
        state.nextSeq = seq + 1;
        seqWatermarkByRunId.set(runId, seq); // 锚点水位:发行即记(含缓冲未落库序号,弱语义)
        state.buffer.push({ entry, resolve, reject });
        scheduleFlush(state);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function scheduleFlush(state) {
  if (state.buffer.length >= FLUSH_MAX_BATCH) {
    queueFlush(state);
    return;
  }
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => queueFlush(state), FLUSH_WINDOW_MS);
  state.flushTimer.unref?.();
}

function queueFlush(state) {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.flushChain = state.flushChain
    .then(() => flushNow(state))
    .catch(() => {}); // 落库错误已按批退回重试,flush 链自身不断
  return state.flushChain;
}

// group commit(GAP-05 语义平移):整批一个 DB 事务。失败 → 整批退回 buffer 头,
// 下次 flush 重试(不弃座位:seq 连续性与单源保住,同 run 不会出双 seq 源)。
async function flushNow(state) {
  const batch = state.buffer.splice(0);
  if (!batch.length) return;
  try {
    writeRunEvents(batch.map((item) => item.entry));
  } catch (error) {
    state.buffer.unshift(...batch);
    state.lastFlushError = String(error?.message || error);
    return;
  }

  markRunProjectionDirty(state.lineage);
  if (batch.some((item) => item.entry.type === RUN_EVENT_TYPES.RUN_CLOSED)) {
    // §十二.1:run 关账必编投影。编译失败不拒事件——投影坏≠事实丢,重放即复原。
    try {
      await compileRunProjections(state.lineage);
    } catch (error) {
      console.error(`[run-event-recorder] run_closed projection compile failed for ${state.lineage.runId}: ${error.message}`);
    }
  }
  for (const item of batch) {
    item.resolve({ seq: item.entry.seq, ref: { runId: state.lineage.runId, seq: item.entry.seq } });
  }
  // live 树账推流:事件已持久(本批 COMMIT 之后)才广播——SSE 面只转述盘上事实,
  // fire-and-forget,推流失败绝不影响记账。前端(runs 页/主页 ticker)以 run_event
  // 为 live 增量第一公民;连接期回放由 routes/dashboard.js 以 replay:true 区分。
  for (const item of batch) {
    try {
      broadcast("run_event", { ...item.entry });
    } catch { /* 推流面弱于记账面 */ }
  }
}

// 阶段2.2 锚点水位(148 §二 2.2):该 run 已发行的最新 seq。内存计数 ——
// happened-during 弱语义专用,含已发行尚在 group commit 缓冲的序号(不是持久性
// 保证);本进程从未触达过的 run → null(锚点留 NULL,宁缺不猜)。
export function getRunSeqWatermark(runId) {
  const id = normalizeString(runId);
  if (!id) return null;
  return seqWatermarkByRunId.get(id) ?? null;
}

// 强制清窗:挂号完成 + 缓冲落库(测试/停机用)。
export async function flushRunEvents(lineage) {
  const { runId } = requireRunLineage(lineage);
  const state = runStates.get(runId);
  if (!state) return;
  await state.chain.catch(() => {});
  await queueFlush(state);
}

// 合约级事件查询(审查④配套):该合约在账上是否出现过给定类型事件。
// 孤儿扫描用它区分"跑过没收口"(有 turn_started/claimed → 真孤儿)与
// "排队未开跑"(无 → 信封仍在队列,交给队列复活,不得误杀)。
export async function runHasEventForContract(lineage, contractId, types = []) {
  const normalized = requireRunLineage(lineage);
  const targetId = normalizeString(contractId);
  if (!targetId || !Array.isArray(types) || types.length === 0) return false;
  await flushRunEvents(normalized);
  return hasRunEventForContract(normalized.runId, targetId, types);
}

// GAP-02 run 关账判定辅助:从事件账现推导 contract_created 无对应 closed 的合约。
// 供 Wire 侧在 closed 事件后判全链终态(空数组 = 可落 run_closed)。
export async function deriveRunOpenContracts(lineage) {
  const normalized = requireRunLineage(lineage);
  await flushRunEvents(normalized);
  return deriveOpenContracts(normalized.runId);
}
