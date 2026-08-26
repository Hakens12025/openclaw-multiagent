import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 投递出栈(备忘录141 §八):终态收口落投递票据 + poke 真泵——
// 票据目录环境种子改道临时目录,绝不写真 control-plane。
process.env.OPENCLAW_DELIVERY_TICKET_DIR = mkdtempSync(join(tmpdir(), "output-commit-tickets-"));

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:output-commit-follow-graph.test.js" });
import { getContractPath, persistContractById } from "../lib/contract/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { runAgentEndLifecycle } from "../lib/lifecycle/agent-end/lifecycle.js";
import { annotateExecutionContract } from "../lib/protocol/protocol-primitives.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";
import { agentWorkspace, cfg } from "../lib/state.js";
import { clearTrackingStore } from "../lib/store/tracker-store.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

// output_commit_observed 是 runAgentEndGraphRoute 的第一道分支(graph-route.js),它在
// 任何路由解析之前就短路返回 routed:false —— 命题是「观察到产出提交 ≠ 推进图边」。
// 2026-08-18 回路退役前本文件用 graph.loop.compose + runtime.loop.start 造场,
// 而那套脚手架与命题无关(分支比 contractStage 更早返回)。现改用一条普通有向边 +
// 一份普通共享执行合约:图上明明有出边、agent 也确实交了产出,依旧不得投递、不得唤醒。
const ENTRY_AGENT = "planner";
const NEXT_AGENT = "worker";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function cleanAgentBoxes(agentId) {
  for (const box of ["inbox", "outbox", "output"]) {
    const dir = join(agentWorkspace(agentId), box);
    try {
      const files = await readdir(dir);
      await Promise.all(files.map((file) => rm(join(dir, file), { recursive: true, force: true })));
    } catch {}
  }
}

test("output_commit on a graph-routable shared contract stays observational and must not advance graph", async () => runGlobalTestEnvironmentSerial(async () => {
  const heartbeatCalls = [];
  const originalGraph = await loadGraph();
  const originalHooksToken = cfg.hooksToken;
  const contractId = `TC-OUTPUT-COMMIT-OBSERVED-${Date.now()}`;
  let contractPath = null;
  const entryInboxFile = join(agentWorkspace(ENTRY_AGENT), "inbox", "contract.json");
  const nextInboxFile = join(agentWorkspace(NEXT_AGENT), "inbox", "contract.json");

  try {
    clearTrackingStore();
    cfg.hooksToken = "";
    await cleanAgentBoxes(ENTRY_AGENT);
    await cleanAgentBoxes(NEXT_AGENT);
    // 出边真实存在:若 output_commit 走了路由解析,合约必然被投给 NEXT_AGENT。
    await saveGraph({ edges: [{ from: ENTRY_AGENT, to: NEXT_AGENT, label: "handoff", metadata: {} }] });

    const contract = annotateExecutionContract({
      id: contractId,
      task: `${ENTRY_AGENT} 交付产出后,不得因 output_commit 推进到 ${NEXT_AGENT}`,
      assignee: ENTRY_AGENT,
      status: CONTRACT_STATUS.RUNNING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    contractPath = await persistContractById(contract, logger);

    // outbox 统一(f7769b5): agent 把交付物写进 outbox/,不再写中央 contract.output。
    const entryOutboxDir = join(agentWorkspace(ENTRY_AGENT), "outbox");
    await mkdir(entryOutboxDir, { recursive: true });
    await writeFile(
      join(entryOutboxDir, "runtime_result.json"),
      JSON.stringify({
        output: `# ${ENTRY_AGENT} output\n\n本阶段产出已提交,推进与否由后续 agent_end 判定,不由 output_commit 决定。\n`,
      }),
      "utf8",
    );

    const trackingState = createTrackingState({
      sessionKey: `synthetic:${ENTRY_AGENT}:${contractId}`,
      agentId: ENTRY_AGENT,
      parentSession: null,
    });
    trackingState.contract = {
      ...contract,
      path: contractPath,
      status: CONTRACT_STATUS.RUNNING,
    };

    await runAgentEndLifecycle({
      event: {
        success: true,
        synthetic: true,
        protocolBoundary: "canonical_outbox_commit",
        commitType: "output_commit",
      },
      ctx: {
        sessionKey: trackingState.sessionKey,
        agentId: ENTRY_AGENT,
      },
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger,
      trackingState,
    });

    const persistedContract = await readJsonFile(contractPath);

    assert.notEqual(persistedContract.status, CONTRACT_STATUS.COMPLETED);
    assert.equal(persistedContract.id, contractId);
    assert.equal(persistedContract.assignee, ENTRY_AGENT);
    await assert.rejects(
      readFile(nextInboxFile, "utf8"),
      { code: "ENOENT" },
      "output_commit must not dispatch the contract to the next graph member",
    );
    assert.equal(
      heartbeatCalls.some((entry) => entry?.agentId === NEXT_AGENT),
      false,
      "output_commit must not wake the next graph member",
    );
  } finally {
    clearTrackingStore();
    cfg.hooksToken = originalHooksToken;
    await saveGraph(originalGraph);
    await rm(contractPath || getContractPath(contractId) || "", { force: true }).catch(() => {});
    await rm(entryInboxFile, { force: true }).catch(() => {});
    await rm(nextInboxFile, { force: true }).catch(() => {});
  }
}));
