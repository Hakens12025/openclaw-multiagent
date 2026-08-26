#!/usr/bin/env node
// kb-ask.js — 用大白话问知识库,秒回相关片段。给 Claude Code / 人用的**读侧开发 CLI**。
//
// 解决的问题:要知道「这块当初为什么这么设计」,以前只能 ls 备忘录目录 + 整篇读(一篇上万字、
// 还容易漏)。这里一句话语义检索,直接拿到那几段。
//
// 默认同时查所有 scope:'global' 的库 —— 即 wiki(编译后的 WHY 层)+ memos(原始讨论 RAW 层),
// 名次交错合并、每条标 [kbId] 出处,让「结论」和「当时的原始语境」一起出现(三权分立:
// code=WHAT / memo=RAW / wiki=WHY,见 wiki/schema.md)。
//
// 用法:
//   node scripts/kb-ask.js "为什么不给 RAG 单独建 meta-agent"
//   node scripts/kb-ask.js "串行测试" --kb memos --topK 8
//   node scripts/kb-ask.js "loop 预算" --agent operator     # 看 operator 视角能读到什么
//   node scripts/kb-ask.js "目标价" --asOf 2026-06-01       # 点时检索(时态库,防未来泄漏)
//   node scripts/kb-ask.js --list                           # 列出有哪些库
//
// 检索永不抛:ollama 挂了自动退化成词法检索(标 [degraded]),仍有结果。

import { searchKb, searchAgentKnowledge, summarizeKnowledgeBases } from "../extensions/watchdog/lib/knowledge/knowledge-base.js";

function parseArgs(argv) {
  const out = { query: [], kb: null, agent: "", topK: 6, asOf: null, list: false, full: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--full") out.full = true;
    else if (a === "--kb") out.kb = argv[++i];
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--asOf") out.asOf = argv[++i];
    else if (a === "--topK") out.topK = Number(argv[++i]) || 6;
    else out.query.push(a);
  }
  out.query = out.query.join(" ").trim();
  return out;
}

function shortSource(p) {
  const base = String(p || "").split("/").pop() || p;
  return base.replace(/_20\d\d-\d\d-\d\d-\d{4}\.md$/, "").replace(/\.md$/, "");
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  const s = await summarizeKnowledgeBases();
  console.log(`知识库 ${s.counts.total} 个:`);
  for (const kb of s.knowledgeBases) {
    console.log(`  ${kb.id.padEnd(12)} ${String(kb.chunkCount).padStart(5)} 块  scope=${kb.scope}${kb.temporal ? " [时态]" : ""}  ${kb.label}`);
  }
  process.exit(0);
}

if (!args.query) {
  console.error('用法: node scripts/kb-ask.js "你的问题" [--kb <id>] [--agent <id>] [--topK N] [--asOf YYYY-MM-DD] [--full]');
  process.exit(1);
}

const res = args.kb
  ? await searchKb(args.kb, args.query, { topK: args.topK, asOf: args.asOf })
  : await searchAgentKnowledge(args.agent, args.query, { topK: args.topK, asOf: args.asOf, includeGlobal: true });

if (!res.ok || !res.results?.length) {
  console.log(`(无结果${res.degraded ? " · 检索降级:embed 不可用,已退化词法" : ""})`);
  if (res.error) console.log("  " + res.error);
  process.exit(0);
}

const bases = res.bases ? ` · 查了 ${res.bases.map((b) => b.id).join("+")}` : "";
console.log(`【${args.query}】${res.degraded ? " [degraded]" : ""}${bases}\n`);

for (const [i, r] of res.results.entries()) {
  const tag = r.kbId ? `[${r.kbId}] ` : "";
  const meta = r.meta?.source || r.meta?.time
    ? ` {${[r.meta.source, r.meta.time?.slice(0, 10)].filter(Boolean).join(" · ")}}`
    : "";
  console.log(`${i + 1}. ${tag}${shortSource(r.sourcePath)}${r.heading ? " · " + r.heading : ""}${meta}`);
  const text = String(r.text || "").replace(/\s+/g, " ");
  console.log(`   ${args.full ? text : text.slice(0, 260)}`);
  console.log(`   ↳ ${r.sourcePath}`);
}

// 时态库的跨源分歧提示(不同来源对同一主题说法不一致时才出现)
if (res.conflictHints?.length) {
  console.log(`\n⚠ 跨源分歧 ${res.conflictHints.length} 处:`);
  for (const h of res.conflictHints) {
    const disp = Object.entries(h.dispersion || {})
      .map(([f, d]) => (d.kind === "numeric" ? `${f}: ${d.min}—${d.mean}—${d.max} (cv ${d.cv})` : `${f}: ${(d.distinctValues || []).join(" / ")}`))
      .join("; ");
    console.log(`  ${h.topic}: ${h.sources.map((s) => s.source).join(" vs ")} → ${disp}`);
  }
}
