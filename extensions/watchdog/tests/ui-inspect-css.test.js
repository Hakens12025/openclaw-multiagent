import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// inspect.css 结构守卫（⑥ Tab 顶部墨线 + ④ 结构层度量位样式）。CSS-only 改动的反证在此。

test("inspect-css ⑥: 非选中 Tab 顶部 1px 细黑线(随 border),仅选中换 3px 橙粗条", async () => {
  const css = await readFile(new URL("../ui/pages/inspect/inspect.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // 非选中 Tab 顶边=细黑线(走 border=1px,不单独设 border-top)——不得是粗黑(3px ink)也不得透明
  assert.match(noComments, /\.insp-tab\s*\{[^}]*border:\s*var\(--border\)/, "非选中 Tab 走 1px 细黑框(含顶)");
  assert.doesNotMatch(noComments, /\.insp-tab\s*\{[^}]*border-top:\s*3px solid var\(--ink\)/, "非选中 Tab 顶边不得是粗黑线");
  assert.doesNotMatch(noComments, /\.insp-tab\s*\{[^}]*border-top:\s*3px solid transparent/, "非选中 Tab 顶边不得透明(要有细黑线)");
  // 选中 Tab 顶边换 3px 橙粗条 + padding 补偿防跳
  assert.match(noComments, /\.insp-tab\.active\s*\{[^}]*border-top:\s*3px solid var\(--active\)/, "选中 Tab 橙粗顶条");
  assert.match(noComments, /\.insp-tab\.active\s*\{[^}]*padding-top:\s*calc/, "选中 padding 补偿防跳动");
});

test("inspect-css ④: 结构层度量位 pl-bar-na 有 --muted 样式（替代空白条）", async () => {
  const css = await readFile(new URL("../ui/pages/inspect/inspect.css", import.meta.url), "utf8");
  assert.match(css, /\.pl-bar-na\s*\{[^}]*color:\s*var\(--muted\)/, "结构标记走 --muted");
});

test("inspect-css: 执行模型读数条走读数带规格(面板底+细黑框),橙顶条仍归主面板", async () => {
  const css = await readFile(new URL("../ui/pages/inspect/inspect.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /\.insp-exec\s*\{[^}]*border:\s*var\(--border\)/, "读数条=细黑框");
  assert.match(noComments, /\.insp-exec\s*\{[^}]*background:\s*var\(--bg-2\)/, "面板底");
  assert.doesNotMatch(noComments, /\.insp-exec\s*\{[^}]*border-top:\s*3px/, "元信息不抢橙顶条(那是主面板的强调)");
  assert.match(noComments, /\.insp-exec-model\s*\{[^}]*color:\s*var\(--info\)/, "模型值走任务蓝");
});

test("inspect-css: 纪律不变——零圆角零阴影（网格底的 1px linear-gradient 是功能线非材质渐变,豁免）", async () => {
  const css = await readFile(new URL("../ui/pages/inspect/inspect.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(noComments, /border-radius|box-shadow/);
});

test("inspect-css 治闪动:面板容器不挂入场动画(重建重播=闪);insp-panel-in 已退役", async () => {
  const css = await readFile(new URL("../ui/pages/inspect/inspect.css", import.meta.url), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // 每次交互重建 innerHTML,容器上的入场动画会重播成「像刷新」的闪动——不得复活
  assert.doesNotMatch(noComments, /animation:\s*insp-panel-in/, "容器不得挂 insp-panel-in");
  assert.doesNotMatch(noComments, /@keyframes\s+insp-panel-in/, "insp-panel-in 关键帧已退役");
  // 平滑只留给真正新出现的详情块(insp-reveal 淡入)
  assert.match(noComments, /@keyframes\s+insp-reveal/, "详情块淡入 insp-reveal 保留");
});
