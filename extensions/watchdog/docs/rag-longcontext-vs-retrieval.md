# wiki 全塞上下文 vs 检索:一笔账

2026-08-11 · 主题:wiki 小到可以整库塞进 prompt 吗?如果可以,wiki 侧的检索优化是否整条作废?

复跑:`node extensions/watchdog/scripts/kb-token-budget.js`
口径的守卫测试:`node --test extensions/watchdog/tests/kb-token-budget.test.js`

---

## 0. 结论先行

| 问题 | 回答 |
|---|---|
| wiki 整库塞得进上下文吗 | **塞得进**。约 4.2 万–6.6 万 token(中位档 4.96 万),占 kimi 256K 窗口的 26.5%(中位)/32.9%(保守) |
| memos 整库塞得进吗 | **塞不进**。约 41 万–65 万 token,是 256K 窗口的 1.9–2.5 倍,数学上出局 |
| operator/viz-master 这条路技术上可行吗 | 可行。它们是单轮规划器,一次 POST 就结束,加长输入在机制上没有障碍 |
| 8 个普通 agent 那条路呢 | 那条路是多轮 tool loop,整库常驻会按轮次翻倍,形态上对不上 |
| 检索优化会作废吗 | **不会**。全塞最多覆盖 10 个 agent 里的 2 个、2 个库里的 1 个;同一条检索代码还要服务 memos(48 万 token)与未来任何用户库 |
| 值得试吗 | **值得试一次受控实验,同时它排在第二位**。第一位是先把今天的 grounding 从 **326 token** 抬到 1,100 token 那一档(成本是全塞的 1/38)—— 见 §6 |

这份账里最刺眼的一个数:今天 operator 每次规划,整个 RAG 子系统向 prompt 贡献
**约 326 token**(topK=4 × 平均 202 字)。相对一个约 2 万 token 的 prompt,占比 **1.6%**。
"全塞 vs 检索"的对立,建立在一个未被检验的前提上 —— 前提是今天已经在认真用检索。

---

## 1. 实测体量(2026-08-11)

`node scripts/kb-token-budget.js` 的输出,原样:

| 语料 | 文件 | 字节 | 字符 | 汉字占比 | token 估算(low ~ high,中位) |
|---|---|---|---|---|---|
| wiki(检索口径,排除 4 个 meta 页) | 61 | 207,852 B | 130,223 | 26.2% | 41,807 ~ 66,116(**49,587**) |
| wiki(全目录,含 index/log/schema/status) | 65 | 274,871 B | 173,050 | 25.8% | 55,312 ~ 87,431(65,573) |
| memos(`use guide/`) | 153 | 2,016,594 B | 1,364,146 | 21.0% | 411,474 ~ 645,887(**484,416**) |

切分后的索引侧(真正会被注入的文本,已剥 markdown 噪声、已脱敏):

| 索引 | chunk | 页 | 中位/ p90 块长 | 文本总量 | token 中位档 |
|---|---|---|---|---|---|
| `wiki-rag-index` | 452 | 61 | 142 字 / 525 字 | 102,852 字 | 41,497 |
| `kb-memos-index` | 3,642 | 150 | — | — | 索引文件 110MB,默认跳过(`--force-index` 可读) |

wiki 切分后比原文少 21%(130,223 → 102,852 字):markdown 噪声被剥掉了。
**全塞时该按 chunk 文本算(41,497 token),而非原始 markdown(49,587 token)。**

单次实际注入(生产值):`topK=4 × 平均 202 字(截断上限 500)= 809 字 ≈ **326 token**`。

排除口径与 `lib/knowledge/wiki-rag-store.js:71` 的 `WIKI_META_PAGES` 一致;
汉字判定区间(U+4E00–U+9FFF)与同文件 `:495` 的词法分词器一致。

### token 估算的诚实说明

本机没有目标模型的分词器,所以按字符分类加权估:

- 汉字 **0.6 / 0.75 / 1.0** token 每字(low/mid/high)
- 其余字符(ASCII 词、路径、标点、空白、换行)**4.5 / 4.0 / 3.0** 字符每 token

误差带相对中位档是 **−16% ~ +33%**(low 到 high 相差 1.58 倍)。挑这两组常数的依据:现代 15 万+ 词表、
面向中文优化的 BPE(Qwen 系公开口径约 1.3 汉字/token ≈ 0.77 token/字)落在中位档附近;
老一代 10 万词表的分词器更接近 high 档。**这个带宽不影响任何结论** ——
全塞与检索之间差 127 倍,一个 1.58 倍的带宽改不动方向。

把估算换成实测有两条零成本的路(都不做推理):

1. Moonshot 的 `/v1/tokenizers/estimate-token-count`(纯计数接口);
2. 读任意一次真实调用回包里的 `usage.prompt_tokens`。

第 2 条生产侧今天取不到:`lib/llm/llm-planner.js:158-167` 只从回包取 `content`,`usage` 字段被丢弃,
全库检索 `prompt_tokens|promptTokens|completion_tokens` **零命中** —— 平台目前没有 token 记账
(实验脚本可以自己记,见 §7.2;缺的是生产链路上的长期核账)。这是 §8 的第一项待补。

---

## 2. 今天的 prompt 里装了什么

operator 单轮规划的请求体是 `[{role:"system"}, {role:"user"}]` 两条消息
(`lib/llm/llm-planner.js:152-154`),user 消息 = 两句固定指令 + `JSON.stringify(context, null, 2)`
(`lib/operator/operator-brain.js:329`)。各块实测/估算体量:

| 块 | 来源 | 体量 | 性质 |
|---|---|---|---|
| `executableSurfaces` | `operator-brain.js:195`,50 个 surface | **34,800 字符**(实测) | 稳定,逐字精确要求最高 |
| system prompt | `operator-brain.js:203-232` | 约 3.9 千字符 | 稳定 |
| 知识片段(13 个静态 + 3 个动态里选 6) | `operator-knowledge.js:9-118`,`MAX_SELECTED_FRAGMENTS=6` | 约 4–7 千字符 | 稳定 |
| skills / agents / models / graph / testReports | `operator-brain.js:193-199` | 约 8–12 千字符 | 随平台状态变 |
| **`retrievedNotes`(RAG grounding)** | `operator-knowledge.js:298` topK=4,`:316` 摘录截 500 字 | **809 字符 ≈ 326 token**(实测) | 随请求变 |

`executableSurfaces` 实测复跑:

```js
import { listOperatorExecutableCliSystemSurfaces } from "./lib/operator/operator-surface-policy.js";
// 50 个 surface,summarizeSurfaceForBrain 后 JSON.stringify(null,2) = 34,800 字符
```

合计约 5.2–5.8 万字符,按中位档折 **约 1.8–2.2 万 token**。后文一律取 **20,000 token** 作基线
(脚本用 `--baseline-tokens` 可换)。

于是今天的比例是:**RAG 贡献 326 token / 全 prompt 约 20,000 token = 1.6%**。
而 `executableSurfaces` 一块就占了 60% 以上。

---

## 3. 成本账

### 3.1 窗口

| 模型 | 角色 | 上下文窗口 | 来源(2026-08-11 检索) |
|---|---|---|---|
| `kimi/kimi-for-coding` | 主力(`openclaw.json` `agents.defaults.model.primary`) | **256K**,默认开 thinking | kimi.com Kimi Code 文档 / 套餐页 |
| `glm-bigmodel/glm-5.1` | 兜底 | **200K**(GLM-5 系),最大输出 128K,支持 context caching | docs.bigmodel.cn GLM-5 模型页 |

wiki 整库(保守档 66,116 + 基线 20,000 = 86,116)在两个窗口里都放得下:
256K 用掉 32.9%,200K 用掉 42.0%。memos 整库(保守档 645,887)两个窗口都放不下。

**平台目前没有窗口真值**:`openclaw.json` 里没有任何 model 条目声明 `contextWindow`,
`lib/management/model-registry-view.js:26` 只从配置读,`operator-brain.js:69` 因此永远向 planner 报
`contextWindow: null`。也就是说,今天即便把整库塞进去,系统自己也没有任何一处能判断"塞不塞得下"。

### 3.2 钱

主力 `kimi-for-coding` 走的是**订阅制 coding 端点**(`api.kimi.com/coding/v1`),
计费单位是 Agent Credits:以订阅日为起点每 7 天刷新、未用完不累积,另有**每 5 小时的滚动频率窗口**
(kimi.com 帮助中心,2026-08-11)。官方未公布该端点的 ¥/token 价目;加油包给的量级参考是
"简单请求约 ¥0.03,复杂多步任务约 ¥1.6"。

**结论:在主力提供商上,全塞的代价不是钱,是额度与 5 小时窗口内还剩几次 operator 调用。**

兜底 `glm-5.1` 是按 token 计费的,可以算得出:

| 方案 | 输入 token | 单价档 | 每次调用 |
|---|---|---|---|
| 今天(检索 topK=4) | ~20,000 | ¥6/M(32K 以下) | **¥0.12** |
| 全塞 wiki | ~61,200 | ¥8/M(32K 以上) | **¥0.49**(4.1×) |
| 全塞 + 缓存命中 | 41,500 缓存 + 20,000 常规 | ¥1.3/M + ¥8/M | **¥0.21**(1.8×) |

价格为二手来源(¥6/¥8 输入分档、¥24/M 输出、¥1.3/M 缓存命中,2026-08-11 检索),
落地前以智谱官方价目表复核。注意分档是按输入总长跳档的:全塞会把**整个请求**从 ¥6 档推到 ¥8 档,
增量成本大于"新增 token × 单价"。

### 3.3 prompt caching 今天省不到

两家都支持前缀缓存,但缓存要求**前缀逐字节稳定**。今天的 context 里第一个字段就是
`request: requestText`(`operator-brain.js:173`)—— 每次调用都变的那一项排在最前面,
其后才是 surfaces / skills / graph 这些稳定大块。于是可复用的前缀只剩下:
system 消息(约 1 千 token)+ user 消息开头那两段固定指令(约 850 字符),
从 JSON 的第一个字段起就逐次不同 —— 占体量九成以上的稳定大块全部落在失效区之后。

**这条是全塞方案的前置条件,也是它最便宜的一步准备工作**:把 context 的字段顺序改成
"稳定块在前(surfaces / 静态片段 / 整库语料)、变动块在后(request / conversation / retrievedNotes)",
缓存才可能把 §3.2 的 4.1× 压到 1.8×。这项改动**与全塞与否无关**,今天就能单独做、单独验。

---

## 4. 关键判断:两条消费路径形态不同

平台上"读知识库"存在两条路,它们对全塞的容纳能力完全不同。这不是实现细节,是形态差异。

### 路径 A:operator / viz-master —— 单轮规划器,无条件预注入

- 调用形态:`callOpenAICompatiblePlanner` 一次 POST,`messages` 只有 system + user,
  **没有 `tools` 字段、没有循环**(`lib/llm/llm-planner.js:120-167`)。期望单轮吐出 JSON plan,
  解析失败的错误码就叫 `PLANNER_JSON_PARSE_FAILED`。
- 检索形态:`Promise.all` 里的**无条件预注入**,问什么都固定拉 4 条
  (`operator-knowledge.js:298`、`lib/viz/viz-master-knowledge.js:127`)。
- **全塞在这条路上技术可行**:输入变长而已,机制上没有额外循环放大。
  语料每次调用只出现一次,占 26.5% 窗口。

### 路径 B:其余 8 个 agent —— FC 工具环,按需检索

- 调用形态:多轮 tool loop,agent 自己决定调不调 `search_knowledge`
  (`lib/knowledge/knowledge-toolface.js`,该文件开头写明了这条边界:预注入对单轮规划器是对的形态,
  强行统一等于为统一而统一)。
- **全塞在这条路上形态对不上**:常驻语料会随对话历史被重复携带,轮数一多就是 4 万 token × N;
  而工具环恰好是"按需付费"的天然形态 —— 该查才查,不查零成本。
- 更实际的是可见性:这 8 个 agent 的 KB 可见范围由 `selectAgentKnowledgeBases`
  (`knowledge-base.js:72-76`)按 scope/agentId 数据决定,全塞需要为每个 agent 各算一份常驻语料,
  与"传送带原则"下的通用机形态相冲。

### 一个必须先说清的现状

`control-plane/knowledge-bases.json` 里 memos 库是 `scope:"agent"` 且 `agentId:null`。
按 `selectAgentKnowledgeBases` 的过滤条件(`id && s.scope==="agent" && s.agentId===id`),
**这个库今天任何 agent 都检索不到** —— 唯一有运行时消费者的库是 global 种子库 wiki。
所以"全塞哪个库"这个问题,今天实际上只涉及 wiki 一个;memos 侧的检索优化,在它接上消费者之前
既不会被全塞取代,也还没有人在用。

---

## 5. 全塞会挤掉什么

窗口够用,但"占用"与"代价"是两件事。具体到 operator 这条路,增加 4.15 万 token 会动到四处:

1. **surface catalog 的精确度**。plan 里每个 `surfaceId` 必须逐字命中 50 个 surface 之一,
   否则被 `operator-plan` 校验拒掉。今天 34,800 字符的 catalog 占 prompt 六成以上(按字符);
   全塞后(+102,852 字符)它被稀释到约两成,而它恰恰是**唯一要求逐字精确**的部分。
   wiki 是散文体的 WHY,catalog 是需要精确复制的 ID 表 —— 用长散文稀释短 ID 表,
   风险方向是明确的。
2. **输出预算**。`maxTokens: 8192` 由 reasoning + plan **共享**(`operator-brain.js:334-336`,
   注释里写明 4096 会让 plan JSON 被截断)。thinking 默认开的模型,输入变长通常带来更长的思考,
   plan JSON 被挤截的概率上升,直接表现为 `PLANNER_JSON_PARSE_FAILED` 与那次重试
   (`callPlannerWithSingleRetry`)。这是已知且已有兜底的失效模式,全塞会抬高它的触发率。
3. **额度与节流**。主力是订阅制,5 小时滚动窗口内 operator 能规划几次,与每次输入量直接挂钩。
4. **延迟**。prefill 增加 4 万 token 的墙钟代价**尚未实测**;A/B 的 wall-clock 差就是答案,
   在此之前不做数字猜测。

反过来,全塞能拿回什么,上界是可以算的:

- wiki 24 例评测里 r@3 = 91.7、r@5 = r@10 = 95.8 → **约 4.2%(24 例里 1 例)的查询,
  期望页在 top-10 内从未出现**;top-3 未出现的约 8.3%。全塞对这部分是确定的救援。
- `dupSlotRate 48.8%` → 今天 top-k 里近一半槽位被同一页重复占用,topK=4 实际只覆盖 2–3 个不同页面。
  需要**跨页综合**的问题(例如"这三个板块的边界怎么划的"),现有 fixture 根本没覆盖,
  它是全塞真正可能赢的地方 —— 也正因为没覆盖,现在无法量化。

所以:**可量化的上界约 4–8% 的查询;不可量化的部分是跨页综合类问题。**
拿 127 倍输入换 4–8% 的确定收益 + 一块未知收益 —— 这个取舍值得用实验定,而不是用直觉定。

---

## 6. 排在全塞前面的那一步

在跑 A/B 之前,有一个更省的干预,而且它能把两个混在一起的假设拆开:

- 假设 H1:"上下文给得太少"(326 token 不够)
- 假设 H2:"检索选错了页"(选出来的 4 条不对)

脚本把几档规格摆在同一张表里(wiki,中位档,基线 20,000 token):

| 规格 | 每次注入 | 占 prompt | 相对今天 |
|---|---|---|---|
| 今天:topK=4,cap=500 | 326 token | 1.6% | 1× |
| 抬高一档:topK=12,cap=1200 | 1,102 token | 5.3% | 3.4× |
| 再抬一档:topK=24,cap=1200 | 2,203 token | 10.1% | 6.8× |
| 全塞:452 块全量 | 41,497 token | 67.8% | **127.3×** |

**把 topK 从 4 抬到 12、把摘录截断从 500 字抬到 1200 字(= chunk 上限)**,
grounding 从 326 token 变成 1,102 token,仍只占 prompt 的 5.3%、占 256K 窗口的 0.4%。
如果 H1 成立,这一步就能吃到大部分收益,**成本是全塞的 1/38**;如果这一步毫无变化,
那"再多给 38 倍上下文"能救的概率也随之下降 —— 全塞的先验被这一步更新掉了。

这一步同时是全塞实验的**必要对照臂**:缺了它,全塞哪怕赢了,也分不清赢在"信息更全"
还是"信息更多"。三臂设计见下。

---

## 7. 对照实验设计

### 7.1 在不动现状的前提下怎么跑

**在离线脚本里跑,生产代码一行都不改。** 参照 `scripts/kb-replay.js` 已经验证过的做法:
脚本 import 生产函数拼 context,只在最后一步替换 `knowledge.retrievedNotes` 这一个字段,
然后直接调 `callOpenAICompatiblePlanner`。这样默认路径逐字节不变,实验臂也留在主干之外
(呼应 CLAUDE.md 的"不留遗留代码":永远为 0 的开关本来就该留在实验脚本里)。

三臂:

| 臂 | grounding | 每次输入 |
|---|---|---|
| A(对照 = 今天) | topK=4,摘录截 500 字 | ~20,000 token |
| B(便宜臂) | topK=12,摘录截 1,200 字 | ~20,800 token |
| C(全塞臂) | 452 个 chunk 全量,按 sourcePath 分组、页内保序 | ~61,200 token |

C 臂的语料顺序放在 context 最前面(见 §3.3),这样它同时验证了缓存前缀的可行性。

### 7.2 用什么判据

平台今天**没有答案质量指标**:`evaluateFaithfulness` 与 `evaluateContextPrecision` 的代码在
`lib/knowledge/wiki-rag-eval.js:168,193`,runner 在 `knowledge-eval-runner.js:141`,judge 是本地
`qwen3:8b`(零外部成本)—— 但两个 fixture 的 case 里**没有 `answer` 字段**
(实测:`wiki-rag-eval-set.json` 24 例,`answer` 命中 0),所以生成侧评测目前进不了门。

在此前提下,可用的判据分三层:

**层 1 — 客观、零成本、今天就能算**

1. `planValid`:plan 里每个 `surfaceId` ∈ 50 个 executableSurfaces id(逐字比对)
2. `degenerateRate`:`isDegeneratePlannerPlan`(已导出,`operator-brain.js`)
3. `parseFailRate`:`PLANNER_JSON_PARSE_FAILED` 次数
4. `replyKeywordCoverage`:24 例 fixture 的 `expectedKeywords` 在 `plan.reply` 里的覆盖率
   —— **诚实标注**:这些关键词是为"检索命中"写的,operator 是规划器而非问答器,
   这只是代理指标,方向可信、绝对值意义有限
5. `promptTokens` / wall-clock:实验脚本自己记录回包的 `usage`(生产今天不记,见 §1)

**层 2 — 需要先补一次性资产**

给 24 例 fixture 补 `answer` 字段(人工写,一次性),`evaluateFaithfulness` 就能进门,
judge 用本地 qwen3:8b,跑一次零外部成本。这是把"感觉更好"变成数字的最短路径。

**层 3 — 人工配对盲评**

准备 20 条**真实形态的 operator 请求**(建 loop / 连边 / 改 agent 角色这类,
而不是 wiki 问答),同一条请求跑三臂,隐去臂标签,人工按"这个 plan 我会直接执行吗"打三档。

### 7.3 统计上能指望什么

这是必须先说清的部分,不然实验会得出"没差别"这种其实是"测不出来"的结论:

- 二值指标(命中/未命中)在 1–3pp 效应量下,n=24 天然测不出。要判的话,做**逐题配对差值**
  推断(同一 query 三臂各跑一次,比每题的分差),靠题目间相关性降方差 —— 与本项目在
  IDF 那轮用 Wilcoxon(ΔRR)/ 符号检验的方法一致。
- 上界摆在那里(§5:约 4–8% 的查询),所以**若 A/B 的目标是证明 recall 类指标变好,
  它注定测不出显著** —— 该指标下全塞的收益本来就只有一两题。
- 因此实验的主判据应当是**层 3 的人工配对偏好**加**层 1 的失效率(parseFail / degenerate)**:
  前者能看见"跨页综合"这块 fixture 覆盖不到的收益,后者能看见 §5 说的挤压风险。
- 调用量估算:3 臂 × 24 例 = 72 次规划调用,C 臂每次约 6.1 万 token 输入。
  在 5 小时滚动窗口里要分批跑,或者整轮走 glm-5.1(那条按 token 计费:
  A 臂 ¥2.9 + B 臂 ¥3.0 + C 臂 ¥11.8 + 输出约 ¥3.5 ≈ **¥20 量级**)。

---

## 8. 诚实结论

**问题一:wiki 小到可以整库塞进上下文吗?**

体量上可以 —— 4.96 万 token(中位档),连同 prompt 基线占主力模型窗口 26.5%、占兜底模型窗口 34%。
memos 不行,它是 48 万 token,**是 256K 窗口的 1.9 倍**。

**问题二:那 wiki 侧的检索优化是不是整条作废?**

否,四条理由,每条都独立成立:

1. **覆盖面**:全塞只适配单轮规划器(10 个 agent 里的 2 个)。另外 8 个走 FC 工具环,
   那条路的正确形态就是按需检索。
2. **同一条代码**:wiki 与 memos 与未来任何用户库共用一条检索路径
   (`hybridSearchOverIndex`)。memos 3,642 块永远塞不进,检索是它唯一的出路。
3. **单调增长**:wiki 检索口径现在 61 页 / 13 万字,每次 Ingest 都在长
   (被排除在索引外的变更日志 `log.md` 已 2.8 万字,它记录的正是概念页的增长速率)。
   全塞的余量只会变小,检索的余量不会。
4. **一条路径原则**:全塞若成为第二条 grounding 路径,平台就同时存在两套 WHY 注入真值。
   要做也得做成"同一个 grounding 出口的一个参数",而不是新开一条回路。

**问题三:值得试吗?**

- **先做 §6 的便宜臂(topK 4→12、截断 500→1200)**:成本是全塞的 1/38,
  且它把"上下文不够"和"检索选错"两个假设拆开。今天 326 token 的 grounding 更像是配置疏忽,
  而不是深思熟虑的取舍。
- **同期做 §3.3 的字段重排(稳定块前置)**:与全塞无关,单独就能让缓存生效,是纯赚的一步。
- **全塞值得跑一次受控实验,但排第二**,并且预期它在现有 recall 类指标上测不出显著(上界只有 4–8%);
  它真正要验的是跨页综合类问题,而那类问题今天还没有评测集。

**数据不足以判断的部分,以及需要先补什么:**

1. **token 记账**:`usage` 字段在 `llm-planner.js` 被丢弃,全库零记录。
   没有它,这份文档里所有 token 数都只能是估算,而且**上线后也无法核账**。补它最省力。
2. **答案质量指标**:24 例 fixture 补 `answer` 字段,`evaluateFaithfulness` 就能进门
   (代码与本地 judge 都现成)。缺了它,任何"全塞让回答更好"的说法都只能靠人工评。
3. **窗口真值**:`openclaw.json` 的 model 条目补 `contextWindow`
   (kimi-for-coding 262144、glm-5.1 204800),`operator-brain.js:69` 才不会永远报 null。
   任何"塞得下"的判断,都应当由运行时自己能算,而非只写在这份文档里。
4. **跨页综合评测集**:全塞唯一可能的大收益,今天没有任何一条 case 覆盖它。
   在补出这类 case 之前,全塞的收益上界只能引用 §5 的 4–8%。

---

## 附:数字出处

| 数字 | 出处 |
|---|---|
| 61 页 / 130,223 字 / 452 chunk / 102,852 字 | `node scripts/kb-token-budget.js`(2026-08-11) |
| 50 个 surface / 34,800 字符 | `listOperatorExecutableCliSystemSurfaces({includeTemplates:true})` + `summarizeSurfaceForBrain` 实跑 |
| topK=4 / 摘录 500 字 | `lib/operator/operator-knowledge.js:298,316` |
| 单轮、无 tools 字段 | `lib/llm/llm-planner.js:120-167` |
| `usage` 被丢弃 | `lib/llm/llm-planner.js:158-167`,全库 grep `prompt_tokens` 零命中 |
| contextWindow 恒为 null | `lib/management/model-registry-view.js:26` + `openclaw.json` 无声明 |
| memos 库无消费者 | `control-plane/knowledge-bases.json`(scope:"agent", agentId:null)+ `knowledge-base.js:72-76` |
| kimi-for-coding 256K / 默认开 thinking / 订阅额度 7 天刷新 + 5 小时滚动窗口 | <https://www.kimi.com/code/docs/> 与 <https://www.kimi.com/zh-cn/help/kimi-code/benefits>,2026-08-11 检索 |
| GLM-5 200K 上下文 / 128K 最大输出 / 支持 context caching | <https://docs.bigmodel.cn/cn/guide/models/text/glm-5>,2026-08-11 检索 |
| GLM-5.1 ¥6(<32K)/¥8(>32K)输入、¥24 输出、¥1.3 缓存命中(每 M token) | 二手来源(<https://www.datalearner.com/en/ai-models/pretrained-models/glm-5-1> 等),2026-08-11 检索,落地前以智谱官方价目表复核 |
| Moonshot 计数接口 `/v1/tokenizers/estimate-token-count` | <https://platform.kimi.com/docs/api/estimate>,2026-08-11 检索 |
| wiki r@1 70.8 / r@3 91.7 / r@5 95.8 / dupSlotRate 48.8% | 既有召回评测(24 例) |
