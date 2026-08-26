import test from "node:test";
import assert from "node:assert/strict";

import { deriveSystemActionTerminalOutcome } from "../lib/system-action/system-action-runtime-ledger.js";
import { CONTRACT_STATUS, SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES } from "../lib/protocol/protocol-primitives.js";

// deriveSystemActionTerminalOutcome 是 agent_end 终态阶梯的第二级
// (lib/lifecycle/agent-end/terminal.js:213-215:deferred > systemAction失败 > graph终态 > 事实收口)。
// 它守的是通用属性,与图回路无关 —— 回路退役(dd04e57..d4a08a0)把仅有的两处引用
// (advance-loop-no-kill / unified-control-plane-p0 的 start_loop 用例)一并删掉后,
// 这条阶梯在 HEAD 上零测试。本文件直调纯函数补网,不 mock。
//
// 三分支(system-action-runtime-ledger.js:102-128):
//   ① 无结果 / NO_ACTION / deferred 已受理 → null(不由 system_action 代收终态)
//   ② executionObservation.collected === true → null(采集到产物就按事实收口)
//   ③ 其余 → FAILED,reason 走 buildSystemActionFailureReason 四级阶梯
// 分支②回归的表现是**把成功轮判成 FAILED**,分支①回归的表现是**把已受理的委派轮杀掉**。

const DEFERRED_PRODUCERS = [
  INTENT_TYPES.CREATE_TASK,
  INTENT_TYPES.ASSIGN_TASK,
];

// deferred 家族(runtime-status.js:45-49):比受理凭证多一个 WAKE_FAILED ——
// 委派已落盘,唤醒失败不该把源约判死。
const DEFERRED_ACCEPTED_STATUSES = [
  SYSTEM_ACTION_STATUS.DISPATCHED,
  SYSTEM_ACTION_STATUS.QUEUED,
  SYSTEM_ACTION_STATUS.WAKE_FAILED,
];

const FAILURE_STATUSES = [
  SYSTEM_ACTION_STATUS.BUSY,
  SYSTEM_ACTION_STATUS.INVALID_PARAMS,
  SYSTEM_ACTION_STATUS.INVALID_STATE,
  SYSTEM_ACTION_STATUS.NOT_IMPLEMENTED,
  SYSTEM_ACTION_STATUS.UNKNOWN_ACTION,
  SYSTEM_ACTION_STATUS.DISPATCH_ERROR,
  SYSTEM_ACTION_STATUS.GATE_REJECTED,
];

// ---------------------------------------------------------------- 分支 ①

test("分支①:deferred 已受理的委派轮不由 system_action 代收终态", () => {
  for (const actionType of DEFERRED_PRODUCERS) {
    for (const status of DEFERRED_ACCEPTED_STATUSES) {
      const result = {
        actionType,
        status,
        deferredCompletion: true,
        targetAgent: "worker2",
        contractId: "DIRECT-1",
        deliveryTicketId: "SADT-1",
      };
      assert.equal(
        deriveSystemActionTerminalOutcome(result, { collected: false }),
        null,
        `${actionType}/${status} 已受理,未采集也不得判终态`,
      );
      assert.equal(
        deriveSystemActionTerminalOutcome(result, null),
        null,
        `${actionType}/${status} 已受理,无采集观测也不得判终态`,
      );
    }
  }
});

test("分支①:WAKE_FAILED 的委派仍算已受理(委派已落盘,唤醒失败不杀源约)", () => {
  const result = {
    actionType: INTENT_TYPES.ASSIGN_TASK,
    status: SYSTEM_ACTION_STATUS.WAKE_FAILED,
    deferredCompletion: true,
    error: "wake failed: target offline",
  };
  // 带 error 也不翻终态:deferred 短路在 reason 阶梯之前。
  assert.equal(deriveSystemActionTerminalOutcome(result, { collected: false }), null);
});

test("分支①:无结果与 NO_ACTION 一律不产出终态", () => {
  for (const observation of [null, undefined, { collected: false }, { collected: true }]) {
    assert.equal(deriveSystemActionTerminalOutcome(null, observation), null);
    assert.equal(deriveSystemActionTerminalOutcome(undefined, observation), null);
    assert.equal(
      deriveSystemActionTerminalOutcome({ status: SYSTEM_ACTION_STATUS.NO_ACTION }, observation),
      null,
    );
    assert.equal(
      deriveSystemActionTerminalOutcome(
        { actionType: INTENT_TYPES.WAKE_AGENT, status: SYSTEM_ACTION_STATUS.NO_ACTION },
        observation,
      ),
      null,
    );
  }
});

test("分支①边界:deferred 豁免要 deferredCompletion===true 与已受理状态同时成立", () => {
  // 只有 deferredCompletion,状态是失败态 → 不豁免。
  for (const status of FAILURE_STATUSES) {
    const derived = deriveSystemActionTerminalOutcome(
      { actionType: INTENT_TYPES.ASSIGN_TASK, status, deferredCompletion: true },
      { collected: false },
    );
    assert.equal(
      derived?.terminalStatus,
      CONTRACT_STATUS.FAILED,
      `deferredCompletion 不能给失败态 ${status} 发豁免`,
    );
  }

  // 只有已受理状态,没有 deferredCompletion → 不豁免(此轮没有回投机械可依赖,
  // 且既无产出又无回程路由,终态与事实收口同为 FAILED,只是归因写在 system_action)。
  for (const status of DEFERRED_ACCEPTED_STATUSES) {
    const derived = deriveSystemActionTerminalOutcome(
      { actionType: INTENT_TYPES.CREATE_TASK, status },
      { collected: false },
    );
    assert.equal(
      derived?.terminalStatus,
      CONTRACT_STATUS.FAILED,
      `缺 deferredCompletion 时状态 ${status} 不得自行豁免`,
    );
  }

  // deferredCompletion 非严格 true 的近似值不得混进豁免。
  for (const loose of [1, "true", "yes", {}]) {
    const derived = deriveSystemActionTerminalOutcome(
      {
        actionType: INTENT_TYPES.ASSIGN_TASK,
        status: SYSTEM_ACTION_STATUS.DISPATCHED,
        deferredCompletion: loose,
      },
      { collected: false },
    );
    assert.equal(
      derived?.terminalStatus,
      CONTRACT_STATUS.FAILED,
      `deferredCompletion=${JSON.stringify(loose)} 是真值近似,不得当已受理`,
    );
  }
});

// ---------------------------------------------------------------- 分支 ②

test("分支②:采集到产物就不由 system_action 失败代收终态(成功轮不得判 FAILED)", () => {
  for (const status of FAILURE_STATUSES) {
    const result = {
      actionType: INTENT_TYPES.WAKE_AGENT,
      status,
      error: "graph disallows wake_agent from worker to planner",
    };
    assert.equal(
      deriveSystemActionTerminalOutcome(result, { collected: true }),
      null,
      `已采集产物时 ${status} 不得翻成终态(这是"成功轮被判 FAILED"假失败的入口)`,
    );
  }
});

test("分支②:collected 只认严格 true,真值近似与缺失不发豁免", () => {
  const failing = {
    actionType: INTENT_TYPES.WAKE_AGENT,
    status: SYSTEM_ACTION_STATUS.DISPATCH_ERROR,
    error: "transport exploded",
  };
  const nonExempt = [
    null,
    undefined,
    {},
    { collected: false },
    { collected: 1 },
    { collected: "true" },
    { collected: "collected" },
    { collectedPrimary: true },
  ];
  for (const observation of nonExempt) {
    const derived = deriveSystemActionTerminalOutcome(failing, observation);
    assert.equal(
      derived?.terminalStatus,
      CONTRACT_STATUS.FAILED,
      `观测 ${JSON.stringify(observation)} 不是 collected===true,不得豁免`,
    );
  }
});

// ---------------------------------------------------------------- 分支 ③

test("分支③:失败态产出 FAILED 终态,形状按 normalizeTerminalOutcome 归一", () => {
  const derived = deriveSystemActionTerminalOutcome(
    {
      actionType: INTENT_TYPES.WAKE_AGENT,
      status: SYSTEM_ACTION_STATUS.GATE_REJECTED,
      error: "caller not authorized by collaboration policy",
    },
    { collected: false },
  );
  assert.ok(derived, "失败态必须产出终态,不能返 null");
  assert.equal(derived.terminalStatus, CONTRACT_STATUS.FAILED);
  assert.equal(derived.terminalOutcome.status, CONTRACT_STATUS.FAILED);
  assert.equal(derived.terminalOutcome.source, "system_action");
  assert.equal(derived.terminalOutcome.actionType, INTENT_TYPES.WAKE_AGENT);
  assert.equal(derived.terminalOutcome.reason, "caller not authorized by collaboration policy");
  assert.equal(derived.terminalOutcome.version, 1);
  assert.equal(derived.terminalOutcome.retryable, false);
  assert.ok(Number.isFinite(derived.terminalOutcome.ts));
});

test("分支③:BUSY 照样记失败(AWAITING_INPUT 已于 2026-08-10 整体删除,无假等待态)", () => {
  const derived = deriveSystemActionTerminalOutcome(
    { actionType: INTENT_TYPES.ASSIGN_TASK, status: SYSTEM_ACTION_STATUS.BUSY },
    { collected: false },
  );
  assert.equal(derived.terminalStatus, CONTRACT_STATUS.FAILED);
  assert.equal(derived.terminalOutcome.reason, "assign_task returned busy");
  // 要不要重试是调用方的事,收口不预设可重试。
  assert.equal(derived.terminalOutcome.retryable, false);
});

test("分支③:reason 四级阶梯 —— error > actionType+status > status > 兜底", () => {
  const reasonOf = (result) =>
    deriveSystemActionTerminalOutcome(result, { collected: false })?.terminalOutcome?.reason;

  // 一级:非空 error 字符串,去首尾空白。
  assert.equal(
    reasonOf({
      actionType: INTENT_TYPES.WAKE_AGENT,
      status: SYSTEM_ACTION_STATUS.INVALID_STATE,
      error: "  target agent is not enrolled  ",
    }),
    "target agent is not enrolled",
  );

  // 二级:error 缺失/纯空白/非字符串时降级到 actionType + status。
  assert.equal(
    reasonOf({ actionType: INTENT_TYPES.WAKE_AGENT, status: SYSTEM_ACTION_STATUS.INVALID_STATE }),
    "wake_agent returned invalid_state",
  );
  assert.equal(
    reasonOf({
      actionType: INTENT_TYPES.WAKE_AGENT,
      status: SYSTEM_ACTION_STATUS.INVALID_STATE,
      error: "   ",
    }),
    "wake_agent returned invalid_state",
  );
  assert.equal(
    reasonOf({
      actionType: INTENT_TYPES.WAKE_AGENT,
      status: SYSTEM_ACTION_STATUS.INVALID_STATE,
      error: { message: "object error is not a string" },
    }),
    "wake_agent returned invalid_state",
  );

  // 三级:只有 status。
  assert.equal(
    reasonOf({ status: SYSTEM_ACTION_STATUS.DISPATCH_ERROR }),
    "system_action returned dispatch_error",
  );

  // 四级:什么都没有的空结果对象仍要留下可读归因,且仍判 FAILED。
  const bare = deriveSystemActionTerminalOutcome({}, { collected: false });
  assert.equal(bare.terminalStatus, CONTRACT_STATUS.FAILED);
  assert.equal(bare.terminalOutcome.reason, "system_action failed");
  assert.equal(bare.terminalOutcome.actionType, null);
});

test("阶梯短路序:① 早于 ②,② 早于 ③", () => {
  // ① 早于 ②:已受理的 deferred 即使未采集也返 null(不是靠 ② 兜住的)。
  assert.equal(
    deriveSystemActionTerminalOutcome(
      {
        actionType: INTENT_TYPES.CREATE_TASK,
        status: SYSTEM_ACTION_STATUS.QUEUED,
        deferredCompletion: true,
      },
      { collected: false },
    ),
    null,
  );
  // ② 早于 ③:失败态 + 已采集 → null,不落到 reason 阶梯。
  assert.equal(
    deriveSystemActionTerminalOutcome(
      {
        actionType: INTENT_TYPES.CREATE_TASK,
        status: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
        error: "message is required",
      },
      { collected: true },
    ),
    null,
  );
});
