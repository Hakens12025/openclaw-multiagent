import test from "node:test";
import assert from "node:assert/strict";
import { createLeaseHolder } from "../lib/core/lease.js";

test("effect 返回单次生效的撤销凭证", () => {
  const lease = createLeaseHolder("t");
  let calls = 0;
  const dispose = lease.effect(() => { calls++; }, "x");
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  assert.equal(calls, 1);
  assert.equal(lease.size(), 0);
});

test("disposeAll 逆序执行且二次调用为空操作", () => {
  const lease = createLeaseHolder("t");
  const order = [];
  lease.effect(() => order.push("a"), "a");
  lease.effect(() => order.push("b"), "b");
  lease.effect(() => order.push("c"), "c");
  assert.equal(lease.disposeAll(), 3);
  assert.deepEqual(order, ["c", "b", "a"]);
  assert.equal(lease.disposeAll(), 0);
});

test("disposeAll 单条失败不阻断其余，逐条上报", () => {
  const lease = createLeaseHolder("t");
  const order = [];
  const errors = [];
  lease.effect(() => order.push("a"), "a");
  lease.effect(() => { throw new Error("boom"); }, "bad");
  lease.effect(() => order.push("c"), "c");
  assert.equal(lease.disposeAll((e, label) => errors.push(label)), 2);
  assert.deepEqual(order, ["c", "a"]);
  assert.deepEqual(errors, ["bad"]);
});

test("disposeAll 之后 effect 抛错（防清理期逃逸）", () => {
  const lease = createLeaseHolder("t");
  lease.disposeAll();
  assert.throws(() => lease.effect(() => {}), /after disposeAll/);
});

test("interval 凭证可清定时器", () => {
  const lease = createLeaseHolder("t");
  const dispose = lease.interval(() => {}, 60_000, "tick");
  assert.equal(lease.size(), 1);
  assert.equal(dispose(), true);
  assert.equal(lease.size(), 0);
});

test("owner 缺失或 disposer 非函数即抛（fail-loud）", () => {
  assert.throws(() => createLeaseHolder(""), /owner name required/);
  const lease = createLeaseHolder("t");
  assert.throws(() => lease.effect(null, "x"), /must be a function/);
});

test("高频登记-撤销后账本自压缩,不留尸体（防以泄漏形态修泄漏）", () => {
  const lease = createLeaseHolder("t");
  for (let i = 0; i < 1000; i++) {
    const dispose = lease.effect(() => {}, `churn-${i}`);
    dispose();
  }
  assert.equal(lease.size(), 0);
  assert.equal(lease.ledgerSize(), 0); // 内部账本也为空——推广批 tracker 高频定时器换手的前提
});

test("异步 disposer 拒收:thenable 走 onError 不计成功（同步专属是结构性约束）", () => {
  const lease = createLeaseHolder("t");
  const errors = [];
  lease.effect(async () => {}, "async-bad");
  assert.equal(lease.disposeAll((e, label) => errors.push(label)), 0);
  assert.deepEqual(errors, ["async-bad"]);
});
