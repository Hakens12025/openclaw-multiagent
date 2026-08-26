// Tests: routing/delivery/delivery-ticket-store.js — 投递票据库(备忘录141 §八 Phase 3)。
//
// 锁六件事(任务A验收面):
//   1. 确定性 id dlv-{contractId}(文件名安全化)+ 同 id 重写=覆盖;
//   2. 写票:schema 归一(suppress/trackerProjection/createdAt/attempts)+ JSON 往返
//      校验——不可序列化字段剥离并 warn,『键为 null』与『键不存在』保真
//      (replyTo hasOwnProperty 语义依赖);
//   3. 列票:createdAt 升序、.failed.json 尸检票排除;
//   4. 完成即删票;
//   5. attempt 递增落盘,打满 MAX 改名 .failed.json 留尸检 + exhausted:true;
//   6. 坏票容错:列票跳过不拖垮整扫,attempt 遇坏票改名尸检防死循环。
//
// 目录经环境种子 OPENCLAW_DELIVERY_TICKET_DIR 注入临时目录,绝不写真 control-plane
// (2026-08-11 测试直写真实 control-plane 的事故教训;店内路径首次 IO 惰性解析,
// 每测各自 mkdtemp 隔离)。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DELIVERY_TICKET_ATTEMPTS,
  buildDeliveryTicketId,
  resolveDefaultTicketDir,
  writeDeliveryTicket,
  listPendingDeliveryTickets,
  completeDeliveryTicket,
  markDeliveryTicketAttempt,
} from "../lib/routing/delivery/delivery-ticket-store.js";

// 兜底种子:即使某个测试忘了自建目录,IO 也落在临时目录,碰不到真 control-plane
process.env.OPENCLAW_DELIVERY_TICKET_DIR = mkdtempSync(join(tmpdir(), "delivery-ticket-test-root-"));

async function useTempTicketDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "delivery-ticket-test-"));
  process.env.OPENCLAW_DELIVERY_TICKET_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function captureWarnings(t) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  t.after(() => { console.warn = originalWarn; });
  return warnings;
}

function baseTicket(overrides = {}) {
  return {
    contractId: "TC-100",
    agentId: "worker-a",
    sessionKey: "agent:worker-a:contract:tc-100",
    terminalStatus: "completed",
    terminalOutcome: { conclusion: "done" },
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

// ---- 1. 确定性 id(零 IO) ----

test("票据 id:dlv-{contractId},文件名安全化;非串/空白 → null", () => {
  assert.equal(buildDeliveryTicketId("TC-9"), "dlv-TC-9");
  assert.equal(buildDeliveryTicketId(" TC-9 "), "dlv-TC-9");
  // 越界字符(空格/斜杠/非 ASCII)折 "-" —— 目录固定 + charset 白名单免路径穿越
  assert.equal(buildDeliveryTicketId("TC 9/α"), "dlv-TC-9--");
  assert.equal(buildDeliveryTicketId("../evil"), "dlv-..-evil");
  assert.equal(buildDeliveryTicketId(""), null);
  assert.equal(buildDeliveryTicketId("   "), null);
  assert.equal(buildDeliveryTicketId(null), null);
  assert.equal(buildDeliveryTicketId(42), null);
});

test("目录解析:环境种子优先,种子即当前临时目录", () => {
  assert.equal(resolveDefaultTicketDir(), process.env.OPENCLAW_DELIVERY_TICKET_DIR);
});

// ---- 2. 写票 ----

test("写票:落盘 dlv-{contractId}.json,schema 归一(createdAt/attempts/suppress 默认)", async (t) => {
  const dir = await useTempTicketDir(t);

  const persisted = await writeDeliveryTicket(baseTicket());
  assert.equal(persisted.id, "dlv-TC-100");
  assert.equal(persisted.contractId, "TC-100");
  assert.equal(persisted.attempts, 0);
  assert.equal(typeof persisted.createdAt, "number");
  assert.deepEqual(persisted.suppress, { deferred: false, deferredBy: null });

  const onDisk = JSON.parse(await readFile(join(dir, "dlv-TC-100.json"), "utf8"));
  assert.deepEqual(onDisk, persisted);
  assert.deepEqual(onDisk.trackerProjection.ioObservation, { produced: ["outbox/result.md"] });
});

test("写票:suppress 缺席/畸形 → 归一 {deferred:false,deferredBy:null};合法值原样", async (t) => {
  await useTempTicketDir(t);

  const withoutSuppress = baseTicket();
  delete withoutSuppress.suppress;
  const bare = await writeDeliveryTicket(withoutSuppress);
  assert.deepEqual(bare.suppress, { deferred: false, deferredBy: null });

  const deferred = await writeDeliveryTicket(baseTicket({
    contractId: "TC-101",
    suppress: { deferred: true, deferredBy: "system_action_runtime_delivery" },
  }));
  assert.deepEqual(deferred.suppress, { deferred: true, deferredBy: "system_action_runtime_delivery" });
});

test("同 id 重写 = 覆盖:同合约重复 commit 不重票,盘上只剩最后一票", async (t) => {
  const dir = await useTempTicketDir(t);

  await writeDeliveryTicket(baseTicket({ terminalStatus: "completed" }));
  await writeDeliveryTicket(baseTicket({ terminalStatus: "failed" }));

  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  assert.deepEqual(names, ["dlv-TC-100.json"]);
  const onDisk = JSON.parse(await readFile(join(dir, "dlv-TC-100.json"), "utf8"));
  assert.equal(onDisk.terminalStatus, "failed");
});

test("写票:不可序列化字段剥离并 warn;『键为 null』与『键不存在』保真", async (t) => {
  const dir = await useTempTicketDir(t);
  const warnings = captureWarnings(t);

  const circular = { name: "loop" };
  circular.self = circular;
  const persisted = await writeDeliveryTicket(baseTicket({
    contractId: "TC-102",
    onDone: () => {},           // function → 剥离
    ghost: undefined,           // undefined → 剥离
    badNumber: Number.NaN,      // 非有限数 → 剥离(往返会变 null,不保真)
    trackerProjection: {
      agentId: "worker-a",
      startMs: 1,
      toolCallTotal: 0,
      status: "completed",
      circular,                 // 环 → 剥离
      mixedList: ["ok", () => {}], // 数组内不可序列化 → null 占位保下标
    },
    // replyTo 键存在但为 null ≠ 键不存在(delivery-terminal hasOwnProperty 语义)
    contractProjection: { replyTo: null },
  }));

  const onDisk = JSON.parse(await readFile(join(dir, "dlv-TC-102.json"), "utf8"));
  assert.deepEqual(onDisk, persisted);
  assert.equal("onDone" in onDisk, false);
  assert.equal("ghost" in onDisk, false);
  assert.equal("badNumber" in onDisk, false);
  assert.equal("circular" in onDisk.trackerProjection, true); // 环点本身剥的是 self 字段
  assert.equal("self" in onDisk.trackerProjection.circular, false);
  assert.deepEqual(onDisk.trackerProjection.mixedList, ["ok", null]);
  assert.equal(Object.hasOwn(onDisk.contractProjection, "replyTo"), true);
  assert.equal(onDisk.contractProjection.replyTo, null);

  const strippedWarning = warnings.find((line) => line.includes("[delivery-ticket]") && line.includes("剥离"));
  assert.ok(strippedWarning, "剥离必须 warn");
  assert.ok(strippedWarning.includes("onDone"));
  assert.ok(strippedWarning.includes("ghost"));
  assert.ok(strippedWarning.includes("badNumber"));
  assert.ok(strippedWarning.includes("circular"));
});

test("写票:缺 contractId / 非对象 → 抛(调用方 bug,拒落无身份票)", async (t) => {
  await useTempTicketDir(t);
  await assert.rejects(() => writeDeliveryTicket({ agentId: "worker-a" }), /contractId/);
  await assert.rejects(() => writeDeliveryTicket(null), /对象/);
  await assert.rejects(() => writeDeliveryTicket([baseTicket()]), /对象/);
});

// ---- 3. 列票 ----

test("列票:无目录 → 空账;有票按 createdAt 升序(旧票先泵)", async (t) => {
  const missingDir = await mkdtemp(join(tmpdir(), "delivery-ticket-test-"));
  await rm(missingDir, { recursive: true, force: true });
  process.env.OPENCLAW_DELIVERY_TICKET_DIR = missingDir;
  assert.deepEqual(await listPendingDeliveryTickets(), []);

  await useTempTicketDir(t);
  await writeDeliveryTicket(baseTicket({ contractId: "TC-3", createdAt: 3000 }));
  await writeDeliveryTicket(baseTicket({ contractId: "TC-1", createdAt: 1000 }));
  await writeDeliveryTicket(baseTicket({ contractId: "TC-2", createdAt: 2000 }));

  const pending = await listPendingDeliveryTickets();
  assert.deepEqual(pending.map((ticket) => ticket.contractId), ["TC-1", "TC-2", "TC-3"]);
});

test("列票:坏票(非 JSON / 缺 id/contractId)warn 跳过,好票照列不拖垮整扫", async (t) => {
  const dir = await useTempTicketDir(t);
  const warnings = captureWarnings(t);

  await writeDeliveryTicket(baseTicket());
  await writeFile(join(dir, "dlv-junk.json"), '{"id":"dlv-junk","contractId', "utf8"); // 截断坏票
  await writeFile(join(dir, "dlv-noid.json"), JSON.stringify({ terminalStatus: "completed" }), "utf8");
  await writeFile(join(dir, "not-a-ticket.txt"), "ignore me", "utf8"); // 非 .json 不扫

  const pending = await listPendingDeliveryTickets();
  assert.deepEqual(pending.map((ticket) => ticket.id), ["dlv-TC-100"]);
  assert.equal(warnings.filter((line) => line.includes("[delivery-ticket] 坏票跳过")).length, 2);
});

// ---- 4. 完成删票 ----

test("完成:删票返回 true;重复完成/无效 id → false", async (t) => {
  const dir = await useTempTicketDir(t);
  const persisted = await writeDeliveryTicket(baseTicket());

  assert.equal(await completeDeliveryTicket(persisted.id), true);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".json")), []);
  assert.equal(await completeDeliveryTicket(persisted.id), false);
  assert.equal(await completeDeliveryTicket("../evil"), false);
  assert.equal(await completeDeliveryTicket(null), false);
});

// ---- 5. attempt 记账与打满尸检 ----

test("attempt:递增落盘 + lastError/lastAttemptAt;打满 MAX 改名 .failed.json + exhausted:true", async (t) => {
  const dir = await useTempTicketDir(t);
  const warnings = captureWarnings(t);
  assert.equal(MAX_DELIVERY_TICKET_ATTEMPTS, 3);
  const persisted = await writeDeliveryTicket(baseTicket());

  assert.deepEqual(await markDeliveryTicketAttempt(persisted.id, new Error("wake timeout")),
    { exhausted: false, attempts: 1 });
  const afterFirst = JSON.parse(await readFile(join(dir, "dlv-TC-100.json"), "utf8"));
  assert.equal(afterFirst.attempts, 1);
  assert.equal(afterFirst.lastError, "wake timeout");
  assert.equal(typeof afterFirst.lastAttemptAt, "number");

  assert.deepEqual(await markDeliveryTicketAttempt(persisted.id, "target busy"),
    { exhausted: false, attempts: 2 });

  const third = await markDeliveryTicketAttempt(persisted.id, new Error("still down"));
  assert.deepEqual(third, { exhausted: true, attempts: 3 });

  const names = await readdir(dir);
  assert.equal(names.includes("dlv-TC-100.json"), false);
  assert.equal(names.includes("dlv-TC-100.failed.json"), true);
  const corpse = JSON.parse(await readFile(join(dir, "dlv-TC-100.failed.json"), "utf8"));
  assert.equal(corpse.attempts, 3);
  assert.equal(corpse.lastError, "still down");
  assert.ok(warnings.some((line) => line.includes("重试打满")));

  // 尸检票不进待泵账
  assert.deepEqual(await listPendingDeliveryTickets(), []);
});

test("attempt:票据缺席 → missing:true 不炸;坏票 → 改名尸检 + exhausted 防死循环", async (t) => {
  const dir = await useTempTicketDir(t);
  const warnings = captureWarnings(t);

  assert.deepEqual(await markDeliveryTicketAttempt("dlv-TC-absent", "x"),
    { exhausted: false, attempts: 0, missing: true });
  assert.deepEqual(await markDeliveryTicketAttempt(null, "x"),
    { exhausted: false, attempts: 0, missing: true });

  await writeFile(join(dir, "dlv-broken.json"), "{not json", "utf8");
  assert.deepEqual(await markDeliveryTicketAttempt("dlv-broken", "x"),
    { exhausted: true, attempts: 0, corrupt: true });
  const names = await readdir(dir);
  assert.equal(names.includes("dlv-broken.json"), false);
  assert.equal(names.includes("dlv-broken.failed.json"), true);
  assert.ok(warnings.some((line) => line.includes("坏票改名留尸检")));
});
