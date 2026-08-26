# 词法腿 IDF 打分内核 · 接线方案

**System Block**: L6 知识·RAG · 检索打分
**状态**: 已接线(2026-08-12,默认 existence 逐字节等价由 parity 18 例冻结锚点钉住;文中行号基于接线前快照)
**写于**: 2026-08-11
**配套测试**: `extensions/watchdog/tests/wiki-rag-lexical-parity.test.js`(11 例,已绿)

---

## 0. 一句话结论

把 `lib/knowledge/wiki-rag-lexical.js` 的可配置打分器接进 `searchWikiRagLexical`,
**默认档保持 `existence`(= 今天逐字节相同的行为)**,IDF/BM25 作为可切换档位就位待命。
本次接线交付的是**开关**,而非"已认证的检索提升" —— 证据强度见 §5。

---

## 1. 改动边界

| 文件 | 现状行号 | 动作 |
|------|---------|------|
| `lib/knowledge/wiki-rag-store.js` | 17 | 加一行 import |
| 同上 | 502-513 | 删除 `lexicalScoreChunk` 整个函数 |
| 同上 | 517 | `searchWikiRagLexical` 签名加 `scoring` |
| 同上 | 522 后 | 插入一行构造 scorer |
| 同上 | 527 | 打分表达式换成 `scoreOf(rec)` |
| `lib/knowledge/wiki-rag-lexical.js` | 1-15 | 文件头说明补一句(配置解析段) |
| 同上 | 1(imports 前) | 加 3 行 import |
| 同上 | 文件末尾 | 新增 `resolveWikiRagLexicalConfig` |
| `lib/knowledge/wiki-rag-search.js` | 10 后 | 加一行 import |
| 同上 | 134 | `hybridSearchOverIndex` 签名加 `lexicalScoring` |
| 同上 | 147-148 之间 | 插入一行解析配置 |
| 同上 | 148 | 调用透传 `scoring` |
| `openclaw.json` | `watchdog.wikiRag` | 可选新键(默认缺省即 existence) |

**保持原样的东西**:索引文件结构、`buildWikiRagIndex`、`compareByScoreThenPath`、
`rrfFuse`、`rewriteQuery`、向量腿、rerank、asOf 过滤、conflictHints。
**索引零迁移**:df / avgLen 全在查询期算(`wiki-rag-lexical.js:81-83` 已论证),切换档位无需重嵌。

`searchWikiRagLexical` 的生产调用方只有一处 —— `wiki-rag-search.js:148`。
其余引用来自 `scripts/kb-replay.js:158,224` 与 4 个测试文件(全库 grep 核实)。
`hybridSearchOverIndex` 的生产调用方两处:`wiki-rag-search.js:196` (`searchWiki`)、
`knowledge-base.js:66` (`searchKb`)。**一个接缝、两个入口**,配置解析放一处即可覆盖全部。

---

## 2. 逐行改法

### 2.1 `lib/knowledge/wiki-rag-store.js`

**(a) 第 17 行之后追加 import**

```js
// 17 行(现有):import { embedText, resolveWikiRagEmbedConfig } from "./wiki-rag-embed.js";
import { buildLexicalScorer } from "./wiki-rag-lexical.js";   // ← 新增第 18 行
```

**(b) 删除 502-513 行整个 `lexicalScoreChunk`**

删除后本文件里 `lexicalScoreChunk` 零引用(唯一调用点是 527 行,同批改掉)。
按「代码质量红线 · 不留遗留代码」,这里是**删除**而非保留兼容 shim。

**(c) 517-533 行的 `searchWikiRagLexical` 改成**

```js
// 词法 top-K(纯函数,不需 ollama)。与 searchWikiRag 同输出形状 {sourcePath,heading,text,score}。
// 用于 hybrid 融合 + ollama 不可用时的降级检索(此前降级=空,现在降级仍有词法结果)。
// scoring:打分档位与参数({mode,k1,b}),由调用方解析后传入 —— 本函数自身与配置文件解耦,
// 于是 kb-replay / 单测的结果与本机 openclaw.json 无关。缺省 = existence = 历史行为。
export async function searchWikiRagLexical(queryText, { topK = 5, index = null, scoring = null } = {}) {
  const resolved = index || await loadWikiRagIndex();
  const chunks = Array.isArray(resolved?.chunks) ? resolved.chunks : [];
  const terms = lexicalTermsForQuery(queryText);
  if (terms.asciiTokens.length === 0 && terms.cjkBigrams.length === 0) return [];
  // 每查询构造一次:df/avgLen 的统计遍在这里发生一次,之后逐块打分是同步纯函数。
  // 传 chunks 本身(而非全库)—— asOf 过滤后的候选集与被打分的集合必须是同一份,df 才对得上。
  const scoreOf = buildLexicalScorer(terms, chunks, scoring || {});
  return chunks
    .map((rec) => ({
      sourcePath: rec.sourcePath,
      heading: rec.heading,
      text: rec.text || "",
      score: scoreOf(rec),
      ...(rec.meta ? { meta: rec.meta } : {}), // Phase5:meta 透传(旧索引无→不加)
    }))
    .filter((r) => r.score > 0)
    .sort(compareByScoreThenPath)
    .slice(0, Math.max(1, Number(topK) || 5));
}
```

`.filter` / `.sort` / `.slice` 三行原样保留(理由见 §4)。

### 2.2 `lib/knowledge/wiki-rag-lexical.js`

**(a) 文件头第 1 行改写**(当前写着"纯函数、零依赖",接线后文件末尾有一段读盘,需同步)

```js
// lib/knowledge/wiki-rag-lexical.js — 词法腿的打分内核(打分部分纯函数、零 ollama)。
// 文件末尾另有一段配置解析(只读 openclaw.json),与 wiki-rag-rerank.js:18-30 同形:
// 打分档位的默认常量与它的配置键放在同一个文件里,读结论的人一处看全。
```

**(b) 现有 import 区之前(即文件顶部)追加**

```js
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "../state.js";
```

**(c) 文件末尾追加解析器**

```js
// 档位配置解析。形状与来源对齐既有两例:embed(wiki-rag-embed.js:44-62)、rerank(wiki-rag-rerank.js:18-30),
// 键位 openclaw.json → watchdog.wikiRag.{lexicalScoring,lexicalK1,lexicalB}。
// override 非空时直接归一化返回(离线扫描 / A-B 台按参数注入,与本机配置解耦);
// override 为空时读盘,读盘失败一律回落默认档 —— hybridSearchOverIndex 承诺不抛。
// 返回的 mode 已过 resolveLexicalScoringMode,调用方可直接拿它打日志。
export async function resolveWikiRagLexicalConfig(override = null) {
  const pick = (src) => ({
    mode: resolveLexicalScoringMode(src?.mode),
    k1: finiteNumber(src?.k1) ?? DEFAULT_BM25_K1,
    b: finiteNumber(src?.b) ?? DEFAULT_BM25_B,
  });
  if (override && typeof override === "object") return pick(override);
  try {
    const cfg = JSON.parse(await readFile(join(OC, "openclaw.json"), "utf8"));
    const wikiRag = (cfg && cfg.watchdog && typeof cfg.watchdog === "object") ? cfg.watchdog.wikiRag : null;
    return pick({ mode: wikiRag?.lexicalScoring, k1: wikiRag?.lexicalK1, b: wikiRag?.lexicalB });
  } catch {
    return pick(null);
  }
}
```

`finiteNumber`(:57-64)已在本文件内,`?? DEFAULT_*` 保证 k1/b 永远是有限数;
`buildLexicalScorer`(:124-127)还会再做一次范围校验(k1>0、0≤b≤1),两层各司其职。

### 2.3 `lib/knowledge/wiki-rag-search.js`

**(a) 第 10 行之后追加 import**

```js
import { resolveWikiRagLexicalConfig } from "./wiki-rag-lexical.js";
```

**(b) 第 134 行签名**

```js
export async function hybridSearchOverIndex(queryText, index, { topK = 5, asOf = null, embedModel = null, rerank = null, lexicalScoring = null } = {}) {
```

**(c) 第 147-148 行之间插入解析,148 行透传**

```js
  const wide = Math.max(topK * 4, 20); // 宽召回供融合 + 分歧派生
  // 词法档位:显式入参优先(评测台/A-B),否则读 openclaw.json。实测读盘+解析 66 µs/次
  // (15 KB 配置,500 次热态均值),与同一函数里 :153 的 embed 配置读同量级,远低于一次 embed 往返。
  const scoring = await resolveWikiRagLexicalConfig(lexicalScoring);
  const lexical = await searchWikiRagLexical(q, { topK: wide, index: scopedIndex, scoring }); // 词法不需 ollama,总能算
```

### 2.4 `openclaw.json`(可选,默认缺省)

```jsonc
"watchdog": {
  "wikiRag": {
    "lexicalScoring": "existence"   // existence | idf | idf-tf | bm25;缺省 = existence
    // "lexicalK1": 1.2,            // 仅 idf-tf / bm25 档读取
    // "lexicalB": 0.3              // 仅 bm25 档读取
  }
}
```

当前 `openclaw.json` 连顶层 `watchdog` 键都尚未出现(2026-08-11 核实),
既有的 `embedModel` / `rerank` 等开关也都靠各自解析器里的默认常量在跑。
**接线本身零配置改动** —— 键缺省时 `resolveWikiRagLexicalConfig` 回落 `existence`。

---

## 3. 模式从哪里读:同步打分器 vs 异步配置

### 3.1 矛盾的实际形态

`lexicalScoreChunk`(store.js:502)是同步的,配置读取是异步的 —— 但两者**从未处在同一个调用层**:

```
hybridSearchOverIndex   async  ← 配置在这里解析(已有先例::153 embed、:173 rerank)
  searchWikiRagLexical  async  ← 已经是 async 函数(store.js:517),接收解析好的普通对象
    buildLexicalScorer  sync   ← 每查询构造一次,统计遍在此
      scoreOf(chunk)    sync   ← 每块调用一次,纯同步,零 IO
```

所以矛盾在 `.map()` 里才成立,而配置**永远不必进入 `.map()`**:
档位在构造 scorer 时就固化进闭包(`wiki-rag-lexical.js:120` 的 `flags`),
逐块打分退化成一次查表 + 若干次乘法。**零新增 async、零缓存层、零模块级可变状态。**

### 3.2 三个候选来源的取舍

| 来源 | 判定 | 理由 |
|------|------|------|
| **openclaw.json `watchdog.wikiRag.lexicalScoring`** | **采用** | 与 embed / rerank 两个既有开关同一键空间、同一读法、同一 SIGUSR1 生效路径;运维只学一处 |
| per-KB spec(`knowledge-bases.json`) | **暂缓**,接口预留 | 见 §3.3 |
| 环境变量 | **排除** | 网关由 launchd 托管(plist `ai.openclaw.gateway`),改 env 要动 plist 并重启;控制面/仪表盘看不见它;而离线扫描台已经能用函数入参注入档位(`kb-replay.js:157-159` 就是这个形状),环境变量在此处无新增能力 |

### 3.3 per-KB 暂缓的理由与预留接口

memos 与 wiki 的语料密度差一个量级(3642 块 vs 453 块),IDF 的收益量级理应有别 ——
per-KB 档位在**语义上是对的**。暂缓的原因是它今天买不起:

- 需要动 `normalizeKnowledgeBaseSpec`(`knowledge-base-registry.js:55-77`)加字段 + 归一化 + 拒绝非法值;
- 需要 `searchKb`(`knowledge-base.js:61-67`)把 `spec.lexicalScoring` 透传进 `hybridSearchOverIndex`;
- 需要知识库管理 UI 暴露该字段,否则它成了只能手改 JSON 的暗桩;
- 而**在没有任何一档被证明优于 existence 之前,per-KB 提供的是"按库配不同的未认证档位"**。

预留接口已经就位:`hybridSearchOverIndex` 的 `lexicalScoring` 入参优先级高于配置文件,
`searchKb` 未来只需在 :66 处补 `lexicalScoring: spec.lexicalScoring` 一个字段,链路即通,
上游三处(store / lexical / search)零改动。

### 3.4 为什么 `searchWikiRagLexical` 自己不读配置

若它读盘,`node --test tests/*.test.js` 与 `scripts/kb-replay.js` 的结果会随本机
`openclaw.json` 漂移 —— 一个开发者把档位切成 `idf` 之后,评测台跑出的"基线臂"就已经是 idf 了,
而 `kb-replay.js:17-19` 的正确性门(基线臂直接调生产函数)正建立在"基线 = 今天"这个前提上。
把配置读取留在合成入口 `hybridSearchOverIndex`,底层函数保持纯参数驱动,这条前提才成立。

同理排除**模块级配置缓存**:配置热重载走 SIGUSR1,缓存需要自建失效逻辑;
`wiki-rag-store.js:471-473` 已明确"no hidden module state"是本条链路的既定风格;
而实测 66 µs/次的成本,配不上这份复杂度。若日后 profile 显示它进了热点,
再加缓存也只需改 `resolveWikiRagLexicalConfig` 一个函数体。

---

## 4. `.filter((r) => r.score > 0)` 召回闸在 idf 档下的行为

**结论:留存集恒等。idf 档下这道闸删掉的块,与 existence 档下删掉的块,逐块相同。**

### 4.1 证明

对任一候选块 `c` 与任一查询词项 `t`,`buildLexicalScorer` 的贡献是
`contribution(t, c) = base(t, c) × idf(t)`(`wiki-rag-lexical.js:136-149`):

1. **结构权重恒 ≥ 1**:ASCII 命中给 `(词长≥4 ? 3 : 1) + (heading 命中 ? 2 : 0)` ∈ {1,3,5};
   CJK bigram 命中给 `1 + (heading 命中 ? 1 : 0)` ∈ {1,2}。最小值 1(:157、:162)。
2. **IDF 恒 > 0**:`idf(t) = log(1 + max(1,N)/max(1,df_t))`(:103-106)。
   df 在**同一份候选集**上统计(:84-92),故 `df_t ≤ N`,于是 `N/df_t ≥ 1`,
   `idf(t) ≥ log 2 ≈ 0.693`。这正是 :94-102 选这一支而非 `log(N/df)` 或
   `log((N-df+0.5)/(df+0.5))` 的原因 —— 后两者在 `df = N` 时分别归零与转负。
3. 未命中的词项一次乘法都不做(`if (hay.includes(...))` 守卫),贡献恒为 0。

⇒ `score(c) > 0 ⟺ c 至少命中一个词项 ⟺ existence 档的 score(c) > 0`。
两档的留存集是同一个集合,闸对二者的效果完全一致。**误删为零。**

`idf-tf` 与 `bm25` 档同理:饱和因子 `((k1+1)·tf) / (tf + k1·norm)`(:146)中
`tf ≥ 1`(命中即至少一次)、`k1 > 0`(:125 校验)、
`norm = 1 - b + b·(len/avgLen) > 0`(:127 保证 0 ≤ b ≤ 1;命中块的 `hay` 非空故 `len > 0`),
分子分母同为正 ⇒ 因子 > 0 ⇒ 命中即正分。**四档共用同一条留存集恒等结论。**

### 4.2 实测(真实索引,2026-08-11)

在 live 索引上对全部评测查询逐块比对两档的 `score > 0` 留存集:

| 库 | 索引块数 | 计分查询数 | 留存集相异的查询 | 单查询命中块数(min–max,均值) |
|----|---------|-----------|-----------------|------------------------------|
| wiki | 453 | 24 | **0 / 24** | 73 – 300,均值 164.8 |
| memos | 3642 | 81 | **0 / 81** | 163 – 2008,均值 1094.9 |

(memos 的 3 条 `verdictStatus: "undecided"` 例已排除,与 `evaluateWikiRagRecall` 同口径;
把它们算进来时结论一样:0 / 84 相异。)

复现方法(约 30 行):读 `control-plane/{wiki-rag-index,kb-memos-index}.json` →
对 fixture 每条 query 走 `rewriteQuery` + `lexicalTermsForQuery` →
`buildLexicalScorer` 分别取 existence / idf 档 → 比对 `score>0` 的块下标集合。
零 ollama、零写盘。

### 4.3 真正会删东西的是下一行,把话说准

召回闸安全,**但 `.slice(0, topK)`(store.js:532,hybrid 传入 `wide=40`,search.js:147)会换成员**:

- 命中集在两库的**每一条查询**上都远大于 40(wiki 73–300、memos 163–2008,共 105/105 条计分查询),
  即 `.slice` 在每次查询里都在做真实截断;
- 换档后进入 RRF 的这 40 个成员会变:实测 top-40 成员重合度 wiki 23–40/40、memos 14–29/40。

这既是收益来源也是风险来源,量在这里:

| 库 | gold 从词法 top-40 掉出 | gold 新进词法 top-40 | 净 |
|----|----------------------|--------------------|-----|
| wiki | 0 | 1 | +1 / 24 |
| memos | 2 | 9 | +7 / 81 |

**净为正、并非单调** —— memos 有 2 条查询的 gold 被换档挤出了词法候选池。
把这句话写进方案,是为了让"召回闸安全"这个正确结论,
不被读成"换档不会让任何一条查询变差"这个错误结论。

---

## 5. 证据强度怎么写(逐字可复制)

### 5.1 手上的数字

| 库 | 计分例数 n | MRR existence → idf | ΔMRR | Wilcoxon p | rank-biserial | ΔMRR 95%CI | MDE(α=.05, power=.8) | 达标所需 n |
|----|-----------|--------------------|------|-----------|--------------|-----------|---------------------|-----------|
| memos | 81 | 0.3861 → 0.4263 | +0.0402 | 0.0894 | 0.329 | [-0.0090, 0.0912] | 0.0719 | 259(缺 178) |
| wiki | 24 | 0.8090 → 0.8646 | +0.0556 | 0.1250 | 1.000 | [0.0035, 0.1181] | 0.0839 | 55(缺 31) |

**两库的实测效应都小于各自的 MDE** —— 这批尺子的分辨率本来就看不见这么小的差。

两个补充事实(用 `rag-stats.js` 复算得到,写进方案以防被误读):

- **wiki 的 p=0.1250 是精确检验在 n_nonzero=4 时的下限本身**。
  符号秩精确双侧 p 的最小可达值 = `2 × 2^(-n_nonzero)`:n=4 → 0.125,n=5 → 0.0625,n=6 → 0.03125。
  即 wiki 那 24 例里只有 **4 例名次发生了变化**(rank-biserial=1.000 说明这 4 例同向上移),
  在**移动例数 ≥ 6** 之前,wiki 这把尺无论效应多大都够不到 p<0.05。
- **wiki 的 CI 排除 0 而 p=0.125,两者并列出现属于口径差异,而非矛盾**。
  CI 是对均值 ΔRR 的百分位 bootstrap(`rag-stats.js:287-311`),
  其自身备注(:366)已声明:n 小且零膨胀时实际覆盖率低于名义 95%;
  Wilcoxon 是秩检验,小样本下 p 值离散。
  按 `rag-stats.js:8` 的事前约定,**结论以主检验(ΔRR 的 Wilcoxon)为准**,CI 作描述性参考。

### 5.2 代码注释里的标准表述

在 `wiki-rag-lexical.js` 的 `DEFAULT_LEXICAL_SCORING_MODE`(:30)上方,原样写入:

```js
// 默认档为何仍是 existence:idf 档的离线 A/B 在两库上方向一致为正
// (memos ΔMRR +0.0402,n=81,Wilcoxon p=0.0894;wiki ΔMRR +0.0556,n=24,p=0.1250),
// 而两库的 MDE 分别是 0.0719 / 0.0839,**都大于实测效应** —— 这批评测集的分辨率
// 看不见这个量级的差异。当前证据支持的说法是「方向为正、机制成立、统计上待认证」,
// 支持不了「已验证的提升」。翻默认档的条件写在
// extensions/watchdog/docs/rag-idf-wiring-plan.md §5.4。
```

在 `openclaw.json` 的键旁 / 运维文档里,原样写入:

```
lexicalScoring:词法腿打分档。默认 existence = 自 wiki-RAG 上线以来的行为。
idf 档在离线重放中两库方向为正(memos +0.0402 / wiki +0.0556 ΔMRR),
样本量尚未达到统计判定门槛(MDE 0.0719 / 0.0839,均大于实测效应),
故作为可切换档位提供,默认保持 existence。
```

### 5.3 措辞规范

**采用这类写法**(每次给出效应必带 n、检验 p、MDE 三件套):

- 「方向为正、机制成立、当前样本量下待认证」
- 「ΔMRR +0.0402(n=81,p=0.0894,MDE=0.0719)」
- 「离线重放显示 idf 档在 memos 上把 MRR 从 0.3861 抬到 0.4263;该差异小于本评测集的 MDE」

**避开这类写法**(它们把"测不出"说成了"没差别"或"已验证"):

- 「IDF 提升了 4 个点」「实验证明 IDF 更好」「已验证的检索优化」
- 「p=0.089,接近显著」(p 值没有"接近"这个刻度)
- 「两库都是正向 → 可以上了」(两个功效不足的检验并列,不等于一次有功效的检验)
- 「MRR 0.386 → 0.426」这种只给两个数字、省掉 n 与 MDE 的写法

### 5.4 允许翻默认档的条件(满足其一)

1. **降方差路线(推荐)**:fixture 换成分级相关性 + 多 gold,主指标改 nDCG,
   在新尺子上重跑配对检验,主检验 p<0.05 且 rank-biserial 同向;
2. **加样本路线**:memos 计分例数 ≥ 259、wiki ≥ 55,同一配对协议下主检验 p<0.05。

两条路线都额外要求:重跑 §4.3 的候选池探针,gold 进出词法 top-40 的净变化 ≥ 0,
并把"掉出"的具体查询逐条列出来看过。

在此之前,`DEFAULT_LEXICAL_SCORING_MODE` 保持 `"existence"`。

---

## 6. 回滚路径

三级,由轻到重。**任何一级都无需重建索引**(df/avgLen 是查询期算的),回滚即时生效。

| 级别 | 触发场景 | 操作 | 生效方式 |
|------|---------|------|---------|
| **L0 配置回退** | 切档后线上召回变差 | `openclaw.json` 的 `watchdog.wikiRag.lexicalScoring` 改回 `"existence"` 或整键删除 | `pgrep -f "openclaw-gateway" \| xargs kill -USR1`;下一次查询即恢复。零代码改动 |
| **L1 默认值回退** | 默认档被翻成 idf 后需要退回 | `wiki-rag-lexical.js:30` 的 `DEFAULT_LEXICAL_SCORING_MODE` 改回 `"existence"` | 重启网关。所有未显式配置的实例一起退回 |
| **L2 整体拆除** | 判定这条路线整体作废 | 还原 3 个文件 + 删 2 个文件(清单见下) | 重启网关 + 跑 `node --test tests/wiki-rag-*.test.js` |

**L2 清单**(按「不留遗留代码」,拆就拆干净):

- 还原 `wiki-rag-store.js`:恢复 502-513 的 `lexicalScoreChunk`、撤销 517/527 改动、撤销 import;
- 还原 `wiki-rag-search.js`:撤销 import、134 签名、147-148 之间的解析行;
- 删除 `lib/knowledge/wiki-rag-lexical.js`;
- 删除 `tests/wiki-rag-lexical.test.js`、`tests/wiki-rag-lexical-parity.test.js`;
- `scripts/kb-replay.js:106-135` 的 `idfLexicalLeg` 是自带复刻,与本模块无耦合,可独立保留或一并删除。

**回滚的安全性从哪来**:L0/L1 的正确性由 `wiki-rag-lexical-parity.test.js` 保证 ——
它把 existence 档的整行输出冻成字面量,只要这份测试绿,"退回 existence" 就等于"退回今天"。

---

## 7. 接线后需要补的断言

现有 `wiki-rag-lexical-parity.test.js` 的断言在接线前后都成立(选项在接线前被忽略、
接线后回落默认档,两种世界下结论相同),所以它可以先落盘、先跑绿。
接线那一刻再补三条**只在接线后成立**的断言:

1. `searchWikiRagLexical(q, { index, scoring: { mode: "idf" } })` 的名次 =
   `["kb/a.md","kb/d.md","kb/b.md","kb/h.md","kb/c.md","kb/c.md","kb/f.md"]`
   (parity 测试里已用新路参考实现算出并冻结了这一序,接线后把断言目标换成生产函数即可);
2. `resolveWikiRagLexicalConfig(null)` 在 `watchdog.wikiRag` 缺省时返回
   `{ mode: "existence", k1: 1.2, b: 0.3 }`;传入非法档位名(`"constructor"` / `"BM25"` / 数字)时同样回落;
3. `hybridSearchOverIndex(q, index, {})` 与 `hybridSearchOverIndex(q, index, { lexicalScoring: { mode: "existence" } })`
   在合成索引 + 无 ollama(词法-only 降级)下逐字段同结果 —— 证明新增入参没改动默认合成路径。

---

## 8. 明确排除在本次范围之外

- **翻默认档** —— 条件见 §5.4,当前未满足;
- **per-KB 档位** —— 接口预留,落地条件见 §3.3;
- **`b` 参数的取值** —— `DEFAULT_BM25_B = 0.3` 至今未做离线扫描(`wiki-rag-lexical.js:41-42` 已自陈),
  bm25 档默认关,该值仅在有人显式开启时生效;
- **宽集 40 的扩容** —— `kb-replay.js:51-53` 记录了"深度 40 → 85.2% / 深度 200 → 100%"的天花板探测,
  那是与本次正交的另一项改动,合在一起测会得到混合体;
- **分级相关性 + 多 gold 的 fixture 改造** —— 它是 §5.4 路线 1 的前置,属评测集工程,另案。
