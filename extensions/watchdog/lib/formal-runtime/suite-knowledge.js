// lib/formal-runtime/suite-knowledge.js — 知识库召回套件（EMBED 门控）
//
// 门控：先用 wiki-rag 实际使用的 embed 配置探测 ollama（resolveWikiRagEmbedConfig + embedText）——
// 不可达 → 全部 check 记 skip E-KNOWLEDGE-SKIP（外部前置条件缺失，不是失败）。
// 可达 → ① inspect.knowledge_bases（HTTP 零旁路面）wiki 库存在且有 chunk
//        ② inspect.knowledge_search 已知良查询命中期望 sourcePath（评测集稳定用例）
//        ③ 同响应 degraded 不得为 true（embed 在线时不许降级）
//        ④ 24 例评测集 live recall 地板（与 tests/wiki-rag-recall.test.js 完全同源：
//           recall@10>=0.85 / recall@5>=0.65 / MRR>=0.5）。

import { readFile } from "node:fs/promises";

import { markBlocked, runCheck } from "./checks/check-runner.js";
import { gatewayGetJson } from "./checks/check-http.js";
import { loadConfig } from "./infra.js";
import { embedText, resolveWikiRagEmbedConfig } from "../knowledge/wiki-rag-embed.js";
import { searchWiki } from "../knowledge/wiki-rag-search.js";
import { evaluateWikiRagRecall } from "../knowledge/wiki-rag-eval.js";

// 与 tests/wiki-rag-recall.test.js 的回归地板逐字一致（那里是 gate 真值；改地板须两处同步）。
export const KNOWLEDGE_RECALL_FLOORS = Object.freeze({ recallAt10: 0.85, recallAt5: 0.65, mrr: 0.5 });

// 已知良查询的期望页：harness 概念页（独特术语多，hybrid 基线下稳定 top 命中）。
export const KNOWN_GOOD_SOURCE_PATH = "wiki/concepts/harness.md";

const FIXTURE_URL = new URL("../../tests/fixtures/wiki-rag-eval-set.json", import.meta.url);

export const KNOWLEDGE_CHECK_DESCRIPTORS = Object.freeze([
  Object.freeze({ id: "knowledge.embed-probe", subsystem: "knowledge", title: "Embedding endpoint reachable (wiki-rag config)" }),
  Object.freeze({ id: "knowledge.kb-registry", subsystem: "knowledge", title: "Wiki knowledge base registered with chunks" }),
  Object.freeze({ id: "knowledge.search-known-good", subsystem: "knowledge", title: "Known-good query hits expected sourcePath" }),
  Object.freeze({ id: "knowledge.search-not-degraded", subsystem: "knowledge", title: "Search not degraded while embeddings are up" }),
  Object.freeze({ id: "knowledge.recall-floors", subsystem: "knowledge", title: "Live recall floors over the 24-case eval set" }),
]);

// 纯函数：ollama 不可达时给全部 check 产 skip 结果（单测直接验）。
export function buildKnowledgeSkipChecks(reason) {
  return KNOWLEDGE_CHECK_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    status: "skip",
    code: "E-KNOWLEDGE-SKIP",
    evidence: `ollama embeddings unavailable: ${reason}`,
    durationMs: 0,
  }));
}

// 纯函数：评测结果 vs 地板（单测喂 canned 结果）。
export function evaluateRecallFloors(result, floors = KNOWLEDGE_RECALL_FLOORS) {
  const recallAt10 = Number(result?.recallAt?.[10] ?? 0);
  const recallAt5 = Number(result?.recallAt?.[5] ?? 0);
  const mrr = Number(result?.mrr ?? 0);
  const breaches = [];
  if (!(recallAt10 >= floors.recallAt10)) breaches.push(`recall@10=${(recallAt10 * 100).toFixed(1)}% < ${(floors.recallAt10 * 100).toFixed(0)}%`);
  if (!(recallAt5 >= floors.recallAt5)) breaches.push(`recall@5=${(recallAt5 * 100).toFixed(1)}% < ${(floors.recallAt5 * 100).toFixed(0)}%`);
  if (!(mrr >= floors.mrr)) breaches.push(`MRR=${mrr.toFixed(3)} < ${floors.mrr.toFixed(2)}`);
  const evidence = `n=${result?.total ?? 0}: recall@10=${(recallAt10 * 100).toFixed(1)}% (floor ${(floors.recallAt10 * 100).toFixed(0)}%), `
    + `recall@5=${(recallAt5 * 100).toFixed(1)}% (floor ${(floors.recallAt5 * 100).toFixed(0)}%), `
    + `MRR=${mrr.toFixed(3)} (floor ${floors.mrr.toFixed(2)}) — floors mirror tests/wiki-rag-recall.test.js`;
  return { ok: breaches.length === 0, breaches, evidence };
}

// 纯函数：从评测集 fixture 里取稳定用例。
export function pickKnownGoodCase(fixture, expectedSourcePath = KNOWN_GOOD_SOURCE_PATH) {
  const cases = Array.isArray(fixture?.cases) ? fixture.cases : [];
  return cases.find((c) => c?.expectedSourcePath === expectedSourcePath) || null;
}

export async function runKnowledgeSuite(run, context) {
  await loadConfig();

  // ── EMBED 门：用 wiki-rag 实际生效的配置探测（含 openclaw.json 覆盖）────────
  const probeStartedAt = Date.now();
  let embedConfig = null;
  let probeEvidence = "";
  try {
    embedConfig = await resolveWikiRagEmbedConfig();
    const vector = await embedText("probe", embedConfig);
    probeEvidence = `${embedConfig.model} @ ${embedConfig.baseUrl} (dims=${vector.length})`;
  } catch (error) {
    for (const check of buildKnowledgeSkipChecks(error?.message || String(error))) context.addCheck(check);
    return;
  }
  context.addCheck({
    ...KNOWLEDGE_CHECK_DESCRIPTORS[0], status: "pass", evidence: probeEvidence, durationMs: Date.now() - probeStartedAt,
  });

  try {
    // ── KB 注册表（HTTP 零旁路 inspect 面）──────────────────────────────────
    await runCheck(context, { ...KNOWLEDGE_CHECK_DESCRIPTORS[1], code: "E-KNOWLEDGE-001" }, async () => {
      const res = await gatewayGetJson("/watchdog/inspect?surface=inspect.knowledge_bases");
      const bases = res.body?.knowledgeBases;
      if (res.status !== 200 || !Array.isArray(bases)) {
        return { status: "fail", evidence: `inspect.knowledge_bases invalid: status=${res.status} body=${res.rawBody.slice(0, 160)}` };
      }
      const wiki = bases.find((kb) => kb?.id === "wiki");
      if (!wiki || !(wiki.chunkCount > 0)) {
        return { status: "fail", evidence: `wiki KB missing or empty: ${JSON.stringify(bases.map((kb) => `${kb.id}:${kb.chunkCount}`))}` };
      }
      return `wiki KB present: ${wiki.chunkCount} chunks, model=${wiki.model || "unknown"}, total KBs=${res.body?.counts?.total}`;
    });

    // ── 评测集 fixture（known-good 用例 + 24 例地板共用一份真值）──────────────
    let fixture = null;
    try {
      fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
    } catch (error) {
      // fixture 是这 3 条 check 的前置真值 —— 读不到就是 blocked（verdict 仍 FAIL，但语义如实）。
      markBlocked(context, KNOWLEDGE_CHECK_DESCRIPTORS.slice(2), "E-RUNNER-005",
        `eval fixture unreadable (tests/fixtures/wiki-rag-eval-set.json): ${error?.message || error}`);
      return;
    }
    const knownGood = pickKnownGoodCase(fixture);

    // ── 已知良查询 + 非降级（HTTP 零旁路 inspect.knowledge_search 面）────────
    let searchBody = null;
    await runCheck(context, { ...KNOWLEDGE_CHECK_DESCRIPTORS[2], code: "E-KNOWLEDGE-003" }, async () => {
      if (!knownGood) {
        return { status: "fail", evidence: `no fixture case with expectedSourcePath=${KNOWN_GOOD_SOURCE_PATH}` };
      }
      const res = await gatewayGetJson(`/watchdog/inspect?surface=inspect.knowledge_search&query=${encodeURIComponent(knownGood.query)}&topK=10`);
      searchBody = res.body;
      const results = Array.isArray(res.body?.results) ? res.body.results : [];
      const rank = results.findIndex((r) => r?.sourcePath === knownGood.expectedSourcePath);
      if (res.status !== 200 || res.body?.ok !== true || rank === -1) {
        return {
          status: "fail",
          evidence: `query "${knownGood.query}" missed ${knownGood.expectedSourcePath}: ok=${res.body?.ok}, top=[${results.slice(0, 5).map((r) => r?.sourcePath).join(", ")}]`,
        };
      }
      return `query "${knownGood.query}" hit ${knownGood.expectedSourcePath} at rank ${rank} (top-10)`;
    });
    await runCheck(context, {
      ...KNOWLEDGE_CHECK_DESCRIPTORS[3],
      code: "E-KNOWLEDGE-002",
      hint: "searchWiki degrades when embedText throws INSIDE the serving process; if a fresh `node` probe to localhost:11434 works but the gateway search stays degraded, the gateway process state is stale (e.g. cached embed dispatcher in lib/knowledge/wiki-rag-embed.js after an ollama restart) — restart the gateway (node openclawctl.js restart) and reindex via apply.wiki_reindex",
    }, async () => {
      if (!searchBody) {
        // 上一条 check 连响应都没拿到（网络层抛了）→ 本检查没验证到，blocked 而非二次 fail。
        return { status: "blocked", code: "E-RUNNER-005", evidence: "known-good search response unavailable" };
      }
      if (searchBody.degraded === true) {
        return { status: "fail", evidence: "search returned degraded=true although the embed probe succeeded" };
      }
      return `degraded=${searchBody.degraded === true} with embeddings up (${embedConfig.model})`;
    });

    // ── 24 例 live recall 地板（in-process searchWiki = gate 测试同一条路径）──
    await runCheck(context, { ...KNOWLEDGE_CHECK_DESCRIPTORS[4], code: "E-KNOWLEDGE-004" }, async () => {
      const cases = Array.isArray(fixture?.cases) ? fixture.cases : [];
      if (cases.length < 20) {
        return { status: "fail", evidence: `eval set too small: ${cases.length} cases (expected >=20)` };
      }
      const result = await evaluateWikiRagRecall(cases, searchWiki, { topK: fixture.topK || 10 });
      const verdict = evaluateRecallFloors(result);
      return verdict.ok ? verdict.evidence : { status: "fail", evidence: `${verdict.breaches.join("; ")} — ${verdict.evidence}` };
    });
  } catch (error) {
    context.addCheck({
      id: "knowledge.suite-driver", subsystem: "knowledge", title: "Knowledge suite driver",
      status: "fail", code: "E-RUNNER-001", evidence: `threw: ${error?.message || error}`, durationMs: 0,
    });
  }
}
