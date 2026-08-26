// tests/core-boot-ledger.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createBootLedger } from "../lib/core/boot-ledger.js";

test("依赖齐备时 assertComplete 通过并给出计数", () => {
  const ledger = createBootLedger();
  ledger.provide("store.tracker", "state-collections");
  ledger.requires("store.tracker", "lifecycle/agent-timeout-sweep");
  const summary = ledger.assertComplete();
  assert.equal(summary.providedCount, 1);
  assert.equal(summary.requiredCount, 1);
});

test("缺依赖即抛,报错点名缺什么、谁在要", () => {
  const ledger = createBootLedger();
  ledger.requires("store.contracts", "routing/dispatch");
  assert.throws(() => ledger.assertComplete(), /E-BOOT-001[\s\S]*store\.contracts[\s\S]*routing\/dispatch/);
});

test("断言之后禁止再声明（防装配期之后的漂移）", () => {
  const ledger = createBootLedger();
  ledger.assertComplete();
  assert.throws(() => ledger.provide("x", "y"), /after assertComplete/);
  assert.throws(() => ledger.requires("x", "y"), /after assertComplete/);
});

test("重复 provide 同名即抛（一条路径原则:双供给=真值分裂前兆）", () => {
  const ledger = createBootLedger();
  ledger.provide("store.tracker", "a");
  assert.throws(() => ledger.provide("store.tracker", "b"), /already provided/);
});

test("summary 报告封账状态与计数（health 体检的消费面,无副作用可重复读）", () => {
  const ledger = createBootLedger();
  ledger.provide("a", "p");
  assert.deepEqual(ledger.summary(), { sealed: false, providedCount: 1, requiredCount: 0 });
  ledger.assertComplete();
  assert.equal(ledger.summary().sealed, true);
  assert.equal(ledger.summary().sealed, true); // 二次读无副作用
});
