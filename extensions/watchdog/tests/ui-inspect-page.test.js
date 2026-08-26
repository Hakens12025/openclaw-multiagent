import test from "node:test";
import assert from "node:assert/strict";
import {
  renderInspectLayout,
  renderTabBar,
  deriveRunStatus,
  sessionIdFromParticipantFiles,
  buildTreeModel,
  resolveDeepLinkSelection,
} from "../ui/pages/inspect/inspect-page.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });

test("inspect-page: 布局含左树/右详槽位 + 三 Tab", () => {
  const html = renderInspectLayout(i18n.t);
  assert.match(html, /data-slot="tree"/);
  assert.match(html, /data-slot="detail"/);
  const tabs = renderTabBar("timeline", i18n.t);
  for (const tab of ["timeline", "prompt", "output"]) {
    assert.match(tabs, new RegExp(`data-action="set-tab" data-tab="${tab}"`));
  }
  assert.match(tabs, /insp-tab active" data-action="set-tab" data-tab="timeline"/);
});

test("inspect-page: run 状态推导（closed=done / 失败事件=failed / 否则 running）", () => {
  assert.equal(deriveRunStatus({ closed: true }, []), "done");
  assert.equal(deriveRunStatus({ closed: true }, [{ type: "delivery_failed" }]), "failed");
  assert.equal(deriveRunStatus({ closed: false }, []), "running");
  assert.equal(deriveRunStatus(null, []), "running", "run.json 投影缺席按进行中（事件账仍是真值）");
});

test("inspect-page: sessionId 从 participants 文件名解析（跳过 prompt sidecar）", () => {
  const sid = sessionIdFromParticipantFiles([
    "session-abc123.prompt.json",
    "session-abc123.jsonl",
    "turn-1.json",
  ]);
  assert.equal(sid, "abc123");
  assert.equal(sessionIdFromParticipantFiles(["turn-1.json"]), null);
});

test("inspect-page: 树模型装配（展开门:expanded+loaded 才铺子级 + 状态点）", () => {
  const args = {
    threads: [{ threadId: "t-1", runCount: 1, latestRunId: "r-1", latestTs: 100 }],
    runDetails: {
      "t-1": {
        found: true,
        run: { closed: false },
        participants: [{ agentId: "w-a" }, { agentId: "w-b" }],
      },
    },
    selected: { type: "run", threadId: "t-1", runId: "r-1" },
  };
  // 展开集含 t-1 → 铺开 run/agent 子级
  const model = buildTreeModel({ ...args, expandedThreads: ["t-1"] });
  assert.equal(model.threads.length, 1);
  const [thread] = model.threads;
  assert.equal(thread.expanded, true, "在展开集内 → expanded=true");
  assert.equal(thread.status, "running");
  assert.equal(thread.runs.length, 1);
  assert.deepEqual(thread.runs[0].agents.map((a) => a.agentId), ["w-a", "w-b"]);
  assert.equal(thread.runs[0].runId, "r-1");
  // 详情已加载但未在展开集 → runs=null（单节点收起,只出 thread 行）
  const collapsed = buildTreeModel({ ...args, expandedThreads: [] });
  assert.equal(collapsed.threads[0].expanded, false, "不在展开集 → expanded=false");
  assert.equal(collapsed.threads[0].runs, null, "收起态即使详情已加载也不铺子级");
  assert.equal(collapsed.threads[0].status, "running", "收起态状态点仍取真值");
  // 展开但详情未加载 → expanded=true 但 runs=null（caret ▾,子级异步补齐）
  const pending = buildTreeModel({ threads: args.threads, runDetails: {}, expandedThreads: ["t-1"] });
  assert.equal(pending.threads[0].expanded, true);
  assert.equal(pending.threads[0].runs, null);
  // 未加载详情的 thread（默认收起）不出子级
  const bare = buildTreeModel({ threads: [{ threadId: "t-2", runCount: 3, latestRunId: "r-9" }], runDetails: {}, selected: null });
  assert.equal(bare.threads[0].runs, null);
  assert.equal(bare.threads[0].expanded, false);
});

test("inspect-page: 未加载 thread 状态=unknown(中性),不谎报 done;failed 检测语义不变", () => {
  // 详情未拉取 → unknown（旧码默认 done 会把在跑/失败的 thread 显成已完成）
  const bare = buildTreeModel({ threads: [{ threadId: "t-9", runCount: 1, latestRunId: "r-9" }], runDetails: {} });
  assert.equal(bare.threads[0].status, "unknown", "未加载 → unknown");
  // 加载后判定不变:closed+失败事件 → failed
  const failed = buildTreeModel({
    threads: [{ threadId: "t-9", runCount: 1, latestRunId: "r-9" }],
    runDetails: { "t-9": { found: true, run: { closed: true }, events: [{ type: "delivery_failed" }], participants: [] } },
  });
  assert.equal(failed.threads[0].status, "failed", "failed 检测语义不变");
});

test("inspect-page: 深链解析（?run= / ?wi= → 选中态）", () => {
  assert.deepEqual(resolveDeepLinkSelection({ run: "r-1" }), { type: "run", id: "r-1" });
  assert.deepEqual(resolveDeepLinkSelection({ wi: "C-9" }), { type: "run", id: "C-9" },
    "工作项 id 就是 contractId,同一把钥匙");
  assert.equal(resolveDeepLinkSelection({}), null);
});

test("inspect: fetchAnchoredTraces 并行取各会话 trace;单会话失败/空只留白", async () => {
  const { fetchAnchoredTraces } = await import("../ui/pages/inspect/index.js");
  const calls = [];
  const resolvers = {};
  const api = {
    inspect(surface, { sessionKey }) {
      calls.push(sessionKey);
      if (sessionKey === "s-bad") return Promise.reject(new Error("boom"));
      return new Promise((resolve) => { resolvers[sessionKey] = resolve; });
    },
  };
  const join = { events: [{ sessionKey: "s-1" }, { sessionKey: "s-2" }, { sessionKey: "s-bad" }, { sessionKey: "s-1" }] };
  const pending = fetchAnchoredTraces(api, join);
  // 并行判据:s-1 尚未 resolve 时,s-2/s-bad 的请求已经发出(串行实现此处只会有 s-1)
  assert.deepEqual(calls, ["s-1", "s-2", "s-bad"], "全部会话同步发起(去重后),不逐个串行等待");
  resolvers["s-1"]([{ seq: 1 }]);
  resolvers["s-2"]([]); // 空行会话不进结果
  const traces = await pending;
  assert.deepEqual(traces, [{ sessionKey: "s-1", rows: [{ seq: 1 }] }], "失败/空会话留白,不拖垮其余");
});
