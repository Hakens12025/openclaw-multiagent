// tests/agent-end-contract-refresh.test.js — agent_end 收尾前重读最新合约快照。
//
// 归位记录(2026-08-19):本条原住回路测试(contractor-start-loop-contract-truth.test.js),
// 退役时抢救保留。但它守的是 lib/lifecycle/agent-end/contract-refresh.js 的
// refreshEffectiveContractDataAfterTransport —— 属 agent_end 生命周期,不属 system_action。
// 按既有 agent-end-* 主题族归位:混在别的主题下本身就说明位置不对。
//
// 守的不变量:consume_system_action 之前必须重读盘上最新根合约,而不是沿用
// context 里那份可能已陈旧的副本(陈旧副本会让收尾按过期状态判定)。
import test from "node:test";
import assert from "node:assert/strict";

import {
  refreshEffectiveContractDataAfterTransport,
} from "../lib/lifecycle/agent-end/lifecycle.js";
import { getContractPath, persistContractById } from "../lib/contract/contracts.js";

test("transport refresh reloads the newest root contract before consume_system_action", async () => {
  const contractId = `TC-REFRESH-${Date.now()}`;
  let contractPath = getContractPath(contractId);

  try {
    contractPath = await persistContractById({
      id: contractId,
      task: "refresh latest contract snapshot",
      status: "pending",
      assignee: "worker",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      output: `/tmp/${contractId}.md`,
      summary: "freshest snapshot marker",
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    }, { info() {}, warn() {}, error() {} });

    const context = {
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
        },
      },
      executionObservation: {
        contractId,
      },
      contractData: {
        id: contractId,
        task: "stale snapshot",
      },
      effectiveContractData: {
        id: contractId,
        task: "stale snapshot",
      },
      logger: { info() {}, warn() {}, error() {} },
    };

    await refreshEffectiveContractDataAfterTransport(context);

    // 判据是"刷新后读到盘上最新快照"——原用例借 loop 字段当载体,回路退役后换成
    // 中性字段验同一件事:陈旧 context 里只有 task,刷新后必须出现盘上的 summary。
    assert.equal(context.effectiveContractData?.summary, "freshest snapshot marker");
    assert.equal(context.effectiveContractData?.assignee, "worker");
  } finally {
    await import("node:fs/promises").then(({ unlink }) => unlink(contractPath).catch(() => {}));
  }
});
