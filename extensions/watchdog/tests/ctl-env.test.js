// Tests: openclawctl 纯逻辑层(scripts/ctl/ctl-env.js)——产品化批1 的地基守卫。
//
// 锁五件事:
//   ① parseEnvFile:KEY=VALUE/注释/引号/坏行容忍,纯解析不 source(bash 退役的替换点);
//   ② buildGatewayEnv 的 NO_PROXY 地板:只要声明了代理,localhost/127.0.0.1/::1 恒在——
//      不设会把 localhost embed 塞进隧道(2026-08-07 实证事故);
//   ③ 产品默认零代理:profile 无代理声明 → env 不带任何 proxy 键;
//   ④ token 占位判定与自动签发形状(48 hex);
//   ⑤ Node 版本门(node:sqlite 免 flag ≥22.13)。
//
// Run: node --test tests/ctl-env.test.js

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvFile,
  buildGatewayEnv,
  NO_PROXY_FLOOR,
  generateGatewayToken,
  isPlaceholderToken,
  nodeVersionSatisfies,
  gatewayPortOf,
  agentIdsOf,
  frontendUrl,
} from "../../../scripts/ctl/ctl-env.js";

test("parseEnvFile: KEY=VALUE/注释/引号/坏行", () => {
  const parsed = parseEnvFile([
    "# comment",
    "PLAIN=abc",
    'QUOTED="http://127.0.0.1:7897"',
    "SINGLE='v'",
    "  SPACED = padded  ",
    "no_eq_line",
    "=novalue",
    "1BAD=key",
    "",
  ].join("\n"));
  assert.deepEqual(parsed, {
    PLAIN: "abc",
    QUOTED: "http://127.0.0.1:7897",
    SINGLE: "v",
    SPACED: "padded",
  });
});

test("buildGatewayEnv: 声明代理 → NO_PROXY 地板恒在且与 profile 清单取并集", () => {
  const env = buildGatewayEnv({
    profileEnv: {
      OPENCLAW_HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: ".volces.com,localhost",
    },
  });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7897", "HTTP_PROXY 缺省跟随 HTTPS_PROXY");
  const noProxy = env.NO_PROXY.split(",");
  for (const floor of NO_PROXY_FLOOR) {
    assert.ok(noProxy.includes(floor), `地板项 ${floor} 必须在(embed 走本地不进隧道)`);
  }
  assert.ok(noProxy.includes(".volces.com"), "profile 声明的直连域保留");
  assert.equal(new Set(noProxy).size, noProxy.length, "去重");
  assert.equal(env.no_proxy, env.NO_PROXY, "大小写双写(Node fetch 双读)");
});

test("buildGatewayEnv: 产品默认零代理零 CA → 空 env", () => {
  assert.deepEqual(buildGatewayEnv({ profileEnv: {} }), {});
});

test("buildGatewayEnv: CA bundle 在场 → NODE_EXTRA_CA_CERTS + NODE_USE_SYSTEM_CA(对齐 live plist)", () => {
  const env = buildGatewayEnv({ profileEnv: {}, caBundleExists: true, caBundlePath: "/x/roots.pem" });
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/x/roots.pem");
  assert.equal(env.NODE_USE_SYSTEM_CA, "1");
});

test("token: 占位判定与签发形状(48 hex)", () => {
  for (const bad of [null, "", "  ", "REDACTED_FOR_PUBLIC", "CHANGE_ME", "your-token-here"]) {
    assert.equal(isPlaceholderToken(bad), true, `${JSON.stringify(bad)} 应判占位`);
  }
  const token = generateGatewayToken();
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(isPlaceholderToken(token), false);
});

test("nodeVersionSatisfies: 22.13 地板(node:sqlite 免 flag)", () => {
  assert.equal(nodeVersionSatisfies("v22.13.0"), true);
  assert.equal(nodeVersionSatisfies("v25.6.1"), true);
  assert.equal(nodeVersionSatisfies("v22.12.9"), false);
  assert.equal(nodeVersionSatisfies("v20.11.0"), false);
  assert.equal(nodeVersionSatisfies("garbage"), false);
});

test("配置读数: 端口优先级(profile>config>默认)与花名册/前端地址", () => {
  assert.equal(gatewayPortOf({ gateway: { port: 9000 } }, { OPENCLAW_GATEWAY_PORT: "18789" }), 18789);
  assert.equal(gatewayPortOf({ gateway: { port: 9000 } }, {}), 9000);
  assert.equal(gatewayPortOf(null, {}), 18789);
  assert.deepEqual(agentIdsOf({ agents: { list: [{ id: "a" }, { id: " b " }, { noId: 1 }] } }), ["a", "b"]);
  assert.equal(frontendUrl(18789, "tok"), "http://localhost:18789/watchdog/?token=tok");
  assert.equal(frontendUrl(18789, null), "http://localhost:18789/watchdog/");
});
