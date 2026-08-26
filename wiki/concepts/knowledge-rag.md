# 知识库 / RAG 检索

> 内容寻址的语义记忆:operator/agent 经 hybrid 检索把外部语料按需注入上下文。与 skill(名寻址、确定加载)互补。

## 是什么

一条 hybrid 检索路径,服务多个知识库(KB)。核心在 `lib/operator/wiki-rag-*.js` + `knowledge-base*.js`:

- **切分 + 索引** (`wiki-rag-store.js`):markdown 按 heading 结构化切块(`markdown-sections.js` 共享切分器,词法与向量同源),每 chunk sha256 增量复用(改一处只重嵌改动块)。flat-JSON 向量库,纯 JS cosine(0 外部依赖)。
- **hybrid 检索** (`wiki-rag-search.js` `hybridSearchOverIndex`):查询改写(`rewriteQuery`,0-LLM 剥填充词)→ 词法 BM25-lite(CJK bigram + ASCII 整词,不需 ollama)+ 向量 cosine(需 ollama)→ **RRF 融合**(只用名次,量纲无关)→ 可选 LLM rerank → 可选跨源分歧派生。NEVER throws:embed 挂 → 退化词法-only。
- **嵌入** (`wiki-rag-embed.js`):本地 ollama,默认 `qwen3-embedding:0.6b`(见决策页)。
- **多 KB** (`knowledge-base.js` + `knowledge-base-registry.js`):KB = 命名语料 + 自有索引。内置种子库 `wiki`(复用 wiki 索引);用户库持久在 `control-plane/knowledge-bases.json`,源是任意可读文件/夹(`isTextFile` 白名单 + NUL 检测拒二进制)。`searchKb(kbId)` 复用同一检索核心。
- **时序元数据(Phase5)**:每 chunk 可挂 `{source, time, fields}`(`extractFrontMatter` 从 front-matter 提,**不改 `stripMarkdownNoise`** 以保 hash 不变)。**通用机**:核心只认三个通用槽,金融 schema(issuer/target_price)只活在 KB 的 `metadataRules` 配置=数据非代码。
- **分歧派生** (`deriveConflictHints`):query-time 派生(召回集涌现属性,非 index 预存),同源 time 取最新(supersession)、跨源算离散度(cv/stdev),**呈现分布不塌缩成赢家**。
- **评测** (`wiki-rag-eval.js`):recall@k/MRR(检索对了)+ ghostHitRate(幽灵结论)+ faithfulness/context-precision(用对了,LLM-as-judge `wiki-rag-judge.js`)。per-KB 评测集 + runner(`knowledge-eval-*.js`)。
- **per-agent 消费** (`searchAgentKnowledge`):按 scope/agentId 聚合绑定库 ∪(可选)global,round-robin 名次交错(score 跨库不可比不强排)。

## 为什么存在

operator/agent 的「接地」需要把外部记忆按需调进上下文,而上下文有限。RAG 是对外部记忆做注意力:embedding 同源 transformer,cosine ↔ 内部 QK 相似度。**与 skill 的区别**:skill=名寻址、确定、整单元、规范性;RAG=内容寻址、概率、片段、描述性(见 [Skill 边界](skill-boundary.md))。RAG 工程的核心是缩小「embedding 近 → 真正需要」的 proxy gap:hybrid 补独特词、rerank 重判、查询改写、时序元数据补「索引陈旧/冲突」这一前沿盲区(三大评测框架 RAGAS/DeepEval/TruLens 共同看不见的)。

## 和谁交互

- [Operator](operator.md):grounding 的检索消费者(`operator-knowledge.js`)。RAG 不另建 meta-agent,由 operator 驱动(见决策页 + 备忘录123 D-γ)。
- [Skill 边界](skill-boundary.md):RAG(内容寻址)与 skill(名寻址)互补,不替代。
- [Evaluator](evaluator.md):per-KB 评测复用评测纪律;faithfulness 是生成侧度量。
- [CLI System](cli-system.md):全经 `inspect.knowledge_*`(读)+ `apply.knowledge_*`(写)零旁路;`apply.knowledge_configure` 是时序 on-switch。
- knowledge-bases.json **≠ 结构真值**(内容/数据,类比 artifacts,不进 structure-snapshot;备忘录123 D-β)。

## 演化

- v133-stable: wiki-RAG 朴素版(结构切分 + 本地 nomic embed + 裸 topK)+ 多库 RAG 子系统起步。
- v142: hybrid(向量+词法 RRF),recall@10 71%→96%。v143: 查询改写救填充词查询。
- v145-147: Phase2 ingestion(任意文件/夹建库)+ Phase3 知识库管理页(主页/工作流同级)。
- v148-149: Phase4 per-KB 召回评测(`evaluateWikiRagRecall` 复用 searchFn)+ 面板。
- v150-152: Phase5 时序元数据地基(source/time/fields,通用机)+ 分歧派生(deriveConflictHints,目标3)+ 可视化(知识库页跨源分歧卡)。`asOf` 点时过滤防未来泄漏。
- v153: 评测时序维度——ghostHitRate(recall@k 对幽灵结论失明)+ undecided 弃权。
- v154: per-agent KB consumer(`searchAgentKnowledge`,operator/UI 验证面 `inspect.knowledge_agent_search`;否决 agent 经 system_action 调 inspect=破隔离/造协议)。
- v156: faithfulness/context-precision 生成侧评测(LLM-as-judge)+ 接进 runner。
- v158: **embed 升级 nomic→qwen3-embedding:0.6b**(A/B +37.5pp recall@1)。
- v162: LLM-as-reranker(默认关,质量 +16.7pp recall@1 但 ~60s/query 延迟劝退默认开)。

源: 备忘录122(高星 AgentRAG 调研三档落地)/ 备忘录123(三计划真值层协调,knowledge≠真值)。

## 当前状态

演化中。122 三档 land 主线(embed→rerank→faithfulness)已走完;时序/分歧/per-agent 后端闭环。待续:rerank 换快模型再评估默认开 / faithfulness 挂 harnessRunId 进 gate / per-agent 自动注入。
