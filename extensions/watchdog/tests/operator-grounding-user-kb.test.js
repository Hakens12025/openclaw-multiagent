/**
 * operator-grounding-user-kb.test.js — 悬办2:operator/viz-master grounding 从「只读 wiki」
 * 升级为「per-agent 聚合检索(绑定 KB ∪ global)」。
 *
 * 此前 retrieveWikiGroundingNotes 硬调 searchWiki,用户自建的知识库**没有任何运行时消费者**
 * (实测:用户库数=0,因为建了也没人读)。改为 searchAgentKnowledge(agentId,{includeGlobal:true})。
 *
 * 两条必须锁住的性质:
 *  ① 零回归 — 无用户库时 bound=[wiki],结果与 searchWiki 逐条一致(operator 现有 grounding 不变)
 *  ② 新能力 — 存在 global 用户库时,其内容能进 operator 的 retrievedNotes,且带 kbId 出处标注
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retrieveGroundingNotes } from "../lib/operator/operator-knowledge.js";
import { searchWiki } from "../lib/knowledge/wiki-rag-search.js";
import { addKnowledgeBaseSource, removeKnowledgeBase } from "../lib/knowledge/knowledge-base-registry.js";
import { buildKbIndex, listKnowledgeBaseSpecs } from "../lib/knowledge/knowledge-base.js";
import { knowledgeBaseIndexFile } from "../lib/control-plane/control-plane-paths.js";
import { AGENT_IDS } from "../lib/agent/agent-metadata.js";
import { embedText } from "../lib/knowledge/wiki-rag-embed.js";

let ollamaUp = false;
try { await embedText("probe", {}); ollamaUp = true; } catch { ollamaUp = false; }

test("note 形状不变:{title,sourcePath,excerpt},excerpt 截断 500", async () => {
  const notes = await retrieveGroundingNotes("传送带原则", 3);
  assert.ok(Array.isArray(notes));
  for (const n of notes) {
    assert.equal(typeof n.title, "string");
    assert.equal(typeof n.sourcePath, "string");
    assert.ok(n.excerpt.length <= 500);
  }
});

test("不传 agentId → 纯 wiki 路径(旧行为保留,viz/其它调用方不受影响)", { skip: !ollamaUp }, async () => {
  const q = "operator 控制面";
  const notes = await retrieveGroundingNotes(q, 4);
  const { results } = await searchWiki(q, { topK: 4 });
  assert.deepEqual(notes.map((n) => n.sourcePath), results.map((r) => r.sourcePath));
  assert.ok(notes.every((n) => n.kbId === undefined), "纯 wiki 路径不应带 kbId 字段");
});

// 不变量测试(不依赖环境快照):断言随实际存在的 global 库数量分档。
// 早先这里硬断言「与 searchWiki 逐条同序」,结果本机一建 memos 库就红——那是把「当时的环境」
// 当成了「要锁的性质」。真正要锁的是两条:
//   ① 只有 wiki 时 → 退化成单表,与旧 searchWiki 完全同序(全新部署的零回归保证)
//   ② 有别的 global 库时 → wiki 仍进得来(新库不得把 wiki grounding 挤空)
test("不变量:只有 wiki 时同序;有其它 global 库时 wiki 不被挤空", { skip: !ollamaUp }, async () => {
  const q = "传送带 inbox outbox";
  const globals = (await listKnowledgeBaseSpecs()).filter((s) => s.scope === "global");
  const viaAgent = await retrieveGroundingNotes(q, 4, { agentId: AGENT_IDS.OPERATOR });
  const { results } = await searchWiki(q, { topK: 4 });

  if (globals.length === 1) {
    assert.deepEqual(
      viaAgent.map((n) => n.sourcePath),
      results.map((r) => r.sourcePath),
      "只有 wiki 时 round-robin 退化成单表,应与旧 searchWiki 完全同序",
    );
    return;
  }
  // 多库:round-robin 会给别的库让出名额,但 wiki 必须仍有代表(kbId 缺省=wiki 单库路径)
  assert.ok(
    viaAgent.some((n) => !n.kbId || n.kbId === "wiki"),
    `存在 ${globals.length} 个 global 库时 wiki 仍应有代表,实得: ${JSON.stringify(viaAgent.map((n) => n.kbId))}`,
  );
});

test("新能力:global 用户库的内容进入 operator grounding + 带 kbId 标注", { skip: !ollamaUp }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "opkb-"));
  const kbId = `opkb-${Date.now()}`;
  try {
    // 一个 wiki 里绝不存在的独特事实 —— 命中它即证明 operator 读到了用户库
    await writeFile(
      join(dir, "zzz-runbook.md"),
      "# 巡检口令\n\n季度巡检口令是 QUOKKA-7731,由值班工程师在交接单上签字确认。\n",
    );
    await addKnowledgeBaseSource(kbId, dir, { label: "运维手册" }); // 默认 scope:global
    await buildKbIndex(kbId, { force: true });

    const notes = await retrieveGroundingNotes("季度巡检口令 QUOKKA", 5, { agentId: AGENT_IDS.OPERATOR });
    const hit = notes.find((n) => n.sourcePath.endsWith("zzz-runbook.md"));
    assert.ok(hit, `operator grounding 应读到用户库内容,实得: ${JSON.stringify(notes.map((n) => n.sourcePath))}`);
    assert.equal(hit.kbId, kbId, "跨库结果须带 kbId 出处标注");
    assert.ok(hit.excerpt.includes("QUOKKA-7731"), "excerpt 应含用户库的真实内容");

    // 同时 wiki 仍可达(global 种子库没被挤掉)
    const wikiNotes = await retrieveGroundingNotes("传送带原则 inbox", 5, { agentId: AGENT_IDS.OPERATOR });
    assert.ok(wikiNotes.some((n) => !n.kbId || n.kbId === "wiki"), "wiki grounding 不应因新增用户库而消失");
  } finally {
    await removeKnowledgeBase(kbId).catch(() => {});
    await rm(knowledgeBaseIndexFile(kbId), { force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
