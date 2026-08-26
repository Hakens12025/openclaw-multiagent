// Tests: routing/delivery/delivery-pump.js — 投递泵(备忘录141 §八 Phase 3,任务B锁)。
//
// 锁五件事:
//   ① 一票 = 回投链先行 →(未压制)终态投递随后;入参 = 票据投影 + 正本重读
//      (自包含铁律:泵期 tracker 已删,禁止内存 tracker 依赖);诊断写回正本;完成删票。
//   ② deferred 票压制终态投递,日志原文逐字
//      "[watchdog] terminal delivery deferred for {agentId} via {deferredBy}"
//      (含链上 suppressCompletionEgress 变体)。
//   ③ 链抛错 → attempt 递增,票仍在待泵账上。
//   ④ 3 次打满 → 改名 .failed.json + broadcast alert(delivery_pump_exhausted)+ error 日志。
//   ⑤ poke 重入单飞:draining 旗标,重入返回 started:false,排空后旗标复位。
//
// mock 面:两条链 + contracts store + sse 用 mock.module,泵模块【动态 import】
// 加载(ESM 静态图教训:mock.module 对已链接的静态可达消费者无效,备忘录141 §七.3);
// 票据库走真实现,目录经 OPENCLAW_DELIVERY_TICKET_DIR 种进临时目录。
//
// Run: node --test --experimental-test-module-mocks tests/delivery-pump.test.js


import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DELIVERY_TICKET_ATTEMPTS,
  writeDeliveryTicket,
  listPendingDeliveryTickets,
} from "../lib/routing/delivery/delivery-ticket-store.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";

// 兜底种子:任何测试 IO 之前先指向临时目录
process.env.OPENCLAW_DELIVERY_TICKET_DIR = mkdtempSync(join(tmpdir(), "delivery-pump-test-root-"));

// ---- mock 面(注册必须先于泵的动态 import) ----

const calls = [];
let chainImpl = async () => buildChainResult();
let terminalImpl = async () => ({ ok: true, channel: "delivery", lane: "terminal_delivery" });

mock.module("../lib/routing/delivery/delivery-system-action-chain.js", {
  namedExports: {
    deliveryRunSystemActionChain: async (context) => {
      calls.push({ kind: "chain", context });
      return chainImpl(context);
    },
  },
});

mock.module("../lib/routing/delivery/delivery-terminal-runtime.js", {
  namedExports: {
    deliveryRunTerminalRuntime: async (input) => {
      calls.push({ kind: "terminal", input });
      return terminalImpl(input);
    },
  },
});

const contractsById = new Map();
const mergeCalls = [];
mock.module("../lib/contract/contracts.js", {
  namedExports: {
    readContractSnapshotById: async (contractId) => {
      const snapshot = contractsById.get(contractId);
      return snapshot ? structuredClone(snapshot) : null;
    },
    getContractPath: (contractId) => join("/virtual-contracts", `${contractId}.json`),
    mergeContractFields: async (contractPath, _logger, extraFields) => {
      mergeCalls.push({ contractPath, extraFields });
    },
    // 泵图内 contract-refresh.js(mergeRuntimeDiagnostics 宿主)也 import 本模块
    readContractSnapshotByPath: async () => null,
  },
});

const alerts = [];
mock.module("../lib/transport/sse.js", {
  namedExports: {
    broadcast: (event, payload) => { alerts.push({ event, payload }); },
  },
});

const {
  processDeliveryTicket,
  pokeDeliveryPump,
  startDeliveryPumpBackstop,
} = await import("../lib/routing/delivery/delivery-pump.js");

// ---- fixtures ----

function buildChainResult(overrides = {}) {
  return {
    diagnostics: {
      "delivery:system_action_runtime_result": { lane: "delivery:system_action_runtime_result", handled: true },
    },
    results: {
      "delivery:system_action_runtime_result": { deliveryId: "delivery:system_action_runtime_result", handled: true },
    },
    suppressCompletionEgress: false,
    suppressCompletionEgressBy: null,
    ...overrides,
  };
}

function seedContract(contractId, overrides = {}) {
  const contract = {
    id: contractId,
    task: "泵测试任务",
    assignee: "worker-a",
    status: "completed",
    replyTo: { agentId: "main" },
    output: "outbox/result.md",
    terminalOutcome: { status: "completed", reason: "done" },
    executionObservation: { toolCalls: 7 },
    runtimeDiagnostics: { ioObservation: { produced: ["outbox/result.md"] } },
    ...overrides,
  };
  contractsById.set(contractId, contract);
  return contract;
}

function buildTicket(contractId, overrides = {}) {
  return {
    contractId,
    agentId: "worker-a",
    terminalStatus: "completed",
    terminalOutcome: { status: "completed", reason: "done" },
    executionObservation: { toolCalls: 7 },
    suppress: { deferred: false, deferredBy: null },
    trackerProjection: {
      agentId: "worker-a",
      startMs: 1755000000000,
      toolCallTotal: 7,
      status: "completed",
      ioObservation: { produced: ["outbox/result.md"] },
    },
    ...overrides,
  };
}

function captureLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message) => lines.info.push(message),
    warn: (message) => lines.warn.push(message),
    error: (message) => lines.error.push(message),
  };
}

async function useTempTicketDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "delivery-pump-test-"));
  process.env.OPENCLAW_DELIVERY_TICKET_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  calls.length = 0;
  mergeCalls.length = 0;
  alerts.length = 0;
  contractsById.clear();
  chainImpl = async () => buildChainResult();
  terminalImpl = async () => ({ ok: true, channel: "delivery", lane: "terminal_delivery" });
  return dir;
}

// ---- ① 链→终态顺序 + 自包含重建 + 诊断写回 + 删票 ----

test("①一票:回投链先行,终态投递随后;入参自票据投影+正本重读;诊断写回正本;完成删票", async (t) => {
  const dir = await useTempTicketDir(t);
  const logger = captureLogger();
  const canon = seedContract("TC-P1");
  const persisted = await writeDeliveryTicket(buildTicket("TC-P1"));

  const outcome = await processDeliveryTicket(persisted, { logger });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.suppressed, false);

  // 顺序:链 → 终态
  assert.deepEqual(calls.map((entry) => entry.kind), ["chain", "terminal"]);

  // 链入参:contractData = 正本重读(非票据内嵌),tracker 依赖全部来自票据投影
  const chainContext = calls[0].context;
  assert.equal(chainContext.agentId, "worker-a");
  assert.deepEqual(chainContext.contractData, canon);
  assert.equal(chainContext.terminalStatus, "completed");
  assert.deepEqual(chainContext.outcome, { status: "completed", reason: "done" });
  assert.deepEqual(chainContext.executionObservation, { toolCalls: 7 });
  assert.equal(chainContext.trackingState.status, "completed");
  assert.equal(chainContext.trackingState.startMs, 1755000000000);
  assert.equal(chainContext.trackingState.toolCallTotal, 7);
  assert.deepEqual(chainContext.trackingState.ioObservation, { produced: ["outbox/result.md"] });
  // trackingState.contract = 正本展开 + path(replyTo 键与值保真)
  assert.deepEqual(chainContext.trackingState.contract.replyTo, { agentId: "main" });
  assert.equal(chainContext.trackingState.contract.path, join("/virtual-contracts", "TC-P1.json"));

  // 终态入参与链共享同一 tracker 投影
  const terminalInput = calls[1].input;
  assert.equal(terminalInput.trackingState, chainContext.trackingState);
  assert.deepEqual(terminalInput.contractData, canon);
  assert.equal(terminalInput.terminalStatus, "completed");

  // 诊断经 mergeContractFields 写回正本 path,保留正本既有 runtimeDiagnostics
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0].contractPath, join("/virtual-contracts", "TC-P1.json"));
  const mergedDiagnostics = mergeCalls[0].extraFields.runtimeDiagnostics;
  assert.deepEqual(mergedDiagnostics.terminalDelivery, { ok: true, channel: "delivery", lane: "terminal_delivery" });
  assert.ok(mergedDiagnostics.systemActionDelivery["delivery:system_action_runtime_result"]);
  assert.deepEqual(mergedDiagnostics.ioObservation, { produced: ["outbox/result.md"] });

  // 完成删票
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".json")), []);
});

// ---- ② 压制语义(逐字日志) ----

test("②deferred 票:压制终态投递,日志原文 via {deferredBy};票照常完成删票", async (t) => {
  const dir = await useTempTicketDir(t);
  const logger = captureLogger();
  seedContract("TC-P2");
  const persisted = await writeDeliveryTicket(buildTicket("TC-P2", {
    suppress: { deferred: true, deferredBy: "assign_task" },
  }));

  const outcome = await processDeliveryTicket(persisted, { logger });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.suppressed, true);
  assert.deepEqual(calls.map((entry) => entry.kind), ["chain"], "终态投递必须被压制");
  assert.ok(
    logger.lines.info.includes("[watchdog] terminal delivery deferred for worker-a via assign_task"),
    `压制日志必须逐字,实得: ${JSON.stringify(logger.lines.info)}`,
  );
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".json")), []);
});

test("②链上 suppressCompletionEgress:压制终态投递,deferredBy 取链的 suppressCompletionEgressBy", async (t) => {
  await useTempTicketDir(t);
  const logger = captureLogger();
  seedContract("TC-P3");
  chainImpl = async () => buildChainResult({
    suppressCompletionEgress: true,
    suppressCompletionEgressBy: "system_action_runtime_delivery",
  });
  const persisted = await writeDeliveryTicket(buildTicket("TC-P3"));

  const outcome = await processDeliveryTicket(persisted, { logger });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.suppressed, true);
  assert.deepEqual(calls.map((entry) => entry.kind), ["chain"]);
  assert.ok(
    logger.lines.info.includes("[watchdog] terminal delivery deferred for worker-a via system_action_runtime_delivery"),
  );
});

// ---- ③ 链抛错 → attempt 递增,票仍在 ----

test("③链抛错:attempt 递增落盘,票仍在待泵账上,不删票不投终态", async (t) => {
  const dir = await useTempTicketDir(t);
  const logger = captureLogger();
  seedContract("TC-P4");
  chainImpl = async () => { throw new Error("chain down"); };
  const persisted = await writeDeliveryTicket(buildTicket("TC-P4"));

  const outcome = await processDeliveryTicket(persisted, { logger });
  assert.equal(outcome.completed, false);
  assert.equal(outcome.exhausted, false);
  assert.equal(outcome.attempts, 1);

  const onDisk = JSON.parse(await readFile(join(dir, `${persisted.id}.json`), "utf8"));
  assert.equal(onDisk.attempts, 1);
  assert.equal(onDisk.lastError, "chain down");
  assert.deepEqual((await listPendingDeliveryTickets()).map((ticket) => ticket.id), [persisted.id]);
  assert.deepEqual(calls.map((entry) => entry.kind), ["chain"], "链抛错后不得继续终态投递");
  assert.equal(mergeCalls.length, 0);
  assert.ok(logger.lines.warn.some((line) => line.includes(`${persisted.id} attempt 1 failed`)));
});

// ---- ④ 3 次打满 → .failed 尸检 + alert + error 日志 ----

test("④重试打满:改名 .failed.json + broadcast delivery_pump_exhausted + error 日志", async (t) => {
  const dir = await useTempTicketDir(t);
  const logger = captureLogger();
  seedContract("TC-P5");
  chainImpl = async () => { throw new Error("still down"); };
  const persisted = await writeDeliveryTicket(buildTicket("TC-P5"));

  let lastOutcome = null;
  for (let attempt = 0; attempt < MAX_DELIVERY_TICKET_ATTEMPTS; attempt += 1) {
    lastOutcome = await processDeliveryTicket(persisted, { logger });
  }
  assert.equal(lastOutcome.exhausted, true);
  assert.equal(lastOutcome.attempts, MAX_DELIVERY_TICKET_ATTEMPTS);

  const names = await readdir(dir);
  assert.equal(names.includes(`${persisted.id}.json`), false);
  assert.equal(names.includes(`${persisted.id}.failed.json`), true);
  assert.deepEqual(await listPendingDeliveryTickets(), []);

  const exhaustedAlert = alerts.find((entry) => entry.payload?.type === EVENT_TYPE.DELIVERY_PUMP_EXHAUSTED);
  assert.ok(exhaustedAlert, "打满必须 broadcast alert");
  assert.equal(exhaustedAlert.event, "alert");
  assert.equal(exhaustedAlert.payload.ticketId, persisted.id);
  assert.equal(exhaustedAlert.payload.contractId, "TC-P5");
  assert.equal(exhaustedAlert.payload.attempts, MAX_DELIVERY_TICKET_ATTEMPTS);
  assert.equal(exhaustedAlert.payload.error, "still down");
  assert.ok(logger.lines.error.some((line) => line.includes(`${persisted.id} exhausted`)));
});

// ---- ⑤ poke 重入单飞 ----

test("⑤poke:排空当前 pending;drain 期间重入返回 started:false;排空后旗标复位", async (t) => {
  await useTempTicketDir(t);
  const logger = captureLogger();
  seedContract("TC-P6");
  await writeDeliveryTicket(buildTicket("TC-P6"));

  let releaseChain;
  const chainGate = new Promise((resolve) => { releaseChain = resolve; });
  chainImpl = async () => { await chainGate; return buildChainResult(); };

  const firstPoke = pokeDeliveryPump({ logger });
  assert.equal(firstPoke.started, true);
  await new Promise((resolve) => setTimeout(resolve, 20)); // 让 drain 走到链上挂起

  const reentry = pokeDeliveryPump({ logger });
  assert.equal(reentry.started, false, "drain 在飞时重入必须返回");

  releaseChain();
  await firstPoke.done;
  assert.equal(calls.filter((entry) => entry.kind === "chain").length, 1, "单飞:链只跑一次");
  assert.deepEqual(await listPendingDeliveryTickets(), [], "排空后无 pending");

  const afterDrain = pokeDeliveryPump({ logger });
  assert.equal(afterDrain.started, true, "排空后旗标必须复位");
  await afterDrain.done;
});

// ---- 背压兜底:启动即全量扫描(崩溃恢复) ----

test("backstop:启动即扫一次全量(崩溃恢复),stop() 停表", async (t) => {
  await useTempTicketDir(t);
  const logger = captureLogger();
  seedContract("TC-P7");
  await writeDeliveryTicket(buildTicket("TC-P7"));

  const stop = startDeliveryPumpBackstop({ logger, intervalMs: 3_600_000 });
  t.after(() => stop());

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await listPendingDeliveryTickets()).length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await listPendingDeliveryTickets(), [], "启动扫描必须消费存量票");
  assert.deepEqual(calls.map((entry) => entry.kind), ["chain", "terminal"]);
});

// ---- 2026-08-12 审查修缮的行为锁 ----

test("审查①:共享正本缺席时用票据快照执行(DIRECT 信封合约的唯一事实载体)", async () => {
  calls.length = 0;
  const ticket = await writeDeliveryTicket(buildTicket("DIRECT-ENV-SNAP-1", {
    contractSnapshot: {
      id: "DIRECT-ENV-SNAP-1",
      status: "completed",
      replyTo: { agentId: "main" },
      path: "/tmp/pump-env-snap/inbox/contract.json",
      terminalOutcome: { status: "completed", reason: "done" },
    },
  }));
  // 不 seedContract:readContractSnapshotById 返回 undefined = 共享目录无此约
  const result = await processDeliveryTicket(ticket, { api: {}, logger: captureLogger() });
  assert.equal(result.completed, true, "信封合约必须经票据快照完成投递,不得报快照缺失");
  assert.ok(calls.some((c) => c.kind === "chain"), "回投链必须被执行");
});

test("审查③:done 键在手时跳过执行只补删票(跨重启不重投)", async () => {
  calls.length = 0;
  seedContract("TC-PUMP-DONEKEY-1");
  const ticket = await writeDeliveryTicket(buildTicket("TC-PUMP-DONEKEY-1"));
  const first = await processDeliveryTicket(ticket, { api: {}, logger: captureLogger() });
  assert.equal(first.completed, true);
  const executionsAfterFirst = calls.filter((c) => c.kind === "chain").length;

  // 重放同票(如崩溃后残票被启动扫描重拾):done 键挡执行——重放前把票复写回盘
  const replayTicket = await writeDeliveryTicket(buildTicket("TC-PUMP-DONEKEY-1"));
  const replay = await processDeliveryTicket(replayTicket, { api: {}, logger: captureLogger() });
  assert.equal(replay.completed, true);
  assert.equal(
    calls.filter((c) => c.kind === "chain").length,
    executionsAfterFirst,
    "done 键在手的重放不得再次执行投递链",
  );
});

test("审查⑤:源会话 closing 时让路不执行(票据保留待重扫)", async () => {
  calls.length = 0;
  const { registerAgentEndRun } = await import("../lib/session/session-phase-store.js");
  const sessionKey = `agent:pump-defer:contract:tc-pump-defer-${Date.now()}`;
  const runHandle = registerAgentEndRun(sessionKey);
  try {
    seedContract("TC-PUMP-DEFER-1");
    const result = await processDeliveryTicket(
      await writeDeliveryTicket(buildTicket("TC-PUMP-DEFER-1", { sessionKey })),
      { api: {}, logger: captureLogger() },
    );
    assert.equal(result.completed, false);
    assert.equal(result.deferred, "session_closing");
    assert.equal(calls.filter((c) => c.kind === "chain").length, 0, "closing 让路时不得执行投递");
  } finally {
    runHandle.settle(Promise.resolve());
    runHandle.clear();
  }
});
