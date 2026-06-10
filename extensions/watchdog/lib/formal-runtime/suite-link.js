// lib/formal-runtime/suite-link.js — 活链路 suite 驱动器（dispatch / pipeline 两个 preset 共用）
//
// 每 case 流程：清理测试残留 → POST /watchdog/tests/inject 注入（传送带可信入口，不指名 agent）
// → SSE 观察 inbox_dispatch（轮询 /watchdog/work-items 兜底）→ 等 contract 终态 → 按阶段产出
// CheckResult（suite 只 addCheck，报告由 formal-report.js 渲染）。
//
// 阶段 → 错误码（注册表 lib/formal-runtime/error-codes.js 单源）：
//   inject     E-DISPATCH-001 | created  E-CONTRACT-001
//   terminal   超时 E-CONTRACT-002（terminalize 清场）/ failed E-CONTRACT-003
//   mirrored   E-CONTRACT-004（v133 输出镜像回归点：共享 contract 快照必须带 output）
//   validated  E-CONTRACT-007（test-output-validation.js minBytes/keywords）
//   upstream   E-CONTRACT-006（双布局探测：artifacts/<cid>/ 与 inbox/upstream/<producer>/）
// 前序阶段失败 → 余下阶段 blocked（E-RUNNER-005）。
//
// case 定义与纯判定在 suite-link-cases.js（此处统一 re-export，下游只 import 本模块）；
// 纯逻辑 + stub deps 的阶段映射由 tests/suite-link-units.test.js 覆盖。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RUNTIME_AGENT_IDS,
  SSEClient,
  cleanTestArtifacts,
  fetchJSON,
  loadConfig,
  postAdmin,
  sendTestInject,
  sleep,
} from "./infra.js";
import { runCheck, markBlocked } from "./checks/check-runner.js";
import {
  buildLinkStageDescriptors,
  evaluateLinkExpectation,
  normalizeLinkCase,
  probeUpstreamPackages,
  DISPATCH_LINK_CASES,
  PIPELINE_LINK_CASES,
} from "./suite-link-cases.js";
import { agentWorkspace } from "../state-agent-helpers.js";
import { artifactDir } from "../lifecycle/artifact-store.js";
import { readContractSnapshotById } from "../contracts.js";
import { resolveRuntimeResultOutputPath } from "../routing/delivery-result.js";
import { CONTRACT_STATUS, isCompletedContractStatus, isTerminalContractStatus } from "../core/runtime-status.js";
import { createTestTimeoutBudget } from "../test-timeout-policy.js";

export {
  buildLinkStageDescriptors,
  evaluateLinkExpectation,
  normalizeLinkCase,
  probeUpstreamPackages,
  DISPATCH_LINK_CASES,
  PIPELINE_LINK_CASES,
} from "./suite-link-cases.js";

const SSE_DISPATCH_WAIT_MS = 30000;
const POLL_DISPATCH_WAIT_MS = 20000;
const TERMINAL_POLL_INTERVAL_MS = 1500;

// ── 观察原语（默认 deps；单测以 stub 整体替换）──────────────────────────────────

// 吸收与本 case 相关的 SSE 事件：收集参与 agent + 最后事件摘要。case 串行执行，claim 安全。
function drainLinkSse(sse, startMs, contractId, agents) {
  if (!sse) return null;
  let lastNote = null;
  for (const evt of sse.events) {
    if (evt.claimed || evt.replay || evt.receivedAt < startMs) continue;
    const evtCid = evt.data?.contractId;
    if (contractId && evtCid && evtCid !== contractId) continue;
    if (evt.type === "track_start" || evt.type === "track_end") {
      evt.claimed = true;
      if (evt.data?.agentId) agents.add(evt.data.agentId);
      lastNote = `${evt.type}:${evt.data?.agentId || "?"}${evt.data?.status ? `(${evt.data.status})` : ""}`;
    } else if (evt.type === "alert" && typeof evt.data?.type === "string" && evt.data.type.startsWith("delivery_")) {
      evt.claimed = true;
      lastNote = evt.data.type;
    }
  }
  return lastNote;
}

// SSE inbox_dispatch 优先，丢事件时轮询 /watchdog/work-items 按任务文本兜底找合约。
async function observeContractDispatch({ message, startMs, budget, sse }) {
  if (sse) {
    const evt = await sse.waitFor(
      (e) => e.type === "alert"
        && e.receivedAt >= startMs
        && e.data?.type === "inbox_dispatch"
        && String(e.data?.task || "").includes(message.slice(0, 50)),
      Math.max(1000, Math.min(SSE_DISPATCH_WAIT_MS, budget.remainingMs(Date.now()))),
    );
    if (evt?.data?.contractId) {
      budget.noteProgress(evt.receivedAt);
      return { contractId: evt.data.contractId, via: "sse:inbox_dispatch" };
    }
  }
  const deadline = Date.now() + Math.max(1000, Math.min(POLL_DISPATCH_WAIT_MS, budget.remainingMs(Date.now())));
  while (Date.now() < deadline) {
    try {
      const items = await fetchJSON("/watchdog/work-items");
      const match = (Array.isArray(items) ? items : []).find((item) => {
        return String(item?.task || "").includes(message.slice(0, 50)) && Number(item?.createdAt || 0) >= (startMs - 2000);
      });
      if (match?.id) {
        budget.noteProgress(Date.now());
        return { contractId: match.id, via: "poll:/watchdog/work-items" };
      }
    } catch {}
    await sleep(1000);
  }
  return null;
}

// 轮询到终态或预算耗尽（进度租约：状态变化 / SSE 活动续期）。
async function waitForContractTerminal({ contractId, startMs, budget, sse }) {
  let lastStatus = null;
  let lastSseNote = null;
  const agents = new Set();
  while (!budget.isExpired(Date.now())) {
    const note = drainLinkSse(sse, startMs, contractId, agents);
    if (note) {
      lastSseNote = note;
      budget.noteProgress(Date.now());
    }
    try {
      const items = await fetchJSON("/watchdog/work-items");
      const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === contractId);
      if (item) {
        const status = item.status || "unknown";
        if (status !== lastStatus) {
          lastStatus = status;
          budget.noteProgress(Date.now());
        }
        if (isTerminalContractStatus(status)) {
          drainLinkSse(sse, startMs, contractId, agents);
          return { status, timedOut: false, lastStatus, agents: [...agents], lastSseNote };
        }
      }
    } catch {}
    await sleep(TERMINAL_POLL_INTERVAL_MS);
  }
  return { status: null, timedOut: true, lastStatus, agents: [...agents], lastSseNote };
}

// 超时清场：强制终态化（沿用 suite-single-observer markTimedOutContract 的请求形状）。
async function terminalizeLinkContract(contractId, detail) {
  if (!contractId) return null;
  return postAdmin("/watchdog/tests/terminalize", {
    contractId,
    status: CONTRACT_STATUS.FAILED,
    source: "test_runner",
    reason: "case_timeout",
    summary: detail,
    retryable: false,
  });
}

export function buildDefaultLinkDeps(sse = null) {
  return {
    now: Date.now,
    sleep,
    cleanState: () => cleanTestArtifacts(),
    inject: (message) => sendTestInject(message, "webui", null),
    createBudget: (testCase, startMs) => createTestTimeoutBudget({ startMs, baseTimeoutMs: testCase.timeoutMs }),
    observeContract: (args) => observeContractDispatch({ ...args, sse }),
    waitForTerminal: (args) => waitForContractTerminal({ ...args, sse }),
    terminalize: (contractId, detail) => terminalizeLinkContract(contractId, detail),
    readContract: (contractId) => readContractSnapshotById(contractId),
    resolveOutputPath: (contract) => resolveRuntimeResultOutputPath(contract),
    readFileText: (path) => readFile(path, "utf8"),
    probeUpstream: (contractId) => probeUpstreamPackages({
      artifactsContractDir: artifactDir(contractId),
      inboxRoots: RUNTIME_AGENT_IDS.map((agentId) => ({ agentId, inboxDir: join(agentWorkspace(agentId), "inbox") })),
    }),
  };
}

// ── 阶段执行（runCheck 协议：string/undefined=pass，{status,code,evidence}=合并）────

async function executeLinkStage(key, testCase, state, d) {
  if (key === "inject") {
    await d.cleanState();
    const response = await d.inject(testCase.message);
    if (response?.ok === false) {
      return { status: "fail", evidence: `inject rejected: ${JSON.stringify(response).slice(0, 200)}` };
    }
    return `inject accepted via /watchdog/tests/inject (source=webui)`;
  }
  if (key === "created") {
    const found = await d.observeContract({ message: testCase.message, startMs: state.startMs, budget: state.budget });
    if (!found?.contractId) {
      return { status: "fail", evidence: "no inbox_dispatch SSE event and no matching /watchdog/work-items entry after inject" };
    }
    state.contractId = found.contractId;
    return `contract=${found.contractId} via=${found.via}`;
  }
  if (key === "terminal") {
    const outcome = await d.waitForTerminal({ contractId: state.contractId, startMs: state.startMs, budget: state.budget });
    state.agents = outcome.agents || [];
    const sseNote = outcome.lastSseNote || "none";
    if (outcome.timedOut) {
      const detail = `contract ${state.contractId} not terminal within ${testCase.timeoutMs}ms budget`;
      try { await d.terminalize(state.contractId, detail); } catch {}
      return { status: "fail", evidence: `${detail}; lastStatus=${outcome.lastStatus || "never-seen"}; lastSse=${sseNote}; terminalized for cleanup` };
    }
    if (!isCompletedContractStatus(outcome.status)) {
      return { status: "fail", code: "E-CONTRACT-003", evidence: `terminal status=${outcome.status}; agents=[${state.agents.join(",")}]; lastSse=${sseNote}` };
    }
    return `completed in ${((d.now() - state.startMs) / 1000).toFixed(1)}s; agents=[${state.agents.join(",")}]; lastSse=${sseNote}`;
  }
  if (key === "mirrored") {
    const contract = await d.readContract(state.contractId);
    const aliasOutput = typeof contract?.output === "string" && contract.output.trim() ? contract.output.trim() : null;
    const outputPath = d.resolveOutputPath(contract);
    if (!outputPath) {
      return { status: "fail", evidence: `completed contract carries no output projection (contract.output=${JSON.stringify(aliasOutput)}) — v133 mirror regression class` };
    }
    let content;
    try {
      content = await d.readFileText(outputPath);
    } catch (error) {
      return { status: "fail", evidence: `contract output path ${outputPath} unreadable: ${error.message}` };
    }
    state.content = content;
    return `contract snapshot carries output → ${outputPath} (${Buffer.byteLength(content, "utf8")} bytes; contract.output=${aliasOutput ? "set" : "unset"})`;
  }
  if (key === "validated") {
    const verdict = evaluateLinkExpectation({ content: state.content || "", expectation: testCase.expectation });
    return verdict.ok ? verdict.evidence : { status: "fail", evidence: verdict.evidence };
  }
  if (key === "upstream") {
    const probe = await d.probeUpstream(state.contractId);
    const hops = `hops observed=[${(state.agents || []).join(",")}]`;
    if (!probe.found) {
      return { status: "fail", evidence: `neither artifacts/<cid>/ packages nor any inbox/upstream/<producer>/ found for ${state.contractId}; ${hops}` };
    }
    return `upstream package present: ${probe.locations.join(" | ")}; ${hops}`;
  }
  throw new Error(`unknown link stage: ${key}`);
}

// 单 case：逐阶段 runCheck；某阶段非 pass → 其余阶段 blocked（E-RUNNER-005）。
export async function runLinkCase(ctx, rawCase, { deps = null, sse = null } = {}) {
  const testCase = normalizeLinkCase(rawCase);
  if (!testCase) throw new TypeError("runLinkCase requires a valid link case");
  const d = { ...buildDefaultLinkDeps(sse), ...(deps || {}) };
  const stages = buildLinkStageDescriptors(testCase);
  const startMs = d.now();
  const state = { startMs, budget: d.createBudget(testCase, startMs), contractId: null, content: null, agents: [] };

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const check = await runCheck(ctx, stage, () => executeLinkStage(stage.key, testCase, state, d));
    if (check.status !== "pass") {
      markBlocked(ctx, stages.slice(i + 1), "E-RUNNER-005", `prerequisite ${check.id} ${check.status} (${check.code})`);
      return { contractId: state.contractId, completedStages: i, blockedStages: stages.length - i - 1 };
    }
  }
  return { contractId: state.contractId, completedStages: stages.length, blockedStages: 0 };
}

// ── suite 驱动 ────────────────────────────────────────────────────────────────

// 复用 orchestrator 已建好的 SSE（context.sse / run.sse），否则自建（连不上 → 纯轮询降级）。
export async function resolveSuiteSse(run, context, { connectTimeoutMs = 8000 } = {}) {
  const candidate = context?.sse || run?.sse || null;
  if (candidate && typeof candidate.waitFor === "function") {
    return { sse: candidate, owned: false };
  }
  const sse = new SSEClient();
  try {
    const connectPromise = sse.connect();
    connectPromise.catch(() => {}); // race 输掉后迟到的 reject 不得变成 unhandled rejection
    await Promise.race([
      connectPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("sse connect timeout")), connectTimeoutMs).unref?.()),
    ]);
    return { sse, owned: true };
  } catch {
    try { sse.close(); } catch {}
    return { sse: null, owned: false };
  }
}

function noteRunCase(run, testCase) {
  if (!run || typeof run !== "object") return;
  run.currentCaseId = testCase.id;
  run.currentCaseMessage = testCase.message;
}

export async function runLinkSuite(run, context, { cases = [], deps = null } = {}) {
  const normalized = (Array.isArray(cases) ? cases : []).map(normalizeLinkCase).filter(Boolean);
  const allStages = normalized.flatMap(buildLinkStageDescriptors);
  try {
    await loadConfig();
    await fetchJSON("/watchdog/runtime");
  } catch (error) {
    markBlocked(context, allStages, "E-RUNNER-003", `gateway prerequisite failed: ${error.message}`);
    return;
  }
  const { sse, owned } = await resolveSuiteSse(run, context);
  try {
    for (const testCase of normalized) {
      noteRunCase(run, testCase);
      await runLinkCase(context, testCase, { deps, sse });
    }
  } finally {
    if (owned && sse) sse.close();
  }
}

export async function runDispatchSuite(run, context) {
  return runLinkSuite(run, context, { cases: DISPATCH_LINK_CASES });
}

export async function runPipelineSuite(run, context) {
  return runLinkSuite(run, context, { cases: PIPELINE_LINK_CASES });
}
