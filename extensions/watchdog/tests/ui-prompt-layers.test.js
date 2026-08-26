import test from "node:test";
import assert from "node:assert/strict";
import { renderPromptLayers } from "../ui/components/prompt-layers.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });

// inspect.session_system_prompt 出闸形状（六层投影 + injectedFiles + activePath/source）
// 与真值一致（curl 抽查 TC run planner）：framework/tools/skills 是结构装配层——present 但无 chars；
// role/soul/wake 才带 chars(=content.length)。旧夹具误给 tools chars 是与真值背离，本次校正。
const report = {
  available: true,
  source: "run",
  activePath: "dispatch-agent-awake",
  layers: [
    { layer: "framework", name: "framework base", present: true, source: "framework-managed" },
    { layer: "tools", name: "tools binding", present: true, source: "binding" },
    { layer: "skills", name: "skill heads", present: false, source: "unavailable" },
    { layer: "role", name: "role persona", present: true, source: "role-spec", chars: 1071, content: "You are a worker." },
    { layer: "soul", name: "user soul", present: true, source: "user-soul", chars: 110, content: "be kind" },
    { layer: "wake", name: "wake mechanism", present: true, source: "contract-session-override", chars: 993, content: "wake up" },
  ],
  injectedFiles: [
    { name: "AGENTS.md", path: "/w/AGENTS.md", content: "agent guidance body", contentChars: 19, persistent: true, truncated: false },
    { name: "SOUL.md", path: "/w/SOUL.md", content: "soul body", contentChars: 9, persistent: true, truncated: true },
  ],
  totalContentChars: 28,
};

test("prompt-layers: 六层装配栈齐渲染 + present/absent 灯 + 占比条 + chars", () => {
  const html = renderPromptLayers({ report, openLayer: null, openFile: null }, i18n.t);
  for (const layer of ["framework", "tools", "skills", "role", "soul", "wake"]) {
    assert.match(html, new RegExp(`data-layer="${layer}"`), `六层缺 ${layer}`);
  }
  assert.match(html, /pl-layer-present/, "在场层标记");
  assert.match(html, /pl-layer-absent/, "缺席层标记");
  assert.match(html, /pl-lamp/, "在场指示灯");
  assert.match(html, /pl-bar-fill/, "字符数占比条");
  assert.match(html, /1071/, "chars 原值计数(不缩写)");
  assert.match(html, /dispatch-agent-awake/, "activePath 角标");
  assert.match(html, /ASSEMBLY STACK/, "装配栈标题");
  assert.match(html, /data-action="toggle-layer"/);
});

test("prompt-layers: 展开层显示 source + content 全文；缺席层无 content 槽", () => {
  const html = renderPromptLayers({ report, openLayer: "role", openFile: null }, i18n.t);
  assert.match(html, /pl-layer-source/, "展开层显示 source 行");
  assert.match(html, /role-spec/, "展开层 source 值");
  assert.match(html, /pl-layer-content/, "展开层有正文槽");
  assert.match(html, /You are a worker\./);
  // 未展开层不出正文/source
  assert.doesNotMatch(html, /be kind/, "soul 层未展开不出正文");
  assert.doesNotMatch(html, /framework-managed/, "未展开层不出 source");
});

test("prompt-layers: injectedFiles 列表 + truncated 标记 + 展开正文", () => {
  const html = renderPromptLayers({ report, openLayer: null, openFile: "SOUL.md" }, i18n.t);
  assert.match(html, /pl-file-row/, "注入文件清单");
  assert.match(html, /AGENTS\.md/);
  assert.match(html, /pl-truncated/, "truncated 标记如实显示");
  assert.match(html, /soul body/, "展开文件正文");
});

test("prompt-layers ④: 结构层(present 无 chars)显结构标记不画空白条；可度量层才有橙比例条", () => {
  const html = renderPromptLayers({ report, openLayer: null, openFile: null }, i18n.t);
  // 可度量层 role/soul/wake → 恰 3 条橙比例条（chars>0 才画）
  const fills = html.match(/pl-bar-fill/g) || [];
  assert.equal(fills.length, 3, "只有 chars>0 的层才有橙比例条");
  // 结构层 framework/tools → 结构标记 pl-bar-na（present 无 chars，不画空白条）
  const naCount = (html.match(/pl-bar-na/g) || []).length;
  assert.equal(naCount, 2, "framework/tools 两个结构层显结构标记");
  assert.match(html, /structural/, "结构标记文案(i18n)");
  // 反证:结构层 framework 那一行不含 pl-bar-fill（旧代码此处会画 width:0 空白条=「全白」病根）
  const frameworkRow = html.slice(html.indexOf('data-layer="framework"'), html.indexOf('data-layer="tools"'));
  assert.doesNotMatch(frameworkRow, /pl-bar-fill/, "结构层不再画 width:0 空白条");
  assert.match(frameworkRow, /pl-bar-na/, "结构层用结构标记替代空白条");
});

test("prompt-layers: 无装配报告 → unavailable 态", () => {
  const html = renderPromptLayers({ report: { available: false }, openLayer: null, openFile: null }, i18n.t);
  assert.match(html, /pl-unavailable/);
  assert.match(html, /no assembly report/);
});
