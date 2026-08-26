// Tests: lib/archive/thread-tree-store.js — 树店地址权威(备忘录142 §三/§十四,批②树店落地)。
//
// 锁四件事:
//   ① 环境种子惰性解析:OPENCLAW_THREADS_DIR/OPENCLAW_CONTRACT_INDEX_FILE 每次 IO 时读,
//      测试换根即隔离(防污染铁律:绝不写真 control-plane)。
//   ② 身份即地址:runDirFor = threads/{threadId}/runs/{runId},id 原串不改写;
//      非法/缺位 id 抛错(不是容错面)。
//   ③ ensureRunScaffold 建 contracts/participants/assembly 三目录,workspace 只留名
//      不创建(§十一钩②),幂等。
//   ④ id→home 索引:建约单写一行/幂等重登/同步 resolveContractHome/坏行防御式跳过/
//      rebuildContractIndex 全树扫描重建。
//
// Run: node --test tests/thread-tree-store.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 防污染:一切 IO 前种进临时目录(解析是惰性 per-IO,模块体赋值即生效)
const SANDBOX = mkdtempSync(join(tmpdir(), "thread-tree-store-test-"));
process.env.OPENCLAW_THREADS_DIR = join(SANDBOX, "threads");
process.env.OPENCLAW_CONTRACT_INDEX_FILE = join(SANDBOX, "contract-index.jsonl");

import {
  RUN_WORKSPACE_DIRNAME,
  ensureRunScaffold,
  rebuildContractIndex,
  recordContractHome,
  requireRunLineage,
  resolveContractHome,
  resolveContractIndexFile,
  resolveThreadsRoot,
  runDirFor,
  threadDirFor,
} from "../lib/archive/thread-tree-store.js";

const THREADS_ROOT = join(SANDBOX, "threads");

test("环境种子惰性解析:每次 IO 读 env,换根即生效", () => {
  assert.equal(resolveThreadsRoot(), THREADS_ROOT);
  assert.equal(resolveContractIndexFile(), join(SANDBOX, "contract-index.jsonl"));

  const altRoot = join(SANDBOX, "alt-threads");
  process.env.OPENCLAW_THREADS_DIR = altRoot;
  try {
    assert.equal(resolveThreadsRoot(), altRoot);
    assert.equal(runDirFor({ threadId: "t-aa", runId: "r-1-bb" }), join(altRoot, "t-aa", "runs", "r-1-bb"));
  } finally {
    process.env.OPENCLAW_THREADS_DIR = THREADS_ROOT;
  }
});

test("身份即地址:id 原串直接成路径,不做二次改写", () => {
  const lineage = { threadId: "t-abc12345", runId: "r-1755000000000-a1b2c3" };
  assert.equal(
    runDirFor(lineage),
    join(THREADS_ROOT, "t-abc12345", "runs", "r-1755000000000-a1b2c3"),
  );
  assert.equal(threadDirFor(lineage), join(THREADS_ROOT, "t-abc12345"));
  assert.deepEqual(requireRunLineage(lineage), lineage);
});

test("非法谱系抛错:缺位/穿越字符都是调用方 bug,不改写救场", () => {
  assert.throws(() => runDirFor(null), /invalid lineage\.threadId/);
  assert.throws(() => runDirFor({ threadId: "t-aa" }), /invalid lineage\.runId/);
  assert.throws(() => runDirFor({ runId: "r-1-bb" }), /invalid lineage\.threadId/);
  assert.throws(() => runDirFor({ threadId: "../evil", runId: "r-1-bb" }), /invalid lineage\.threadId/);
  assert.throws(() => runDirFor({ threadId: "t-aa", runId: "a/b" }), /invalid lineage\.runId/);
  assert.throws(() => runDirFor({ threadId: "..", runId: "r-1-bb" }), /invalid lineage\.threadId/);
});

test("ensureRunScaffold:三目录落地,workspace 只留名不创建(§十一钩②),幂等", async () => {
  const lineage = { threadId: "t-scaffold", runId: "r-1-scaffold" };
  const scaffold = await ensureRunScaffold(lineage);
  assert.equal(scaffold.runDir, runDirFor(lineage));
  assert.equal(scaffold.contractsDir, join(scaffold.runDir, "contracts"));
  assert.equal(scaffold.participantsDir, join(scaffold.runDir, "participants"));
  assert.equal(scaffold.assemblyDir, join(scaffold.runDir, "assembly"));

  const members = (await readdir(scaffold.runDir)).sort();
  assert.deepEqual(members, ["assembly", "contracts", "participants"]);
  assert.equal(RUN_WORKSPACE_DIRNAME, "workspace"); // 名字预留:常量在,目录不建
  assert.ok(!members.includes(RUN_WORKSPACE_DIRNAME));

  // 幂等:重复调用不抛、成员不变
  await ensureRunScaffold(lineage);
  assert.deepEqual((await readdir(scaffold.runDir)).sort(), ["assembly", "contracts", "participants"]);
});

test("索引:建约单写一行,同步 resolveContractHome,幂等重登不重复落行", async () => {
  const lineage = { threadId: "t-idx", runId: "r-1-idx" };
  const recorded = await recordContractHome("TC-idx-001", lineage);
  assert.deepEqual(recorded, { id: "TC-idx-001", threadId: "t-idx", runId: "r-1-idx" });

  const raw = await readFile(resolveContractIndexFile(), "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { id: "TC-idx-001", threadId: "t-idx", runId: "r-1-idx" });

  assert.deepEqual(resolveContractHome("TC-idx-001"), { id: "TC-idx-001", threadId: "t-idx", runId: "r-1-idx" });
  // case-drift 锁(批③A 回归):会话键派生的小写 id 也必须命中,且 home.id 保原串进文件名
  assert.deepEqual(resolveContractHome("tc-idx-001"), { id: "TC-idx-001", threadId: "t-idx", runId: "r-1-idx" });
  assert.equal(resolveContractHome("TC-nope"), null);
  assert.equal(resolveContractHome(null), null);

  // 同 id 同 home 重登:幂等跳写
  await recordContractHome("TC-idx-001", lineage);
  const rawAfter = await readFile(resolveContractIndexFile(), "utf8");
  assert.equal(rawAfter.split("\n").filter((line) => line.trim()).length, 1);

  // 非法 contractId 抛(索引不是清洗层)
  await assert.rejects(async () => recordContractHome("../evil", lineage), /invalid contractId/);
});

test("索引坏行防御式跳过:撕裂尾行不拖垮查询,合法行照常命中", async () => {
  const tornIndexFile = join(SANDBOX, "contract-index-torn.jsonl");
  await writeFile(
    tornIndexFile,
    `${JSON.stringify({ id: "TC-good-1", threadId: "t-torn", runId: "r-1-torn" })}\n`
    + "not-json-garbage\n"
    + `${JSON.stringify({ id: "TC-good-2", threadId: "t-torn", runId: "r-2-torn" })}\n`
    + '{"id":"TC-torn","threadId":"t-torn","runId":"r-3', // 撕裂尾行,无换行
    "utf8",
  );
  process.env.OPENCLAW_CONTRACT_INDEX_FILE = tornIndexFile;
  try {
    assert.deepEqual(resolveContractHome("TC-good-1"), { id: "TC-good-1", threadId: "t-torn", runId: "r-1-torn" });
    assert.deepEqual(resolveContractHome("TC-good-2"), { id: "TC-good-2", threadId: "t-torn", runId: "r-2-torn" });
    assert.equal(resolveContractHome("TC-torn"), null);
  } finally {
    process.env.OPENCLAW_CONTRACT_INDEX_FILE = join(SANDBOX, "contract-index.jsonl");
  }
});

test("rebuildContractIndex:全树扫描重建,重建后索引与树一致", async () => {
  // 树内两约(不经 recordContractHome,模拟索引丢失后的重建面)
  const lineageA = { threadId: "t-rebuild", runId: "r-1-aa" };
  const lineageB = { threadId: "t-rebuild", runId: "r-2-bb" };
  const scaffoldA = await ensureRunScaffold(lineageA);
  const scaffoldB = await ensureRunScaffold(lineageB);
  await writeFile(join(scaffoldA.contractsDir, "TC-tree-A.json"), "{}\n", "utf8");
  await writeFile(join(scaffoldB.contractsDir, "TC-tree-B.json"), "{}\n", "utf8");
  // 干扰项:非 .json 文件不入索引
  await writeFile(join(scaffoldA.contractsDir, "notes.txt"), "x\n", "utf8");

  const rebuiltIndexFile = join(SANDBOX, "contract-index-rebuilt.jsonl");
  process.env.OPENCLAW_CONTRACT_INDEX_FILE = rebuiltIndexFile;
  try {
    const result = await rebuildContractIndex();
    // 树里还有前面测试建的 TC-idx-001?没有——那次只写了索引没写树文件。
    // 本树内合约文件:TC-tree-A / TC-tree-B(t-scaffold run 无合约文件)。
    assert.equal(result.entries, 2);
    assert.deepEqual(resolveContractHome("TC-tree-A"), { id: "TC-tree-A", threadId: "t-rebuild", runId: "r-1-aa" });
    assert.deepEqual(resolveContractHome("TC-tree-B"), { id: "TC-tree-B", threadId: "t-rebuild", runId: "r-2-bb" });
    assert.equal(resolveContractHome("TC-idx-001"), null);

    const raw = await readFile(rebuiltIndexFile, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((entry) => entry.id).sort(),
      ["TC-tree-A", "TC-tree-B"],
    );
  } finally {
    process.env.OPENCLAW_CONTRACT_INDEX_FILE = join(SANDBOX, "contract-index.jsonl");
  }
});
