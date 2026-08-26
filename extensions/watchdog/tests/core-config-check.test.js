// tests/core-config-check.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { validateCfgAssignment } from "../lib/core/config-check.js";

const GOOD = Object.freeze({
  hooksToken: "", qqAppId: "", qqClientSecret: "",
  gatewayPort: 18789, gatewayToken: "tok", agentTimeout: 1800000,
});

test("合法配置原样通过（空字符串合法——是否必填是部署策略,不是类型问题）", () => {
  assert.deepEqual(validateCfgAssignment({ ...GOOD }), GOOD);
});

test("端口越界即抛,报错带字段名", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, gatewayPort: 0 }), /E-CONFIG-003[\s\S]*gatewayPort/);
  assert.throws(() => validateCfgAssignment({ ...GOOD, gatewayPort: 70000 }), /gatewayPort/);
});

test("agentTimeout 非正整数即抛", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, agentTimeout: -1 }), /agentTimeout/);
  assert.throws(() => validateCfgAssignment({ ...GOOD, agentTimeout: 1.5 }), /agentTimeout/);
});

test("类型错误即抛", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, hooksToken: 123 }), /hooksToken/);
});

test("未知键即抛（防拼写错的配置静默失效）", () => {
  assert.throws(() => validateCfgAssignment({ ...GOOD, gatewyToken: "x" }), /unknown keys[\s\S]*gatewyToken/);
});

test("多个错误一次全报", () => {
  try {
    validateCfgAssignment({ ...GOOD, gatewayPort: 0, agentTimeout: -1 });
    assert.fail("should throw");
  } catch (error) {
    assert.match(error.message, /gatewayPort/);
    assert.match(error.message, /agentTimeout/);
  }
});
