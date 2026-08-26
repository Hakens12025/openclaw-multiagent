import test from "node:test";
import assert from "node:assert/strict";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:test-runs-graph-preservation.test.js" });
import { withPreservedRuntimeGraph } from "../lib/formal-runtime/test-runs.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";
import { addSseClient, removeSseClient } from "../lib/transport/sse.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";

// 截获 broadcast 的假 SSE 客户端(broadcast 遍历 sseClients 逐个 res.write)。
function makeSseSpy() {
  const writes = [];
  const client = { finished: false, destroyed: false, write: (p) => writes.push(p) };
  return { client, writes };
}

test("withPreservedRuntimeGraph restores the live graph after a temporary test-run mutation", async () => (
  runGlobalTestEnvironmentSerial(async () => {
    const originalGraph = await loadGraph();

    await withPreservedRuntimeGraph(async () => {
      await saveGraph({
        edges: [
          {
            from: "worker-3",
            to: "worker-4",
            label: "temporary-test-run-graph",
          },
        ],
      });

      const mutatedGraph = await loadGraph();
      assert.equal(mutatedGraph.edges.length, 1);
      assert.equal(mutatedGraph.edges[0]?.label, "temporary-test-run-graph");
    });

    const restoredGraph = await loadGraph();
    assert.deepEqual(restoredGraph, originalGraph);
  })
));

test("护栏恢复检出测试窗口内的图漂移 → 打 SSE 告警(不再无声回滚,b 裁决 2026-08-26)", async () => (
  runGlobalTestEnvironmentSerial(async () => {
    const spy = makeSseSpy();
    addSseClient(spy.client);
    try {
      await withPreservedRuntimeGraph(async () => {
        // 模拟用户测试期手改图(= agent-graph.json 相对快照漂移)
        await saveGraph({ edges: [{ from: "user-edit", to: "mid-test", label: "hand-edit" }] });
      });
    } finally {
      removeSseClient(spy.client);
    }
    const alert = spy.writes.find((p) => p.includes(EVENT_TYPE.TEST_CONTROL_STATE_RESTORED));
    assert.ok(alert, "漂移恢复必须发 test_control_state_restored 告警");
    assert.match(alert, /agent-graph/, "告警带被恢复的文件");
  })
));

test("护栏恢复时无漂移(测试期没人改图) → 零告警(不误报)", async () => (
  runGlobalTestEnvironmentSerial(async () => {
    const spy = makeSseSpy();
    addSseClient(spy.client);
    try {
      await withPreservedRuntimeGraph(async () => { /* 测试期间没人碰图 */ });
    } finally {
      removeSseClient(spy.client);
    }
    const alert = spy.writes.find((p) => p.includes(EVENT_TYPE.TEST_CONTROL_STATE_RESTORED));
    assert.equal(alert, undefined, "无漂移不得误报");
  })
));
