// lib/knowledge/wiki-rag-lexical.js — 词法腿的打分内核(打分部分纯函数、零 ollama)。
// 文件末尾另有一段配置解析(只读 openclaw.json),与 wiki-rag-rerank.js:18-30 同形:
// 打分档位的默认常量与它的配置键放在同一个文件里,读结论的人一处看全。
//
// 单一职责:把「查询词项 + 候选块集合」变成一个 (chunk) => score 的分值函数。
// 分词归 lexicalTermsForQuery(wiki-rag-store.js:492),排序/切片/召回闸仍归
// searchWikiRagLexical(wiki-rag-store.js:507)。本模块只管"一个块值多少分"。
//
// 四档打分模式,逐级叠加一个 BM25 部件(便于消融归因):
//   existence  今天的行为:命中即计结构权重(**默认**,= 接线前 lexicalScoreChunk 的逐字节
//              行为,由 tests/wiki-rag-lexical-parity.test.js 的冻结锚点 EXPECTED_ROWS 钉住)
//   idf        结构权重 × IDF
//   idf-tf     结构权重 × IDF × 词频饱和
//   bm25       结构权重 × IDF × 词频饱和(含长度归一)
//
// 结构权重保持今天的形状:ASCII 命中 (词长≥4 ? 3 : 1) + (命中 heading ? 2 : 0);
// CJK bigram 命中 1 + (命中 heading ? 1 : 0)。IDF/TF 只当**乘子**叠上去,
// 这样 A/B 量到的 delta 归因于 IDF/TF 本身,而非顺手改掉的结构权重(测的会是混合体)。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "../state.js";

// 模式表 = 部件开关的声明式真值,新增模式只在这里加一行,打分主循环保持一条路径。
// Object.create(null) + Object.hasOwn 双保险:配置里写 "constructor"/"__proto__" 时,
// 原型成员会被当成合法档位取到 → 解构得 undefined → 分值 NaN → 全部被
// searchWikiRagLexical(wiki-rag-store.js:524)的 `.filter(score > 0)` 召回闸滤掉 → 词法腿静默返空。
// 同一防线在 lib/security/execution-policy-defaults.js:44 已有先例,沿用同一写法。
const LEXICAL_SCORING = Object.freeze(Object.assign(Object.create(null), {
  existence: Object.freeze({ idf: false, tf: false, lengthNorm: false }),
  idf: Object.freeze({ idf: true, tf: false, lengthNorm: false }),
  "idf-tf": Object.freeze({ idf: true, tf: true, lengthNorm: false }),
  bm25: Object.freeze({ idf: true, tf: true, lengthNorm: true }),
}));

export const LEXICAL_SCORING_MODES = LEXICAL_SCORING;

// 默认档为何仍是 existence:idf 档的离线 A/B 在两库上方向一致为正
// (memos ΔMRR +0.0402,n=81,Wilcoxon p=0.0894;wiki ΔMRR +0.0556,n=24,p=0.1250),
// 而两库的 MDE 分别是 0.0719 / 0.0839,**都大于实测效应** —— 这批评测集的分辨率
// 看不见这个量级的差异。当前证据支持的说法是「方向为正、机制成立、统计未认证」,
// 支持不了「已验证的提升」。翻默认档的条件写在
// extensions/watchdog/docs/rag-idf-wiring-plan.md §5.4。
export const DEFAULT_LEXICAL_SCORING_MODE = "existence";

// k1 = 词频饱和速度。默认 1.2(BM25 常用档)。本语料下它影响很小:chunk 文本中位数 142 字符,
// 同一词项 tf 绝大多数为 1,而 tf=1 时饱和因子恒为 1 → idf-tf 在单次命中上与 idf 逐位相同,
// k1 只在"同词多次出现"的块上才起作用。
export const DEFAULT_BM25_K1 = 1.2;

// b = 长度归一强度(0 = 不归一,1 = 完全按长度比压)。默认 0.3,依据本语料长度分布,而非照抄 0.75:
// chunk 文本中位数 142 字符,切分上限 1200 字符(wiki-rag-store.js:21),长块基本都是
// "段落打包到上限"的密集正文而不是注水;b=0.75 会按接近 8 倍的 len/avgLen 比例压它们,
// 把只有一句话的短块顶到前面。0.3 保留"过长略降权"的方向、幅度取约四成。
// 诚实标注:b 尚未做离线扫描(scripts/kb-replay.js 目前只扫 existence / idf 两臂),
// 所以它是**待扫参数**而非结论;bm25 档默认关,这个默认值只在有人显式开启时才生效。
export const DEFAULT_BM25_B = 0.3;

// 合法档位 → 原样返回;缺省 / 未知 / 原型成员名 → 回落默认档(= 今天的行为)。
// 选"回落"而不是"抛错":hybridSearchOverIndex(wiki-rag-search.js:135)承诺不抛,
// 配置写错时降级到已验证的旧行为,比让词法腿整条消失安全得多。
// 接线侧可以调它拿到真正生效的档位名去打日志。
export function resolveLexicalScoringMode(mode) {
  return (typeof mode === "string" && Object.hasOwn(LEXICAL_SCORING, mode))
    ? mode
    : DEFAULT_LEXICAL_SCORING_MODE;
}

// 配置里来的数字可能是字符串/null/NaN。落到 k1、b 上会一路变成 NaN 分值,
// 同样被召回闸吃掉,所以这里显式判定,取不到就用默认值。
function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const hayOf = (chunk) => `${chunk?.text || ""} ${chunk?.heading || ""}`.toLowerCase();

// 非重叠子串计数。与命中判定 hay.includes(term) 用同一套子串语义(整词边界不参与),
// 读作"提了几次"。重叠计数会把 CJK 叠字放大(「啊啊啊啊」对 bigram「啊啊」记 3 次而非 2 次)。
function countOccurrences(hay, term) {
  if (!term) return 0;
  let count = 0;
  let at = hay.indexOf(term);
  while (at !== -1) {
    count += 1;
    at = hay.indexOf(term, at + term.length);
  }
  return count;
}

// 查询期统计:df 与平均块长各扫一遍候选集。df 留在查询期算而不预存进索引,原因有二:
// ① 索引里加字段 = 结构变更 = 全量重嵌,换来的只是省掉一次纯字符串扫描;
// ② asOf 点时过滤(wiki-rag-search.js:140)之后候选集会变小,预存的全库 df 对子集是错的。
function corpusStats(chunks, terms) {
  const list = Array.isArray(chunks) ? chunks : [];
  const df = new Map(terms.map((term) => [term, 0]));
  let totalLen = 0;
  for (const chunk of list) {
    const hay = hayOf(chunk);
    totalLen += hay.length;
    for (const term of terms) if (hay.includes(term)) df.set(term, df.get(term) + 1);
  }
  const count = list.length;
  // IDF = log(1 + N/df),**严格为正**。为什么是这一支:召回闸 `.filter(score > 0)` 会删掉零分及负分块,
  // 而 log(N/df) 在 df=N 时恰好归零;经典 log((N-df+0.5)/(df+0.5)) 在 df=N 时为负(452 块语料约 -6.8,
  // 命中反成惩罚);常见的 +1 平滑式 log(1+(N-df+0.5)/(df+0.5)) 在 df=N 时约 1.1e-3(452 块)、
  // 1.4e-4(3642 块),形式上为正而实质等于把词删掉。三者都会把"全库共有词"从召回里抹去 ——
  // 本语料里 CJK bigram 高频往往只是中文构词密度高,仍带信息。
  // log(1+N/df) 在 df=N 时保底 log2≈0.693,单调性保留而召回闸放行。
  // 小语料平滑取 **df 下限 1**(而非加性平滑):这样对非空候选集,本式与 scripts/kb-replay.js:111
  // 的离线实测臂逐字相同,那一轮"两库全指标正向"的结论可以原样迁移到本实现。
  // N 同样取下限 1:候选集为空(调用方传错集合)时 idf 仍是 log2 而不是 0,免得整条腿静默清零。
  const idf = new Map(terms.map((term) => [
    term,
    Math.log(1 + Math.max(1, count) / Math.max(1, df.get(term))),
  ]));
  return { count, df, idf, avgLen: count > 0 ? totalLen / count : 0 };
}

/**
 * 构造词法分值函数。
 *
 * @param {{asciiTokens?: string[], cjkBigrams?: string[]}} terms lexicalTermsForQuery 的产物
 * @param {Array<{text?: string, heading?: string}>} chunks 本次查询的**候选集**(与将被打分的集合同一份:
 *        asOf 过滤后要传过滤后的那份,df 才对得上)。existence 档不读它。
 * @param {{mode?: string, k1?: number, b?: number}} [options]
 * @returns {(chunk: {text?: string, heading?: string}) => number} 分值函数(同步、无副作用)
 */
export function buildLexicalScorer(terms, chunks, { mode, k1, b } = {}) {
  const flags = LEXICAL_SCORING[resolveLexicalScoringMode(mode)];
  const asciiTokens = Array.isArray(terms?.asciiTokens) ? terms.asciiTokens : [];
  const cjkBigrams = Array.isArray(terms?.cjkBigrams) ? terms.cjkBigrams : [];

  const rawK1 = finiteNumber(k1);
  const saturation = rawK1 !== null && rawK1 > 0 ? rawK1 : DEFAULT_BM25_K1;
  const rawB = finiteNumber(b);
  const lengthPull = rawB !== null && rawB >= 0 && rawB <= 1 ? rawB : DEFAULT_BM25_B;

  // existence 档跳过统计遍:开销与今天完全一致,同时排除了统计遍影响结果的可能。
  const stats = (flags.idf || flags.lengthNorm)
    ? corpusStats(chunks, [...asciiTokens, ...cjkBigrams])
    : null;

  // 每个命中词项的贡献 = 结构权重 × 可选乘子。existence 档一次乘法也不做,
  // 累加的整数序列与接线前的 lexicalScoreChunk 逐位相同(parity 测试冻结锚点钉住)。
  const contributionOf = (term, base, hay) => {
    let weight = base;
    if (flags.idf) weight *= stats.idf.get(term);
    if (flags.tf) {
      // 块长按 hay 的字符数算(与 df 用同一份 hay 定义)。字符而非 token:本语料 CJK 占多数,
      // token 数在中文上没有意义,而 142 字符中位数这类分布统计本来就是按字符量的。
      const norm = flags.lengthNorm && stats.avgLen > 0
        ? (1 - lengthPull + lengthPull * (hay.length / stats.avgLen))
        : 1;
      const tf = countOccurrences(hay, term);
      weight *= ((saturation + 1) * tf) / (tf + saturation * norm);
    }
    return weight;
  };

  return (chunk) => {
    const hay = hayOf(chunk);
    const head = String(chunk?.heading || "").toLowerCase();
    let score = 0;
    for (const token of asciiTokens) {
      if (hay.includes(token)) {
        score += contributionOf(token, (token.length >= 4 ? 3 : 1) + (head.includes(token) ? 2 : 0), hay);
      }
    }
    for (const bigram of cjkBigrams) {
      if (hay.includes(bigram)) {
        score += contributionOf(bigram, 1 + (head.includes(bigram) ? 1 : 0), hay);
      }
    }
    return score;
  };
}

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
  // 字符串速记 = {mode: 字符串}。此前字符串会静默落到读盘配置:调用方写 lexicalScoring:"idf"
  // 时意图明明是显式指定,实效却随 openclaw.json 漂 —— 同一探针在配置翻转前后给出相反结论
  // (本机实测踩过两次)。速记收窄这个坑;非法字符串仍由 resolveLexicalScoringMode 回落默认档。
  if (typeof override === "string" && override.trim()) return pick({ mode: override });
  try {
    const cfg = JSON.parse(await readFile(join(OC, "openclaw.json"), "utf8"));
    const wikiRag = (cfg && cfg.watchdog && typeof cfg.watchdog === "object") ? cfg.watchdog.wikiRag : null;
    return pick({ mode: wikiRag?.lexicalScoring, k1: wikiRag?.lexicalK1, b: wikiRag?.lexicalB });
  } catch {
    return pick(null);
  }
}
