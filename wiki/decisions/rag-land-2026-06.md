# RAG 主线落地决策(备忘录122 三档 land)

> 评测驱动地落地 embed 升级 / rerank / faithfulness;每条「有正向 delta 才切」,诚实记录环境阻塞与延迟权衡。

## 决策一:embed 升级 nomic-embed-text → qwen3-embedding:0.6b

**决策**:换默认嵌入模型(`wiki-rag-embed.js` `DEFAULT_EMBED_MODEL`),换模触发 `existing.model!==model` 全量重嵌。

**原因**:24 例中文 fixture 公平 A/B(同 chunk 集、查询与索引同模型)决定性正向:recall@1 41.7%→**79.2%**(+37.5pp)、@5 79.2%→100%、MRR 0.612→0.862。这是 122 纪律「改 embed 先跑 fixture recall delta,有正向才切」的直接产物。

**替代方案**:① 保 nomic — 被 A/B 否决,差距过大。② BGE-M3 单模型 hybrid — 对我们是**降级**,会让「embed 挂、词法路径仍有结果」的 graceful 降级消失(我们 BM25-lite 为中文手写 CJK bigram)。③ ColBERT/ColPali late-interaction — 每 token 一向量让 flat-JSON 索引体积爆炸。

**影响**:[知识库/RAG](../concepts/knowledge-rag.md) 检索质量;需 `ollama pull qwen3-embedding:0.6b`(未拉→优雅退化词法-only);live full-build 测试 ~25s(nomic 3×)贴近 30s timeout → 提到 90s。新增 `embedModel`/`indexPath` A/B 基础设施(默认 null,backward-compat),让未来 embed 改动都能公平 A/B 不盲换。

## 决策二:rerank 用 LLM-as-reranker,默认关

**决策**:rerank 第二级用 LLM listwise(qwen3:8b 一次调用排序宽召回集,`wiki-rag-rerank.js`),复用 judge 的 ollama chat 原语;**默认关**,LLM 不可用/解析失败→保持 RRF 原序优雅退化。

**原因**:122 P0-2 设想的「本地 ollama 专用 reranker」在此环境**不成立**——ollama 0.21 无 `/api/rerank` 端点,`qwen3-reranker:0.6b` tag 不存在于 ollama 库。LLM-rerank 是 0 依赖可行路径。质量 A/B 正向:recall@1 79.2%→95.8%(+16.7pp)、MRR 0.862→0.972。**但 ~60s/query(qwen3:8b thinking + listwise)对交互式检索是劝退级延迟** → 默认关、可选开(config `watchdog.wikiRag.rerank` 或 per-call),适合离线/高价值精排。

**替代方案**:① 专用 cross-encoder(bge-reranker-v2-m3)— ollama 不 serve,放弃。② 升级 serving(TEI/vLLM/llama.cpp rerank)— 引入新进程,破「0 外部运行时依赖」。③ 默认开 — 延迟否决。④ 逐条 pointwise 打分 — O(N) 次 LLM 调用更慢,故选 listwise(一次)。

**影响**:`hybridSearchOverIndex` 加 rerank 选项(默认路径零 config 读=零回归)。待续:换快模型(qwen3.5:0.8b / `/no_think`)再测延迟,达标才考虑默认开。

## 决策三:faithfulness/context-precision 生成侧评测(judge 注入)

**决策**:`wiki-rag-eval.js` 加 `evaluateFaithfulness`/`evaluateContextPrecision`,judgeFn 注入边界(同 searchFn 模式);本地 judge `wiki-rag-judge.js`(qwen3:8b,format:json,防御式解析剥 `<think>`/截断补 `}`)。接进 eval runner。

**原因**:recall@k 只证「检索对了」(对的 chunk 进 top-k),faithfulness 证「用对了」(context 真支撑答案)——是 embed/rerank 改进的**验证前提**。这正是 RAGAS/DeepEval/TruLens 三大框架的共同盲区方向(我们 v150 时序元数据已先手解「索引陈旧」那半)。judge 注入使 gate 可用 fake judge 确定式。

**替代方案**:① Self-RAG/CRAG 检索后自我纠正 — 落地需标注/微调评估器,门槛高;先 LLM-as-judge 轻量切入。② 不做生成侧度量 — 改进只能证检索对不能证用对,不可量化。

**影响**:[Evaluator](../concepts/evaluator.md) 评测纪律延伸到生成侧;eval-set case 加可选 `answer`(gold)。

## 决策四:RAG 不建 meta-agent;knowledge ≠ 结构真值

**决策**:RAG 由 [Operator](../concepts/operator.md) 驱动消费,**不**对称建 kb-master meta-agent;`knowledge-bases.json` **不**进 structure-snapshot 真值枚举。

**原因**:[传送带原则](../concepts/conveyor-belt.md)反对增殖具名 agent;RAG 的目的就是被 operator 消费,真缺口是 grounding 只读 wiki(`operator-knowledge.js`,待 searchWiki→searchKb)。KB=语料+可重建索引=内容/数据,类比 artifacts,纳入会引哈希 churn + 多 MB 索引同步,且 `knowledge_remove` 拍结构快照却没备份被删 KB=假回滚。

**替代方案**:对称建 kb-master meta-agent(被否决,违传送带)/ knowledge 入快照(假「可回滚」,被 D-β 修正)。

**影响**:operator 所有权表只「认得」knowledge 家族;`maybePreApplyStructureSnapshot` 对 non-truth-backed family 豁免(并发 viz/seam 计划落地)。

## 出处

源: 备忘录122 §三/§八(高星 AgentRAG 三档落地 + A/B 实测)/ 备忘录123 D-β/D-γ(三计划真值层协调)。实测 A/B 见会话内 embed/rerank delta 度量。
