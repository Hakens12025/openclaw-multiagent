// saveGraph 整写门守卫(§13 多主体真值:整写路径必须报写者身份 + edge 级差异日志)。
// 事故背景:2026-08-26 测试护栏恢复快照整写覆盖,把用户测试期手加的边静默抹掉——
// add/delete 端点有日志,整写路径没有。本文件锁死三件事:
//   ① 整写 diff 出的 added/removed 逐条打日志且点名 writer
//   ② 幂等整写(无差异)零日志
//   ③ writer 透传(缺省 unknown 也照样点名)
import test from "node:test";
import assert from "node:assert/strict";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";

const WRITER = "test:agent-graph-save-writer.test.js";

function makeLoggerSpy() {
  const lines = [];
  return { lines, info: (msg) => lines.push(String(msg)) };
}

test("saveGraph 整写:diff 出的 added/removed 逐条打日志并点名 writer", async () => {
  const originalGraph = await loadGraph();
  try {
    await saveGraph({ edges: [{ from: "gw-a", to: "gw-b" }] }, { writer: WRITER });

    const addSpy = makeLoggerSpy();
    await saveGraph(
      { edges: [{ from: "gw-a", to: "gw-b" }, { from: "gw-c", to: "gw-d" }] },
      { writer: WRITER, logger: addSpy },
    );
    assert.deepEqual(
      addSpy.lines,
      [`[watchdog] graph edge added: gw-c -> gw-d (writer=${WRITER})`],
      "新增一条边 => 恰好一行 added 日志,带写者身份",
    );

    const removeSpy = makeLoggerSpy();
    await saveGraph(
      { edges: [{ from: "gw-c", to: "gw-d" }] },
      { writer: WRITER, logger: removeSpy },
    );
    assert.deepEqual(
      removeSpy.lines,
      [`[watchdog] graph edge removed: gw-a -> gw-b (writer=${WRITER})`],
      "抹掉一条边 => 恰好一行 removed 日志,带写者身份",
    );
  } finally {
    await saveGraph(originalGraph, { writer: WRITER });
  }
});

test("saveGraph 幂等整写(无差异) => 零日志", async () => {
  const originalGraph = await loadGraph();
  try {
    const edges = [{ from: "gw-idem-a", to: "gw-idem-b" }];
    await saveGraph({ edges }, { writer: WRITER });

    const spy = makeLoggerSpy();
    await saveGraph({ edges }, { writer: WRITER, logger: spy });
    assert.deepEqual(spy.lines, [], "同一份边整写第二遍必须静默");
  } finally {
    await saveGraph(originalGraph, { writer: WRITER });
  }
});

test("saveGraph writer 缺省 => 日志点名 writer=unknown(过渡容错但可揪出漏报方)", async () => {
  const originalGraph = await loadGraph();
  try {
    await saveGraph({ edges: [] }, { writer: WRITER });

    const spy = makeLoggerSpy();
    await saveGraph({ edges: [{ from: "gw-anon-a", to: "gw-anon-b" }] }, { logger: spy });
    assert.deepEqual(
      spy.lines,
      ["[watchdog] graph edge added: gw-anon-a -> gw-anon-b (writer=unknown)"],
      "缺省 writer 也必须在日志里显式点名 unknown",
    );
  } finally {
    await saveGraph(originalGraph, { writer: WRITER });
  }
});

// ── 2026-08-27 归一批:四写口全员署名,edge 级日志单源=突变层 ──────────────────

test("pruneGraphToAgentIds:实际剪掉的边逐条署名,零剪静默", async () => {
  const { pruneGraphToAgentIds } = await import("../lib/agent/agent-graph-mutations.js");
  const originalGraph = await loadGraph();
  try {
    await saveGraph({ edges: [
      { from: "gw-keep-a", to: "gw-keep-b" },
      { from: "gw-keep-a", to: "gw-gone-x" },
    ] }, { writer: WRITER });

    const spy = makeLoggerSpy();
    const pruned = await pruneGraphToAgentIds(["gw-keep-a", "gw-keep-b"], { writer: WRITER, logger: spy });
    assert.equal(pruned.changed, true);
    assert.deepEqual(
      spy.lines,
      [`[watchdog] graph edge removed: gw-keep-a -> gw-gone-x (writer=${WRITER})`],
      "批量剪边必须逐条点名写者",
    );

    const idemSpy = makeLoggerSpy();
    const idem = await pruneGraphToAgentIds(["gw-keep-a", "gw-keep-b"], { writer: WRITER, logger: idemSpy });
    assert.equal(idem.changed, false);
    assert.deepEqual(idemSpy.lines, [], "零剪必须静默");
  } finally {
    await saveGraph(originalGraph, { writer: WRITER });
  }
});

test("addEdge/removeEdge:实际改边署名,幂等/缺席静默", async () => {
  const { addEdge, removeEdge } = await import("../lib/agent/agent-graph-mutations.js");
  const originalGraph = await loadGraph();
  try {
    await saveGraph({ edges: [] }, { writer: WRITER });

    const addSpy = makeLoggerSpy();
    await addEdge("gw-e1", "gw-e2", { writer: WRITER, logger: addSpy });
    assert.deepEqual(addSpy.lines, [`[watchdog] graph edge added: gw-e1 -> gw-e2 (writer=${WRITER})`]);

    const dupSpy = makeLoggerSpy();
    await addEdge("gw-e1", "gw-e2", { writer: WRITER, logger: dupSpy });
    assert.deepEqual(dupSpy.lines, [], "已存在的边重复 add 必须静默");

    const rmSpy = makeLoggerSpy();
    await removeEdge("gw-e1", "gw-e2", { writer: WRITER, logger: rmSpy });
    assert.deepEqual(rmSpy.lines, [`[watchdog] graph edge removed: gw-e1 -> gw-e2 (writer=${WRITER})`]);

    const absentSpy = makeLoggerSpy();
    await removeEdge("gw-e1", "gw-e2", { writer: WRITER, logger: absentSpy });
    assert.deepEqual(absentSpy.lines, [], "删不存在的边必须静默");
  } finally {
    await saveGraph(originalGraph, { writer: WRITER });
  }
});

test("归一源守卫:admin 端点只递身份,不再自打 edge 日志(第二套日志复活即红)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/admin/operations/admin-surface-graph-operations.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /graph edge \$\{|graph edge added|graph edge removed/, "端点不得再有自己的 edge 日志模板");
  assert.match(src, /admin-surface:\$\{/, "端点必须构造 admin-surface: 前缀写者身份");
  assert.match(src, /removeEdge\(from, to, \{ writer, logger \}\)/, "removeEdge 必须递身份");
  assert.match(src, /graph\.group\.compose:\$\{groupId\}/, "组装配循环必须递身份");
});
