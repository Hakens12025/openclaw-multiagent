// tests/system-action-reply-target.test.js — system_action 回件目标解析。
//
// 归位记录(2026-08-19):这两条原先住在回路测试里,退役时被抢救进
// system-action-legacy-payload-rejection.test.js —— 但那个文件守的是"legacy 载荷必须被拒",
// 与回件目标解析是两回事。混装本身就说明位置不对,故拆出独立成文件。
//
// 守的是 buildSystemActionReplyTarget 的两条不变量:
//   ①合约上带 live 渠道元数据(QQ channel/target/messageId…)时原样保留;
//   ②合约上没有时【不得】按 agent 身份凭空合成投递目标(只回 agentId+sessionKey)。
// ②是防回归位:靠 ingressSource 猜渠道会把结果投给错误的会话。

import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemActionReplyTarget } from "../lib/system-action/system-action-consumer.js";
import { runtimeAgentConfigs } from "../lib/state.js";

test("system action reply target preserves live QQ metadata from the current contract", () => {
  const replyTo = {
    agentId: "controller",
    sessionKey: "agent:controller:main",
    channel: "qqbot",
    target: "c2c:live-user",
    messageId: "msg-1",
    replyToId: "msg-1",
    accountId: "default",
  };

  assert.deepEqual(
    buildSystemActionReplyTarget({
      agentId: "controller",
      sessionKey: "agent:controller:contract:TC-QQ-ACTION",
      contractData: { replyTo },
    }),
    replyTo,
  );
});

test("system action reply target does not synthesize QQ delivery target from agent identity", () => {
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("controller", {
      id: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "qq",
    });

    assert.deepEqual(
      buildSystemActionReplyTarget({
        agentId: "controller",
        sessionKey: "agent:controller:contract:TC-QQ-ACTION",
        contractData: { id: "TC-QQ-ACTION" },
      }),
      {
        agentId: "controller",
        sessionKey: "agent:controller:contract:TC-QQ-ACTION",
      },
    );
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
  }
});
