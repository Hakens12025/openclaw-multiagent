/**
 * knowledge-markdown-chunker.test.js — lib/core/markdown-sections.js 的纯函数门。
 *
 * 覆盖 2026-08 语料审计修掉的 4 个缺陷,每条都带「真实语料形状」用例 + 回归用例:
 *   ① 规则1 去 /m         —— front-matter 规则必须锚在第 0 位,不得吞掉 section 中段
 *   ② splitMarkdownSections 围栏感知 —— 围栏内的 `# 注释` 不得当成 heading
 *   ③ 表格分隔行整行丢弃   —— |---|---| 不得把横杠灌进 chunk
 *   ④ HTML 注释拆壳保内容 —— 备忘录元数据头必须留下,标记必须剥掉
 * 以及 ⑤ 链接整条丢弃(本次只改注释、不改行为)的回归锁。
 *
 * 全纯函数,零 IO、零 ollama,可无条件进 gate。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  stripMarkdownNoise,
  splitMarkdownSections,
  extractFrontMatter,
} from "../lib/core/markdown-sections.js";

const lines = (...rows) => rows.join("\n");

// ─────────────────────────────────────────────────────────────────
// ① 规则1 去 /m:front-matter 规则只吃文档顶部
// ─────────────────────────────────────────────────────────────────

test("①-真实形状:#### 下的一对 --- 不再吞掉中间正文", () => {
  // 语料形状取自备忘录:#### 不是切段边界(splitMarkdownSections 只认 #{1,3}),
  // 所以 #### 段落里的两条 --- 会同时落进同一个 section buffer。
  // 带 /m 时 `^---\s*\n[\s\S]*?\n---\s*` 会从第一条 --- 一路删到第二条 ---,正文A 静默消失。
  const doc = lines("## 配置", "", "#### 细节", "", "---", "", "正文A", "", "---", "", "正文B");
  const [section] = splitMarkdownSections(doc);
  assert.equal(section.heading, "配置");
  assert.ok(section.text.includes("正文A"), `中段正文被吞:${section.text}`);
  assert.ok(section.text.includes("正文B"));
  assert.ok(section.text.includes("细节"));
});

test("①-回归:文档顶部真 front-matter 仍被剥掉", () => {
  const doc = lines("---", "issuer: 中信证券", "date: 2026-01-15", "---", "# 目标价上调", "", "我们预测目标价 200。");
  const sections = splitMarkdownSections(doc);
  assert.equal(sections.length, 1, "front-matter 段应被剥空,不产 section");
  assert.equal(sections[0].heading, "目标价上调");
  assert.ok(!sections[0].text.includes("issuer"));
  // 直接调 strip 也要剥掉
  assert.ok(!stripMarkdownNoise(doc).includes("issuer"));
});

test("①-回归:strip 与 extractFrontMatter 对同一块 front-matter 语义一致", () => {
  // 两者用同一个 pattern,曾经一个带 /m 一个不带 → 自相矛盾。锁住"剥掉的正是抓到的那块"。
  const doc = lines("---", "issuer: 中信证券", "date: 2026-01-15", "---", "正文");
  assert.deepEqual(extractFrontMatter(doc), { issuer: "中信证券", date: "2026-01-15" });
  assert.equal(stripMarkdownNoise(doc), "正文");

  // 非顶部的 --- 块:extractFrontMatter 抓不到,strip 也不许剥
  const notTop = lines("先有正文", "", "---", "k: v", "---", "尾巴");
  assert.deepEqual(extractFrontMatter(notTop), {});
  assert.ok(stripMarkdownNoise(notTop).includes("k: v"), "非顶部 --- 块不是 front-matter,不该被剥");
});

// ─────────────────────────────────────────────────────────────────
// ② 围栏感知:代码块里的 `# xxx` 不是 heading
// ─────────────────────────────────────────────────────────────────

test("②-真实形状:```bash 里的 # 注释不产幽灵 heading,不残留字面围栏", () => {
  // 逐字取自 use guide/[过时]备忘录11_[主]_V7系统全貌_2026-03-09-1630.md:99-105
  const doc = lines(
    "### Gateway 启动",
    "",
    "```bash",
    "# 无需代理",
    "cd ~/.openclaw && nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &",
    "```",
    "",
    "### 消息入口",
    "",
    "正文",
  );
  const sections = splitMarkdownSections(doc);
  assert.deepEqual(sections.map((s) => s.heading), ["消息入口"],
    "「Gateway 启动」整段只有代码 → 剥空不产 section;绝不能出现幽灵 heading「无需代理」");
  for (const s of sections) {
    assert.ok(!s.text.includes("```"), `残留字面围栏:${s.text}`);
    assert.ok(!s.text.includes("nohup"), `命令行原文进了索引:${s.text}`);
  }
});

test("②-真实形状:围栏内的 ## 也不切段", () => {
  const doc = lines("# 真标题", "", "```md", "## 假标题", "正文示例", "```", "", "尾巴");
  const sections = splitMarkdownSections(doc);
  assert.deepEqual(sections.map((s) => s.heading), ["真标题"]);
  assert.equal(sections[0].text, "尾巴");
});

test("②-回归:围栏外的 #/##/### 照常切段并保留 level", () => {
  const doc = lines("# A", "内容a", "## B", "内容b", "### C", "内容c");
  const sections = splitMarkdownSections(doc);
  assert.deepEqual(sections.map((s) => [s.heading, s.level, s.text]), [
    ["A", 1, "内容a"],
    ["B", 2, "内容b"],
    ["C", 3, "内容c"],
  ]);
});

test("②-回归:连续两个围栏开关正确配对,围栏之间的正文不丢", () => {
  const doc = lines("# H", "```js", "# c1", "```", "中间", "```sh", "# c2", "```", "结尾");
  const sections = splitMarkdownSections(doc);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "H");
  assert.equal(sections[0].text, "中间 结尾");
});

test("②-回归:#### 及更深仍不是切段边界(未改变既有边界定义)", () => {
  const doc = lines("# A", "内容a", "#### D", "内容d");
  const sections = splitMarkdownSections(doc);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "A");
  assert.ok(sections[0].text.includes("内容d"));
});

// ─────────────────────────────────────────────────────────────────
// ③ 表格分隔行整行丢弃
// ─────────────────────────────────────────────────────────────────

test("③-真实形状:|---|---| 分隔行不进 chunk,表头与数据全留", () => {
  const doc = lines(
    "| 入口 | Session Key 格式 | 处理方式 |",
    "|------|-----------------|---------|",
    "| QQ Bot | `agent:controller:main` | after_tool_call |",
  );
  const out = stripMarkdownNoise(doc);
  assert.ok(!out.includes("--"), `横杠残留:${out}`);
  assert.ok(out.includes("入口") && out.includes("处理方式"));
  assert.ok(out.includes("QQ Bot") && out.includes("after_tool_call"));
});

test("③-真实形状:带对齐冒号的分隔行也吃掉", () => {
  const out = stripMarkdownNoise(lines("| a | b | c |", "|:---|---:|:---:|", "| 1 | 2 | 3 |"));
  assert.ok(!out.includes("-"), `对齐分隔行残留:${out}`);
  assert.ok(out.includes("1") && out.includes("3"));
});

test("③-回归:单横杠占位单元格不被误吃(这就是用 -{2,} 而非 -+ 的原因)", () => {
  // 实测语料里有 27 行「含竖线、只由 -:| 空白组成、但没有连续横杠」的行
  const out = stripMarkdownNoise(lines("| 项 | 值 |", "|---|---|", "| - | - |"));
  assert.ok(out.includes("-"), `占位单元格被误吃:${out}`);
  assert.ok(!out.includes("---"), "真分隔行仍应被吃");
});

test("③-回归:独立 --- 水平线不归本规则管(不越界,行为同旧)", () => {
  const out = stripMarkdownNoise(lines("正文A", "", "---", "", "正文B"));
  assert.ok(out.includes("---"), "无竖线的 HR 不是表格分隔行,新规则不许碰");
});

test("③-回归:围栏里的 ASCII 表格随围栏一起消失,不触发本规则", () => {
  const out = stripMarkdownNoise(lines("```", "| a | b |", "|---|---|", "```", "尾巴"));
  assert.equal(out, "尾巴");
});

// ─────────────────────────────────────────────────────────────────
// ④ HTML 注释:拆壳保内容
// ─────────────────────────────────────────────────────────────────

test("④-真实形状:备忘录元数据头保留内容、剥掉标记", () => {
  // 形状取自 use guide/ 128/150 篇的统一头(摘要/涉及文件/状态/创建)
  const doc = lines(
    "<!--",
    "摘要：本次把「OpenClaw 是一栋多 agent 大楼」下沉为运行时显式引导。",
    "涉及文件：/Users/hakens/.openclaw/extensions/watchdog/index.js",
    "状态：活跃",
    "创建：2026-03-19 00:56",
    "-->",
    "",
    "# 正文标题",
    "内容",
  );
  const sections = splitMarkdownSections(doc);
  assert.equal(sections.length, 2, "头部注释现在自成一段(heading=null),不再被整块丢弃");
  const head = sections[0];
  assert.equal(head.heading, null);
  assert.ok(head.text.includes("摘要"), `摘要丢了:${head.text}`);
  assert.ok(head.text.includes("状态"));
  assert.ok(head.text.includes("涉及文件"));
  assert.ok(!head.text.includes("<!--") && !head.text.includes("-->"), `标记泄漏:${head.text}`);
});

test("④-真实形状:注释不在第 0 字节时也被处理(旧写法只吃第 0 字节)", () => {
  const out = stripMarkdownNoise(lines("开头正文", "", "<!-- 备注：这条以前会以字面量泄漏 -->", "", "尾巴"));
  assert.ok(!out.includes("<!--") && !out.includes("-->"), `标记泄漏:${out}`);
  assert.ok(out.includes("备注"));
  assert.ok(out.includes("开头正文") && out.includes("尾巴"));
});

test("④-回归:同一段里多个注释全部拆壳(旧写法无 /g,只吃第一个)", () => {
  const out = stripMarkdownNoise("<!-- A -->中间<!-- B -->");
  assert.ok(!out.includes("<!--") && !out.includes("-->"));
  assert.ok(out.includes("A") && out.includes("B") && out.includes("中间"));
});

test("④-回归:未闭合注释 fail-soft,不吞后文不抛", () => {
  const out = stripMarkdownNoise(lines("<!-- 没有闭合", "正文还在"));
  assert.equal(typeof out, "string");
  assert.ok(out.includes("正文还在"), "未闭合注释不许把后文吞掉");
});

// ─────────────────────────────────────────────────────────────────
// ⑤ 本次未改行为的规则:回归锁
// ─────────────────────────────────────────────────────────────────

test("⑤-回归:链接仍整条丢弃(文字也不留)、图片丢弃、行内 code 保留文字", () => {
  const out = stripMarkdownNoise("见 [三层协议](wiki/concepts/protocol.md) 与 ![图](a.png),字段 `model.primary`。");
  assert.ok(!out.includes("三层协议"), "链接文字策略被改动了");
  assert.ok(!out.includes("wiki/concepts"));
  assert.ok(!out.includes("a.png"));
  assert.ok(out.includes("model.primary"), "行内 code 应保留文字");
});

test("⑤-回归:引用/列表前缀与 heading 井号仍被剥,空白归一", () => {
  assert.equal(stripMarkdownNoise(lines("> 引用", "- 列表项", "* 星号项", "###### 六级")), "引用 列表项 星号项 六级");
});

test("⑤-回归:空输入/非字符串 fail-soft", () => {
  assert.equal(stripMarkdownNoise(""), "");
  assert.equal(stripMarkdownNoise(null), "");
  assert.equal(stripMarkdownNoise(undefined), "");
  assert.deepEqual(splitMarkdownSections(""), []);
  assert.deepEqual(splitMarkdownSections(null), []);
});

// ─────────────────────────────────────────────────────────────────
// 端到端:一篇真实形状的备忘录一次过全部 4 条修复
// ─────────────────────────────────────────────────────────────────

test("端到端:注释头 + 围栏内 # 注释 + 表格 + #### 下的 --- 同时正确", () => {
  const doc = lines(
    "<!--",
    "摘要：端到端形状。",
    "状态：活跃",
    "-->",
    "",
    "# 系统全貌",
    "",
    "本文记录 V7 的运行拓扑。",
    "",
    "### Gateway 启动",
    "",
    "```bash",
    "# 无需代理",
    "openclaw gateway run",
    "```",
    "",
    "### 消息入口",
    "",
    "| 入口 | 处理方式 |",
    "|------|---------|",
    "| QQ Bot | after_tool_call |",
    "",
    "#### 补充",
    "",
    "---",
    "",
    "补充正文",
  );
  const sections = splitMarkdownSections(doc);
  const headings = sections.map((s) => s.heading);
  assert.deepEqual(headings, [null, "系统全貌", "消息入口"],
    "注释头自成一段;「Gateway 启动」纯代码被剥空;无幽灵 heading");
  assert.ok(sections[0].text.includes("状态"));
  const last = sections.at(-1).text;
  assert.ok(last.includes("QQ Bot") && last.includes("after_tool_call"));
  assert.ok(!last.includes("------"), `表格分隔行横杠残留:${last}`);
  assert.ok(last.includes("补充正文"), "#### 下的 --- 不许吞正文");
  // 独立 HR `---` 仍在:本次只治表格分隔行,不越界动 HR(实测两库 700 行 HR,属另一笔待评估改动)
  assert.ok(last.includes("---"), "独立 HR 不在本次修复范围,行为应同旧");
  for (const s of sections) assert.ok(!s.text.includes("```"), `围栏残留:${s.text}`);
});
