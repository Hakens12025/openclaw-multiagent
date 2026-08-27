import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

// mock 特定符必须与被测 lib 的动态 import 特定符逐字同源(channel-notify.js:8 用
// process.env.HOME 拼 QQBOT_DIST)——写死 /Users/<user> 在 CI/别机 HOME 下 mock 落空,
// 真 import 走丢(qqbot/dist 被 gitignore)→ qqNotify 全线 ok:false。
const QQBOT_DIST = join(process.env.HOME || "", ".openclaw", "extensions", "qqbot", "dist", "src");

// mock.module 注册时即解析特定符:dist 是构建产物(gitignore),全新 checkout/离线 CI 缺席
// → 注册直接 ERR_MODULE_NOT_FOUND 拖垮全文件。存在才注册;吃 mock 的传输用例同门 skip,
// 纯函数用例(normalizeReplyTarget / synthetic 拒收)照常全跑。
const qqbotDistPresent = existsSync(join(QQBOT_DIST, "outbound.js")) && existsSync(join(QQBOT_DIST, "api.js"));
const QQBOT_DIST_SKIP = qqbotDistPresent
  ? false
  : "qqbot dist 构建产物缺席(全新环境未构建 qqbot,mock 特定符无法解析)";

const sendTextCalls = [];
const sendProactiveCalls = [];

mock.module("../lib/state.js", {
  namedExports: {
    cfg: {
      qqAppId: "app-id",
      qqClientSecret: "client-secret",
    },
  },
});

mock.module("../lib/agent/agent-identity.js", {
  namedExports: {
    isBridgeAgent: () => false,
  },
});

if (qqbotDistPresent) {
  mock.module(join(QQBOT_DIST, "outbound.js"), {
    namedExports: {
      sendText: async (payload) => {
        sendTextCalls.push(payload);
        return { channel: "qqbot", messageId: "reply-message-id", timestamp: 123 };
      },
      sendProactiveMessage: async (...args) => {
        sendProactiveCalls.push(args);
        return { channel: "qqbot", messageId: "proactive-message-id", timestamp: 456 };
      },
    },
  });

  mock.module(join(QQBOT_DIST, "api.js"), {
    namedExports: {
      getAccessToken: async () => "token",
      sendC2CInputNotify: async () => ({}),
    },
  });
}

const { getQQTarget, qqNotify, hasQQPassiveReplyTarget } = await import("../lib/transport/channel-notify.js");
const { normalizeReplyTarget } = await import("../lib/routing/coordination-primitives.js");

test("normalizeReplyTarget preserves QQ passive reply message id fields", () => {
  assert.deepEqual(
    normalizeReplyTarget({
      agentId: "controller",
      sessionKey: "agent:controller:main",
      channel: "qqbot",
      target: "openid-1",
      messageId: "msg-1",
      replyToId: "msg-2",
    }),
    {
      agentId: "controller",
      sessionKey: "agent:controller:main",
      channel: "qqbot",
      target: "openid-1",
      messageId: "msg-1",
      replyToId: "msg-2",
    },
  );
});

test("qqNotify uses passive reply when reply target carries message id", { skip: QQBOT_DIST_SKIP }, async () => {
  sendTextCalls.length = 0;
  sendProactiveCalls.length = 0;

  const replyTarget = {
    channel: "qqbot",
    target: "openid-1",
    messageId: "msg-1",
    accountId: "default",
  };
  assert.deepEqual(getQQTarget({ replyTo: replyTarget }), replyTarget);

  const result = await qqNotify(replyTarget, "完成");

  assert.equal(result.ok, true);
  assert.equal(sendTextCalls.length, 1);
  assert.equal(sendProactiveCalls.length, 0);
  assert.equal(sendTextCalls[0].to, "openid-1");
  assert.equal(sendTextCalls[0].replyToId, "msg-1");
  assert.equal(sendTextCalls[0].text, "完成");
  assert.equal(sendTextCalls[0].accountId, "default");
  assert.equal(hasQQPassiveReplyTarget(replyTarget), true);
});

test("qqNotify preserves group reply target prefix for passive group replies", { skip: QQBOT_DIST_SKIP }, async () => {
  sendTextCalls.length = 0;
  sendProactiveCalls.length = 0;

  const replyTarget = {
    channel: "qqbot",
    target: "group:group-openid-1",
    messageId: "group-msg-1",
    accountId: "default",
  };

  const result = await qqNotify(replyTarget, "群聊完成");

  assert.equal(result.ok, true);
  assert.equal(sendTextCalls.length, 1);
  assert.equal(sendProactiveCalls.length, 0);
  assert.equal(sendTextCalls[0].to, "group:group-openid-1");
  assert.equal(sendTextCalls[0].replyToId, "group-msg-1");
  assert.equal(sendTextCalls[0].text, "群聊完成");
});

test("qqNotify still uses proactive send when no passive reply id exists", { skip: QQBOT_DIST_SKIP }, async () => {
  sendTextCalls.length = 0;
  sendProactiveCalls.length = 0;

  const result = await qqNotify("openid-2", "完成");

  assert.equal(result.ok, true);
  assert.equal(sendTextCalls.length, 0);
  assert.equal(sendProactiveCalls.length, 1);
  assert.equal(sendProactiveCalls[0][1], "openid-2");
  assert.equal(sendProactiveCalls[0][2], "完成");
  assert.equal(hasQQPassiveReplyTarget("openid-2"), false);
});

test("qqNotify rejects synthetic QQ targets before calling outbound transport", async () => {
  sendTextCalls.length = 0;
  sendProactiveCalls.length = 0;

  const result = await qqNotify({
    channel: "qqbot",
    target: "c2c:synthetic-test",
    messageId: "synthetic-msg",
    accountId: "default",
  }, "完成");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_target");
  assert.match(result.detail, /synthetic QQ target/u);
  assert.equal(sendTextCalls.length, 0);
  assert.equal(sendProactiveCalls.length, 0);
});
