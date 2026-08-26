// tests/contract-budget-sentinel.test.js — 合约预算护栏(2026-08-26 用户裁决)。
// live 测试窗口内新建合约超预算(默认 10)→ 判失控增殖,onBreach 恰好触发一次;
// 未超/读账失败(null)不误杀。countContractsCreatedSince 对临时库实测水位语义。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createContractBudgetSentinel,
  DEFAULT_CONTRACT_BUDGET,
} from "../lib/formal-runtime/test-run-suites.js";
import { countContractsCreatedSince, closeRecordReadersForTests } from "../lib/record-plane/record-reader.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("哨兵:计数超预算 → onBreach 恰触发一次并自停;边界(=预算)不触发", async () => {
  let breach = 0;
  let count = DEFAULT_CONTRACT_BUDGET; // == 预算,不该触发(判据是 >)
  const s = createContractBudgetSentinel({
    budget: DEFAULT_CONTRACT_BUDGET,
    readCount: () => count,
    onBreach: () => { breach += 1; },
    intervalMs: 10,
  });
  await sleep(40);
  assert.equal(breach, 0, "count==budget 不触发(判据严格大于)");
  count = DEFAULT_CONTRACT_BUDGET + 1; // 超预算
  await sleep(60);
  assert.equal(breach, 1, "超预算恰触发一次");
  assert.equal(s.fired, true);
  count = DEFAULT_CONTRACT_BUDGET + 99; // 已 fired,自停不再触发
  await sleep(40);
  assert.equal(breach, 1, "fired 后自停,不重复触发");
  s.stop();
});

test("哨兵:读账失败(null/throw)按兵不动,不误杀", async () => {
  let breach = 0;
  let mode = "null";
  const s = createContractBudgetSentinel({
    budget: 2,
    readCount: () => {
      if (mode === "null") return null;
      if (mode === "throw") throw new Error("db gone");
      return 99;
    },
    onBreach: () => { breach += 1; },
    intervalMs: 10,
  });
  await sleep(40);
  mode = "throw";
  await sleep(40);
  assert.equal(breach, 0, "null/throw 均不触发");
  mode = "count";
  await sleep(60);
  assert.equal(breach, 1, "账恢复后正常触发");
  s.stop();
});

test("countContractsCreatedSince:只数水位后的 contract_created,DISTINCT 去重", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-sentinel-db-"));
  const dbPath = join(dir, "records.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, type TEXT, contractId TEXT
  );`);
  const ins = db.prepare("INSERT INTO records (kind, type, contractId) VALUES (?, ?, ?)");
  ins.run("run_event", "contract_created", "TC-A"); // id=1 水位前
  ins.run("run_event", "contract_created", "TC-B"); // id=2 水位后 ↓
  ins.run("run_event", "dispatched", "TC-B");       // 非 created 不算
  ins.run("run_event", "contract_created", "TC-B"); // 同合约重复 created,DISTINCT 去重
  ins.run("trace_event", "contract_created", "TC-C"); // 非 run_event 不算
  ins.run("run_event", "contract_created", "TC-D");
  db.close();
  try {
    assert.equal(countContractsCreatedSince(1, dbPath), 2, "水位1后:TC-B+TC-D=2(去重/滤kind/滤type)");
    assert.equal(countContractsCreatedSince(0, dbPath), 3, "水位0:TC-A+TC-B+TC-D");
    assert.equal(countContractsCreatedSince(999, dbPath), 0, "水位之后无新建=0");
    assert.equal(countContractsCreatedSince(1, join(dir, "no-such.db")), null, "库缺席=null(不误杀)");
  } finally {
    closeRecordReadersForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
