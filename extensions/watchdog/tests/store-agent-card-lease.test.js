// tests/store-agent-card-lease.test.js
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setAgentCard, getAgentCard, getAgentCardMeta, sweepAgentCards, clearAgentCards,
} from "../lib/store/agent-card-store.js";

beforeEach(() => clearAgentCards());

test("注册返回撤销凭证,条目带 owner 元数据", () => {
  const dispose = setAgentCard("a1", { name: "A1" }, "test-owner");
  assert.equal(getAgentCard("a1").name, "A1");
  assert.equal(getAgentCardMeta("a1").owner, "test-owner");
  assert.equal(dispose(), true);
  assert.equal(getAgentCard("a1"), null);
  assert.equal(getAgentCardMeta("a1"), null);
  assert.equal(dispose(), false); // 单次生效
});

test("sweep 依存活谓词清幽灵并记名（graceMs=0 关宽限）", () => {
  setAgentCard("alive", {}, "reg");
  setAgentCard("ghost", {}, "reg");
  const swept = sweepAgentCards((id) => id === "alive", { graceMs: 0 });
  assert.deepEqual(swept.map((s) => s.agentId), ["ghost"]);
  assert.equal(swept[0].owner, "reg");
  assert.notEqual(getAgentCard("alive"), null);
  assert.equal(getAgentCard("ghost"), null);
});

test("宽限期内的新条目不清（在途窗口保护:admin create 先卡后配）", () => {
  setAgentCard("fresh", {}, "reg");
  const swept = sweepAgentCards(() => false, { graceMs: 60_000 });
  assert.equal(swept.length, 0);
  assert.notEqual(getAgentCard("fresh"), null);
});

test("dryRun 只报告不删除（soak 观察模式）", () => {
  setAgentCard("ghost", {}, "reg");
  const swept = sweepAgentCards(() => false, { graceMs: 0, dryRun: true });
  assert.equal(swept.length, 1);
  assert.notEqual(getAgentCard("ghost"), null); // 仍在
});

test("owner 缺省为 unknown（兼容旧调用方）", () => {
  setAgentCard("legacy", {});
  assert.equal(getAgentCardMeta("legacy").owner, "unknown");
});
