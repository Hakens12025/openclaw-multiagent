import test from "node:test";
import assert from "node:assert/strict";

import { redactSecrets, SECRET_PLACEHOLDER } from "../lib/security/secret-redactor.js";

// 注意:本文件里的所有"密钥"都是**同形态的假值**。真实语料里的网关 token / hook token
// 一个字符都不会出现在这里 —— 测试文件本身不该成为新的泄漏点。
const FAKE_HEX_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718"; // 48 位小写 hex,与真值同形态
const FAKE_HOOK_TOKEN = "hook-test-token-9999";

test("redactSecrets 脱敏 URL query 里的网关 token(审计实测的泄漏形态)", () => {
  const line = `curl -s "http://localhost:18789/watchdog/debug?token=${FAKE_HEX_TOKEN}" | python3 -m json.tool`;
  const out = redactSecrets(line);

  assert.ok(!out.includes(FAKE_HEX_TOKEN), "密钥必须消失");
  assert.equal(
    out,
    `curl -s "http://localhost:18789/watchdog/debug?token=${SECRET_PLACEHOLDER}" | python3 -m json.tool`,
  );
});

test("redactSecrets 脱敏 Authorization: Bearer 头", () => {
  const out = redactSecrets(`-H "Authorization: Bearer ${FAKE_HOOK_TOKEN}" \\`);
  assert.equal(out, `-H "Authorization: Bearer ${SECRET_PLACEHOLDER}" \\`);
});

test("redactSecrets 脱敏 X-Hook-Token 自定义头(连字符提供 \\b)", () => {
  const out = redactSecrets(`-H "X-Hook-Token: ${FAKE_HOOK_TOKEN}" \\`);
  assert.equal(out, `-H "X-Hook-Token: ${SECRET_PLACEHOLDER}" \\`);
});

test("redactSecrets 脱敏 shell 变量赋值与 JSON 字段", () => {
  assert.equal(redactSecrets(`TOKEN="${FAKE_HOOK_TOKEN}"`), `TOKEN="${SECRET_PLACEHOLDER}"`);
  assert.equal(
    redactSecrets(`{"token": "${FAKE_HEX_TOKEN}"}`),
    `{"token": "${SECRET_PLACEHOLDER}"}`,
  );
});

test("redactSecrets 脱敏厂商前缀密钥与 JWT", () => {
  const vendor = "sk-abcdefghijklmnopqrstuvwxyz012345";
  assert.equal(redactSecrets(`export OPENAI_KEY=${vendor}`), `export OPENAI_KEY=${SECRET_PLACEHOLDER}`);

  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redactSecrets(`token: ${jwt}`), `token: ${SECRET_PLACEHOLDER}`);
});

test("redactSecrets 处理同一段文本里的多个密钥", () => {
  const text = [
    `TOKEN="${FAKE_HOOK_TOKEN}"`,
    `curl "http://x/debug?token=${FAKE_HEX_TOKEN}"`,
  ].join("\n");
  const out = redactSecrets(text);

  assert.ok(!out.includes(FAKE_HOOK_TOKEN));
  assert.ok(!out.includes(FAKE_HEX_TOKEN));
  assert.equal(out.split(SECRET_PLACEHOLDER).length - 1, 2);
});

// ---- 保守性:以下都必须**原样返回**,一个字符都不许改 ----

test("redactSecrets 不误伤代码标识符(实测误报语料:备忘录_多Agent实施计划:427)", () => {
  const line = "token = CancellationToken()";
  assert.equal(redactSecrets(line), line);
});

test("redactSecrets 不误伤环境变量引用(纯字母 value)", () => {
  const line = "apiKey: process.env.OPENAI_API_KEY";
  assert.equal(redactSecrets(line), line);
});

test("redactSecrets 不动无锚点的裸 hex(sha256 chunk hash 满地都是)", () => {
  const line = `chunk sha256 = 见下 | ${FAKE_HEX_TOKEN} | 增量复用命中`;
  // 有 `= 见下` 挡着,hex 前面没有凭据 key,不该被当密钥
  const out = redactSecrets(`chunk hash ${FAKE_HEX_TOKEN} 增量复用命中`);
  assert.equal(out, `chunk hash ${FAKE_HEX_TOKEN} 增量复用命中`);
  assert.ok(line.includes(FAKE_HEX_TOKEN)); // 语料构造自检
});

test("redactSecrets 不动模板占位符(实测语料 备忘录13:164 的 <hooks.token>)", () => {
  const line = "-H \"X-OpenClaw-Token: <hooks.token>\"";
  assert.equal(redactSecrets(line), line);
});

test("redactSecrets 不动短值(长度 < 16 视为非凭据)", () => {
  const line = "token=abc123";
  assert.equal(redactSecrets(line), line);
});

test("redactSecrets 不误吃 mytoken= 这类粘连 key", () => {
  const line = "mytoken=1234567890123456789";
  assert.equal(redactSecrets(line), line);
});

// ---- 契约:幂等 + 输入健壮 ----

test("redactSecrets 幂等,重复调用不二次替换", () => {
  const once = redactSecrets(`token=${FAKE_HEX_TOKEN}`);
  assert.equal(redactSecrets(once), once);
});

test("redactSecrets 对 null/undefined/非字符串输入返回字符串", () => {
  assert.equal(redactSecrets(null), "");
  assert.equal(redactSecrets(undefined), "");
  assert.equal(redactSecrets(12345), "12345");
});

test("口令家族即使不含数字也脱敏(与 token 家族的取舍不同)", () => {
  const line = 'password="correcthorsebatterystaple"';
  assert.equal(redactSecrets(line), `password="${SECRET_PLACEHOLDER}"`);
});

// ---- extraSecrets:字面量兜底,补锚点规则管不了的裸值 ----

test("extraSecrets 脱掉无锚点的裸值(实测残留形态:备忘录13:166 的 `- 当前值: <token>`)", () => {
  const line = `- 当前值: \`${FAKE_HOOK_TOKEN}\``;
  assert.equal(redactSecrets(line), line, "无 extraSecrets 时按设计漏检");
  assert.equal(
    redactSecrets(line, { extraSecrets: [FAKE_HOOK_TOKEN] }),
    `- 当前值: \`${SECRET_PLACEHOLDER}\``,
  );
});

test("extraSecrets 忽略过短条目,避免全文替换打烂正文", () => {
  const line = "loop 是核心循环,loop 出现很多次";
  assert.equal(redactSecrets(line, { extraSecrets: ["loop"] }), line);
});

test("extraSecrets 对空/undefined 条目不炸", () => {
  const line = "token=abc123";
  assert.equal(redactSecrets(line, { extraSecrets: [null, undefined, ""] }), line);
});
