// Tests: deliveryEnqueueSystemActionReturn 跨腿幂等隔离(备忘录141 修订)。
//
// 病理(2026-08-12 对抗审查抓获,live 复现确认过):assign 的派发腿与回投腿共用
// 同一 SADT 票据且同走本漏斗。票据键不带腿别时,派发入箱记 deliver:SADT-x,
// 回投携同一票据到达→查到同键→整个回投被去重,结果永不入 requester inbox——
// 每一次 assign_task(及当时仍在的 request_review)往返的回程都断。
// 修法:deliver:{leg}:{ticketId},派发腿显式标注 deliveryLeg:"dispatch"。
//
// 本锁:①派发后回投【必须照常入箱】 ②同腿重复到达【必须去重】。
// mock 面:入箱层(dispatch-transport)捕获调用;键账 mock 成内存实现(勿写真
// control-plane),键构造/DELIVERY_LEGS 沿用真实现。
//
// Run: node --test --experimental-test-module-mocks tests/delivery-cross-leg-idempotency.test.js

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  COMPACT_TRIGGER_LINES,
  COMPACT_KEEP_LINES,
  DELIVERY_LEGS,
  buildWakeIdempotencyKey,
  buildDeliverIdempotencyKey,
  compactLedgerEntries,
  createDeliveryIdempotencyStore,
} from "../lib/store/delivery-idempotency-store.js";

const memoryLedger = new Set();
const ledgerImpl = {
  hasDeliveryKey: async (key) => memoryLedger.has(key),
  recordDeliveryKey: async (key) => {
    if (typeof key !== "string" || !key.trim()) return false;
    memoryLedger.add(key.trim());
    return true;
  },
};

mock.module("../lib/store/delivery-idempotency-store.js", {
  namedExports: {
    COMPACT_TRIGGER_LINES,
    COMPACT_KEEP_LINES,
    DELIVERY_LEGS,
    buildWakeIdempotencyKey,
    buildDeliverIdempotencyKey,
    compactLedgerEntries,
    createDeliveryIdempotencyStore,
    ...ledgerImpl,
  },
});

const enqueueCalls = [];
mock.module("../lib/routing/dispatch/dispatch-transport.js", {
  namedExports: {
    dispatchSendDirectRequest: async ({ contract, from }) => {
      enqueueCalls.push({ contractId: contract?.id || null, from });
      return { enqueueResult: { promoted: true }, blocked: false };
    },
  },
});

const { deliveryEnqueueSystemActionReturn } = await import(
  "../lib/routing/delivery/delivery-system-action-transport.js"
);

const silentLogger = { info() {}, warn() {}, error() {} };
const TICKET = "SADT-CROSS-LEG-1";

function makeEnvelope(id) {
  return { id, output: null };
}

function enqueueArgs(leg, envelopeId) {
  return {
    lane: "system_action_assign_task_result",
    targetAgent: "cross-leg-target",
    contract: makeEnvelope(envelopeId),
    api: null,
    logger: silentLogger,
    deliveryLeg: leg,
    wake: { deliveryTicketId: TICKET },
  };
}

test("派发腿记键后,携同一票据的回投腿必须照常入箱(跨腿不碰撞)", async () => {
  memoryLedger.clear();
  enqueueCalls.length = 0;

  const dispatchLeg = await deliveryEnqueueSystemActionReturn(enqueueArgs("dispatch", "DIRECT-TASK-1"));
  assert.ok(dispatchLeg.enqueueResult, "派发腿应入箱");
  assert.equal(enqueueCalls.length, 1);

  const returnLeg = await deliveryEnqueueSystemActionReturn(enqueueArgs("return", "DIRECT-RESULT-1"));
  assert.ok(
    returnLeg.enqueueResult,
    "回投腿携同一票据必须照常入箱——被去重即跨腿碰撞回归",
  );
  assert.notEqual(returnLeg.wake?.mode, "deduplicated");
  assert.equal(enqueueCalls.length, 2, "两条腿各自真实入箱一次");
});

test("同腿重复到达必须去重(双总线重复投递无害化)", async () => {
  memoryLedger.clear();
  enqueueCalls.length = 0;

  const first = await deliveryEnqueueSystemActionReturn(enqueueArgs("return", "DIRECT-RESULT-A"));
  assert.ok(first.enqueueResult);

  const duplicate = await deliveryEnqueueSystemActionReturn(enqueueArgs("return", "DIRECT-RESULT-A"));
  assert.equal(duplicate.enqueueResult, null, "同腿同票据重复到达应被去重");
  assert.equal(duplicate.wake?.mode, "deduplicated");
  assert.equal(enqueueCalls.length, 1, "重复到达不得再次入箱");
});
