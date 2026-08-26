// Tests: ui/pages/manage/ — 管理区(批3)纯渲染契约。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createI18n } from "../ui/core/i18n.js";
import { renderAgentsView } from "../ui/pages/manage/agents.js";
import { renderKnowledgeView } from "../ui/pages/manage/knowledge.js";
import { renderControlPlaneView } from "../ui/pages/manage/control-plane.js";
import { renderDevtoolsView } from "../ui/pages/manage/devtools.js";
import { renderChartsView } from "../ui/pages/manage/charts.js";

const i18n = createI18n({ lang: "en-US" });
const includes = (html, needle) => assert.ok(html.includes(needle), `应包含: ${needle}`);

test("manage/agents: 卡片网格 + 面(控制/执行)标签 + 装配读数", () => {
  const html = renderAgentsView([
    { id: "controller", role: "bridge", plane: "control", model: "kimi/kimi-for-coding", effectiveSkills: ["a"], capabilities: { tools: ["read"] }, effectiveHeartbeatEvery: "2h", description: "bridge node" },
    { id: "worker", role: "executor", plane: "execution", model: "m", effectiveSkills: [], capabilities: {}, effectiveHeartbeatEvery: "1h" },
  ], i18n.t);
  assert.equal((html.match(/class="mg-card agent-card"/g) || []).length, 2);
  includes(html, 'mg-tag is-plane-control">CONTROL');
  includes(html, 'mg-tag is-plane-exec">EXECUTION');
  includes(html, "SKILLS: <b>1</b>");
  includes(html, "HEARTBEAT: <b>2h</b>");
  assert.match(renderAgentsView([], i18n.t), /mg-state/); // 空态
});

test("manage/knowledge: 库选择 + 评测集表格(带跑评测钮) + 检索/维护表单", () => {
  const html = renderKnowledgeView({
    kbs: [{ id: "memos" }, { id: "wiki" }],
    kbId: "memos",
    evalSets: [{ id: "es-1", cases: [1, 2] }],
    evalRuns: [{ id: "r1", startedAt: 1787600000000, status: "done", metrics: { mrr: 0.5 } }],
    busy: false,
  }, i18n.t);
  includes(html, 'data-mg-act="kb"');
  includes(html, '<option value="memos" selected>');
  includes(html, 'data-mg-act="eval-run" data-set="es-1"');
  includes(html, 'data-mg-form="search"');
  includes(html, 'data-mg-form="add"');
  includes(html, 'data-mg-form="reindex"');
  includes(html, "CASES</th>");
});

test("manage/knowledge: 浅卡按钮用 mg-btn(墨字可读),不再借深色头带的 gb-btn", async () => {
  const html = renderKnowledgeView({ kbs: [{ id: "memos" }], kbId: "memos", evalSets: [{ id: "es-1", cases: [] }], evalRuns: [], busy: false }, i18n.t);
  assert.doesNotMatch(html, /gb-btn/, "gb-btn 是深色头带专用(米白字),浅卡上不可读");
  assert.ok((html.match(/class="mg-btn"/g) || []).length >= 4, "search/eval-run/add/reindex 四钮都走 mg-btn");
  // CSS:mg-btn 必须是浅底墨字(可读),而 gb-btn 保持米白字(深头带用)
  const css = await readFile(new URL("../ui/pages/manage/manage.css", import.meta.url), "utf8");
  const rule = (css.match(/\.mg-btn\s*\{[^}]*\}/) || [""])[0];
  assert.match(rule, /color:\s*var\(--ink\)/, "mg-btn 墨字");
  assert.match(rule, /background:\s*var\(--bg\)/, "mg-btn 纸底");
  assert.match(css, /\.mg-btn:disabled/, "busy 禁用态有降灰样式");
});

test("manage/knowledge: 搜索词回写——渲染回填 state.search + 提交时写回(不清空输入框)", async () => {
  const html = renderKnowledgeView({ kbs: [], kbId: "k", evalSets: [], evalRuns: [], search: "how to rag", busy: true }, i18n.t);
  assert.match(html, /name="query"[^>]*value="how to rag"/, "busy 重渲用 state.search 回填输入框");
  // 接线层守卫:submit 时必须把 query 写回 state.search(否则 busy 重渲即清空)
  const src = await readFile(new URL("../ui/pages/manage/knowledge.js", import.meta.url), "utf8");
  assert.match(src, /state\.search = String\(fd\.get\("query"\)/, "onSubmit 把搜索词回写 state.search");
});

test("manage/index: 死码 renderState 已删(零引用)", async () => {
  const src = await readFile(new URL("../ui/pages/manage/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /renderState/, "renderState 零引用死码不复活");
});

test("manage/control-plane: operator 快照读数带 + 变更集表", () => {
  const html = renderControlPlaneView({
    snapshot: { summary: { state: "idle", attentionCount: 0, enabledAutomations: 1 } },
    changeSets: { drafts: [{ id: "cs-1", surface: "apply.x", status: "draft", createdAt: 1787600000000 }] },
  }, i18n.t);
  includes(html, 'data-cp="state"');
  includes(html, 'is-done">idle');        // idle 态染绿
  includes(html, 'is-active">1');         // 启用中的自动化染橙
  includes(html, "cs-1");
});

test("manage/devtools: 模型注册表 + 预设卡 + 运行表", () => {
  const html = renderDevtoolsView({
    models: [{ provider: "ark", id: "deepseek-v3.2", name: "DeepSeek", api: "anthropic-messages" }],
    presets: [{ id: "health", runtimeMode: "static", description: "zero-LLM checks" }],
    runs: [],
  }, i18n.t);
  includes(html, "MODEL REGISTRY (1)");
  includes(html, "deepseek-v3.2");
  includes(html, "dev-preset");
  assert.match(html, /mg-state/); // 空运行历史走三态
});

test("manage/charts: 批3 占位说明(编排器后续批)", () => {
  const html = renderChartsView(i18n.t);
  includes(html, "viz/plan");
  assert.match(html, /mg-note/);
});
