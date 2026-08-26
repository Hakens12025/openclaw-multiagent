import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderThreadTree } from "../ui/components/thread-tree.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });

const model = {
  threads: [
    {
      threadId: "t-1",
      runCount: 2,
      status: "running",
      expanded: true,
      runs: [
        {
          runId: "r-1",
          status: "running",
          agents: [
            { agentId: "worker-a", status: "running" },
            { agentId: "worker-b", status: "failed" },
          ],
        },
      ],
    },
    { threadId: "t-2", runCount: 1, status: "done", expanded: false, runs: null },
  ],
  selected: { type: "agent", threadId: "t-1", runId: "r-1", agentId: "worker-a" },
};

test("thread-tree: 三级缩进树 + 状态点色类名", () => {
  const html = renderThreadTree(model, i18n.t);
  assert.match(html, /class="tt-node tt-depth-1[^"]*"[^>]*data-thread-id="t-1"/);
  assert.match(html, /class="tt-node tt-depth-2[^"]*"[^>]*data-run-id="r-1"/);
  assert.match(html, /class="tt-node tt-depth-3[^"]*"[^>]*data-agent-id="worker-a"/);
  // 状态点：运行中=active / 完成=done / 失败=failed
  assert.match(html, /tt-dot status-running/);
  assert.match(html, /tt-dot status-done/);
  assert.match(html, /tt-dot status-failed/);
});

test("thread-tree: 点击回调参数（data-action=select-node + node-type + ids）", () => {
  const html = renderThreadTree(model, i18n.t);
  assert.match(html, /data-action="select-node" data-node-type="thread" data-thread-id="t-2"/);
  assert.match(html, /data-action="select-node" data-node-type="run" data-thread-id="t-1" data-run-id="r-1"/);
  assert.match(html, /data-action="select-node" data-node-type="agent" data-thread-id="t-1" data-run-id="r-1" data-agent-id="worker-a"/);
});

test("thread-tree: 选中态类名 + 未加载 run 不渲染子级", () => {
  const html = renderThreadTree(model, i18n.t);
  assert.match(html, /tt-node tt-depth-3 selected/, "选中 agent 行带 selected");
  // t-2 未加载 runs → 只有 thread 行
  const t2Section = html.slice(html.indexOf('data-thread-id="t-2"'));
  assert.doesNotMatch(t2Section, /tt-depth-2/, "t-2 无 run 子级");
});

test("thread-tree: 单节点展开门 — 展开 thread 有 caret ▾ 且铺子级；收起 thread caret ▸ 不铺子级", () => {
  const html = renderThreadTree(model, i18n.t);
  // t-1 expanded → caret ▾ + aria-expanded=true + 铺开 run/agent
  assert.match(html, /data-thread-id="t-1" aria-expanded="true"/, "展开 thread 标 aria-expanded=true");
  assert.match(html, /<span class="tt-caret" aria-hidden="true">▾<\/span>/, "展开 caret ▾");
  assert.match(html, /tt-depth-2/, "展开 thread 铺 run 级");
  // t-2 collapsed → caret ▸ + aria-expanded=false + 无子级
  assert.match(html, /data-thread-id="t-2" aria-expanded="false"/, "收起 thread 标 aria-expanded=false");
  assert.match(html, /<span class="tt-caret" aria-hidden="true">▸<\/span>/, "收起 caret ▸");
  // 反证:把 t-1 改成 collapsed → 不再铺子级
  const collapsedModel = { ...model, threads: [{ ...model.threads[0], expanded: false }, model.threads[1]] };
  const collapsedHtml = renderThreadTree(collapsedModel, i18n.t);
  assert.doesNotMatch(collapsedHtml, /tt-depth-2/, "整体收起后无任何 run 子级");
});

test("thread-tree: 每个 thread 包成 tt-group(虚线只在组间=t- 之间,组内无虚线)", () => {
  const html = renderThreadTree(model, i18n.t);
  // 两个 thread → 两个 tt-group
  assert.equal((html.match(/class="tt-group"/g) || []).length, 2, "每 thread 一个 tt-group");
  // tt-node 自身不再带 border-bottom 虚线(改由 .tt-group 分隔)——渲染层无法验 CSS,
  // 但可验 run/agent 与 thread 同在一个 group 内(t-1 的 group 含 depth-2/3)
  const g1 = html.slice(html.indexOf("tt-group"), html.indexOf("tt-group", html.indexOf("tt-group") + 1));
  assert.match(g1, /tt-depth-2/, "展开 thread 的 run 与 thread 同组");
});

test("thread-tree: 空态", () => {
  const html = renderThreadTree({ threads: [], selected: null }, i18n.t);
  assert.match(html, /tt-empty/);
  assert.match(html, /no threads/);
});

test("thread-tree: 展开态头部带收起按钮（toggle-tree）", () => {
  const html = renderThreadTree(model, i18n.t);
  assert.match(html, /class="tt-collapse"[^>]*data-action="toggle-tree"/, "收起按钮");
  assert.doesNotMatch(html, /tt-rail/, "展开态非细轨");
});

// ── ③ 文件管理器式连线：层级靠 guide 连线（│ ├ └）体现，非仅靠相同圆点 ──
test("③ run/agent 带 guide 连线容器 + 分支肘（├ 非末项 / └ 末项）", () => {
  const html = renderThreadTree(model, i18n.t);
  assert.match(html, /tt-guides/, "连线容器在场");
  assert.match(html, /tt-branch/, "分支肘在场");
  // model：t-1 唯一 run（末项）→ run 分支 = └(last)
  const runToAgents = html.slice(html.indexOf('data-run-id="r-1"'), html.indexOf('data-agent-id="worker-a"'));
  assert.match(runToAgents, /<span class="tt-guides" aria-hidden="true"><span class="tt-guide tt-branch last"><\/span><\/span>/, "run=末项 └");
  // worker-a 非末项 → ├(through)；祖先(run)列留白（run 是末项，竖线不续下去）
  const aSlice = html.slice(html.indexOf('data-agent-id="worker-a"'), html.indexOf('data-agent-id="worker-b"'));
  assert.match(aSlice, /<span class="tt-guides" aria-hidden="true"><span class="tt-guide"><\/span><span class="tt-guide tt-branch through"><\/span><\/span>/, "worker-a=├ through + 祖先留白");
  // worker-b 末项 → └(last)
  const bSlice = html.slice(html.indexOf('data-agent-id="worker-b"'));
  assert.match(bSlice, /<span class="tt-guides" aria-hidden="true"><span class="tt-guide"><\/span><span class="tt-guide tt-branch last"><\/span><\/span>/, "worker-b=└ last");
  // thread（根）不挂 guide 连线
  const threadHead = html.slice(html.indexOf('data-thread-id="t-1"'), html.indexOf('data-run-id="r-1"'));
  assert.doesNotMatch(threadHead, /tt-guides/, "根 thread 无连线列");
});

test("③ CSS：连线用伪元素画（竖线 cont::before / 分支肘 branch::after）；零圆角零阴影", async () => {
  const css = await readFile(new URL("../ui/components/thread-tree.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /\.tt-guide\.cont::before\s*\{/, "祖先续接竖线");
  assert.match(noComments, /\.tt-branch::before\s*\{/, "分支肘竖段");
  assert.match(noComments, /\.tt-branch::after\s*\{/, "分支肘横臂");
  assert.match(noComments, /\.tt-branch\.through::before\s*\{[^}]*height:\s*100%/, "├ 非末项竖线贯穿");
  // 旧 padding 缩进已退役（连线列接管缩进）
  assert.doesNotMatch(noComments, /\.tt-depth-2\s*\{[^}]*padding-left/, "旧 padding 缩进已退役");
  assert.doesNotMatch(noComments, /border-radius|box-shadow|gradient/, "零圆角零阴影零渐变");
});

// ── 语义色统一(08-26 裁决「运行=蓝」)+ unknown 中性态 ──
test("状态色: running=蓝(--info,橙留给强调) + unknown=灰(未加载不谎报)", async () => {
  const css = await readFile(new URL("../ui/components/thread-tree.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /\.tt-dot\.status-running\s*\{\s*background:\s*var\(--info\)/, "running 状态点=任务蓝");
  assert.doesNotMatch(noComments, /\.tt-dot\.status-running\s*\{\s*background:\s*var\(--active\)/, "running 不再用橙(--active 留给 CTA/选中/强调)");
  assert.match(noComments, /\.tt-dot\.status-unknown\s*\{/, "unknown 中性态样式在场");
});

test("unknown 态: status=unknown 渲染灰点;缺失/未知状态回退 unknown 而非谎报 done", () => {
  const m = {
    threads: [
      { threadId: "t-u", runCount: 1, status: "unknown", expanded: false, runs: null },
      { threadId: "t-x", runCount: 1, expanded: false, runs: null }, // 无 status → 回退
    ],
    selected: null,
  };
  const html = renderThreadTree(m, i18n.t);
  assert.equal((html.match(/tt-dot status-unknown/g) || []).length, 2, "unknown 与缺失状态都落灰点");
  assert.doesNotMatch(html, /tt-dot status-done/, "未加载不得谎报 done");
});

test("thread-tree: 折叠态 → 细轨（每 thread 一状态点 + 展开按钮）", () => {
  const html = renderThreadTree({ ...model, collapsed: true }, i18n.t);
  assert.match(html, /thread-tree tt-rail/, "细轨容器");
  assert.match(html, /class="tt-rail-toggle"[^>]*data-action="toggle-tree"/, "展开按钮");
  // 每 thread 一个可点细轨点，点=选中该 thread（宿主页据此展开）
  assert.match(html, /tt-rail-dot[^>]*data-node-type="thread" data-thread-id="t-1"/);
  assert.match(html, /tt-rail-dot[^>]*data-node-type="thread" data-thread-id="t-2"/);
  assert.match(html, /tt-dot status-running/, "细轨点保留状态色");
  // 折叠态不铺开 run/agent 子级
  assert.doesNotMatch(html, /tt-depth-2/, "细轨不展开 run 级");
});
