import test from "node:test";
import assert from "node:assert/strict";
import {
  renderInspectLayout,
  renderTabBar,
  deriveRunStatus,
  sessionIdFromParticipantFiles,
  buildTreeModel,
  buildExecutionModelGroups,
  renderExecutionModels,
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

// ── 执行模型（inspect.run 的 contracts.executionModels 投影）──

test("inspect-page: 执行模型分组（每合约一组 + 尾号缩写 + 组内保盖章序）", () => {
  const detail = {
    found: true,
    threadId: "t-1",
    runId: "r-1",
    contracts: {
      count: 2,
      ids: ["TC-1787771315860-cc47a4", "TC-1787771315860-bare11"],
      executionModels: {
        "TC-1787771315860-cc47a4": { planner: "glm-bigmodel/glm-5.1", worker: "kimi/kimi-for-coding" },
      },
    },
  };
  const groups = buildExecutionModelGroups(detail, "r-1");
  assert.equal(groups.length, 1, "投影稀疏:未执行过的合约没有键,不成组");
  assert.equal(groups[0].contractId, "TC-1787771315860-cc47a4");
  assert.equal(groups[0].short, "cc47a4", "尾号缩写=末 6 位(同时间线 .tl-contract chip)");
  assert.deepEqual(
    groups[0].rows,
    [{ agentId: "planner", model: "glm-bigmodel/glm-5.1" }, { agentId: "worker", model: "kimi/kimi-for-coding" }],
    "组内保持盖章顺序(=执行先后),不重排成字母序",
  );
});

test("inspect-page: 执行模型数据缺席 → 空数组（旧数据/空对象/空值/无选中 run）", () => {
  const mk = (executionModels) => ({ runId: "r-1", contracts: { executionModels } });
  assert.deepEqual(buildExecutionModelGroups({ runId: "r-1", contracts: { count: 1, ids: ["TC-1"] } }, "r-1"), [],
    "旧数据无 executionModels 字段");
  assert.deepEqual(buildExecutionModelGroups(mk({}), "r-1"), [], "空对象");
  assert.deepEqual(buildExecutionModelGroups(mk({ "TC-1": {}, "TC-2": { planner: "  " }, "TC-3": { planner: null } }), "r-1"), [],
    "空组/空串/非串值都不落组");
  assert.deepEqual(buildExecutionModelGroups(null, "r-1"), [], "详情未加载");
  assert.deepEqual(buildExecutionModelGroups(mk({ "TC-1": { planner: "a/b" } }), null), [], "选中的不是某个 run(如选 thread)");
});

test("inspect-page: 执行模型跨 run 不串台（树只挂最新 run 详情,深链可选中更早的 run）", () => {
  const detail = { runId: "r-latest", contracts: { executionModels: { "TC-1": { planner: "glm-bigmodel/glm-5.1" } } } };
  assert.deepEqual(buildExecutionModelGroups(detail, "r-older"), [], "runId 不一致 → 宁可缺块也不显别的 run 的模型");
  assert.equal(buildExecutionModelGroups(detail, "r-latest").length, 1, "同 run 才显");
});

test("inspect-page: 执行模型渲染（出组=标题+尾号+agent→model;空组=空串不出空壳）", () => {
  const html = renderExecutionModels([
    { contractId: "TC-x-cc47a4", short: "cc47a4", rows: [{ agentId: "planner", model: "glm-bigmodel/glm-5.1" }] },
    { contractId: "TC-x-aa11bb", short: "aa11bb", rows: [{ agentId: "worker", model: "kimi/kimi-for-coding" }] },
  ], i18n.t);
  assert.match(html, /<section class="insp-exec">/);
  assert.match(html, new RegExp(i18n.t("inspect.exec.title")), "标题走 i18n 键表(非硬编码)");
  assert.equal((html.match(/class="insp-exec-group"/g) || []).length, 2, "多合约 run:每个 contractId 各自一组");
  assert.match(html, /class="insp-exec-cid" title="TC-x-cc47a4">cc47a4</, "尾号 chip,全 id 落 title");
  assert.match(
    html,
    /class="insp-exec-agent">planner<\/span><span class="insp-exec-arrow" aria-hidden="true">→<\/span><span class="insp-exec-model">glm-bigmodel\/glm-5\.1</,
    "组内每行 agentId → provider\/model",
  );
  // 缺席 → 整块不渲染(不出空壳、不出占位文案)
  assert.equal(renderExecutionModels([], i18n.t), "");
  assert.equal(renderExecutionModels(undefined, i18n.t), "");
  // 值是数据,一律转义
  const dirty = renderExecutionModels([{ contractId: "<c>", short: "<c>", rows: [{ agentId: "<a>", model: "<m>" }] }], i18n.t);
  assert.doesNotMatch(dirty, /<c>|<a>|<m>/, "id/agent/模型值全部转义");
});

test("inspect 接线守卫: 执行模型拼进详情列(Tab 条之下、Tab 内容之上),取选中 run 的详情", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../ui/pages/inspect/index.js", import.meta.url), "utf8");
  const renderBlock = src.slice(src.indexOf("function render()"), src.indexOf("// ── 事件委托"));
  assert.match(
    renderBlock,
    /renderExecutionModels\(buildExecutionModelGroups\(runDetail, selected\.runId \|\| null\), i18n\.t\)/,
    "详情列必须接上执行模型渲染(撤掉接线此断言即红)",
  );
  assert.match(renderBlock, /inspectRunDetails \|\| \{\}\)\[selected\.threadId\]/, "数据源=选中 thread 的 inspect.run 详情");
  const at = renderBlock.indexOf("renderExecutionModels");
  assert.ok(at > renderBlock.indexOf("renderTabBar"), "在 Tab 条之下");
  assert.ok(at < renderBlock.indexOf("renderRunTimeline"), "在 Tab 内容之上");
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
