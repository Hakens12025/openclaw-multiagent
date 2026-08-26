// run-join.js — 一个 run 的两店场外拼接(只读)
//
// 记录面分两个店,各按自己的维度组织:
//   records DB 事实账 · 按 run/事件 —— run_event 行(权威序 (seq,id))
//   records DB 证据账 · 按 session —— trace_event 行(每次工具调用的原始记录)
// (harness 判定账已全退役,v226 / 2026-08-23;文件账(events.jsonl/trace jsonl)
// 已随文件账退役批退役,records.db 是唯一真值)
// 两个店在树里各有"物"的对应物:threads/{t}/runs/{r}/ 的 contracts 正本与
// participants 产物/转录 —— 那是"物"不是账(148 §1.4),仍走文件读。
// 两者不共享物理位置,但共享两把钥匙:**contractId** 与 **sessionKey**。
// 本模块只做"拼",不做"并":原地读、原地对齐,任何一个店缺席都只让对应那段留白,
// 不影响其余。
//
// 每路数据来源记入 recordSource({events, traces}):db = 正常;none = DB 缺席
// (如实报缺,没有可回落的东西)。
//
// 序的诚实性(备忘录142 四序纪律):
//   店内序以各自主键为准 —— events 用 seq,trace 用 seq(同 sessionKey 内,
//   (sessionKey,seq) 撞号被唯一索引当场拒)。
//   **跨店没有全局序**,合并时间线只能按 ts 近似对齐,
//   因此每个条目都带 `orderKey`(店内权威序)与 `approx:true` 标记,读的人要知道
//   跨店相邻不等于因果相邻。真因果看 events 的 causeRefs。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  RUN_CONTRACTS_DIRNAME,
  RUN_PARTICIPANTS_DIRNAME,
  resolveContractHome,
  resolveThreadsRoot,
  runDirFor,
} from "./thread-tree-store.js";
import { readOutboxSeal } from "./outbox-seal.js";
import { normalizeString } from "../core/normalize.js";
import { tryReadRunEventsFromDb, tryReadTraceEventsFromDb } from "../record-plane/record-reader.js";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// 任意 id(runId / contractId / threadId)→ {threadId, runId}。
// contractId 走索引;runId/threadId 走目录扫描(树不大,且这是只读工具)。
export function resolveRunTarget(idOrKey) {
  const id = normalizeString(idOrKey);
  if (!id) return null;

  const home = resolveContractHome(id);
  if (home?.threadId && home?.runId) {
    return { threadId: home.threadId, runId: home.runId, matchedBy: "contractId" };
  }

  const root = resolveThreadsRoot();
  let threadDirs = [];
  try {
    threadDirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const threadId of threadDirs) {
    if (id === threadId) {
      try {
        const runs = readdirSync(join(root, threadId, "runs")).sort();
        const latest = runs[runs.length - 1];
        if (latest) return { threadId, runId: latest, matchedBy: "threadId(最近一个 run)" };
      } catch { /* 该 thread 无 runs */ }
      continue;
    }
    try {
      if (readdirSync(join(root, threadId, "runs")).includes(id)) {
        return { threadId, runId: id, matchedBy: "runId" };
      }
    } catch { /* 跳过 */ }
  }

  // 索引之外的兜底:参与者目录名自带 cid(inbox-<cid> / outbox-<cid>)。
  // 合约正本一旦缺席(历史上被测试清理误删过),contract-index 跟着重建成空,
  // 按 contractId 就查不到家了 —— 但目录名还认得它。查历史 run 全靠这一层。
  const lowered = id.toLowerCase();
  for (const threadId of threadDirs) {
    let runIds = [];
    try {
      runIds = readdirSync(join(root, threadId, "runs"));
    } catch {
      continue;
    }
    for (const runId of runIds) {
      const participantsDir = join(root, threadId, "runs", runId, RUN_PARTICIPANTS_DIRNAME);
      let agents = [];
      try {
        agents = readdirSync(participantsDir);
      } catch {
        continue;
      }
      for (const agentId of agents) {
        let entries = [];
        try {
          entries = readdirSync(join(participantsDir, agentId));
        } catch {
          continue;
        }
        const hit = entries.some((name) => {
          const cid = name.startsWith("inbox-") ? name.slice(6)
            : name.startsWith("outbox-") ? name.slice(7)
              : null;
          return cid !== null && cid.toLowerCase() === lowered;
        });
        if (hit) return { threadId, runId, matchedBy: "participants 目录名(索引未收录)" };
      }
    }
  }
  return null;
}

function collectParticipants(runDir) {
  const participantsDir = join(runDir, RUN_PARTICIPANTS_DIRNAME);
  const participants = [];
  let names = [];
  try {
    names = readdirSync(participantsDir);
  } catch {
    return participants;
  }
  for (const agentId of names.sort()) {
    const dir = join(participantsDir, agentId);
    let entries = [];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const outboxes = [];
    for (const entry of entries.filter((name) => name.startsWith("outbox-")).sort()) {
      const outboxDir = join(dir, entry);
      const seal = readOutboxSeal(outboxDir);
      let files = [];
      try {
        files = readdirSync(outboxDir).filter((name) => !name.startsWith("."));
      } catch { /* 目录竞态摘除 */ }
      outboxes.push({
        contractId: entry.slice("outbox-".length),
        dir: outboxDir,
        files: files.sort(),
        sealed: Boolean(seal),
        primary: normalizeString(seal?.primary) || null,
        declaredStatus: normalizeString(seal?.declaredStatus) || null,
        collectedAt: Number(seal?.collectedAt) || null,
      });
    }
    const inboxes = entries
      .filter((name) => name.startsWith("inbox-"))
      .sort()
      .map((name) => ({
        contractId: name.slice("inbox-".length),
        dir: join(dir, name),
        contract: readJson(join(dir, name, "contract.json")),
      }));
    participants.push({
      agentId,
      outboxes,
      inboxes,
      sessionTranscripts: entries.filter((name) => name.startsWith("session-")).sort(),
      turnProjections: entries.filter((name) => name.startsWith("turn-")).sort(),
      deliveries: entries.filter((name) => name.startsWith("delivery-")).sort(),
    });
  }
  return participants;
}

function collectTraces(sessionKeys) {
  const traces = [];
  const missing = [];
  const sources = new Set();
  for (const sessionKey of sessionKeys) {
    const fromDb = tryReadTraceEventsFromDb(sessionKey);
    if (fromDb === null) {
      sources.add("none");
      missing.push(sessionKey); // DB 缺席:如实报缺,证据腿留白
      continue;
    }
    if (fromDb.length === 0) {
      missing.push(sessionKey); // 该会话无证据记录(未落账)
      continue;
    }
    sources.add("db");
    traces.push({ sessionKey, file: null, calls: fromDb, source: "db" });
  }
  const source = sources.size === 0 ? "db" : sources.size === 1 ? [...sources][0] : "mixed";
  return { traces, missingSessions: missing, source };
}

// 两店条目并成一条时间线。ts 只是近似对齐轴:同店内的权威序放在 orderKey 里,
// 跨店相邻不代表因果相邻——真因果在 events 的 causeRefs。
function buildTimeline({ events, traces }) {
  const entries = [];
  for (const event of events) {
    entries.push({
      store: "threads",
      kind: "event",
      ts: Number(event.ts) || 0,
      orderKey: `seq:${event.seq}`,
      agentId: event.agentId || null,
      contractId: event.contractId || null,
      sessionKey: event.sessionKey || null,
      label: event.type,
      detail: event.payload || null,
      causeRefs: event.causeRefs || null,
    });
  }
  for (const trace of traces) {
    for (const call of trace.calls) {
      // 证据账里除了工具调用,还有会话生命周期标记(session_open / session_close),
      // 它们没有 channel/name —— 那是合法形态,不是缺字段。
      const isLifecycle = !call.name;
      entries.push({
        store: "trace",
        kind: isLifecycle ? "session_lifecycle" : "tool_call",
        ts: Number(call.ts) || 0,
        orderKey: `seq:${call.seq}@${trace.sessionKey}`,
        agentId: normalizeString(call.agentId) || null,
        contractId: normalizeString(call.contractId) || null,
        sessionKey: trace.sessionKey,
        label: isLifecycle ? call.kind : `${call.channel || "fc"}:${call.name}`,
        detail: isLifecycle
          ? null
          : { args: call.args ?? null, result: call.result ?? null, outcome: call.outcome ?? null },
        hash: call.hash || null,
      });
    }
  }
  entries.sort((a, b) => a.ts - b.ts || a.store.localeCompare(b.store));
  return entries;
}

/**
 * 把一个 run 的两店记录拼成一份完整视图。任何一个店缺席只让对应段留白,
 * 缺口一律进 `gaps` 显式回报——静默留白正是记录面最难查的病。
 *
 * @param {{threadId:string, runId:string}} target
 * @returns {{target, runDir, run, events, participants, traces, timeline, gaps, stats}}
 */
export function joinRunRecords({ threadId, runId }) {
  const runDir = runDirFor({ threadId, runId });
  const gaps = [];

  // 事件账:records DB 唯一来源(按 (seq,id) 升序 = 到达序)。
  let events = tryReadRunEventsFromDb(runId);
  let eventsSource = "db";
  if (events === null) {
    events = [];
    eventsSource = "none"; // DB 缺席:如实报缺,没有可回落的东西
    gaps.push({ store: "records", what: "run_event", reason: "records DB 缺席或不可读" });
  } else if (events.length === 0) {
    gaps.push({ store: "records", what: "run_event", reason: "该 run 无事件记录" });
  }

  const run = readJson(join(runDir, "run.json"));
  if (!run) gaps.push({ store: "threads", what: "run.json", reason: "投影缺席" });

  const contractsDir = join(runDir, RUN_CONTRACTS_DIRNAME);
  let contractFiles = [];
  try {
    contractFiles = readdirSync(contractsDir).filter((name) => name.endsWith(".json"));
  } catch { /* 无 contracts/ 的纯事件 run 是合法态 */ }
  const contracts = contractFiles.map((name) => readJson(join(contractsDir, name))).filter(Boolean);

  const eventContractIds = [...new Set(events.map((e) => normalizeString(e.contractId)).filter(Boolean))];
  const sessionKeys = [...new Set(events.map((e) => normalizeString(e.sessionKey)).filter(Boolean))];

  // 事件账提到过、正本却不在的合约:这是最常见的一种洞,必须点名而不是留白。
  const presentContractIds = new Set(contracts.map((c) => normalizeString(c?.id)).filter(Boolean));
  const missingContracts = eventContractIds.filter((id) => !presentContractIds.has(id));
  if (missingContracts.length > 0) {
    gaps.push({
      store: "threads",
      what: `合约正本 ${missingContracts.length} 份`,
      reason: "事件账记着它、contracts/ 里没有",
      ids: missingContracts,
    });
  }

  const participants = collectParticipants(runDir);
  if (participants.length === 0) gaps.push({ store: "threads", what: "participants/", reason: "无参与者目录" });

  // 参与者目录名里的 cid 也算数:合约正本被清后,它常是唯一还认得出 cid 的地方。
  const participantContractIds = new Set();
  for (const p of participants) {
    for (const o of p.outboxes) participantContractIds.add(o.contractId);
    for (const i of p.inboxes) participantContractIds.add(i.contractId);
  }
  const allContractIds = [...new Set([...eventContractIds, ...participantContractIds])];

  const { traces, missingSessions, source: traceSource } = collectTraces(sessionKeys);
  for (const sessionKey of missingSessions) {
    gaps.push({ store: "trace", what: sessionKey, reason: "该会话无证据记录(未落账或已 TTL 清理)" });
  }

  const tsList = events.map((e) => Number(e.ts)).filter(Number.isFinite);
  const fromMs = tsList.length > 0 ? Math.min(...tsList) : NaN;
  const toMs = tsList.length > 0 ? Math.max(...tsList) : NaN;

  const timeline = buildTimeline({ events, traces });

  return {
    target: { threadId, runId },
    runDir,
    run,
    events,
    contracts,
    participants,
    traces,
    timeline,
    gaps,
    // 数据来源观测字段:db = 正常 / none = DB 缺席 / mixed = 按会话混合。
    recordSource: { events: eventsSource, traces: traceSource },
    stats: {
      events: events.length,
      contracts: contracts.length,
      contractIds: allContractIds.length,
      participants: participants.length,
      // 只数真正的工具调用:证据账里还混着会话生命周期标记(session_open/close),
      // 它们没有 name。时间线按同一判据分类,两处口径必须一致。
      toolCalls: traces.reduce((sum, t) => sum + t.calls.filter((c) => c.name).length, 0),
      traceEntries: traces.reduce((sum, t) => sum + t.calls.length, 0),
      traceSessions: traces.length,
      fromMs: Number.isFinite(fromMs) ? fromMs : null,
      toMs: Number.isFinite(toMs) ? toMs : null,
      timelineEntries: timeline.length,
    },
  };
}
