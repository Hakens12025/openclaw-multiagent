# 记录面（Record Plane）

## 是什么

系统的全部记账收口在一个 SQLite 库:`~/.openclaw/control-plane/records.db`(代码 `extensions/watchdog/lib/record-plane/`)。单宽表 `records`,按 `kind` 分两本账:

- **run_event(事实账)** — threads 维度的执行事实,身份 `(runId, seq)`,唯一写者 run-event-recorder(group commit 单事务)
- **trace_event(证据账)** — session 维度的工具调用证据,身份 `(sessionKey, seq)`,哨兵(session_open/close)+ seq 连续判完整性

全局序 `gseq ≡ id`(AUTOINCREMENT 派生,跨重启连续);`bootId` 区分开机;`ts` 永不作排序键(142 铁律)。拒收行入 `record_rejected`(不丢行)。

## 为什么存在

备忘录148 的出发点:**让 operator 读懂系统**。此前记录散落在几千个 jsonl 文件里(events.jsonl/trace/*.jsonl),人没法查"这个任务当时怎么走的"。SQLite 化 = 可 SQL 查询、可体检、可建因果边。

## 演化(三步走完)

1. **v227-v231 地基与双写**:SQLite 影子 + 文件真值并行写,对账器证相等(迁移安全期)
2. **读面切换**:inspect/拼接/投影/健康巡检逐面改读 DB
3. **v232 文件账退役(2026-08-24)**:写面转正 DB 唯一真值,events.jsonl / trace jsonl / 哈希链 / 链尖断言整体退役。用户裁决"查明消费方后全部搬 SQL 侧,文件侧退役"

## 关键设计

- **失败纪律分层**:run 事件是执行面的地基,写失败外抛+整批重试;trace 事件是证据,拒收入 record_rejected+报警,绝不阻断执行——证据面严格弱于执行面
- **双写者防线**:D-H 事故(seq 双发静默入土三周)的教训落成 `(sessionKey, seq)` 唯一索引——第二个写者当场撞约束报警,替代了退役的哈希链
- **账/物分离**:`threads/{t}/runs/{r}/` 树里的 contracts 正本、participants 产物、投影缓存、两个索引是"物"(工作缓存),不是账,留在文件侧;GC 删树目录不删 DB 账(全history 保留)
- **体检**:`scripts/record-reconcile.js` = 全局序水位 + 拒收计数 + per-run/per-session 序连续 + 因果校验,违例 exit 1

## 相关

- [operator](operator.md) — 记录面的第一读者
- `SYSTEM_MAP.md §6` — 现行真值清单
- 备忘录 147/148/149/150/151/152 — 计划、裁决、施工、交接全程
