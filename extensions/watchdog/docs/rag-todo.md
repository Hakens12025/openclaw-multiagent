# RAG TODO(v193 起的单一真值清单)

> 维护规则:本文件是 RAG 线待办的唯一清单。每项完成后移入文末"已结案"并附裁决证据;
> 被否决的方向留在"已否决"永不删除 —— 它们是挡未来重复提案的判例。
> 所有数字均为实测(评测台/重放台产出),引用时不需要复测。

## 定位判决(2026-08-12 设计复查定稿)

RAG 分三层,三层的正解不同:

| 层 | 语料性质 | 判决 |
|---|---|---|
| **wiki** | 小(61 页/4.2KB 均)、事实型、编译 WHY | 检索已到顶(gold 100% 进 top-20),停止调参;投入转向**返回粒度与全量化** |
| **memos** | 大(150 篇/最大 55KB)、讨论型、RAW | 检索优化主战场:33.3pp headroom(18.5 排序 + 14.8 候选) |
| **运行时记录**(新) | 结构化、高重复模板 | **不用向量**。结构化台账 + 字段查询;词法只管自由文本字段 |

---

## T1|wiki 全量工具化(用户 2026-08-12 拍板)

所有 agent 角色可用 wiki 工具,内容**全量**给。实施取"按页全文"而非"整库每调":

- [ ] `search_knowledge` 对 wiki 命中改返回**整页全文**(现为 500 字摘录)。子块定位、父块返回
      = 父子分段的小语料退化形态;零重嵌零新索引。memos 维持摘录(单篇最大 55KB,整篇不可行)。
- [ ] 评估补一个整页直取入口(list + fetch by path),供 agent 已知页名时跳过检索。
- [x] **A5 已裁决(2026-08-12,72 调用实测)**:fullwiki 引用@1 75.0→83.3(+8.3pp)、kwCov +10.4、
      零"说不足",但 **n=24 的 MDE=0.33 是效应的 4 倍(测不出)且成本 88×**(46,099 vs 522 tok/次)
      → **不切,wiki 检索线保留,grounding 维持 top-4**。副产物(有价值的负结果):
      retrieval12 全面差于 retrieval4(引用命中 66.7 vs 79.2)—— grounding 加宽有害,与扩池实测同构。
- 依据:wiki 页均 4.2KB/最大 10KB(2026-08-12 实测);chunk 过碎病因是缺语境(独立复现:命题化
  切分差 15-27%),整页返回直接治;检索本身零 headroom,不值得再动。

## T2|运行时记录库(用户 2026-08-12 拍板;设计定稿见本次会话)

以合约-runID 为键的 append-only JSONL 台账,`agent_end` 终态时刻**一次 join 落盘**
(真值已在 tracker/artifact-store/session-trace/evaluation-verdicts,台账是汇编不是采集)。

- [ ] **前置(阻塞):与三系统"判决:记"边界协调** —— 并发线刚切除 examiner 面、立 submit_output
      (cb5679f)。agent 声明字段必须消费 submit_output payload,不另开协议。先对齐再动工。
- [ ] 记录 schema(带版本号),**每字段标 provenance**:
      `system`(时间轴/时长分相/唤醒重试中断/超时硬停/provider+fallback/token/工具调用计数/
      协作动作/交付物清单+expectations diff/E-code/degraded/trace 完整性/合约链/automation 轮次)
      `agent`(忠实度/质量/假设/阻碍/偏离 —— 经 submit_output)
      `derived`(时长分位/expectation 匹配率/异常标志)。(原 `reviewer` provenance 依赖的
      request_review/评审链已整体退役 v225,该类字段取消,现役记账事实见 record-plane records.db。)
- [ ] 派生健康指标:**agent 自报质量 vs 系统实测的偏差,按 agent 累积**(抓惯性高报)。
- [ ] 查询面 `inspect.run_ledger`:过滤/排序/聚合(分组、分位数)/**抽样一等公民**(seeded+分层)。
      几千条 JS 全扫毫秒级,零依赖。
- [ ] 自由文本字段(自评/反馈/错误信息)注册为普通用户 KB,scope:agent 绑 operator,
      **只开词法腿**,metadataRules 提 runId/agentId/time,temporal+asOf 点时查询。零新检索机器。
- [ ] 聚合快照(per-agent/per-week)供 operator 面板;派生可重算,非真值。
- 判据(为什么不用向量):运行时记录是同表单高重复模板,嵌入空间塌缩(wiki 仅"兄弟 section 相似"
  dupSlotRate 已 48.8%,此处更甚);operator 查询九成是过滤/聚合/抽样,recall 不是指标,
  过滤正确性才是,结构化查询天生 100%。

## T3|memos rerank —— ✅ 空间已认证(2026-08-12),待生产化选型

**RAG 线首个统计认证改进**:n=76 配对,基线 r@1 26.3/@10 68.4/MRR 0.4030 → rerank(qwen3:8b
离线 oracle)r@1 **57.9**/@10 80.3/MRR **0.6503**。ΔMRR +0.2472 = 2×MDE(0.127),
Wilcoxon p<1e-4,池内救回 10/14、lost 1。6/84 例判官无法产出合法排序被排除(按能力非按结果)。
- [ ] **生产化(待用户拍板,新依赖决策)**:qwen3:8b 单次 1-3.5min 只能当 oracle;内联需
      gte-multilingual-reranker-base(0.3B ONNX 纯 Node,CMTEB-R 74.08 > bge 72.16 > Qwen3-R 71.31),
      要引 @huggingface/transformers + onnxruntime。
- [x] indexPath 前置(4edaab6)| 测量台 + 实跑加固(54acf61, b0d180d)

## T4|IDF 词法腿 —— ✅ 已接线并启用(2026-08-12,判断型切换)

接线 d45129d:代码默认 existence 逐字节等价(parity 18 例冻结锚点);**运行时已翻
`watchdog.wikiRag.lexicalScoring="idf"`**(openclaw.json,不进 git,换机需手工同步;回滚=删键)。
证据等级(固化在代码注释):方向为正/机制成立/**统计未认证**(memos Δ+0.040 p=0.089、
wiki Δ+0.056 p=0.125,MDE 均大于效应;分级降 sd 路线已证伪)。差分验证:idf 与 existence
输出不同、auto 跟随配置、词法分带小数。踩坑记录:探针传字符串曾静默落到读配置 → 已加字符串速记。

## T5|headingPrefix × 同源上限 —— 网格已测(2026-08-12),组合正向但未认证,ship 待拍板

影子索引网格(memos 84 例,同语料快照内部对比):基线(off/N=0)r@1 25.6/@10 67.1/kwCov 66.5/dup 22.9%
→ **组合格(on/N=1)r@1 29.3/@10 75.6/kwCov 70.1/dup 1.4%/S-Rec 0.483**。
互补机制被完整兑现:面包屑单独用 dup +9.8pp(预言的副作用),cap 单独用 kwCov −3.1,组合互抵。
代价:ghost 0.73→0.82(面包屑同样帮过时页)。配对检验 Δ+0.037 < MDE 0.105,p=0.176 →
证据等级与 T4 同:方向为正/机制成立/统计未认证。
- [ ] **ship 待拍板**:要生产化需 per-KB chunking 配置(T6)+ 生产重嵌 + 作废重放缓存;
      `result-diversity.js` 因此有了消费者(chunkctx 驱动),wire-or-delete 判 keep。

## T6|结构债(小、明确)

- [ ] wiki 双入口真值分裂:`searchWiki` 直读索引拿不到 spec,per-KB 参数会单入口静默失效。T1/T3 前收敛。
- [ ] 种子 spec `sources:["wiki"]` 死字段(builder 短路在前),防"统一路径"引爆 chunk id。
- [ ] 休眠开关 wire-or-delete:`result-diversity.js` 绑 T5 裁决;`rag-graded-eval.js`/`rag-stats.js`
      归评测工具面(尺子,合法保留)。
- [ ] `mid` 片 12 题(备忘录 41-80)补对抗审查后入集。

## T7|评测规矩修正(2026-08 实测教训成文)

- [ ] wiki 24 例退役为纯回归守卫(gold 覆盖 100%,McNemar 最小 p=0.5,不再当尺子)。
- [ ] 纪律细化:**大效应照旧认证;小效应(<MDE)测方向 + 报 MDE + 机制论证,标注证据等级** ——
      否则"先测出 delta 才切"对小效应是永久否决权。
- [ ] `ghostHitRate` 升级为 wiki 健康度长期监控(人工策展知识会烂:3 周 96%→9 周 72%,外部实测)。

## 已否决(判例,附实测/来源;新提案先对表)

扩宽候选集(实测全线负,k=60/wide=40 是一对)| MMR(同源核 AUC 0.66,cap 等效省 3 倍)|
向量库迁移(4094×1024 毫秒级,算术)| GraphRAG/知识图谱(账单在人侧)| 语义/LLM 切分(三方复现否)|
LLM 自由改写(FiQA −9.0%)| LLM 生成 gold(rerank+评测同模型 τ=−0.40)| 自动记忆巩固
(效用跌破无记忆基线;write-once+人工编译正是文献推荐配置)| late chunking(qwen3 last-token
pooling 物理封死)| contextual retrieval(违反本地跑;官方数字无独立复现)| 照 MTEB 换嵌入模型
(榜单已烂;自测 +37.5pp 比榜单可信)| jieba(bigram 与分词效果相当,零依赖不换)

## 已结案

- v183 切分器四缺陷 + 摄入侧脱敏 | v184 memos 评测集建立 | v186 检索 FC 工具全 agent 派发 +
  memos 降级出 grounding | v187/188 sourcePath 统一 | v192 测量基础设施(重放台/统计尺/MDE)
- 分级相关性路线:**已证伪归档**(降 sd 同时降效应,净变差)—— 标注保留(65 例)供 nDCG 视角,
  但不再作为"解锁 IDF 认证"的路径。
