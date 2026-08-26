// Tests: 合约执行模型一等字段(2026-08-27)——"该合约以哪个模型执行"从转录考古升级为可查列。
//
// 锁四件事:
//   ① 提取器 resolveSessionExecutionModel:从 live 会话 jsonl 取**最后一条** assistant
//      消息的 model/provider(最后=failover 换挡后的实际真相);容忍非 message 行与坏行;
//      sessions.json/jsonl 缺席、无 assistant 模型行 → null(缺测不误报);
//   ② COLLECTED 账列:wireCollected 带 executionModel 时 payload 落 model/provider,
//      缺测时两列都不落(事件形状按需增列,与 kind 同则);
//   ③ provider 只随 model 落(有 provider 无 model 不成立——半截观测不进账);
//   ④ 接线不回退(反证锚):transport.js 保持提取调用 + 正本 executionModels 盖章。
//
// Run: node --test tests/contract-execution-model.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSessionExecutionModel } from "../lib/lifecycle/run-tree-archive.js";
import { wireCollected } from "../lib/archive/run-event-wiring.js";
import { flushRunEvents } from "../lib/archive/run-event-recorder.js";
import { tryReadRunEventsFromDb } from "../lib/record-plane/record-reader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIQ = `xm-${process.pid}`;

// ── 夹具:临时根里造 agents/<id>/sessions/{sessions.json,<sid>.jsonl} ─────────
function seedSession(root, agentId, sessionKey, jsonlLines) {
  const dir = join(root, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const sessionId = `sid-${agentId}`;
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({
    [sessionKey]: { sessionId, updatedAt: 1724700000000 },
  }));
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonlLines.join("\n") + "\n");
  return sessionId;
}

const assistantLine = (model, provider) => JSON.stringify({
  type: "message",
  message: { role: "assistant", model, provider, content: [] },
});

// ── ① 提取器 ────────────────────────────────────────────────────────────────

test("extractor: last assistant message wins (failover 换挡后以末条为准)", async () => {
  const root = mkdtempSync(join(tmpdir(), "xm-root-"));
  seedSession(root, "planner", "agent:planner:main", [
    JSON.stringify({ type: "session", id: "s" }),
    assistantLine("kimi-for-coding", "kimi"),
    JSON.stringify({ type: "model_change", model: "glm-5.1" }),
    "{broken json line",
    assistantLine("glm-5.1", "glm-bigmodel"),
    JSON.stringify({ type: "text", text: "trailing non-message" }),
  ]);
  const got = await resolveSessionExecutionModel({ agentId: "planner", sessionKey: "agent:planner:main", root });
  assert.deepEqual(got, { model: "glm-5.1", provider: "glm-bigmodel" });
});

test("extractor: provider 缺席时归一 null,model 独立成立", async () => {
  const root = mkdtempSync(join(tmpdir(), "xm-root-"));
  seedSession(root, "worker", "agent:worker:main", [
    JSON.stringify({ type: "message", message: { role: "assistant", model: "glm-5.1" } }),
  ]);
  const got = await resolveSessionExecutionModel({ agentId: "worker", sessionKey: "agent:worker:main", root });
  assert.deepEqual(got, { model: "glm-5.1", provider: null });
});

test("extractor: 缺席三态皆 null(无 sessions.json/无 jsonl 行/无 assistant 模型)", async () => {
  const root = mkdtempSync(join(tmpdir(), "xm-root-"));
  // 无 sessions.json
  assert.equal(await resolveSessionExecutionModel({ agentId: "ghost", sessionKey: "k", root }), null);
  // 有会话但转录里没有 assistant 模型行(user 行不算)
  seedSession(root, "mute", "agent:mute:main", [
    JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
  ]);
  assert.equal(await resolveSessionExecutionModel({ agentId: "mute", sessionKey: "agent:mute:main", root }), null);
  // 参数缺席
  assert.equal(await resolveSessionExecutionModel({}), null);
});

// ── ②③ COLLECTED 账列 ───────────────────────────────────────────────────────

async function collectedPayloadFor(executionModel, tag) {
  const lineage = { threadId: `t-${UNIQ}-${tag}`, runId: `r-${UNIQ}-${tag}` };
  const contract = { id: `TC-${UNIQ}-${tag}`, lineage };
  await wireCollected({
    contract,
    agentId: "planner",
    sessionKey: "agent:planner:main",
    collected: true,
    executionModel,
    logger: null,
  });
  await flushRunEvents(lineage);
  const events = tryReadRunEventsFromDb(lineage.runId) || [];
  const collected = events.find((e) => e.type === "collected");
  assert.ok(collected, "COLLECTED 事件应已落账");
  return collected.payload || {};
}

test("ledger: executionModel 随 COLLECTED 落 model/provider 两列", async () => {
  const payload = await collectedPayloadFor({ model: "glm-5.1", provider: "glm-bigmodel" }, "full");
  assert.equal(payload.model, "glm-5.1");
  assert.equal(payload.provider, "glm-bigmodel");
});

test("ledger: 缺测时不落列;provider 只随 model 落(半截观测不进账)", async () => {
  const bare = await collectedPayloadFor(null, "none");
  assert.equal("model" in bare, false);
  assert.equal("provider" in bare, false);
  const orphanProvider = await collectedPayloadFor({ provider: "glm-bigmodel" }, "orphan");
  assert.equal("model" in orphanProvider, false);
  assert.equal("provider" in orphanProvider, false);
});

// ── ④ 接线反证锚 ────────────────────────────────────────────────────────────

test("wiring guard: transport.js 保持提取调用与正本盖章(接线拆除即红)", () => {
  const src = readFileSync(join(HERE, "..", "lib", "lifecycle", "agent-end", "transport.js"), "utf8");
  assert.match(src, /resolveSessionExecutionModel\(\{/, "agent_end 应从转录提取执行模型");
  assert.match(src, /executionModel,\s*\n?\s*logger/, "wireCollected 应携带 executionModel");
  assert.match(src, /contract\.executionModels = \{/, "合约正本应盖 executionModels[agentId]");
});
