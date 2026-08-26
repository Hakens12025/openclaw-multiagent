// tests/wake-receipt-attribution.test.js — 言面收口 P0 守卫(备忘录156 四层②)。
// 宿主把 hook 隔离运行的回执塞进 default agent(controller) main 会话:
//   载荷缺 name → 横幅显示为无归属的 "Hook Hook";wakeMode:"now" → 每合约结束强拍醒 controller。
// 守卫:hooks 派发载荷必须带 runtime:<agentId> 归属名,且 wakeMode=next-heartbeat(不强拍醒)。
// 反证:改回 wakeMode:"now" 或删 name → 红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SRC = new URL("../lib/transport/runtime-wake-transport.js", import.meta.url);

test("P0: hooks 派发载荷带 runtime:<agentId> 归属名(回执自述来源,不再是 Hook Hook)", async () => {
  const src = await readFile(SRC, "utf8");
  assert.match(src, /name:\s*`runtime:\$\{agentId\}/, "载荷必须带 name: runtime:<agentId>");
  // 合约会话拼 cid 尾巴(回执可定位到合约)
  assert.match(src, /:contract:/, "sessionKey 含 :contract: 时归属名拼合约尾");
});

test("P0: hooks 派发 wakeMode=next-heartbeat(回执不强拍醒 controller;目标 agent 运行不受影响)", async () => {
  const src = await readFile(SRC, "utf8");
  const noComments = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /wakeMode:\s*"next-heartbeat"/, "wakeMode 必须是 next-heartbeat");
  assert.doesNotMatch(noComments, /wakeMode:\s*"now"/, "禁止回退到 now(每合约结束强拍醒 controller=言面泄漏放大器)");
});

test("P1: HEARTBEAT 模板定义 Hook 回执语义(遥测只供知悉,HEARTBEAT_OK 收尾)", async () => {
  const src = await readFile(new URL("../lib/prompt/platform-doc-builder.js", import.meta.url), "utf8");
  assert.match(src, /以 \\`Hook\\` 开头的系统事件/, "心跳模板必须给 Hook 系统事件下定义");
  assert.match(src, /回执仅供知悉/, "回执=只读遥测的语义在场");
});