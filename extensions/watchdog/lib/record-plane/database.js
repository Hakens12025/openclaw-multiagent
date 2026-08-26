// lib/record-plane/database.js — 记录面 DB 全库唯一入口(149 §六:connect PRAGMA 与
// schema.sql 分离,OPENCLAW_RECORD_DB 环境种子与 OPENCLAW_THREADS_DIR 同形)。
//
// 纪律:
// - 默认落点 ~/.openclaw/control-plane/records.db;OPENCLAW_RECORD_DB 在【每次解析】时
//   惰性读(照抄 thread-tree-store 手法:静态图下环境种子是唯一有效注入面)。
// - connect 级 PRAGMA(busy_timeout/foreign_keys/journal_mode/synchronous)不写进
//   库文件(149 §3.2 M 实测:新开连接读不回 busy_timeout),必须每个新连接重跑;
//   schema.sql 只含 DDL,exec 幂等(IF NOT EXISTS)。
// - 连接按解析后的路径缓存,测试换根自动隔离。

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CONTROL_PLANE_PATHS, resolveOwnedStorePath } from "../control-plane/control-plane-paths.js";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

// connect 级 PRAGMA 集(149 M):每次 open 必跑,顺序无关。
const CONNECT_PRAGMAS = Object.freeze([
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = FULL",
]);

// 既有生产库补列(阶段2.2/2.3):schema.sql 只管新库,老库靠这里幂等 ALTER ——
// 列已存在时吞 duplicate column 错跳过,其余错误照抛(不是容错面)。
const ADDITIVE_COLUMN_MIGRATIONS = Object.freeze([
  "ALTER TABLE records ADD COLUMN anchorRunId TEXT",
  "ALTER TABLE records ADD COLUMN anchorSeq INTEGER",
  "ALTER TABLE records ADD COLUMN causeRefs TEXT",
]);

// 索引演进(文件账退役批):trace 身份键从 (sessionKey, hash) 换 (sessionKey, seq)。
// 哈希链随文件层退役,新行 hash 恒 NULL(唯一索引对 NULL 各视为不同,旧索引护不住
// 任何东西);seq 唯一索引让 DB 当场拒同一 session 的第二次 seq 发行——D-H 双写者
// fork 从"静默入土三周"变"撞约束报警"。建唯一索引撞出重复行 = 库里真有 fork 残留,
// 照抛(不是容错面)。
const INDEX_MIGRATIONS = Object.freeze([
  "DROP INDEX IF EXISTS uq_records_trace_identity",
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_records_trace_seq
     ON records(kind, sessionKey, seq) WHERE kind = 'trace_event'`,
  "CREATE INDEX IF NOT EXISTS idx_records_threadId ON records(threadId)",
]);

function applyAdditiveMigrations(db) {
  for (const sql of ADDITIVE_COLUMN_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
    }
  }
  for (const sql of INDEX_MIGRATIONS) db.exec(sql);
}

export function resolveRecordDbPath() {
  // 店根门卫单源(control-plane-paths §13)。
  return resolveOwnedStorePath("OPENCLAW_RECORD_DB", join(CONTROL_PLANE_PATHS.root, "records.db"), "records.db");
}

// dbPath → DatabaseSync。按路径分键:测试换根(换 OPENCLAW_RECORD_DB)自动开新库。
const connections = new Map();

const DEFAULT_DB_PATH = join(CONTROL_PLANE_PATHS.root, "records.db");

// 记账真值店自己的 fail-loud 门(149 §六立,2026-08-26 店根门卫 §13 后成双覆盖):
// 默认解析已被门卫沙箱化,能走到这里的只剩显式传生产路径——照拦(账店零例外)。
// 读面(record-reader)共用同一门:只读打开也是打开。
export function assertNotProductionInTests(dbPath) {
  if (process.env.NODE_TEST_CONTEXT && dbPath === DEFAULT_DB_PATH) {
    throw new Error(
      "record-plane: refusing to open production records.db under node --test — the store-root sentinel sandboxes default resolution; only an explicit production path reaches here, pass an explicit OPENCLAW_RECORD_DB/sandbox path instead",
    );
  }
}

export function openDatabase(dbPath = resolveRecordDbPath()) {
  const cached = connections.get(dbPath);
  if (cached) return cached;
  assertNotProductionInTests(dbPath);
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  for (const pragma of CONNECT_PRAGMAS) db.exec(pragma);
  db.exec(SCHEMA_SQL); // 幂等建表(IF NOT EXISTS)
  applyAdditiveMigrations(db); // 老库补列(幂等,列已存在吞错)
  connections.set(dbPath, db);
  return db;
}

// 测试用:关掉并忘掉全部缓存连接,不删库文件。
export function closeRecordDatabasesForTests() {
  for (const db of connections.values()) {
    try { db.close(); } catch { /* 已关 */ }
  }
  connections.clear();
}
