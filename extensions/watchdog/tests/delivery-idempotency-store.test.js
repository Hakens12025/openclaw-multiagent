// Tests: store/delivery-idempotency-store.js — 投递幂等键账(备忘录141 §三 锁B)。
//
// 锁三件事:
//   1. 键构造纯函数——有身份才去重(双 id 缺 → null),session 归一与 tracker-store 一致;
//   2. has/record 往返与跨实例持久化——路径注入临时目录,绝不写真 control-plane
//      (2026-08-11 测试直写真实 control-plane 的事故教训);
//   3. 压实判定纯函数 + 载入时容量治理(超限压实、原子写回、坏行跳过)。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMPACT_TRIGGER_LINES,
  COMPACT_KEEP_LINES,
  buildWakeIdempotencyKey,
  buildDeliverIdempotencyKey,
  compactLedgerEntries,
  createDeliveryIdempotencyStore,
} from "../lib/store/delivery-idempotency-store.js";

async function makeTempLedgerDir() {
  return mkdtemp(join(tmpdir(), "delivery-idem-test-"));
}

// ---- 1. 键构造(零 IO) ----

test("wake 键:deliveryTicketId 在手 → wake:{session}:{ticketId},session 归一 trim+toLowerCase", () => {
  const key = buildWakeIdempotencyKey({
    targetSessionKey: "  Agent:Worker-A:Contract:TC-9  ",
    deliveryTicketId: "SADT-20260812-abc",
  });
  assert.equal(key, "wake:agent:worker-a:contract:tc-9:SADT-20260812-abc");
});

test("wake 键:ticket 缺时回落 sourceContractId;两者都在时 ticket 优先", () => {
  assert.equal(
    buildWakeIdempotencyKey({ targetSessionKey: "s1", sourceContractId: "TC-77" }),
    "wake:s1:TC-77",
  );
  assert.equal(
    buildWakeIdempotencyKey({
      targetSessionKey: "s1",
      deliveryTicketId: "SADT-1",
      sourceContractId: "TC-77",
    }),
    "wake:s1:SADT-1",
  );
});

test("wake 键:无身份(双 id 缺/空白)→ null——generic/heartbeat 唤醒永不去重", () => {
  assert.equal(buildWakeIdempotencyKey({ targetSessionKey: "s1" }), null);
  assert.equal(buildWakeIdempotencyKey({}), null);
  assert.equal(buildWakeIdempotencyKey(), null);
  assert.equal(
    buildWakeIdempotencyKey({ targetSessionKey: "s1", deliveryTicketId: "   ", sourceContractId: "" }),
    null,
  );
});

test("wake 键:sessionKey 缺但身份在手仍成键(id 全局唯一足以定住投递)", () => {
  assert.equal(buildWakeIdempotencyKey({ deliveryTicketId: "SADT-2" }), "wake::SADT-2");
});

test("wake 键:身份 id 保留大小写(mint id 大小写敏感,只 trim 不折叠)", () => {
  assert.equal(
    buildWakeIdempotencyKey({ targetSessionKey: "s1", deliveryTicketId: " SADT-AbC " }),
    "wake:s1:SADT-AbC",
  );
});

test("deliver 键:deliver:{leg}:{ticketId},默认 return 腿;空白/非串 → null", () => {
  assert.equal(buildDeliverIdempotencyKey(" SADT-9 "), "deliver:return:SADT-9");
  // 腿别必须区分键——assign 派发腿与回投腿共用同一 SADT 票据同一漏斗,
  // 无腿别时派发记键会把回投永久去重(2026-08-12 跨腿碰撞)。
  assert.equal(buildDeliverIdempotencyKey("SADT-9", "dispatch"), "deliver:dispatch:SADT-9");
  assert.notEqual(buildDeliverIdempotencyKey("SADT-9", "dispatch"), buildDeliverIdempotencyKey("SADT-9", "return"));
  assert.equal(buildDeliverIdempotencyKey("SADT-9", "unknown-leg"), "deliver:return:SADT-9");
  assert.equal(buildDeliverIdempotencyKey(""), null);
  assert.equal(buildDeliverIdempotencyKey("   "), null);
  assert.equal(buildDeliverIdempotencyKey(null), null);
  assert.equal(buildDeliverIdempotencyKey(42), null);
});

// ---- 2. has/record 往返(路径注入临时目录) ----

test("has/record 往返:未记 → false;记后 → true;同键重记 no-op 不追加重复行", async (t) => {
  const dir = await makeTempLedgerDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "ledger.jsonl");
  const store = createDeliveryIdempotencyStore({ filePath });

  assert.equal(await store.hasDeliveryKey("wake:s1:SADT-1"), false);
  assert.equal(await store.recordDeliveryKey("wake:s1:SADT-1", { mode: "hooks" }), true);
  assert.equal(await store.hasDeliveryKey("wake:s1:SADT-1"), true);

  // 同键重记:no-op,盘上仍只有一行
  assert.equal(await store.recordDeliveryKey("wake:s1:SADT-1"), true);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.key, "wake:s1:SADT-1");
  assert.deepEqual(entry.meta, { mode: "hooks" });
  assert.equal(typeof entry.at, "number");
});

test("跨实例持久化:新实例同路径载入后 has → true(重启后重放安全闭环)", async (t) => {
  const dir = await makeTempLedgerDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "ledger.jsonl");

  const writer = createDeliveryIdempotencyStore({ filePath });
  await writer.recordDeliveryKey("deliver:return:SADT-7");

  const reader = createDeliveryIdempotencyStore({ filePath });
  assert.equal(await reader.hasDeliveryKey("deliver:return:SADT-7"), true);
  assert.equal(await reader.hasDeliveryKey("deliver:SADT-8"), false);
});

test("无效键(null/空白)→ has false / record false,不落盘", async (t) => {
  const dir = await makeTempLedgerDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "ledger.jsonl");
  const store = createDeliveryIdempotencyStore({ filePath });

  assert.equal(await store.hasDeliveryKey(null), false);
  assert.equal(await store.hasDeliveryKey("   "), false);
  assert.equal(await store.recordDeliveryKey(null), false);
  assert.equal(await store.recordDeliveryKey("   "), false);
  await assert.rejects(readFile(filePath, "utf8"), /ENOENT/);
});

test("追加写失败:warn 不抛,record 仍返回 true 且内存 Set 守住本进程去重", async (t) => {
  const dir = await makeTempLedgerDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 让账本的父目录落在一个普通文件上 → mkdir/appendFile 必败
  const blockerFile = join(dir, "blocker");
  await writeFile(blockerFile, "not-a-directory", "utf8");
  const store = createDeliveryIdempotencyStore({ filePath: join(blockerFile, "ledger.jsonl") });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  t.after(() => { console.warn = originalWarn; });

  assert.equal(await store.recordDeliveryKey("wake:s1:SADT-1"), true);
  assert.equal(await store.hasDeliveryKey("wake:s1:SADT-1"), true);
  assert.equal(warnings.some((line) => line.includes("[delivery-idempotency]")), true);
});

// ---- 3. 压实:纯判定 + 载入时治理 ----

test("压实判定纯函数:≤trigger → null;>trigger → 最近 keep 条且保序", () => {
  const atTrigger = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}` }));
  assert.equal(compactLedgerEntries(atTrigger, { trigger: 10, keep: 5 }), null);
  assert.equal(compactLedgerEntries([], { trigger: 10, keep: 5 }), null);
  assert.equal(compactLedgerEntries(null, { trigger: 10, keep: 5 }), null);

  const overTrigger = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}` }));
  const kept = compactLedgerEntries(overTrigger, { trigger: 10, keep: 5 });
  assert.deepEqual(kept.map((e) => e.key), ["k7", "k8", "k9", "k10", "k11"]);
});

test("压实默认阈值:4000 触发 / 保留 2000(备忘录141 §三 容量上限~2000 超2×压实)", () => {
  assert.equal(COMPACT_TRIGGER_LINES, 4000);
  assert.equal(COMPACT_KEEP_LINES, 2000);
  const entries = Array.from({ length: COMPACT_TRIGGER_LINES + 1 }, (_, i) => ({ key: `k${i}` }));
  const kept = compactLedgerEntries(entries);
  assert.equal(kept.length, COMPACT_KEEP_LINES);
  assert.equal(kept[0].key, `k${COMPACT_TRIGGER_LINES + 1 - COMPACT_KEEP_LINES}`);
  assert.equal(kept[kept.length - 1].key, `k${COMPACT_TRIGGER_LINES}`);
});

test("载入时容量治理:超限账本压实写回,旧键遗忘、新键仍在,坏行跳过", async (t) => {
  const dir = await makeTempLedgerDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "ledger.jsonl");

  // 12 有效行 + 1 截断坏行(崩溃截尾场景,防御式解析应跳过)
  const validLines = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({ key: `wake:s:TC-${i}`, at: i }));
  await writeFile(filePath, validLines.join("\n") + "\n" + '{"key":"wake:s:TC-trunc","a', "utf8");

  const store = createDeliveryIdempotencyStore({ filePath, compactTrigger: 10, compactKeep: 5 });
  // 保留最近 5 条 = TC-7..TC-11;更旧的遗忘(有界去重窗口,过窗重放 fail-open 照发)
  assert.equal(await store.hasDeliveryKey("wake:s:TC-11"), true);
  assert.equal(await store.hasDeliveryKey("wake:s:TC-7"), true);
  assert.equal(await store.hasDeliveryKey("wake:s:TC-6"), false);
  assert.equal(await store.hasDeliveryKey("wake:s:TC-trunc"), false);

  const rewritten = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(rewritten.map((line) => JSON.parse(line).key),
    ["wake:s:TC-7", "wake:s:TC-8", "wake:s:TC-9", "wake:s:TC-10", "wake:s:TC-11"]);
});

test("载入不超限:不压实不写回,文件原样(含坏行)保留", async (t) => {
  const dir = await makeTempLedgerDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "ledger.jsonl");
  const original = JSON.stringify({ key: "deliver:SADT-1", at: 1 }) + "\n" + "broken-line\n";
  await writeFile(filePath, original, "utf8");

  const store = createDeliveryIdempotencyStore({ filePath, compactTrigger: 10, compactKeep: 5 });
  assert.equal(await store.hasDeliveryKey("deliver:SADT-1"), true);
  assert.equal(await readFile(filePath, "utf8"), original);
});
