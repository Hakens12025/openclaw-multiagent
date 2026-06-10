/**
 * formal-error-codes.test.js — 错误码注册表形状校验
 *
 * 注册表是 CheckResult 体系的单一真值源：码格式、subsystem/meaning/hint 完备性、
 * 前缀↔subsystem 一致性、冻结性。hint 必须具体（指名文件/路由/真值源）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ERROR_CODES, getErrorCode, listErrorCodes } from "../lib/formal-runtime/error-codes.js";

const CODE_FORMAT = /^E-[A-Z]+-(?:\d{3}|SKIP)$/;

test("所有码符合 E-<SUBSYS>-<NNN|SKIP> 格式", () => {
  const ids = Object.keys(ERROR_CODES);
  assert.ok(ids.length >= 60, `expected a thorough registry (>=60 codes), got ${ids.length}`);
  for (const id of ids) {
    assert.match(id, CODE_FORMAT, `bad code format: ${id}`);
  }
});

test("每个条目都有非空 subsystem/meaning/hint，且 hint 非敷衍", () => {
  for (const [id, meta] of Object.entries(ERROR_CODES)) {
    assert.equal(typeof meta.subsystem, "string", `${id} subsystem`);
    assert.ok(meta.subsystem.trim().length > 0, `${id} subsystem empty`);
    assert.equal(typeof meta.meaning, "string", `${id} meaning`);
    assert.ok(meta.meaning.trim().length > 0, `${id} meaning empty`);
    assert.equal(typeof meta.hint, "string", `${id} hint`);
    assert.ok(meta.hint.trim().length >= 10, `${id} hint too thin to be actionable: ${meta.hint}`);
  }
});

test("同前缀的码共享同一 subsystem（前缀↔subsystem 一致性）", () => {
  const byPrefix = new Map();
  for (const [id, meta] of Object.entries(ERROR_CODES)) {
    const prefix = id.split("-")[1];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, meta.subsystem);
    assert.equal(meta.subsystem, byPrefix.get(prefix), `${id} subsystem diverges within prefix E-${prefix}-*`);
  }
});

test("listErrorCodes 与注册表一一对应且携带 id", () => {
  const list = listErrorCodes();
  assert.equal(list.length, Object.keys(ERROR_CODES).length);
  for (const item of list) {
    assert.ok(ERROR_CODES[item.id], `listed id missing in registry: ${item.id}`);
    assert.equal(item.hint, ERROR_CODES[item.id].hint);
  }
});

test("getErrorCode：已注册返回条目，未注册/非字符串返回 null", () => {
  const graph = getErrorCode("E-GRAPH-001");
  assert.ok(graph, "contract example E-GRAPH-001 must exist");
  assert.equal(graph.subsystem, "graph");
  assert.match(graph.hint, /agent-graph\.json/);

  assert.equal(getErrorCode("E-NOPE-999"), null);
  assert.equal(getErrorCode(null), null);
  assert.equal(getErrorCode(42), null);
});

test("约定的 skip 码已注册（E-KNOWLEDGE-SKIP / E-LOOP-SKIP）", () => {
  assert.ok(getErrorCode("E-KNOWLEDGE-SKIP"));
  assert.ok(getErrorCode("E-LOOP-SKIP"));
  assert.match(getErrorCode("E-KNOWLEDGE-SKIP").hint, /ollama/);
});

test("runner 内部码族存在（E-RUNNER-*：crash/timeout/gateway 不可达）", () => {
  assert.ok(getErrorCode("E-RUNNER-001"));
  assert.ok(getErrorCode("E-RUNNER-002"));
  assert.ok(getErrorCode("E-RUNNER-003"));
});

test("注册表与条目均被冻结（防运行期篡改）", () => {
  assert.ok(Object.isFrozen(ERROR_CODES));
  for (const meta of Object.values(ERROR_CODES)) {
    assert.ok(Object.isFrozen(meta));
  }
});
