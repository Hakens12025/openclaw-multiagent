#!/usr/bin/env node
// record-reconcile.js — 记录面完整性体检(文件账退役批转型:文件↔DB 对账腿随
// 文件账退役删除,records DB 是唯一真值,体检对象 = 库自身的不变量)。
//
// 体检项:
//   ① 全局序水位:min/max gseq(≡ records.id 派生)+ 总行数 + boots 元表行数;
//   ② record_rejected 行数:> 0 = 有写入被拒(双写者/形态异常的先行信号),exit 1;
//   ③ run_event  序连续:每 run 的 seq 必须 1..max 无洞(缺头/中洞点名到 runId);
//   ④ trace_event 序连续:每 session 的 seq 必须 0..max 无洞;
//   ⑤ payload 可解析:parse 失败的行点名(防御式,理论上不该有);
//   ⑥ 因果边形式校验(148 §二 2.4:引用存在 + 同 run 方向),0 违例 / 点名违例;
//   ⑦ 物有账无(2026-08-26,备忘录158 兜底):树内 thread 在账内零行 = 绕过记账的
//     写者(史上五次=测试夹具漏进生产树)。店根门卫(§13)是结构本体,本项是纪律兜底。
//
// 用法: node scripts/record-reconcile.js [--json]
// 退出码: 0 = 全部不变量成立;1 = 有违例(含 rejected > 0);2 = records DB 不可用

import { readdirSync } from "node:fs";

import { resolveRecordDbPath } from "../lib/record-plane/database.js";
import { resolveThreadsRoot } from "../lib/archive/thread-tree-store.js";
import { getGlobalRange, openReadOnlyDatabase } from "../lib/record-plane/record-reader.js";
import { validateCausality } from "../lib/record-plane/validate-causality.js";

function collectIntegrity(db) {
  const violations = [];

  // ② 拒收行
  const rejected = db.prepare("SELECT COUNT(*) AS c FROM record_rejected").get().c;

  // ③ run_event 序连续(身份 (runId,seq) 由唯一索引守,这里守"无洞":缺头或中洞
  // 都意味着有 seq 发行了却没落上 —— 单写者语义下只可能是 bug 或外力删行)。
  for (const row of db.prepare(`
    SELECT runId, COUNT(*) AS c, COUNT(DISTINCT seq) AS d, MIN(seq) AS minSeq, MAX(seq) AS maxSeq
    FROM records WHERE kind = 'run_event' GROUP BY runId
  `).all()) {
    if (!row.runId) {
      violations.push({ type: "run_event_no_runId", key: "(NULL runId)", detail: `${row.c} 行无 runId` });
      continue;
    }
    if (row.minSeq !== 1) {
      violations.push({ type: "run_event_missing_head", key: row.runId, detail: `min seq = ${row.minSeq}(应为 1)` });
    }
    if (row.maxSeq - row.minSeq + 1 !== row.c) {
      violations.push({
        type: "run_event_seq_gap", key: row.runId,
        detail: `seq [${row.minSeq}..${row.maxSeq}] 应有 ${row.maxSeq - row.minSeq + 1} 行,实有 ${row.c} 行`,
      });
    }
  }

  // ④ trace_event 序连续(每 session 从 0 起:open 哨兵)
  for (const row of db.prepare(`
    SELECT sessionKey, COUNT(*) AS c, MIN(seq) AS minSeq, MAX(seq) AS maxSeq
    FROM records WHERE kind = 'trace_event' GROUP BY sessionKey
  `).all()) {
    if (!row.sessionKey) {
      violations.push({ type: "trace_event_no_sessionKey", key: "(NULL sessionKey)", detail: `${row.c} 行无 sessionKey` });
      continue;
    }
    if (row.minSeq !== 0) {
      violations.push({ type: "trace_event_missing_open", key: row.sessionKey, detail: `min seq = ${row.minSeq}(应为 0 = open 哨兵)` });
    }
    if (row.maxSeq - row.minSeq + 1 !== row.c) {
      violations.push({
        type: "trace_event_seq_gap", key: row.sessionKey,
        detail: `seq [${row.minSeq}..${row.maxSeq}] 应有 ${row.maxSeq - row.minSeq + 1} 行,实有 ${row.c} 行`,
      });
    }
  }

  // ⑤ payload 可解析
  for (const row of db.prepare(
    "SELECT id, kind, runId, sessionKey, seq, payload FROM records",
  ).all()) {
    try {
      JSON.parse(row.payload);
    } catch {
      violations.push({
        type: "payload_unparseable", key: `id=${row.id}`,
        detail: `${row.kind} ${row.runId ?? row.sessionKey}#${row.seq}`,
      });
    }
  }

  return { rejected, violations };
}

// ⑦ 物有账无:树内 thread 目录 ∄ 账内 threadId → 孤儿(绕账写者的痕迹)。
function collectOrphanThreads(db) {
  let treeThreads = [];
  try {
    treeThreads = readdirSync(resolveThreadsRoot()).filter((n) => n.startsWith("t-"));
  } catch {
    return { checked: 0, orphans: [] }; // 树根缺席(全新环境)= 无物可查
  }
  const known = new Set(
    db.prepare("SELECT DISTINCT threadId FROM records WHERE threadId IS NOT NULL").all().map((r) => r.threadId),
  );
  return { checked: treeThreads.length, orphans: treeThreads.filter((t) => !known.has(t)) };
}

function main() {
  const jsonMode = process.argv.slice(2).includes("--json");
  const dbPath = resolveRecordDbPath();

  const db = openReadOnlyDatabase(dbPath);
  if (!db) {
    console.error(`records DB 不可用:${dbPath}(缺席或只读打开失败)`);
    process.exit(2);
  }

  const globalRange = getGlobalRange(dbPath);
  const causality = validateCausality(dbPath);
  const integrity = collectIntegrity(db);
  const orphanThreads = collectOrphanThreads(db);
  const causalityViolations = causality?.violations ?? null;

  const report = {
    paths: { dbPath },
    counts: {
      runEvents: db.prepare("SELECT COUNT(*) AS c FROM records WHERE kind='run_event'").get().c,
      traceEvents: db.prepare("SELECT COUNT(*) AS c FROM records WHERE kind='trace_event'").get().c,
      runs: db.prepare("SELECT COUNT(DISTINCT runId) AS c FROM records WHERE kind='run_event'").get().c,
      sessions: db.prepare("SELECT COUNT(DISTINCT sessionKey) AS c FROM records WHERE kind='trace_event'").get().c,
    },
    recordRejected: integrity.rejected,
    orphanThreads,
    globalRange,
    causality,
    integrityViolations: integrity.violations,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("记录面体检(records DB 唯一真值 · 文件账已退役)");
    console.log(`  records DB  ${dbPath}`);
    console.log(
      `  run_event    ${report.counts.runs} 个 run · ${report.counts.runEvents} 行`,
    );
    console.log(
      `  trace_event  ${report.counts.sessions} 个会话 · ${report.counts.traceEvents} 行`,
    );
    console.log(`  record_rejected  ${report.recordRejected} 行(写入被拒的先行信号)`);
    if (globalRange) {
      console.log(
        `  全局序水位  gseq [${globalRange.minGseq ?? "—"} .. ${globalRange.maxGseq ?? "—"}]`
        + ` · records ${globalRange.rowCount} 行 · boots ${globalRange.boots} 个`,
      );
    } else {
      console.log("  全局序水位  查询失败(DB 只读打开异常)");
    }
    if (integrity.violations.length === 0) {
      console.log("序连续    无违例 —— 每 run 1..max、每 session 0..max 无洞");
    } else {
      console.log(`序连续    ${integrity.violations.length} 处违例:`);
      for (const v of integrity.violations.slice(0, 20)) {
        console.log(`  [${v.type}] ${v.key}  ${v.detail}`);
      }
      if (integrity.violations.length > 20) console.log(`  … 其余 ${integrity.violations.length - 20} 处从略`);
    }
    if (causality === null) {
      console.log("因果校验  不可用(DB 缺席或老库无 causeRefs 列)");
    } else if (causality.violations.length === 0) {
      console.log(`因果校验  0 违例(扫 ${causality.rows} 行带边记录 · ${causality.edges} 条因果边)`);
    } else {
      console.log(`因果校验  ${causality.violations.length} 违例(扫 ${causality.rows} 行 · ${causality.edges} 条边):`);
      for (const v of causality.violations) {
        const ref = v.causeRef ? `{${v.causeRef.runId}, ${v.causeRef.seq}}` : "(形态非法)";
        console.log(`  [${v.type}] ${v.runId}#${v.seq} → causeRef ${ref}`);
      }
    }
    if (orphanThreads.orphans.length === 0) {
      console.log(`物有账无  0 孤儿(树内 ${orphanThreads.checked} thread 全部在账)`);
    } else {
      console.log(`物有账无  ${orphanThreads.orphans.length} 孤儿 thread(树内有、账内零行 = 绕账写者痕迹):`);
      for (const t of orphanThreads.orphans) console.log(`  ${t}`);
    }
  }

  process.exit(
    integrity.violations.length === 0
    && integrity.rejected === 0
    && (causalityViolations?.length ?? 0) === 0
    && orphanThreads.orphans.length === 0
      ? 0
      : 1,
  );
}

main();
