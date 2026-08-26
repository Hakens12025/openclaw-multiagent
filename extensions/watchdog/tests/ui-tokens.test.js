import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("tokens: NASA-punk 全谱上色（2026-08-25 用户裁决,推翻 08-24 限色）+ 零圆角零阴影 + CJK 回退栈", async () => {
  const css = await readFile(new URL("../ui/core/tokens.css", import.meta.url), "utf8");
  // 底色层次
  assert.match(css, /--bg:\s*#FEF9EC/);
  assert.match(css, /--bg-2:\s*#F5EFD8/);
  assert.match(css, /--bg-3:\s*#EDE3C4/);
  // 五语义色
  assert.match(css, /--active:\s*#C87533/);   // NASA 橙
  assert.match(css, /--info:\s*#2E5FA8/);     // 任务蓝
  assert.match(css, /--alert:\s*#A83030/);    // 警告红
  assert.match(css, /--ok:\s*#3A7A4A/);       // 确认绿
  assert.match(css, /--amber:\s*#B8860B/);    // 琥珀
  // 黑色系对比度回调（08-25 二次裁决:黑都稍微高了——墨/线/深板全部压一档）
  assert.match(css, /--ink:\s*#2E2A24/);
  assert.match(css, /--line-soft:\s*#9C886E/);
  assert.match(css, /--bg-dark:\s*#262219/);
  // 字体清晰度:CJK 显式回退
  assert.match(css, /--font-mono:[^;]*PingFang SC[^;]*Microsoft YaHei/);
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(noComments, /border-radius|box-shadow/);
});
