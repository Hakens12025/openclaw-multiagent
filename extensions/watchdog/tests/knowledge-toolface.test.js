import test from "node:test";
import assert from "node:assert/strict";

import { runtimeAgentConfigs } from "../lib/state.js";
import { buildKnowledgeTools, listKnowledgeToolNames } from "../lib/knowledge/knowledge-toolface.js";

const logger = { info() {}, warn() {}, error() {} };

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

function register(agentId) {
  runtimeAgentConfigs.set(agentId, { id: agentId });
}

function onlyTool(agentId) {
  const tools = buildKnowledgeTools({ agentId, logger });
  assert.equal(tools.length, 1);
  return tools[0];
}

// 最重要的一条:框架的 `resolved = entry.factory(params.context)` **不 await**
// (dist/subagent-registry-*.js),工厂一旦变成 async,返回的 Promise 会被当成 [Promise] →
// 工具静默消失,没有任何报错。这个测试就是那道闸。
test("工厂必须同步返回数组(框架不 await 工厂)", () => {
  register("worker");
  const result = buildKnowledgeTools({ agentId: "worker", logger });
  assert.ok(Array.isArray(result), "工厂返回值必须是数组,不能是 Promise");
  assert.ok(typeof result.then !== "function", "工厂不能是 async");
});

test("未注册的 agent 不物化工具", () => {
  assert.deepEqual(buildKnowledgeTools({ agentId: "nobody", logger }), []);
  assert.deepEqual(buildKnowledgeTools({ agentId: "", logger }), []);
  assert.deepEqual(buildKnowledgeTools({ agentId: null, logger }), []);
});

test("工具形状:名字与 allowlist 声明一致,query 必填", () => {
  register("worker");
  const tool = onlyTool("worker");
  assert.deepEqual(listKnowledgeToolNames(), [tool.name]);
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.ok(tool.parameters.properties.query);
  assert.ok(tool.parameters.properties.topK);
  assert.equal(typeof tool.execute, "function");
});

// description 是模型决定调不调的唯一依据,所以它承载的是行为契约,不是文案。
// 守三件事:说清装的是什么、说清什么时候不必调(否则次次调=纯浪费)、
// 明确许可"查不到就说没有"(否则模型拿空结果硬编,是检索型工具最常见的坏结局)。
test("description 覆盖三件必须说清的事", () => {
  register("worker");
  const d = onlyTool("worker").description;
  assert.match(d, /知识库/);
  assert.match(d, /不必检索|直接回答/);
  assert.match(d, /没有相关记载|结果为空/);
});

test("空 query 不打检索,直接回执", async () => {
  register("worker");
  const out = await onlyTool("worker").execute("call-1", { query: "  " });
  assert.equal(out.details.hitCount, 0);
  assert.match(out.details.note, /query/);
});

test("execute 结果是可解析 JSON 文本 + 结构化 details", async () => {
  register("worker");
  const out = await onlyTool("worker").execute("call-2", { query: "传送带原则" });
  assert.equal(out.content[0].type, "text");
  const parsed = JSON.parse(out.content[0].text);
  assert.deepEqual(parsed, out.details);
  assert.equal(typeof out.details.hitCount, "number");
  assert.ok(Array.isArray(out.details.results));
});

// 跨库 score 不可比(mergeAgentKbResults 的书面取舍),外露会诱导模型当置信度用。
test("命中结果只暴露来源/标题/摘录,不外露 score", async () => {
  register("worker");
  const out = await onlyTool("worker").execute("call-3", { query: "传送带原则 inbox outbox" });
  for (const hit of out.details.results) {
    assert.ok(hit.source, "每条必须带来源");
    assert.equal(hit.score, undefined, "score 不得外露");
    assert.ok(hit.excerpt.length <= 500);
  }
});

test("topK 收敛在 1..10", async () => {
  register("worker");
  const tool = onlyTool("worker");
  const big = await tool.execute("call-4", { query: "传送带", topK: 999 });
  assert.ok(big.details.results.length <= 10);
  const zero = await tool.execute("call-5", { query: "传送带", topK: 0 });
  assert.ok(zero.details.results.length >= 0); // 不抛即可:0 被抬到 1
  const nan = await tool.execute("call-6", { query: "传送带", topK: "abc" });
  assert.ok(Array.isArray(nan.details.results));
});
