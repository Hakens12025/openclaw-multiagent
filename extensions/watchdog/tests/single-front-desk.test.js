// tests/single-front-desk.test.js — 单前台守卫(备忘录156 §三方向B)。
//
// 2026-08-26 两桥合一:休眠壳 agent-for-kksl 退役,controller 成为唯一前台
// bridge/gateway。守三条不变量:
//   ① 渠道绑定单点:openclaw.json bindings 里 qqbot/feishu 都指向 controller;
//   ② 配置无退役 agent:agents.list 无 agent-for-kksl,且 controller 是唯一
//      gateway agent(第二 gateway 出现即回到两桥世界,①③ 的前提全失效);
//   ③ owner 改判死码不复活:ingress owner 解析是线性回退链
//      (explicit → source gateway → webui 前台 → replyTo),两桥时代的
//      "gateway 身份比对→改判 controller"分支(dd5b94f)已删,源码里不得再出现
//      gateway id 比对形状,也不得出现退役 agent id。
//
// ②依赖真实 openclaw.json——这份守卫的对象就是 live 配置本身,不是夹具。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_ROOT = join(TESTS_DIR, "..");
const OPENCLAW_ROOT = join(WATCHDOG_ROOT, "..", "..");

function loadLiveConfig() {
  return JSON.parse(readFileSync(join(OPENCLAW_ROOT, "openclaw.json"), "utf8"));
}

test("channel bindings all point at the controller front desk", () => {
  const cfg = loadLiveConfig();
  const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  assert.ok(bindings.length > 0, "expected at least one channel binding");
  for (const binding of bindings) {
    assert.equal(
      binding.agentId,
      "controller",
      `binding for channel ${binding?.match?.channel} must target controller`,
    );
  }
  const channels = new Set(bindings.map((binding) => binding?.match?.channel));
  assert.ok(channels.has("qqbot"), "qqbot channel binding missing");
  assert.ok(channels.has("feishu"), "feishu channel binding missing");
});

test("config has no retired agent-for-kksl and exactly one gateway agent", () => {
  const cfg = loadLiveConfig();
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  assert.ok(list.length > 0, "expected agents.list entries");
  assert.equal(
    list.some((agent) => agent?.id === "agent-for-kksl"),
    false,
    "agent-for-kksl must stay retired",
  );
  const gatewayIds = list.filter((agent) => agent?.gateway === true).map((agent) => agent.id);
  assert.deepEqual(gatewayIds, ["controller"], "controller must be the only gateway agent");
});

test("ingress owner resolution stays a linear fallback chain without gateway re-judgment", () => {
  const source = readFileSync(
    join(WATCHDOG_ROOT, "lib", "ingress", "dispatch-execution-contract-entry.js"),
    "utf8",
  );
  assert.ok(
    source.includes("resolveIngressDispatchOwnerAgent"),
    "owner resolver anchor missing — guard needs updating if it moved",
  );
  // 改判分支的形状:gateway id 之间的不等比对。线性回退链里不存在这种比对。
  assert.equal(
    /GatewayAgentId\s*!==|!==\s*\w*GatewayAgentId/u.test(source),
    false,
    "gateway-owner re-judgment comparison resurfaced in ingress owner resolution",
  );
});

test("lib tree carries no reference to the retired kksl bridge", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!/\.(js|mjs|cjs|json|md)$/u.test(entry)) continue;
      if (readFileSync(fullPath, "utf8").includes("kksl")) {
        offenders.push(fullPath);
      }
    }
  };
  walk(join(WATCHDOG_ROOT, "lib"));
  assert.deepEqual(offenders, [], "kksl reference resurfaced under lib/");
});
