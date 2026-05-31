import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GroupSession = 运行层（追踪组内成员完成状态：aggregate 等齐 / race 先得取消）。
// 类比 loop-session-store：复用 atomicWriteFile + withLock，独立文件 + 独立 lock，
// 与 loop-session-store 完全独立存储（不融合）。spec(装配层) 在 agent-group-spec.js。
//
// 这些纯逻辑判定（等齐 / 先得 / 拓扑剪枝判定）以纯函数导出，便于无 IO 单测。

import {
  normalizeGroupSessionEntry,
  isGroupAggregateSatisfied,
  pickGroupRaceWinner,
  applyMemberCompletion,
  groupSessionFitsTopology,
} from "../lib/agent/group-session-normalize.js";

// ── normalize ─────────────────────────────────────────────────────────────────

test("normalizeGroupSessionEntry seeds memberStates pending for every member", () => {
  const entry = normalizeGroupSessionEntry({
    id: "GS-1",
    groupId: "g",
    members: ["a", "b"],
    entryAgentId: "a",
    outputMode: "aggregate",
  });
  assert.equal(entry.groupId, "g");
  assert.equal(entry.status, "initialized");
  assert.deepEqual(Object.keys(entry.memberStates).sort(), ["a", "b"]);
  assert.equal(entry.memberStates.a.status, "pending");
  assert.equal(entry.memberStates.b.status, "pending");
});

test("normalizeGroupSessionEntry rejects entries without id/groupId or <1 member", () => {
  assert.equal(normalizeGroupSessionEntry(null), null);
  assert.equal(normalizeGroupSessionEntry({ groupId: "g", members: ["a"] }), null, "no id");
  assert.equal(normalizeGroupSessionEntry({ id: "x", members: ["a"] }), null, "no groupId");
  assert.equal(normalizeGroupSessionEntry({ id: "x", groupId: "g", members: [] }), null, "no members");
});

test("normalizeGroupSessionEntry carries loopSessionId pointer (loop nesting, orthogonal)", () => {
  const entry = normalizeGroupSessionEntry({
    id: "GS-2",
    groupId: "g",
    members: ["a", "b"],
    loopSessionId: "LS-99",
    round: 2,
  });
  assert.equal(entry.loopSessionId, "LS-99");
  assert.equal(entry.round, 2);
});

// ── aggregate: 等齐判定 ────────────────────────────────────────────────────────

test("isGroupAggregateSatisfied true only when ALL members completed", () => {
  const entry = normalizeGroupSessionEntry({ id: "GS", groupId: "g", members: ["a", "b", "c"], outputMode: "aggregate" });
  assert.equal(isGroupAggregateSatisfied(entry), false);
  const e1 = applyMemberCompletion(entry, "a", { output: 1 });
  assert.equal(isGroupAggregateSatisfied(e1), false);
  const e2 = applyMemberCompletion(e1, "b", { output: 2 });
  assert.equal(isGroupAggregateSatisfied(e2), false);
  const e3 = applyMemberCompletion(e2, "c", { output: 3 });
  assert.equal(isGroupAggregateSatisfied(e3), true, "all done → satisfied");
});

test("isGroupAggregateSatisfied stays false if a member failed (not completed)", () => {
  let entry = normalizeGroupSessionEntry({ id: "GS", groupId: "g", members: ["a", "b"], outputMode: "aggregate" });
  entry = applyMemberCompletion(entry, "a", { output: 1 });
  entry = applyMemberCompletion(entry, "b", { status: "failed" });
  assert.equal(isGroupAggregateSatisfied(entry), false);
});

// ── race: 先得 ─────────────────────────────────────────────────────────────────

test("pickGroupRaceWinner returns first completed member, null when none done", () => {
  let entry = normalizeGroupSessionEntry({ id: "GS", groupId: "g", members: ["a", "b", "c"], outputMode: "race" });
  assert.equal(pickGroupRaceWinner(entry), null);
  entry = applyMemberCompletion(entry, "b", { output: "fast" });
  assert.equal(pickGroupRaceWinner(entry), "b", "first completed wins");
});

test("applyMemberCompletion is a pure update (does not mutate input entry)", () => {
  const entry = normalizeGroupSessionEntry({ id: "GS", groupId: "g", members: ["a", "b"], outputMode: "race" });
  const next = applyMemberCompletion(entry, "a", { output: 1 });
  assert.equal(entry.memberStates.a.status, "pending", "input untouched");
  assert.equal(next.memberStates.a.status, "completed");
  assert.notStrictEqual(entry, next);
});

// ── topology prune 判定（镜像 loop session prune）──────────────────────────────

test("groupSessionFitsTopology rejects sessions referencing pruned members/groups", () => {
  const entry = normalizeGroupSessionEntry({ id: "GS", groupId: "g", members: ["a", "b"], outputMode: "aggregate" });
  assert.equal(groupSessionFitsTopology(entry, { agentIds: new Set(["a", "b"]), groupIds: new Set(["g"]) }), true);
  assert.equal(groupSessionFitsTopology(entry, { agentIds: new Set(["a"]), groupIds: new Set(["g"]) }), false, "member b pruned");
  assert.equal(groupSessionFitsTopology(entry, { agentIds: new Set(["a", "b"]), groupIds: new Set([]) }), false, "group g pruned");
});

// ── store round-trip (real IO, isolated tmp dir via env override) ──────────────

test("group-session-store start → updateMember → conclude round-trips on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "group-session-store-"));
  process.env.OPENCLAW_GROUP_SESSION_DIR = dir;
  try {
    // 动态 import 让 store 读到 env 覆盖（模块顶层解析路径）
    const store = await import(`../lib/agent/group-session-store.js?cachebust=${Date.now()}`);
    const started = await store.startGroupSession({
      groupId: "g",
      members: ["a", "b"],
      entryAgentId: "a",
      outputMode: "aggregate",
    });
    assert.equal(started.groupId, "g");
    assert.equal(started.status, "executing");

    const afterA = await store.updateGroupMemberState({
      groupSessionId: started.id,
      agentId: "a",
      status: "completed",
      output: { v: 1 },
    });
    assert.equal(afterA.memberStates.a.status, "completed");
    assert.equal(store.isGroupAggregateSatisfied(afterA), false);

    const afterB = await store.updateGroupMemberState({
      groupSessionId: started.id,
      agentId: "b",
      status: "completed",
      output: { v: 2 },
    });
    assert.equal(store.isGroupAggregateSatisfied(afterB), true);

    const concluded = await store.concludeGroupSession({
      groupSessionId: started.id,
      concludeReason: "all_members_done",
    });
    assert.equal(concluded.status, "concluded");

    const state = await store.loadGroupSessionState();
    assert.equal(state.activeGroup, null, "concluded → not active");
    assert.ok(state.recentGroups.some((g) => g.id === started.id), "archived to recent");
  } finally {
    delete process.env.OPENCLAW_GROUP_SESSION_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("group-session-store pruneGroupSessionsForTopology drops sessions with pruned members", async () => {
  const dir = await mkdtemp(join(tmpdir(), "group-session-store-"));
  process.env.OPENCLAW_GROUP_SESSION_DIR = dir;
  try {
    const store = await import(`../lib/agent/group-session-store.js?cachebust=${Date.now()}`);
    const started = await store.startGroupSession({
      groupId: "g",
      members: ["a", "b"],
      entryAgentId: "a",
      outputMode: "aggregate",
    });
    assert.ok(started);
    const result = await store.pruneGroupSessionsForTopology({ agentIds: ["a"], groupIds: ["g"] });
    assert.equal(result.changed, true);
    assert.equal(result.removed.length, 1);
    const state = await store.loadGroupSessionState();
    assert.equal(state.activeGroup, null);
  } finally {
    delete process.env.OPENCLAW_GROUP_SESSION_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
