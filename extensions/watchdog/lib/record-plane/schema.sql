-- lib/record-plane/schema.sql — 记录面 SQLite 地基(阶段1,备忘录148 §二 / 149 §六 / 150 §九 D-H;
-- 文件账退役批起 records 库是唯一真值,本文件即记录面全部结构)。
--
-- 单宽表 records + kind 字段(149 裁决4 = 148 D-B 推荐案:跨账本查询免 JOIN)。
-- 身份键(文件账退役批定稿):
--   trace_event = (kind, sessionKey, seq) —— 哈希链随文件层退役,seq 唯一索引
--                  由 DB 当场拒同一 session 的第二次 seq 发行(D-H 双写者 fork
--                  从静默入土变撞约束报警;文件时代 seq 可 fork 的前提已不存在)
--   run_event   = (kind, runId, seq)   —— seq 由单写者 recorder 发行,无 fork
-- 全局序(阶段2 第一刀):gseq 直接复用本表 AUTOINCREMENT id,不造取号机 ——
-- 写入是同步直写无缓冲(149 裁决),插入顺序 = 到达顺序,id 即全局序
-- (EventStoreDB global position 同构)。gseq 列保留不填,读侧 gseq ≡ id 派生;
-- bootId 由 record-writer 进程级发行(crypto.randomUUID()),首写时登记 boots。
-- synthesized 标记测试合成事件(149 §二 发现的 120 条测试污染要能被区分)。
--
-- 阶段2 余量(148 §二 2.2/2.3):
--   anchorRunId/anchorSeq —— 跨账本锚点(happened-during 弱语义,非因果):
--     trace 事件写入时刻,其 session 关联合约所属 run 的事件账水位。
--     只填 trace_event;run_event 是本账自身,恒 NULL。
--   causeRefs —— 真因果边(JSON 数组 [{runId, seq}],142 §十/§十一钩①):
--     run 事件账 jsonl 已有此字段,影子写如实落库;纪律 = 只在代码确实知道
--     原因处记,宁缺勿错。只填 run_event;trace 本刀不补因果边,恒 NULL。
-- 既有生产库补列走 database.js 的幂等 ALTER(列已存在吞错跳过),本文件只管新库。
--
-- 本文件只含 DDL。connect 级 PRAGMA(busy_timeout/foreign_keys/journal_mode/synchronous)
-- 不写进库文件,新开连接读不回(149 §3.2 M)——收在 database.js 的 openDatabase()。

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('run_event', 'trace_event')),
  threadId TEXT,
  runId TEXT,
  sessionKey TEXT,
  contractId TEXT,
  seq INTEGER,            -- 账内序:run_event=run 内 seq;trace_event=session 内 seq
  bootId TEXT,            -- 写入进程 boot 号(阶段2 起填充);跨重启连续性查 boots 表
  gseq INTEGER,           -- 恒 NULL:全局序 ≡ id 派生(见文件头),列保留不填
  ts INTEGER NOT NULL,
  hash TEXT,              -- 退役列:哈希链随文件层退役,新行恒 NULL(列保留不拆表)
  prevHash TEXT,
  type TEXT,              -- run_event 的事件类型(run_triggered/contract_created/...)
  name TEXT,              -- trace_event 的工具名;哨兵行落 session_open/session_close
  payload TEXT NOT NULL,  -- 原事件 JSON 全文
  synthesized INTEGER NOT NULL DEFAULT 0,
  anchorRunId TEXT,       -- 阶段2.2 锚点(happened-during):仅 trace_event,见文件头
  anchorSeq INTEGER,
  causeRefs TEXT          -- 阶段2.3 真因果边 JSON [{runId,seq}]:仅 run_event,见文件头
);

-- trace 身份 = (sessionKey, seq)(文件账退役批)。同一 session 的第二次 seq 发行
-- 被唯一索引当场拒(INSERT throw → 写入侧报警入 record_rejected),D-H 形态的
-- 双写者由此显形。既有库的 hash 身份索引由 database.js 幂等 DROP。
CREATE UNIQUE INDEX IF NOT EXISTS uq_records_trace_seq
  ON records(kind, sessionKey, seq) WHERE kind = 'trace_event';

-- run_event 身份 = (runId, seq)。重复 = bug,写入侧不吞,让它 throw。
CREATE UNIQUE INDEX IF NOT EXISTS uq_records_run_identity
  ON records(kind, runId, seq) WHERE kind = 'run_event';

CREATE INDEX IF NOT EXISTS idx_records_runId ON records(runId);
CREATE INDEX IF NOT EXISTS idx_records_sessionKey ON records(sessionKey);
CREATE INDEX IF NOT EXISTS idx_records_contractId ON records(contractId);
CREATE INDEX IF NOT EXISTS idx_records_ts ON records(ts);
CREATE INDEX IF NOT EXISTS idx_records_threadId ON records(threadId);

-- 迁移/写入拒收行:入表不丢弃(149 §3.2 M:迁移实测被拒 2 行不得悄悄消失)。
CREATE TABLE IF NOT EXISTS record_rejected (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,           -- 来源文件或写入点
  reason TEXT NOT NULL,  -- 拒收原因
  line TEXT NOT NULL,    -- 原行/原事件 JSON 全文
  ts INTEGER NOT NULL
);

-- boot 元表(阶段2):进程首次写库登记一行,bootId = 进程级 randomUUID()。
-- records.bootId 指回这里;跨重启连续性 = 同库 gseq(≡ records.id)只增 + boots 行数增长。
CREATE TABLE IF NOT EXISTS boots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bootId TEXT UNIQUE,
  startedAt INTEGER NOT NULL
);
