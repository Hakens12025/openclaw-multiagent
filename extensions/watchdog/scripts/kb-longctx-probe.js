#!/usr/bin/env node
// scripts/kb-longctx-probe.js — 「检索 grounding vs 整库全塞」的可执行对照实验台。
//
// docs/rag-longcontext-vs-retrieval.md 把这件事算成了一笔账;本脚本把账变成一次能真跑的实验:
// 对 wiki 评测集的同一批问题、同一个模型、同一段指令,只换**喂进去的材料**,把答案并排落盘。
//
// ── 三条臂(材料的唯一差异,其余逐字相同)──────────────────────────────────────
//   retrieval4   今天的生产值:检索 top-4、摘录截 500 字   (operator-knowledge.js:298,316)
//   retrieval12  便宜臂:检索 top-12、摘录截 1200 字        (docs §6)
//   fullwiki     全塞臂:整库 chunk 全量,按 sourcePath 分组、页内保序 (docs §7.1 C 臂)
// 便宜臂是**必要对照**:缺了它,全塞哪怕赢了也分不清赢在「信息更全」还是「信息更多」(docs §6)。
// 只要两条臂时:--arms retrieval4,fullwiki
//
// ── 零 ollama ─────────────────────────────────────────────────────────────
// 检索臂需要向量腿,而向量腿要 embed。本脚本**不调 ollama**:它复用 kb-replay 的向量腿缓存
// (`.replay-cache/wiki.json`,由主控用 `node scripts/kb-replay.js capture wiki` 生成),
// 本地重放 词法腿 + rrfFuse,得到与生产逐字一致的 top-k。缓存与当前索引块数不符时**硬报错**,
// 不静默退化成词法-only —— 那样测的就不是生产这条路了。
//
// 【控制臂 = 生产值的证据】把本文件的重放接上 evaluateWikiRagRecall,24 例实测(2026-08-11):
//   topK=10 → r@1 70.8 / r@3 91.7 / r@5 95.8 / r@10 95.8 / MRR 0.8090 / kwCov 92.0
// 与既有 live 召回评测(docs 附表:wiki r@1 70.8 / r@3 91.7 / r@5 95.8)**逐位一致**。
// 这一位一位的吻合是「retrieval4 臂确实是今天的生产值」的凭据 —— 不是靠注释声称。
// 同一次实测顺带确认 topK=4 时 96 个槽位只覆盖 52 个不同页面(dupSlot 45.8%):
// 生产 grounding 名义 4 条,实际平均只有 2.2 个不同页面。
//
// ── 默认不发请求 ───────────────────────────────────────────────────────────
//   node scripts/kb-longctx-probe.js                      # dry:装配 prompt,打印 token 表,零网络
//   node scripts/kb-longctx-probe.js run --endpoint <url> --model <id> --api-key-env KB_PROBE_API_KEY
//   node scripts/kb-longctx-probe.js score                # 零网络:读答案 → 客观判据 + 配对统计 + 盲评并排
// run 串行、限速(相邻两次真实请求间隔 --sleep-ms,默认 1000)、失败原地重试一次(等 5s 再发)、
// 单题最终失败只记账继续跑;可断点续跑(已有成功答案的 case 自动跳过,--force 重跑);
// API key 只从环境变量读,不落盘不打印。
//
// ── 判据(客观层)与它测不到什么 ─────────────────────────────────────────────
// 平台今天没有答案质量指标(fixture 无 answer 字段,docs §7.2)。本脚本用四个零 LLM、可复算的量:
//   ① goldCitationRank —— 答案自报的 SOURCES 里,期望页排第几(0-indexed,-1=未引用)。
//      主判据。取倒数名次后与召回评测同一把尺(rag-stats 的 Wilcoxon/符号检验/CI/MDE),
//      且**抗散弹**:多列几条来源不会提高名次,只会稀释它。
//   ② keywordCoverage —— fixture 的 expectedKeywords 在答案正文里的覆盖率。
//   ③ unknownCitationRate —— 引用了索引里不存在的路径(编造出处)。
//   ④ insufficientRate / formatCompliantRate —— 是否老实说材料不够、是否守住输出格式。
// 测不到的部分,逐条写在 `docs/` 之外的这里,读结论的人必须先读它:
//   · **正确性**:答对页码但内容说错,四个指标全满分。本脚本不做事实核查。
//   · **跨页综合**:fixture 每题只有一个 gold,题目本身就是「单页能答」的形态;
//     而全塞真正可能赢的正是跨页综合(docs §5)。这块结构性地看不见,需要另建评测集。
//   · **单 gold / pooling bias**:答案引用了同样贴题的另一页 → 记为未命中。0/1 悬崖与高方差照旧,
//     所以 score 一定会把 MDE 打印出来 —— 「没测出差别」与「没有差别」必须分开说。
//   · **keywordCoverage 偏向长材料**:全塞臂手里有十万字可抄,照抄就能提高覆盖率而答案未必更好。
//     它应读作「需要的材料在不在场」,而非「答得好不好」;其上界正是 docs §5 的 4–8%。
//   · **格式遵从是混淆项**:长上下文稀释指令 → SOURCES 段更容易走形,引用类指标随之下降。
//     这是长上下文的真实代价,但机制与「检索选错页」不同,故 formatCompliantRate 单列不合并。
//   · **单次采样**:每个(题×臂)只跑一次,模型随机性直接进入配对差值,本脚本不做重复采样去噪。
//   · **数据外发**:全塞臂会把 61 页内部设计文档整体发给所选端点。端点归属由主控决定。

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeString } from "../lib/core/normalize.js";
import { loadKnowledgeBaseIndex } from "../lib/knowledge/knowledge-base.js";
import { searchWikiRagLexical } from "../lib/knowledge/wiki-rag-store.js";
import { rrfFuse } from "../lib/knowledge/wiki-rag-search.js";
import { countCharClasses, estimateTokenRange, formatInt } from "./kb-token-budget.js";
import { pairedRankReport, wilcoxonSignedRank, bootstrapMeanCI, minimumDetectableEffect } from "../lib/knowledge/rag-stats.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KB_ID = "wiki";

// 与生产逐字对齐的三个常数。改了生产就该红:tests/kb-longctx-probe.test.js 有源码漂移守卫。
const PROD_TOP_K = 4;                                   // operator-knowledge.js:298
const PROD_EXCERPT_CAP = 500;                           // operator-knowledge.js:316
const wideFor = (topK) => Math.max(topK * 4, 20);       // wiki-rag-search.js:147

export const ARMS = Object.freeze({
  retrieval4: Object.freeze({ id: "retrieval4", label: "检索 top-4(生产值)", kind: "retrieval", topK: PROD_TOP_K, excerptCap: PROD_EXCERPT_CAP }),
  retrieval12: Object.freeze({ id: "retrieval12", label: "检索 top-12(便宜臂)", kind: "retrieval", topK: 12, excerptCap: 1200 }),
  fullwiki: Object.freeze({ id: "fullwiki", label: "整库全塞", kind: "full" }),
});
const DEFAULT_ARMS = ["retrieval4", "retrieval12", "fullwiki"];
const BLIND_LABELS = ["甲", "乙", "丙", "丁", "戊"];

// ── 纯函数:材料装配 ────────────────────────────────────────────────────────
// 两条臂共用同一套渲染,页头格式逐字相同 —— 否则「谁更容易引对路径」会被排版差异污染。

export function renderMaterial(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => {
      const body = (Array.isArray(b?.sections) ? b.sections : [])
        .map((s) => {
          const heading = String(s?.heading || "").trim();
          const text = String(s?.text || "").trim();
          return heading ? `## ${heading}\n${text}` : text;
        })
        .filter(Boolean)
        .join("\n\n");
      return `### ${b?.sourcePath || ""}\n${body}`;
    })
    .join("\n\n---\n\n");
}

// 检索结果 → grounding note,形状与 operator-knowledge.js:311-318 的 retrieveGroundingNotes 一致。
export function toGroundingNotes(results, { excerptCap = PROD_EXCERPT_CAP } = {}) {
  return (Array.isArray(results) ? results : []).map((r) => ({
    title: normalizeString(r?.heading) || normalizeString(r?.sourcePath) || "wiki",
    sourcePath: normalizeString(r?.sourcePath),
    excerpt: (normalizeString(r?.text) || "").slice(0, excerptCap),
  }));
}

// 每条 note 单独成块(同一页被召回两段就是两块)—— dupSlot 现象在材料里保持可见,不悄悄合并。
export function notesToBlocks(notes) {
  return (Array.isArray(notes) ? notes : []).map((n) => ({ sourcePath: n?.sourcePath || "", sections: [{ heading: n?.title || "", text: n?.excerpt || "" }] }));
}

// 整库 → 块:按 sourcePath 首次出现的顺序分组,页内保序(chunk 数组序 = 建索引序 = 文件序)。
export function chunksToBlocks(chunks) {
  const pages = new Map();
  for (const c of Array.isArray(chunks) ? chunks : []) {
    const p = c?.sourcePath;
    if (!p) continue;
    if (!pages.has(p)) pages.set(p, []);
    pages.get(p).push({ heading: c?.heading || "", text: c?.text || "" });
  }
  return [...pages.entries()].map(([sourcePath, sections]) => ({ sourcePath, sections }));
}

// ── 纯函数:prompt ─────────────────────────────────────────────────────────
// 材料在前、问题在后:稳定前缀靠前是 prompt caching 的前提(docs §3.3),
// 全塞臂的材料还是**跨 24 题的常量**,所以这条实验顺带验证了缓存前缀的可行性。

export const PROBE_SYSTEM_PROMPT = [
  "你是 OpenClaw 平台的资料问答助手。回答只依据 <材料> 里出现的内容,材料之外的部分留白。",
  "输出恰好两段:",
  "ANSWER: 中文回答,200 字以内。",
  "SOURCES: 材料中最支撑该答案的来源文件路径,按支撑力从强到弱排列,最多 3 条,英文逗号分隔。",
  "材料不足以回答时,ANSWER 以 INSUFFICIENT 开头并说明缺什么,SOURCES 写 NONE。",
].join("\n");

export function buildUserPrompt({ material, question }) {
  return `<材料>\n${material}\n</材料>\n\n<问题>\n${String(question || "").trim()}\n</问题>`;
}

// ── 纯函数:答案解析与打分 ──────────────────────────────────────────────────

export const WIKI_PATH_RE = /wiki\/[A-Za-z0-9_\-./]+\.md/g;

const uniq = (list) => [...new Set(list)];

// 行式解析(而非跨行正则):SOURCES 那一行之前的都算正文,行为对畸形输出可预测、可单测。
// citations 优先取 SOURCES 行;模型没守格式时回退到全文里出现的 wiki 路径 —— 判的是
// 「答案有没有指对页」,不是「有没有守格式」,后者由 formatCompliant 单独记账。
export function parseAnswer(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sourcesIdx = lines.findIndex((l) => /^\s*SOURCES\s*[::]/i.test(l));
  const sourcesRaw = sourcesIdx >= 0 ? lines[sourcesIdx].replace(/^\s*SOURCES\s*[::]\s*/i, "").trim() : null;
  const bodyRaw = (sourcesIdx >= 0 ? lines.slice(0, sourcesIdx) : lines).join("\n").trim();
  const hasAnswerTag = /^\s*ANSWER\s*[::]/i.test(bodyRaw);
  const body = bodyRaw.replace(/^\s*ANSWER\s*[::]\s*/i, "").trim();
  const declared = uniq(sourcesRaw ? sourcesRaw.match(WIKI_PATH_RE) || [] : []);
  const citations = declared.length ? declared : uniq(String(text || "").match(WIKI_PATH_RE) || []);
  return {
    body,
    declaredSources: declared,
    citations,
    formatCompliant: hasAnswerTag && sourcesIdx >= 0,
    insufficient: /^INSUFFICIENT/i.test(body),
  };
}

// 关键词口径与 wiki-rag-eval.js:42 一致(小写子串匹配),差别只在 haystack:
// 那里是召回的 chunk 文本,这里是**答案正文** —— 同一把尺量的是不同的东西,标注见文件头。
export function scoreAnswer({ parsed, expectedSourcePath, expectedKeywords = [], knownPaths = null }) {
  const p = parsed || parseAnswer("");
  const keywords = (Array.isArray(expectedKeywords) ? expectedKeywords : []).filter(Boolean);
  const hay = p.body.toLowerCase();
  const keywordHits = keywords.filter((kw) => hay.includes(String(kw).toLowerCase())).length;
  const known = knownPaths instanceof Set ? knownPaths : null;
  return {
    goldRank: p.citations.indexOf(expectedSourcePath),           // 0-indexed;-1=未引用
    goldCited: p.citations.includes(expectedSourcePath),
    citedCount: p.citations.length,
    unknownCitations: known ? p.citations.filter((c) => !known.has(c)) : [],
    keywordTotal: keywords.length,
    keywordHits,
    keywordCoverage: keywords.length ? keywordHits / keywords.length : null,
    insufficient: p.insufficient,
    formatCompliant: p.formatCompliant,
    answerChars: p.body.length,
  };
}

// 盲评标签:逐例确定性洗牌(同 seed 同结果)。人工比对时先看不带臂名的 compare.md,
// 想对号入座再翻 key.json —— 标签藏起来的目的是让偏好先于立场形成。
// 全程 Math.imul 走 32 位整数运算:换成浮点乘会超过 2^53 而丢精度,洗牌结果就成了「靠舍入决定」,
// 别人拿别的语言复算对不上。整数域里任何人都能独立复现这份洗牌(测试里的期望值正是这样算出来的)。
export function blindOrder(armIds, caseIndex, seed = 20260811) {
  const arr = [...armIds];
  let state = (Math.imul(seed >>> 0, 2654435761) + Math.imul(caseIndex, 40503)) >>> 0;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function tokenEstimate(text) {
  return estimateTokenRange(countCharClasses(text));
}

// ── IO:检索臂的零 ollama 重放 ───────────────────────────────────────────────

// 缓存新鲜度判据(纯函数)。块数不符 = 缓存是对着旧索引抓的,重放出来的 top-k 属于旧世界,
// 拿它当「今天的生产值」是错的。返回 null=新鲜,字符串=该说给人听的整句。
export function cacheStalenessMessage({ cacheChunkCount, indexChunkCount, kbId = KB_ID }) {
  if (cacheChunkCount === indexChunkCount) return null;
  return `向量腿缓存对应 ${cacheChunkCount} 块,当前索引 ${indexChunkCount} 块 —— 缓存重放的是旧世界。`
    + ` 重新跑(需 ollama): node scripts/kb-replay.js capture ${kbId};确要带病继续加 --allow-stale-cache`;
}

async function loadReplayCache(index, { allowStale }) {
  const path = join(ROOT, ".replay-cache", `${KB_ID}.json`);
  const cache = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
  if (!cache) {
    throw new Error(`缺向量腿缓存 ${path}。主控先跑(需 ollama): node scripts/kb-replay.js capture ${KB_ID}`);
  }
  const stale = cacheStalenessMessage({ cacheChunkCount: cache.chunkCount, indexChunkCount: index.chunks.length });
  if (stale) {
    if (!allowStale) throw new Error(stale);
    console.error(`⚠ ${stale}`);
  }
  return { cache, path, stale };
}

// 复现 hybridSearchOverIndex 的默认路径:向量腿(缓存)+ 词法腿(生产函数)→ rrfFuse → slice(topK)。
// rerank 默认关(wiki-rag-search.js:172-177),fixture 无 asOf,故两个分支都不在这条路上。
async function replayRetrieval(index, cacheEntry, topK) {
  const wide = wideFor(topK);
  const vector = cacheEntry.vector.slice(0, wide);
  const lexical = await searchWikiRagLexical(cacheEntry.rewritten, { topK: wide, index });
  return rrfFuse([vector, lexical], { topK: wide }).slice(0, topK);
}

// ── 组装 ──────────────────────────────────────────────────────────────────

async function buildPlan(args) {
  const fixture = JSON.parse(await readFile(join(ROOT, "tests/fixtures", `${KB_ID}-rag-eval-set.json`), "utf8"));
  const cases = fixture.cases.slice(0, args.cases || fixture.cases.length);
  const index = await loadKnowledgeBaseIndex(KB_ID);
  if (!index?.chunks?.length) throw new Error(`kb '${KB_ID}' 索引为空`);

  const needRetrieval = args.arms.some((a) => ARMS[a].kind === "retrieval");
  const { cache, path: cachePath } = needRetrieval
    ? await loadReplayCache(index, { allowStale: args.allowStaleCache })
    : { cache: null, path: null };

  const fullMaterial = renderMaterial(chunksToBlocks(index.chunks));
  const rows = [];
  for (const [i, c] of cases.entries()) {
    const entry = cache ? cache.entries.find((e) => e.query === c.query) : null;
    if (needRetrieval && !entry) throw new Error(`向量腿缓存缺查询: ${c.query}`);
    const perArm = {};
    for (const armId of args.arms) {
      const arm = ARMS[armId];
      let material = fullMaterial;
      let notes = null;
      if (arm.kind === "retrieval") {
        const results = await replayRetrieval(index, entry, arm.topK);
        notes = toGroundingNotes(results, { excerptCap: arm.excerptCap });
        material = renderMaterial(notesToBlocks(notes));
      }
      const userPrompt = buildUserPrompt({ material, question: c.query });
      perArm[armId] = {
        material,
        userPrompt,
        notes,
        materialChars: material.length,
        promptTokensEstimate: tokenEstimate(`${PROBE_SYSTEM_PROMPT}\n${userPrompt}`),
      };
    }
    rows.push({ caseId: `case-${String(i + 1).padStart(2, "0")}`, ...c, perArm });
  }
  return { fixture, cases: rows, index, cachePath, cacheChunkCount: cache?.chunkCount ?? null, fullMaterialChars: fullMaterial.length };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 失败后等一拍再重试:限流/网络抖动场景里立即重发大概率原样再失败。只重试一次 ——
// 持久性错误(如 401)重试也救不回,记进答案文件由断点续跑处理。
const RETRY_BACKOFF_MS = 5000;

// ── LLM 调用(自带 fetch,不复用 callOpenAICompatiblePlanner)──────────────────
// 理由两条,都不是重复造轮子:① 生产那个函数丢掉 usage(llm-planner.js:158-167,docs §8.1),
// 而本实验的核心记账之一就是 prompt_tokens;② 它强制把回包按 JSON plan 解析,本实验要的是自然语言答案。
async function callChat({ endpoint, model, apiKey, systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  const url = new URL("chat/completions", endpoint.endsWith("/") ? endpoint : `${endpoint}/`).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `http ${response.status}`);
    const content = payload?.choices?.[0]?.message?.content;
    return {
      text: typeof content === "string" ? content : JSON.stringify(content ?? ""),
      usage: payload?.usage || null,
      wallClockMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 命令 ──────────────────────────────────────────────────────────────────

async function cmdDry(args) {
  const plan = await buildPlan(args);
  await mkdir(args.out, { recursive: true });
  const manifest = {
    // args 里只有 API key 的**环境变量名**,key 本体从头到尾只存在于 cmdRun 的局部变量与请求头。
    kbId: KB_ID, generatedAt: new Date().toISOString(), args,
    indexChunks: plan.index.chunks.length, indexModel: plan.index.model,
    cachePath: plan.cachePath, cacheChunkCount: plan.cacheChunkCount,
    fullMaterialChars: plan.fullMaterialChars,
    arms: args.arms.map((a) => ARMS[a]),
    cases: plan.cases.map((c) => ({
      caseId: c.caseId, query: c.query, expectedSourcePath: c.expectedSourcePath,
      perArm: Object.fromEntries(args.arms.map((a) => [a, {
        materialChars: c.perArm[a].materialChars,
        promptChars: c.perArm[a].userPrompt.length,
        promptTokensEstimate: c.perArm[a].promptTokensEstimate,
        citablePaths: uniq((c.perArm[a].material.match(WIKI_PATH_RE) || [])).length,
      }])),
    })),
  };
  await writeFile(join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const armId of args.arms) {
    await writeFile(join(args.out, `sample-${armId}.txt`), `[system]\n${PROBE_SYSTEM_PROMPT}\n\n[user]\n${plan.cases[0].perArm[armId].userPrompt}`, "utf8");
  }

  console.log(`# dry-run(零网络)| ${plan.cases.length} 题 × ${args.arms.length} 臂 = ${plan.cases.length * args.arms.length} 次调用`);
  console.log(`# 索引 ${plan.index.chunks.length} 块 / 全塞材料 ${formatInt(plan.fullMaterialChars)} 字`);
  console.log("\n臂            材料(平均字)  prompt token 估算(low~high,中位)   全批中位档合计   可引用路径数");
  for (const armId of args.arms) {
    const per = plan.cases.map((c) => c.perArm[armId]);
    const avgChars = Math.round(per.reduce((s, x) => s + x.materialChars, 0) / per.length);
    const mid = per.reduce((s, x) => s + x.promptTokensEstimate.mid, 0);
    const one = per[0].promptTokensEstimate;
    const citable = uniq(per[0].material.match(WIKI_PATH_RE) || []).length;
    console.log(`${armId.padEnd(13)} ${String(formatInt(avgChars)).padStart(10)}   ${`${formatInt(one.low)}~${formatInt(one.high)}`.padStart(17)} (${formatInt(one.mid)})   ${String(formatInt(mid)).padStart(12)}   ${String(citable).padStart(8)}`);
  }
  console.log(`\nprompt 样本(第 1 题全文)→ ${args.out}/sample-<arm>.txt;清单 → ${args.out}/manifest.json`);
  console.log("token 为字符分类加权估算(口径见 scripts/kb-token-budget.js 文件头);run 会记录回包 usage 的实测值。");
  console.log(`真发: node scripts/kb-longctx-probe.js run --endpoint <baseUrl> --model <id> --api-key-env ${args.apiKeyEnv}`);
}

async function cmdRun(args) {
  const apiKey = process.env[args.apiKeyEnv];
  if (!args.endpoint || !args.model) throw new Error("run 需要 --endpoint 与 --model");
  if (!apiKey) throw new Error(`环境变量 ${args.apiKeyEnv} 为空:export ${args.apiKeyEnv}=<key> 后重试`);
  const plan = await buildPlan(args);
  const answersDir = join(args.out, "answers");
  await mkdir(answersDir, { recursive: true });

  let done = 0;
  let skipped = 0;
  let sentAny = false;
  for (const c of plan.cases) {
    for (const armId of args.arms) {
      const file = join(answersDir, `${c.caseId}.${armId}.json`);
      // 断点续跑只跳**成功**的记录:上一轮因超时/限流失败的例子必须重试,否则一次网络抖动
      // 会被永久固化成一条"答错",而长上下文臂恰恰更容易超时 —— 那是偏向基线臂的系统性污染。
      const prior = await readFile(file, "utf8").then((t) => JSON.parse(t), () => null);
      if (!args.force && prior && !prior.error) { skipped += 1; continue; }
      const record = {
        caseId: c.caseId, arm: armId, query: c.query, expectedSourcePath: c.expectedSourcePath,
        expectedKeywords: c.expectedKeywords || [], model: args.model, endpoint: args.endpoint,
        promptTokensEstimate: c.perArm[armId].promptTokensEstimate, materialChars: c.perArm[armId].materialChars,
      };
      // 限速:相邻两次真实请求之间隔 sleepMs(跳过的记录零成本,故只在真发过之后计拍)。
      if (sentAny && args.sleepMs > 0) await sleep(args.sleepMs);
      sentAny = true;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          const res = await callChat({
            endpoint: args.endpoint, model: args.model, apiKey,
            systemPrompt: PROBE_SYSTEM_PROMPT, userPrompt: c.perArm[armId].userPrompt,
            maxTokens: args.maxTokens, timeoutMs: args.timeoutMs,
          });
          Object.assign(record, { text: res.text, usage: res.usage, wallClockMs: res.wallClockMs, error: null, attempts });
          break;
        } catch (err) {
          if (attempts === 1) {
            process.stderr.write("r");
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          Object.assign(record, { text: "", usage: null, wallClockMs: null, error: String(err?.message || err), attempts });
          break;
        }
      }
      await writeFile(file, JSON.stringify(record, null, 2), "utf8");
      done += 1;
      process.stderr.write(record.error ? "x" : ".");
    }
  }
  console.error(`\n完成 ${done} 次调用(跳过已有 ${skipped} 次;进度符:.成功 r重试 x最终失败)→ ${answersDir}`);
  await cmdScore(args);
}

async function cmdScore(args) {
  const answersDir = join(args.out, "answers");
  const files = (await readdir(answersDir).catch(() => [])).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error(`${answersDir} 没有答案文件;先跑 run`);
  const index = await loadKnowledgeBaseIndex(KB_ID);
  const knownPaths = new Set(index.chunks.map((c) => c.sourcePath));

  const byCase = new Map();
  for (const f of files) {
    const rec = JSON.parse(await readFile(join(answersDir, f), "utf8"));
    if (!byCase.has(rec.caseId)) byCase.set(rec.caseId, { caseId: rec.caseId, query: rec.query, expectedSourcePath: rec.expectedSourcePath, arms: {} });
    const parsed = parseAnswer(rec.text);
    byCase.get(rec.caseId).arms[rec.arm] = {
      ...rec, parsed,
      score: scoreAnswer({ parsed, expectedSourcePath: rec.expectedSourcePath, expectedKeywords: rec.expectedKeywords, knownPaths }),
    };
  }
  const cases = [...byCase.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const armIds = args.arms.filter((a) => cases.some((c) => c.arms[a]));
  if (armIds.length === 0) throw new Error(`${answersDir} 里没有 --arms(${args.arms.join(",")})的答案;用 --arms 指定该目录实际跑过的臂`);

  const base = armIds[0];
  const aggregate = Object.fromEntries(armIds.map((a) => [a, aggregateArm(cases.map((c) => c.arms[a]).filter(Boolean))]));
  const paired = Object.fromEntries(armIds.slice(1).map((a) => [a, pairArms(cases, base, a)]));
  const { markdown, key } = renderBlindCompare(cases, armIds, args.seed);

  await writeFile(join(args.out, "compare.md"), markdown, "utf8");
  await writeFile(join(args.out, "key.json"), JSON.stringify(key, null, 2), "utf8");
  await writeFile(join(args.out, "scores.json"), JSON.stringify({
    kbId: KB_ID, base, arms: armIds, aggregate, paired,
    perCase: cases.map((c) => ({
      caseId: c.caseId, query: c.query, expectedSourcePath: c.expectedSourcePath,
      arms: Object.fromEntries(armIds.filter((a) => c.arms[a]).map((a) => [a, {
        score: c.arms[a].score, citations: c.arms[a].parsed.citations,
        usage: c.arms[a].usage, wallClockMs: c.arms[a].wallClockMs, error: c.arms[a].error,
      }])),
    })),
  }, null, 2), "utf8");

  const text = renderScoreReport({ caseCount: cases.length, base, armIds, aggregate, paired });
  await writeFile(join(args.out, "scores.txt"), `${text}\n`, "utf8");
  console.log(text);
  console.log(`\n落盘 → ${args.out}/{compare.md,key.json,scores.json,scores.txt}`);
}

// ── 纯函数:聚合、配对、渲染 ────────────────────────────────────────────────

const mean = (list) => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null);
const rate = (rows, pred) => (rows.length ? rows.filter(pred).length / rows.length : null);
const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const num = (x, d) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(d));

// 一条臂的聚合。调用失败的例子排除在各率之外、单独计 errors —— 把「模型答错」和「请求没成功」
// 混进同一个分母,长上下文臂会因为更容易超时而白白背锅。
export function aggregateArm(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const scored = all.filter((r) => !r.error);
  const kw = scored.map((r) => r.score.keywordCoverage).filter((x) => x != null);
  return {
    n: all.length,
    errors: all.length - scored.length,
    goldCitedRate: rate(scored, (r) => r.score.goldCited),
    goldCitedAt1Rate: rate(scored, (r) => r.score.goldRank === 0),
    citationMrr: mean(scored.map((r) => (r.score.goldRank >= 0 ? 1 / (r.score.goldRank + 1) : 0))),
    meanCitedCount: mean(scored.map((r) => r.score.citedCount)),
    unknownCitationRate: rate(scored, (r) => r.score.unknownCitations.length > 0),
    keywordCoverage: kw.length ? mean(kw) : null,
    insufficientRate: rate(scored, (r) => r.score.insufficient),
    formatCompliantRate: rate(scored, (r) => r.score.formatCompliant),
    meanAnswerChars: mean(scored.map((r) => r.score.answerChars)),
    meanPromptTokens: mean(scored.map((r) => r.usage?.prompt_tokens).filter(Number.isFinite)),
    meanWallClockMs: mean(scored.map((r) => r.wallClockMs).filter(Number.isFinite)),
  };
}

// 逐例配对:引用名次直接喂 pairedRankReport —— 它的 rank 口径(0-indexed、-1=未命中)与
// scoreAnswer.goldRank 逐字相同,所以召回评测那把尺原样复用,不另造一把。
// 只取两臂都成功的例子:一边失败的例子配不成对,强行计入等于拿空答案当"答错"。
export function pairArms(cases, baseArm, variantArm) {
  const usable = (Array.isArray(cases) ? cases : []).filter((c) =>
    c.arms[baseArm] && c.arms[variantArm] && !c.arms[baseArm].error && !c.arms[variantArm].error);
  const citation = pairedRankReport(usable.map((c) => ({
    rankA: c.arms[baseArm].score.goldRank, rankB: c.arms[variantArm].score.goldRank, scored: true,
  })));
  const kwDeltas = usable
    .filter((c) => c.arms[baseArm].score.keywordCoverage != null && c.arms[variantArm].score.keywordCoverage != null)
    .map((c) => c.arms[variantArm].score.keywordCoverage - c.arms[baseArm].score.keywordCoverage);
  return {
    vs: baseArm,
    n: usable.length,
    citation,
    keyword: { n: kwDeltas.length, mean: mean(kwDeltas), wilcoxon: wilcoxonSignedRank(kwDeltas), ci: bootstrapMeanCI(kwDeltas), mde: minimumDetectableEffect(kwDeltas) },
  };
}

// 盲评并排:臂名换成甲/乙/丙,每题独立洗牌。人工先在不知道谁是谁的情况下形成偏好,再翻 key.json。
export function renderBlindCompare(cases, armIds, seed) {
  const key = {};
  const lines = [`# 盲评并排:${KB_ID} 长上下文 vs 检索`, "", `臂标签每题独立洗牌(seed=${seed});对号入座见 key.json。`, ""];
  for (const [i, c] of (Array.isArray(cases) ? cases : []).entries()) {
    const order = blindOrder(armIds, i, seed);
    key[c.caseId] = Object.fromEntries(order.map((a, k) => [BLIND_LABELS[k], a]));
    lines.push(`## ${c.caseId} ${c.query}`, "", `期望来源:\`${c.expectedSourcePath}\``, "");
    for (const [k, armId] of order.entries()) {
      const row = c.arms[armId];
      lines.push(`### ${BLIND_LABELS[k]}`, "", row?.error ? `调用失败:${row.error}` : `\`\`\`\n${String(row?.text || "").trim()}\n\`\`\``, "");
    }
    lines.push("---", "");
  }
  return { markdown: lines.join("\n"), key };
}

export function renderScoreReport({ caseCount, base, armIds, aggregate, paired }) {
  const lines = [
    `# ${KB_ID} 长上下文对照 | ${caseCount} 题 | 基线臂 ${base}`,
    "",
    "臂            n  err  引用命中  引用@1   引用MRR  每答引用数  编造出处  关键词覆盖  说不足  守格式  答案字数  实测promptTok  墙钟ms",
  ];
  for (const armId of armIds) {
    const a = aggregate[armId];
    lines.push([
      armId.padEnd(13), String(a.n).padStart(2), String(a.errors).padStart(4),
      pct(a.goldCitedRate).padStart(9), pct(a.goldCitedAt1Rate).padStart(7), num(a.citationMrr, 4).padStart(8),
      num(a.meanCitedCount, 2).padStart(11), pct(a.unknownCitationRate).padStart(9), pct(a.keywordCoverage).padStart(11),
      pct(a.insufficientRate).padStart(7), pct(a.formatCompliantRate).padStart(7),
      num(a.meanAnswerChars, 0).padStart(9), num(a.meanPromptTokens, 0).padStart(14), num(a.meanWallClockMs, 0).padStart(8),
    ].join(" "));
  }
  for (const [armId, p] of Object.entries(paired)) {
    const cit = p.citation;
    lines.push("", `## ${armId} vs ${p.vs}(逐例配对,n=${p.n})`);
    lines.push(`  引用MRR ${num(cit.mrrBefore, 4)} → ${num(cit.mrrAfter, 4)} (Δ${cit.deltaMrr >= 0 ? "+" : ""}${num(cit.deltaMrr, 4)})`);
    lines.push(`    Wilcoxon p=${num(cit.wilcoxon.p, 4)} [${cit.wilcoxon.method}] | 符号检验 p=${num(cit.sign.p, 4)} | rank-biserial=${num(cit.effect.rankBiserial, 3)}`);
    lines.push(`    95%CI [${num(cit.ci.lower, 4)}, ${num(cit.ci.upper, 4)}] | MDE(这批样本能检出的最小 Δ)=${num(cit.mde.mde, 4)}`);
    lines.push(`  关键词覆盖 Δ=${num(p.keyword.mean, 4)}  Wilcoxon p=${num(p.keyword.wilcoxon.p, 4)} | 95%CI [${num(p.keyword.ci.lower, 4)}, ${num(p.keyword.ci.upper, 4)}] | MDE=${num(p.keyword.mde.mde, 4)}`);
    if (cit.mde.mde != null && Math.abs(cit.deltaMrr) < cit.mde.mde) {
      lines.push("  ⚠ |Δ| < MDE:这批样本量下该效应本就检不出,p 值不显著读作「测不出」而非「没差别」。");
    }
  }
  lines.push("", "判据能测到什么、测不到什么:见 scripts/kb-longctx-probe.js 文件头。人工比对读 compare.md(盲标签)。");
  return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    cmd: "dry", arms: DEFAULT_ARMS, out: join(ROOT, "research-lab", "kb-longctx-probe"),
    endpoint: null, model: null, apiKeyEnv: "KB_PROBE_API_KEY",
    cases: 0, seed: 20260811, maxTokens: 1024, timeoutMs: 180000,
    sleepMs: 1000, allowStaleCache: false, force: false,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("--")) args.cmd = rest.shift();
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const next = () => rest[++i];
    if (a === "--arms") args.arms = String(next() || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") args.out = next();
    else if (a === "--endpoint") args.endpoint = next();
    else if (a === "--model") args.model = next();
    else if (a === "--api-key-env") args.apiKeyEnv = next();
    else if (a === "--cases") args.cases = Number(next()) || 0;
    else if (a === "--seed") args.seed = Number(next()) || args.seed;
    else if (a === "--max-tokens") args.maxTokens = Number(next()) || args.maxTokens;
    else if (a === "--timeout-ms") args.timeoutMs = Number(next()) || args.timeoutMs;
    // 0 是合法值(关掉限速),所以显式判 finite 而非用 || 兜底 —— || 会把 0 吞成默认值。
    else if (a === "--sleep-ms") { const v = Number(next()); if (Number.isFinite(v) && v >= 0) args.sleepMs = v; }
    else if (a === "--allow-stale-cache") args.allowStaleCache = true;
    else if (a === "--force") args.force = true;
    else throw new Error(`未知参数: ${a}`);
  }
  const unknownArm = args.arms.find((x) => !ARMS[x]);
  if (unknownArm) throw new Error(`未知臂 '${unknownArm}';可选: ${Object.keys(ARMS).join(", ")}`);
  if (args.arms.length === 0) throw new Error("--arms 至少一条");
  if (!["dry", "run", "score"].includes(args.cmd)) throw new Error(`未知命令 '${args.cmd}';可选: dry | run | score`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "dry") await cmdDry(args);
  else if (args.cmd === "run") await cmdRun(args);
  else await cmdScore(args);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  await main().catch((err) => { console.error(`✖ ${err.message}`); process.exit(1); });
}
