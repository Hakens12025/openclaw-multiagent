/**
 * judgment-ablation.test.js — 「判决面是纯外挂」的行为锁。
 *
 * 用户反复申明的验收判据:判决系统消失,这套系统依然运作,只是没兜底。
 * 本文件锁它的两半:
 *   ① 判决面**自身崩溃**不拖累执行 —— 核对函数抛错,收口照样按事实走
 *   ② 判决在场时,甲方期望正常被核对(对照组,防止"外挂"退化成"从不生效")
 *
 * 模块物理缺席(rm -rf lib/judgment)由 terminal-outcome 的动态 import + catch 兜住,
 * 已于 2026-08-11 消融实测(有产物→completed / 声明失败→failed / 期望在场不核对)。
 * 进程内无法模拟目录消失,故本文件用"核对抛错"锁同一条容错路径。
 *
 * 历史:执行面对判决曾是静态 import —— rm -rf lib/judgment 会让执行面
 * ERR_MODULE_NOT_FOUND。那是"判决焊进执行"同一类跑偏的第三次(前两次:
 * decideRound 判定器放进执行面、evidence.ok 判定结果冒充事实)。
 *
 * Run: node --test --experimental-test-module-mocks tests/judgment-ablation.test.js
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";

// 判决面被 mock 成"一问就炸"——比缺席更恶劣的形态。
mock.module("../lib/judgment/expectation-check.js", {
  namedExports: {
    checkExpectations: () => {
      throw new Error("judgment plane exploded");
    },
  },
});

const { resolveTerminalOutcome } = await import("../lib/contract/terminal-outcome.js");
const { CONTRACT_STATUS } = await import("../lib/core/runtime-status.js");

test("判决核对抛错:有产物的合约照常 COMPLETED(判决崩溃不拖累执行)", async () => {
  const outputPath = `/tmp/judgment-ablation-${Date.now()}.md`;
  await writeFile(outputPath, "真实交付物,判决炸了也照常收口。\n", "utf8");
  try {
    const { terminalStatus } = await resolveTerminalOutcome({
      trackingState: {
        contract: {
          id: "TC-JUDGMENT-EXPLODED",
          output: outputPath,
          // 期望在场——判决炸了就没人核对,这正是"没兜底"的准确形态
          completionCriteria: { requiredFiles: ["/tmp/never-exists-ablation.md"] },
        },
      },
      contractData: null,
      executionObservation: { collected: true, primaryOutputPath: outputPath },
    });
    assert.equal(terminalStatus, CONTRACT_STATUS.COMPLETED);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("判决核对抛错:agent 声明失败仍被转述(声明是执行面事实,不经判决)", async () => {
  const { terminalStatus, terminalOutcome } = await resolveTerminalOutcome({
    trackingState: {
      contract: { id: "TC-JUDGMENT-EXPLODED-DECLARED" },
      submittedOutput: { status: "failed", reason: "上游没给数据" },
    },
    contractData: null,
    executionObservation: { collected: false },
  });
  assert.equal(terminalStatus, CONTRACT_STATUS.FAILED);
  assert.equal(terminalOutcome.source, "declaration");
  assert.match(terminalOutcome.reason, /上游没给数据/);
});
