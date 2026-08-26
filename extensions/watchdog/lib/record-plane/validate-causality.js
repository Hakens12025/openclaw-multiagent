// lib/record-plane/validate-causality.js — 因果边形式校验(148 §一1.1 五层中的
// 可自动验层 / §二 2.4)。
//
// 能自动验的只有形式约束;因果的完整性(④)与真实性(⑤)永远验不了 ——
// 正确性靠写入点纪律保证(148 §1.1:只在代码确实知道原因处记,宁缺勿错)。
// 本模块两条校验:
//   ① 引用存在性:run_event.causeRefs 里每个 {runId, seq} 必须在 records 有对应
//      run_event 行(悬空引用 = bug 或影子缺口);
//   ② 同 run 方向性:同 run 的 causeRef.seq 必须 < 本行 seq(142 §十不变量
//      "seq ⊇ 因果";写入侧 recorder 落账时已断言,本校验兜绕过 recorder 的
//      写入/迁移路径)。
// 跨 run 方向性不验:142 §十.3 裁跨 run 不建全局 seq,异 run 的 seq 不可比。
// 无环(③)同 run 内由 ② 天然保证;跨 run 成环检测不在本刀(148 2.4 的跨账本
// 无环留待锚点消费面成型后再做)。
//
// 只读:走 record-reader 的只读连接,绝不写库。DB 不可用/查询失败(如老库尚无
// causeRefs 列)→ 返回 null,由调用方决定口径(对账器按"不可用"报告,不算违例)。

import { normalizeString } from "../core/normalize.js";
import { openReadOnlyDatabase } from "./record-reader.js";

const SELECT_CAUSED_ROWS_SQL = `
  SELECT id, runId, seq, causeRefs FROM records
  WHERE kind = 'run_event' AND causeRefs IS NOT NULL
  ORDER BY id ASC
`;
const SELECT_REF_EXISTS_SQL = `
  SELECT 1 AS ok FROM records
  WHERE kind = 'run_event' AND runId = ? AND seq = ?
  LIMIT 1
`;

// 返回 { rows, edges, violations:[{type, runId, seq, causeRef}] } | null(DB 不可用)。
// violation.type ∈ missing_ref(引用不存在) / seq_order(同 run 方向反了) /
// bad_ref(引用形态非法:缺 runId/seq 非整数 —— 写入侧 normalizeCauseRefs 本应拒收)。
export function validateCausality(dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  try {
    const rows = db.prepare(SELECT_CAUSED_ROWS_SQL).all();
    const refExists = db.prepare(SELECT_REF_EXISTS_SQL);
    const violations = [];
    let edges = 0;
    for (const row of rows) {
      let refs = null;
      try {
        refs = JSON.parse(row.causeRefs);
      } catch {
        refs = null;
      }
      if (!Array.isArray(refs)) {
        violations.push({
          type: "bad_ref",
          runId: row.runId ?? null,
          seq: Number.isInteger(row.seq) ? row.seq : null,
          causeRef: null,
        });
        continue;
      }
      for (const ref of refs) {
        edges += 1;
        const refRunId = normalizeString(ref?.runId);
        const refSeq = ref?.seq;
        if (!refRunId || !Number.isInteger(refSeq) || refSeq < 1) {
          violations.push({
            type: "bad_ref",
            runId: row.runId ?? null,
            seq: Number.isInteger(row.seq) ? row.seq : null,
            causeRef: { runId: refRunId || null, seq: Number.isInteger(refSeq) ? refSeq : null },
          });
          continue;
        }
        const causeRef = { runId: refRunId, seq: refSeq };
        // ② 同 run 方向性:因不能晚于果(取等也是违例 —— 自引用不是因)。
        if (refRunId === row.runId && refSeq >= row.seq) {
          violations.push({ type: "seq_order", runId: row.runId, seq: row.seq, causeRef });
        }
        // ① 引用存在性。
        if (!refExists.get(refRunId, refSeq)) {
          violations.push({ type: "missing_ref", runId: row.runId ?? null, seq: row.seq ?? null, causeRef });
        }
      }
    }
    return { rows: rows.length, edges, violations };
  } catch {
    return null; // 老库无 causeRefs 列 / 查询失败:按不可用报,不算违例
  }
}
