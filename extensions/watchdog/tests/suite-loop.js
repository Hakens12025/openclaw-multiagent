// tests/suite-loop.js — Graph/loop/pipeline object + synthetic runtime tests
//
// IMPORTANT:
// - This file is not the proof that user-style tasks can drive the whole platform.
// - `researcher-smoke` is a role-local smoke check.
// - `pipeline-basic` is a T0 object/runtime truth test.
// - `pipeline-auto-advance` and related cases are T1 synthetic runtime-mechanics tests.
// - End-to-end platform evidence must come from separate T2 scenario tests with user-style inputs,
//   not from prompt-choreographed internal stage instructions.

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OC, PORT, sleep, wakeAgentNow } from "./infra.js";
import { summarizeTestDiagnosis } from "./suite-single.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { createDirectRequestEnvelope } from "../lib/protocol-primitives.js";
import { dispatchChain, dispatchTargetStateMap } from "../lib/state-collections.js";
import { clearTrackingStore } from "../lib/store/tracker-store.js";

// ── Loop Cases ────────────────────────────────────────────────────────────────

export const LOOP_CASES = [
  {
    id: "researcher-smoke",
    description: "researcher 角色本地冒烟：能否被唤醒并写出有效的 research_direction.json",
    timeoutMs: 360000,
    config: { max_rounds: 1, max_experiments: 1 },
  },
  {
    id: "pipeline-basic",
    description: "Pipeline 对象冒烟: graph edge → start_pipeline → advance_pipeline object chain verification",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
  {
    id: "pipeline-control",
    description: "Pipeline synthetic control: break → repair → interrupt → resume loop control chain",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
  {
    id: "pipeline-auto-advance",
    description: "Pipeline synthetic auto-advance: structured outbox drives researcher→worker→evaluator→researcher without system_action",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
  {
    id: "pipeline-loop-session-truth",
    description: "LoopSession synthetic truth: active session must stay aligned with pipeline stage, round, transition count, and archival state",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
  {
    id: "pipeline-contract-lifecycle",
    description: "Loop synthetic contract lifecycle: each stage contract completes and records runtime-owned pipeline progression",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
  {
    id: "pipeline-late-completion-recovery",
    description: "Loop synthetic late completion recovery: tracker timeout must not orphan pipeline truth when the same stage ends successfully later",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
  {
    id: "pipeline-guardrails",
    description: "Loop synthetic guardrails: ambiguous runtime transitions hold position and illegal targets are rejected",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
  {
    id: "pipeline-protocol-boundary",
    description: "Pipeline protocol boundary: previous stage output flows into next stage contract.task and pipelineStage.previousFeedback",
    timeoutMs: 30000,
    pipeline: true,
    config: {
      startAgent: "researcher",
    },
  },
];

const RESEARCH_LAB = join(OC, "research-lab");
const REGISTRY_FILE = join(RESEARCH_LAB, "registry.json");
const RESEARCH_STATE_FILE = join(RESEARCH_LAB, "research_state.json");
const DATA_DIR = join(RESEARCH_LAB, "data");
const RESEARCHER_INBOX_DIR = join(OC, "workspaces", "researcher", "inbox");
const RESEARCHER_OUTBOX_DIR = join(OC, "workspaces", "researcher", "outbox");
const RESEARCHER_OUTPUT_DIR = join(OC, "workspaces", "researcher", "output");

const STAGE_RESULT_FILENAME = "stage_result.json";
const STAGE_RESULT_MANIFEST_KIND = "stage_result";

function stageResultPath(agentId) {
  return join(OC, "workspaces", agentId, "outbox", STAGE_RESULT_FILENAME);
}

async function writeStageResult(agentId, payload) {
  const outboxDir = join(OC, "workspaces", agentId, "outbox");
  await mkdir(outboxDir, { recursive: true });
  await writeFile(stageResultPath(agentId), JSON.stringify(payload, null, 2), "utf8");
}

async function readStageResult(agentId) {
  try {
    const raw = await readFile(stageResultPath(agentId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildStageResult({
  stage,
  pipelineId = null,
  loopId = null,
  loopSessionId = null,
  round = 1,
  status = "completed",
  artifacts = [],
  primaryArtifactPath = null,
  transition = null,
  summary = null,
  feedback = null,
  deadEnds = [],
  completion = null,
  metadata = null,
} = {}) {
  return {
    version: 1,
    stage,
    pipelineId,
    loopId,
    loopSessionId,
    round,
    status,
    summary,
    feedback,
    artifacts,
    primaryArtifactPath,
    completion: completion || {
      version: 1,
      status,
      feedback,
      deadEnds: Array.isArray(deadEnds) ? deadEnds : [],
      transition,
    },
    metadata: metadata || {},
  };
}

function stageResultManifest(extraArtifacts = []) {
  return {
    version: 1,
    kind: STAGE_RESULT_MANIFEST_KIND,
    artifacts: [
      { type: STAGE_RESULT_MANIFEST_KIND, path: STAGE_RESULT_FILENAME, required: true },
      ...extraArtifacts,
    ],
  };
}


export async function cleanLoopRuntimeState() {
  await ensureLoopTestWorkspaces();
  clearTrackingStore();
  dispatchChain.clear();
  dispatchTargetStateMap.clear();
  for (const f of [REGISTRY_FILE, RESEARCH_STATE_FILE]) {
    try { await unlink(f); } catch {}
  }
  // Clean worker-d, evaluator, researcher inbox/outbox
  for (const agent of ["contractor", "worker-d", "evaluator", "researcher"]) {
    for (const box of ["inbox", "outbox"]) {
      const dir = join(OC, `workspaces/${agent}`, box);
      try {
        const files = await readdir(dir);
        for (const f of files) await unlink(join(dir, f));
      } catch {}
    }
  }
}

async function cleanDir(dir) {
  try {
    const files = await readdir(dir);
    for (const f of files) await unlink(join(dir, f)).catch(() => {});
  } catch {}
}

async function ensureLoopTestWorkspaces() {
  for (const agent of ["contractor", ...PIPELINE_AGENT_IDS]) {
    await mkdir(join(OC, "workspaces", agent), { recursive: true });
    await mkdir(join(OC, "workspaces", agent, "inbox"), { recursive: true });
    await mkdir(join(OC, "workspaces", agent, "outbox"), { recursive: true });
    await mkdir(join(OC, "workspaces", agent, "output"), { recursive: true });
  }
}

async function stageResearcherSmokeContract() {
  await mkdir(RESEARCHER_INBOX_DIR, { recursive: true });
  await mkdir(RESEARCHER_OUTBOX_DIR, { recursive: true });
  await mkdir(RESEARCHER_OUTPUT_DIR, { recursive: true });
  await cleanDir(RESEARCHER_INBOX_DIR);
  await cleanDir(RESEARCHER_OUTBOX_DIR);
  await cleanDir(RESEARCHER_OUTPUT_DIR);

  let availableData = [];
  try {
    const files = await readdir(DATA_DIR);
    availableData = files.filter((f) => f.endsWith(".parquet")).slice(0, 20);
  } catch {}

  const contract = createDirectRequestEnvelope({
    agentId: "researcher",
    sessionKey: `agent:researcher:smoke:${Date.now()}`,
    defaultReplyToSelf: false,
    message: [
      "请完成一轮 researcher 研究方向输出。",
      "不要依赖旧的 loop 上下文文件，只读取 inbox/contract.json 作为任务真值。",
      "输出 research_direction.json，至少包含 hypothesis；尽量补充 research_goal, rationale, coding_required, coding_instructions, experiments, evaluation_focus。",
      "experiments 应该是下一轮最值得执行的 1-3 个实验，不要默认输出大搜索空间。",
      availableData.length > 0
        ? `可用数据样本（节选）: ${availableData.join(", ")}`
        : "当前未发现 parquet 数据样本，也需要给出一个通用且可执行的研究方向。",
    ].join("\n"),
    outputDir: RESEARCHER_OUTPUT_DIR,
    source: "suite-loop.researcher-smoke",
  });
  await writeFile(join(RESEARCHER_INBOX_DIR, "contract.json"), JSON.stringify(contract, null, 2), "utf8");
  return { contractId: contract.id, availableDataCount: availableData.length };
}

// ── Research diagnostics ─────────────────────────────────────────────────────

async function dumpLoopDiag() {
  const lines = [];
  // Research state
  try {
    const raw = await readFile(RESEARCH_STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    lines.push(`  state: phase=${state.phase} round=${state.round} V:${state.validation_retries ?? 0} CR:${state.review_retries ?? 0}`);
    if (state.deadEnds?.length) lines.push(`  dead_ends: ${state.deadEnds.join(", ")}`);
  } catch { lines.push("  state: not found"); }

  // Researcher outbox
  try {
    const files = await readdir(join(OC, "workspaces", "researcher", "outbox"));
    lines.push(`  researcher/outbox: [${files.join(", ")}]`);
    for (const f of files) {
      try {
        const raw = await readFile(join(OC, "workspaces", "researcher", "outbox", f), "utf8");
        const parsed = JSON.parse(raw);
        const keys = Object.keys(parsed).join(", ");
        lines.push(`    ${f}: {${keys}}`);
      } catch {}
    }
  } catch { lines.push("  researcher/outbox: empty or missing"); }

  // Evaluator outbox
  try {
    const files = await readdir(join(OC, "workspaces", "evaluator", "outbox"));
    lines.push(`  evaluator/outbox: [${files.join(", ")}]`);
  } catch { lines.push("  evaluator/outbox: empty or missing"); }

  // Worker-d outbox
  try {
    const files = await readdir(join(OC, "workspaces", "worker-d", "outbox"));
    lines.push(`  worker-d/outbox: [${files.join(", ")}]`);
  } catch { lines.push("  worker-d/outbox: empty or missing"); }

  return lines.join("\n");
}

// ── Research Smoke Test (快速冒烟：验证 researcher 能写 outbox) ─────────────────

export const RESEARCHER_SMOKE_CHECKPOINTS = [
  { id: "S1", name: "Contract prepared",   maxMs: 5000   },
  { id: "S2", name: "Researcher woken",    maxMs: 120000 },
  { id: "S3", name: "Researcher done",     maxMs: 300000 },
  { id: "S4", name: "Outbox written",      maxMs: 5000   },
  { id: "S5", name: "Outbox valid JSON",   maxMs: 1000   },
];

export async function runResearcherSmoke(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Smoke: isolated researcher inbox/outbox check");

  // S1: Stage a canonical direct_request contract
  try {
    const prep = await stageResearcherSmokeContract();
    results.push({ id: "S1", name: "Contract prepared", status: "PASS", elapsed: elapsed(), detail: `contract=${prep.contractId} data=${prep.availableDataCount}` });
  } catch (e) {
    results.push({ id: "S1", name: "Contract prepared", status: "FAIL", elapsed: elapsed(), detail: e.message });
    return { testCase, results, duration: elapsed(), pass: false };
  }

  // S2: Wake researcher directly, without starting the full research loop
  try {
    const wakeResult = await wakeAgentNow("researcher", "研究循环唤醒: 请读取 inbox/contract.json 并执行当前任务，输出 research_direction.json");
    if (wakeResult?.ok === false) {
      results.push({ id: "S2", name: "Researcher woken", status: "FAIL", elapsed: elapsed(), detail: wakeResult.error || JSON.stringify(wakeResult) });
      return { testCase, results, duration: elapsed(), pass: false };
    }
  } catch (e) {
    results.push({ id: "S2", name: "Researcher woken", status: "FAIL", elapsed: elapsed(), detail: e.message });
    return { testCase, results, duration: elapsed(), pass: false };
  }

  const resStart = await sse.waitFor(
    e => e.type === "track_start" && e.data?.agentId === "researcher" && e.receivedAt >= startMs,
    RESEARCHER_SMOKE_CHECKPOINTS[1].maxMs
  );
  if (!resStart) {
    results.push({ id: "S2", name: "Researcher woken", status: "FAIL", elapsed: elapsed(), detail: "researcher not started" });
    return { testCase, results, duration: elapsed(), pass: false };
  }
  results.push({ id: "S2", name: "Researcher woken", status: "PASS", elapsed: elapsed() });

  // S3: Researcher done
  const resEnd = await sse.waitFor(
    e => e.type === "track_end" && e.data?.agentId === "researcher" && e.receivedAt >= startMs,
    RESEARCHER_SMOKE_CHECKPOINTS[2].maxMs
  );
  if (!resEnd) {
    const diag = await dumpLoopDiag();
    results.push({ id: "S3", name: "Researcher done", status: "FAIL", elapsed: elapsed(), detail: `researcher stuck\n${diag}` });
    return { testCase, results, duration: elapsed(), pass: false };
  }
  results.push({ id: "S3", name: "Researcher done", status: "PASS", elapsed: elapsed() });

  // S4: Check outbox was written
  await sleep(1000);
  let outboxFiles = [];
  try {
    outboxFiles = await readdir(RESEARCHER_OUTBOX_DIR);
  } catch {}
  if (outboxFiles.length === 0) {
    const diag = await dumpLoopDiag();
    results.push({ id: "S4", name: "Outbox written", status: "FAIL", elapsed: elapsed(), detail: `outbox empty\n${diag}` });
    return { testCase, results, duration: elapsed(), pass: false };
  }
  results.push({ id: "S4", name: "Outbox written", status: "PASS", elapsed: elapsed(), detail: `files: [${outboxFiles.join(", ")}]` });

  // S5: Validate JSON structure
  const rdFile = outboxFiles.find(f => f === "research_direction.json");
  if (rdFile) {
    try {
      const raw = await readFile(join(RESEARCHER_OUTBOX_DIR, rdFile), "utf8");
      const parsed = JSON.parse(raw);
      const hasHyp = !!parsed.hypothesis;
      const hasExperiments = Array.isArray(parsed.experiments || parsed.experiment_plan || parsed.next_experiments)
        && (parsed.experiments || parsed.experiment_plan || parsed.next_experiments).length > 0;
      const hasCoding = !!parsed.coding_instructions;
      const detail = `hypothesis=${hasHyp} experiments=${hasExperiments} coding_instructions=${hasCoding}`;
      if (hasHyp && (hasExperiments || hasCoding)) {
        results.push({ id: "S5", name: "Outbox valid JSON", status: "PASS", elapsed: elapsed(), detail });
      } else {
        results.push({ id: "S5", name: "Outbox valid JSON", status: "FAIL", elapsed: elapsed(), detail: `missing required fields: ${detail}` });
        return { testCase, results, duration: elapsed(), pass: false };
      }
    } catch (e) {
      results.push({ id: "S5", name: "Outbox valid JSON", status: "FAIL", elapsed: elapsed(), detail: `parse error: ${e.message}` });
      return { testCase, results, duration: elapsed(), pass: false };
    }
  } else {
    results.push({ id: "S5", name: "Outbox valid JSON", status: "FAIL", elapsed: elapsed(), detail: `research_direction.json not found, got: [${outboxFiles.join(", ")}]` });
    return { testCase, results, duration: elapsed(), pass: false };
  }

  return { testCase, results, duration: elapsed(), pass: true };
}

// ── Pipeline Test (start_pipeline + advance_pipeline 链路验证) ────────────────

const LOOP_SESSION_STATE_FILE = join(RESEARCH_LAB, "loop_session_state.json");
const PIPELINE_AGENT_IDS = ["researcher", "worker-d", "evaluator"];

export const PIPELINE_CHECKPOINTS = [
  { id: "P0", name: "Graph edges created",          maxMs: 5000  },
  { id: "P1", name: "Pipeline started",             maxMs: 10000 },
  { id: "P2", name: "State file created",           maxMs: 5000  },
  { id: "P3", name: "Advance: researcher→worker-d", maxMs: 5000  },
  { id: "P4", name: "Illegal transition rejected",  maxMs: 5000  },
  { id: "P5", name: "Conclude pipeline",            maxMs: 5000  },
];

async function loadPipelineState() {
  const { loadActiveLoopRuntime } = await import("../lib/loop/loop-round-runtime.js");
  return loadActiveLoopRuntime();
}

async function loadLoopSessionState() {
  try {
    const raw = await readFile(LOOP_SESSION_STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cleanPipelineState() {
  try { await unlink(LOOP_SESSION_STATE_FILE); } catch {}
  await cleanDir(join(RESEARCH_LAB, "probe-contracts"));
  await ensureLoopTestWorkspaces();
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadActiveInboxContract(agentId) {
  const contractPath = join(OC, "workspaces", agentId, "inbox", "contract.json");
  const contract = await readJsonFile(contractPath);
  return {
    ...contract,
    path: contractPath,
  };
}

async function restageSharedContract(agentId, contractId, contractPathHint = null) {
  const { routeInbox } = await import("../runtime-mailbox.js");
  await routeInbox(agentId, console, {
    contractIdHint: contractId,
    contractPathHint: contractPathHint || getContractPath(contractId),
  });
  return loadActiveInboxContract(agentId);
}

async function createSyntheticProbeContract(baseContract, probeId) {
  const probeDir = join(RESEARCH_LAB, "probe-contracts");
  const probePath = join(probeDir, `${probeId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  const probeContract = {
    ...baseContract,
    id: probeId,
    status: CONTRACT_STATUS.RUNNING,
  };
  await mkdir(probeDir, { recursive: true });
  await writeFile(probePath, JSON.stringify(probeContract, null, 2), "utf8");
  return {
    ...probeContract,
    path: probePath,
  };
}

function buildSyntheticTrackingState(agentId, contract) {
  const contractPath = typeof contract?.path === "string" ? contract.path : "";
  const canonicalContractPath = (
    contract?.id
    && !String(contract.id).startsWith("DIRECT-")
    && /\/inbox\/contract\.json$/.test(contractPath)
  )
    ? getContractPath(contract.id)
    : (contract?.path || null);
  return {
    agentId,
    sessionKey: `synthetic:${agentId}:${contract.id}`,
    status: CONTRACT_STATUS.RUNNING,
    startMs: Date.now() - 1000,
    toolCalls: [],
    toolCallTotal: 0,
    lastLabel: "运行中",
    cursor: `0/${contract.total || 1}`,
    pct: 0,
    estimatedPhase: "处理中",
    contract: {
      ...contract,
      path: canonicalContractPath,
    },
  };
}

function jsonDetail(value, limit = 320) {
  try {
    const text = JSON.stringify(value);
    return text ? text.slice(0, limit) : "";
  } catch (error) {
    return String(error?.message || value || "");
  }
}

function isCanonicalContractSessionKey(sessionKey, agentId, contractId) {
  return sessionKey === `agent:${agentId}:contract:${contractId}`;
}

function pickLoopContractRuntimeSnapshot(contract) {
  if (!contract || typeof contract !== "object") return null;
  return {
    status: contract.status || null,
    taskType: contract.taskType || null,
    protocol: contract.protocol || null,
    coordination: contract.coordination || null,
    followUp: contract.followUp || null,
    systemActionDelivery: contract.systemActionDelivery || null,
    terminalOutcome: contract.terminalOutcome || null,
    systemAction: contract.systemAction || null,
    runtimeDiagnostics: contract.runtimeDiagnostics || null,
  };
}

async function installTestLoopGraph({
  saveGraph,
  saveGraphLoopRegistry,
  ambiguousResearcher = false,
} = {}) {
  await saveGraph({
    edges: [
      { from: "researcher", to: "worker-d", label: "coding", gates: [], metadata: {} },
      ...(ambiguousResearcher
        ? [{ from: "researcher", to: "evaluator", label: "skip-review", gates: [], metadata: {} }]
        : []),
      { from: "worker-d", to: "evaluator", label: "review", gates: [], metadata: {} },
      { from: "evaluator", to: "researcher", label: "feedback", gates: [], metadata: {} },
    ],
  });
  await saveGraphLoopRegistry({
    loops: [{
      id: "loop-test-cycle",
      kind: "cycle-loop",
      entryAgentId: "researcher",
      nodes: [...PIPELINE_AGENT_IDS],
      phaseOrder: [...PIPELINE_AGENT_IDS],
    }],
  });
}

async function writeResearcherPipelineOutbox() {
  const outboxDir = join(OC, "workspaces", "researcher", "outbox");
  await mkdir(outboxDir, { recursive: true });
  await cleanDir(outboxDir);
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify(stageResultManifest([
    { type: "research_direction", path: "research_direction.json", label: "research_direction", required: true },
    { type: "notes", path: "hypothesis.md", label: "hypothesis", required: false },
  ]), null, 2), "utf8");
  await writeFile(join(outboxDir, "research_direction.json"), JSON.stringify({
    hypothesis: "围绕因子稳健性先做一轮低成本验证",
    research_goal: "确认当前方向是否值得进入执行与评估",
    rationale: "先把方向缩窄，再交给执行阶段做验证",
  }, null, 2), "utf8");
  await writeFile(join(outboxDir, "hypothesis.md"), "研究假设：先做一轮基础验证。", "utf8");
  await writeStageResult("researcher", buildStageResult({
    stage: "researcher",
    round: 1,
    status: "completed",
    artifacts: [
      { type: "research_direction", path: "research_direction.json", label: "research_direction", required: true },
      { type: "notes", path: "hypothesis.md", label: "hypothesis", required: false },
    ],
    primaryArtifactPath: "hypothesis.md",
    transition: { kind: "advance", targetStage: "worker-d", reason: "structured stage completion" },
    summary: "researcher stage produced direction artifacts",
    feedback: "auto advance to worker-d",
  }));
}

async function writeResearcherMissingTransitionOutbox() {
  const outboxDir = join(OC, "workspaces", "researcher", "outbox");
  await mkdir(outboxDir, { recursive: true });
  await cleanDir(outboxDir);
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify(stageResultManifest([
    { type: "research_direction", path: "research_direction.json", label: "research_direction", required: true },
    { type: "notes", path: "hypothesis.md", label: "hypothesis", required: false },
  ]), null, 2), "utf8");
  await writeFile(join(outboxDir, "research_direction.json"), JSON.stringify({
    hypothesis: "记录一个已完成但未决定下一跳的研究产物",
    research_goal: "验证 runtime 会保守 hold，而不是猜下一跳",
    rationale: "阶段完成与 loop 推进必须分离表达。",
  }, null, 2), "utf8");
  await writeFile(join(outboxDir, "hypothesis.md"), "研究假设：本轮仅验证无 transition 的 hold。", "utf8");
  await writeStageResult("researcher", buildStageResult({
    stage: "researcher",
    round: 1,
    status: "completed",
    artifacts: [
      { type: "research_direction", path: "research_direction.json", label: "research_direction", required: true },
      { type: "notes", path: "hypothesis.md", label: "hypothesis", required: false },
    ],
    primaryArtifactPath: "hypothesis.md",
    transition: null,
    summary: "researcher stage completed without transition",
    feedback: "no transition declared",
  }));
}

async function writeResearcherFollowGraphOutbox() {
  const outboxDir = join(OC, "workspaces", "researcher", "outbox");
  await mkdir(outboxDir, { recursive: true });
  await cleanDir(outboxDir);
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify(stageResultManifest([
    { type: "research_direction", path: "research_direction.json", label: "research_direction", required: true },
    { type: "notes", path: "hypothesis.md", label: "hypothesis", required: false },
  ]), null, 2), "utf8");
  await writeFile(join(outboxDir, "research_direction.json"), JSON.stringify({
    hypothesis: "沿图推进，但不在产物里直接声明下一跳",
    research_goal: "验证 runtime 在多出口时不会猜测跳转目标",
    rationale: "只有 graph 唯一出口时才允许 follow_graph 推断。",
  }, null, 2), "utf8");
  await writeFile(join(outboxDir, "hypothesis.md"), "研究假设：多出口下 follow_graph 必须保守 hold。", "utf8");
  await writeStageResult("researcher", buildStageResult({
    stage: "researcher",
    round: 1,
    status: "completed",
    artifacts: [
      { type: "research_direction", path: "research_direction.json", label: "research_direction", required: true },
      { type: "notes", path: "hypothesis.md", label: "hypothesis", required: false },
    ],
    primaryArtifactPath: "hypothesis.md",
    transition: { kind: "follow_graph", reason: "follow_graph_only" },
    summary: "researcher stage completed with follow_graph transition",
    feedback: "follow graph without explicit next target",
  }));
}

async function writeWorkerPipelineOutbox() {
  const outboxDir = join(OC, "workspaces", "worker-d", "outbox");
  await mkdir(outboxDir, { recursive: true });
  await cleanDir(outboxDir);
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify(stageResultManifest([
    { type: "text_output", path: "result.md", label: "result", required: true },
  ]), null, 2), "utf8");
  await writeFile(join(outboxDir, "result.md"), "# 执行结果\n\n完成一次最小验证。", "utf8");
  await writeStageResult("worker-d", buildStageResult({
    stage: "worker-d",
    round: 1,
    status: "completed",
    artifacts: [
      { type: "text_output", path: "result.md", label: "result", required: true },
    ],
    primaryArtifactPath: "result.md",
    transition: { kind: "advance", targetStage: "evaluator", reason: "structured stage completion" },
    summary: "worker-d stage produced execution output",
    feedback: "auto advance to evaluator",
  }));
}

async function writeWorkerPipelineOutputArtifact(outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "# 执行结果\n\n迟到成功的输出已落盘。", "utf8");
}

async function writeEvaluatorPipelineOutbox() {
  const outboxDir = join(OC, "workspaces", "evaluator", "outbox");
  await mkdir(outboxDir, { recursive: true });
  await cleanDir(outboxDir);
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify(stageResultManifest([
    { type: "workflow_decision", path: "next_action.json", label: "next_action", required: true },
    { type: "notes", path: "evaluation.md", label: "evaluation", required: false },
  ]), null, 2), "utf8");
  await writeFile(join(outboxDir, "next_action.json"), JSON.stringify({
    action: "continue",
    feedback: "当前结果可继续迭代，回到 researcher 收窄下一轮方向。",
    suggested_directions: ["缩窄样本区间", "调整约束条件"],
    dead_ends_to_add: ["naive-baseline"],
    round_summary: "第1轮：方向已验证，可继续收窄。",
  }, null, 2), "utf8");
  await writeFile(join(outboxDir, "evaluation.md"), "建议继续，下一轮聚焦更窄的方向。", "utf8");
  await writeStageResult("evaluator", buildStageResult({
    stage: "evaluator",
    round: 1,
    status: "completed",
    artifacts: [
      { type: "workflow_decision", path: "next_action.json", label: "next_action", required: true },
      { type: "notes", path: "evaluation.md", label: "evaluation", required: false },
    ],
    primaryArtifactPath: "next_action.json",
    transition: { kind: "advance", targetStage: "researcher", reason: "structured stage completion" },
    summary: "evaluator stage produced decision artifacts",
    feedback: "当前结果可继续迭代，回到 researcher 收窄下一轮方向。",
  }));
}

async function runSyntheticAgentEnd(agentId, sessionKey, api, trackingStateOverride = null) {
  const contract = trackingStateOverride?.contract || await loadActiveInboxContract(agentId);
  const trackingState = trackingStateOverride || buildSyntheticTrackingState(agentId, contract);
  const {
    createAgentEndPipelineContext,
    runAgentEndMainStages,
    runAgentEndFinallyStages,
  } = await import("../lib/lifecycle/agent-end-pipeline.js");

  const context = createAgentEndPipelineContext({
    event: { success: true },
    ctx: { sessionKey, agentId },
    api,
    logger: console,
    enqueueFn: () => {},
    wakeContractor: async () => null,
    trackingState,
  });
  await runAgentEndMainStages(context);
  await runAgentEndFinallyStages(context);
  return context;
}

async function runSyntheticStageAdvance(agentId, {
  targetStage = null,
  result = null,
  feedback = null,
  transitionKind = "advance",
} = {}) {
  const activeContract = await loadActiveInboxContract(agentId);
  const outboxDir = join(OC, "workspaces", agentId, "outbox");
  const artifactName = "synthetic-stage-output.md";
  const transition = transitionKind === "conclude"
    ? { kind: "conclude" }
    : transitionKind === "follow_graph"
      ? { kind: "follow_graph" }
      : { kind: "advance", targetStage };
  const contractPath = getContractPath(activeContract.id);
  const persistedSnapshot = await readJsonFile(contractPath);

  await persistContractSnapshot(contractPath, {
    ...persistedSnapshot,
    status: CONTRACT_STATUS.RUNNING,
    updatedAt: Date.now(),
  }, console);

  await mkdir(outboxDir, { recursive: true });
  await cleanDir(outboxDir);
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify(stageResultManifest([
    { type: "text_output", path: artifactName, label: "result", required: false },
  ]), null, 2), "utf8");
  await writeFile(join(outboxDir, artifactName), `# Synthetic\n\n${result || "synthetic stage result"}\n`, "utf8");
  await writeStageResult(agentId, buildStageResult({
    stage: activeContract?.pipelineStage?.stage || agentId,
    pipelineId: activeContract?.pipelineStage?.pipelineId || null,
    loopId: activeContract?.pipelineStage?.loopId || null,
    loopSessionId: activeContract?.pipelineStage?.loopSessionId || null,
    round: activeContract?.pipelineStage?.round || 1,
    status: "completed",
    artifacts: [
      { type: "text_output", path: artifactName, label: "result", required: false },
    ],
    primaryArtifactPath: artifactName,
    transition,
    summary: result || null,
    feedback: feedback || null,
  }));

  const context = await runSyntheticAgentEnd(
    agentId,
    `test:synthetic-advance:${agentId}:${activeContract.id}`,
    {
      runtime: {
        system: {
          requestHeartbeatNow() {},
        },
      },
    },
  );
  const progression = context?.trackingState?.contract?.runtimeDiagnostics?.pipelineProgression || null;
  if (progression?.action) {
    return progression;
  }
  if (context?.graphRouteResult?.routed) {
    return {
      action: "advanced",
      from: agentId,
      to: context.graphRouteResult.target || null,
    };
  }
  if (context?.graphRouteResult?.action === "dispatch_failed") {
    return {
      action: "invalid_state",
      error: `illegal transition ${agentId} -> ${targetStage || "unknown"}`,
      from: agentId,
      to: targetStage || null,
    };
  }
  return {
    action: context?.graphRouteResult?.action || "unknown",
    error: progression?.reason || context?.graphRouteResult?.reason || null,
    from: agentId,
    to: targetStage || null,
  };
}

async function readJsonFileOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function runPipelineTest(testCase, sse) {
  if (testCase.id === "pipeline-auto-advance") {
    return runPipelineAutoAdvanceTest(testCase, sse);
  }
  if (testCase.id === "pipeline-loop-session-truth") {
    return runPipelineLoopSessionTruthTest(testCase, sse);
  }
  if (testCase.id === "pipeline-contract-lifecycle") {
    return runPipelineContractLifecycleTest(testCase, sse);
  }
  if (testCase.id === "pipeline-late-completion-recovery") {
    return runPipelineLateCompletionRecoveryTest(testCase, sse);
  }
  if (testCase.id === "pipeline-guardrails") {
    return runPipelineGuardrailsTest(testCase, sse);
  }
  if (testCase.id === "pipeline-protocol-boundary") {
    return runPipelineProtocolBoundaryTest(testCase, sse);
  }

  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Pipeline: graph-based start/advance/conclude chain");

  await cleanPipelineState();

  // P0: Set up graph edges (researcher → worker-d → evaluator → researcher)
  const { loadGraph, saveGraph } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
  } = await import("../lib/loop/graph-loop-registry.js");

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  try {
    await saveGraph({
      edges: [
        { from: "researcher", to: "worker-d", label: "coding", gates: [], metadata: {} },
        { from: "worker-d", to: "evaluator", label: "review", gates: [], metadata: {} },
        { from: "evaluator", to: "researcher", label: "feedback", gates: [], metadata: {} },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [{
        id: "loop-test-cycle",
        kind: "cycle-loop",
        entryAgentId: "researcher",
        nodes: ["researcher", "worker-d", "evaluator"],
        phaseOrder: ["researcher", "worker-d", "evaluator"],
      }],
    });

    const graph = await loadGraph();
    if (graph.edges.length >= 3) {
      results.push({ id: "P0", name: "Graph edges created", status: "PASS", elapsed: elapsed(), detail: `edges=${graph.edges.length}` });
    } else {
      results.push({ id: "P0", name: "Graph edges created", status: "FAIL", elapsed: elapsed(), detail: `edges=${graph.edges.length}` });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    // P1: Start pipeline with startAgent
    let startResult;
    try {
      const { startLoopRound: startPipeline } = await import("../lib/loop/loop-round-runtime.js");
      startResult = await startPipeline(
        { startAgent: "researcher", requestedTask: "pipeline unit test" },
        null, // no wakeup — unit test
        null, // no enqueue
        null, // no replyTo
        console,
      );
      if (startResult.action === "started") {
        results.push({
          id: "P1",
          name: "Pipeline started",
          status: "PASS",
          elapsed: elapsed(),
          detail: `stage=${startResult.currentStage} loop=${startResult.loopId || "-"}`,
        });
      } else {
        results.push({ id: "P1", name: "Pipeline started", status: "FAIL", elapsed: elapsed(), detail: `action=${startResult.action} error=${startResult.error}` });
        return { testCase, results, duration: elapsed(), pass: false };
      }
    } catch (e) {
      results.push({ id: "P1", name: "Pipeline started", status: "FAIL", elapsed: elapsed(), detail: e.message });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    // P2: Verify state file
    const state1 = await loadPipelineState();
    const loopSessionState1 = await loadLoopSessionState();
    const activeLoopSession1 = loopSessionState1?.activeSession || null;
    if (
      state1
      && state1.currentStage === "researcher"
      && state1.loopId
      && state1.loopSessionId
      && activeLoopSession1?.id === state1.loopSessionId
      && activeLoopSession1?.loopId === state1.loopId
      && activeLoopSession1?.currentStage === "researcher"
    ) {
      results.push({ id: "P2", name: "State file created", status: "PASS", elapsed: elapsed(), detail: `round=${state1.round} loop=${state1.loopId}` });
    } else {
      results.push({
        id: "P2",
        name: "State file created",
        status: "FAIL",
        elapsed: elapsed(),
        detail: JSON.stringify({
          pipeline: state1,
          loopSession: activeLoopSession1,
        })?.slice(0, 240),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    // P3: Advance researcher → worker-d (legal transition via graph edge)
    try {
      const advResult = await runSyntheticStageAdvance("researcher", {
        targetStage: "worker-d",
        result: "outbox/direction.json",
        feedback: "test advance",
      });
      if (advResult.action === "advanced" && advResult.to === "worker-d") {
        results.push({ id: "P3", name: "Advance: researcher→worker-d", status: "PASS", elapsed: elapsed(), detail: `from=${advResult.from} to=${advResult.to}` });
      } else {
        results.push({ id: "P3", name: "Advance: researcher→worker-d", status: "FAIL", elapsed: elapsed(), detail: `action=${advResult.action} to=${advResult.to} error=${advResult.error}` });
        return { testCase, results, duration: elapsed(), pass: false };
      }
    } catch (e) {
      results.push({ id: "P3", name: "Advance: researcher→worker-d", status: "FAIL", elapsed: elapsed(), detail: e.message });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    // P4: Advance worker-d → illegal target ("researcher" not in worker-d's out-edges)
    try {
      const advResult = await runSyntheticStageAdvance("worker-d", {
        targetStage: "researcher",
        result: "test",
        feedback: "illegal test",
      });
      if (advResult.action === "invalid_state" && String(advResult.error || "").includes("illegal transition")) {
        results.push({ id: "P4", name: "Illegal transition rejected", status: "PASS", elapsed: elapsed(), detail: advResult.error });
      } else {
        results.push({ id: "P4", name: "Illegal transition rejected", status: "FAIL", elapsed: elapsed(), detail: `action=${advResult.action} error=${advResult.error}` });
        return { testCase, results, duration: elapsed(), pass: false };
      }
    } catch (e) {
      results.push({ id: "P4", name: "Illegal transition rejected", status: "FAIL", elapsed: elapsed(), detail: e.message });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    const loopSessionStateAfterIllegalAdvance = await loadLoopSessionState();
    const latestLoopSessionAfterIllegalAdvance = loopSessionStateAfterIllegalAdvance?.recentSessions?.[0] || null;

    // P5: Force conclude (or observe that the invalid transition already closed the loop)
    try {
      const { concludeLoopRound: concludePipeline } = await import("../lib/loop/loop-round-runtime.js");
      const concResult = await concludePipeline("test_complete", console);
      if (concResult.action === "concluded") {
        results.push({ id: "P5", name: "Conclude pipeline", status: "PASS", elapsed: elapsed(), detail: `reason=${concResult.reason} rounds=${concResult.round}` });
      } else if (
        concResult.action === "no_pipeline"
        && latestLoopSessionAfterIllegalAdvance?.status === "concluded"
      ) {
        results.push({
          id: "P5",
          name: "Conclude pipeline",
          status: "PASS",
          elapsed: elapsed(),
          detail: `loop already closed by invalid transition (${latestLoopSessionAfterIllegalAdvance.concludeReason || "concluded"})`,
        });
      } else {
        results.push({ id: "P5", name: "Conclude pipeline", status: "FAIL", elapsed: elapsed(), detail: `action=${concResult.action}` });
        return { testCase, results, duration: elapsed(), pass: false };
      }
    } catch (e) {
      results.push({ id: "P5", name: "Conclude pipeline", status: "FAIL", elapsed: elapsed(), detail: e.message });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    // P6: Verify final state
    const finalState = await loadPipelineState();
    const finalLoopSessionState = await loadLoopSessionState();
    const latestLoopSession = finalLoopSessionState?.recentSessions?.[0] || null;
    if (
      !finalState
      && latestLoopSession?.status === "concluded"
      && latestLoopSession?.loopId === "loop-test-cycle"
    ) {
      results.push({
        id: "P6",
        name: "Final state valid",
        status: "PASS",
        elapsed: elapsed(),
        detail: `loopSession=${latestLoopSession.id} reason=${latestLoopSession.concludeReason || "-"}`,
      });
    } else {
      results.push({
        id: "P6",
        name: "Final state valid",
        status: "FAIL",
        elapsed: elapsed(),
        detail: JSON.stringify({
          stage: finalState?.currentStage,
          loopId: finalState?.loopId,
          latestLoopSession,
        })?.slice(0, 240),
      });
    }

    return { testCase, results, duration: elapsed(), pass: results.every(r => r.status === "PASS") };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState();
  }
}

export async function runPipelineAutoAdvanceTest(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Pipeline auto-advance: runtime-owned stage progression from structured outbox");

  await cleanPipelineState();

  const { loadGraph, saveGraph } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
  } = await import("../lib/loop/graph-loop-registry.js");
  const { startLoopRound: startPipeline } = await import("../lib/loop/loop-round-runtime.js");

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const wakeRequests = [];
  const api = {
    runtime: {
      system: {
        requestHeartbeatNow(payload) {
          wakeRequests.push(payload);
        },
      },
    },
  };
  const wakeupFunc = async (targetAgentId, wakeOptions = {}) => {
    const payload = {
      agentId: targetAgentId,
      ...(wakeOptions?.sessionKey ? { sessionKey: wakeOptions.sessionKey } : {}),
    };
    api.runtime.system.requestHeartbeatNow(payload);
    return {
      ok: true,
      requested: true,
      mode: "heartbeat",
      targetAgent: targetAgentId,
      sessionKey: wakeOptions?.sessionKey || null,
    };
  };

  try {
    await installTestLoopGraph({ saveGraph, saveGraphLoopRegistry });

    const startResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "pipeline runtime auto advance" },
      wakeupFunc,
      null,
      null,
      console,
    );
    if (startResult.action !== "started") {
      results.push({
        id: "A1",
        name: "Start pipeline",
        status: "FAIL",
        errorCode: "E_LOOP_START_FAIL",
        elapsed: elapsed(),
        detail: jsonDetail(startResult),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "A1", name: "Start pipeline", status: "PASS", elapsed: elapsed(), detail: `${startResult.currentStage} loop=${startResult.loopId || "-"}` });

    const initialResearcherWake = wakeRequests.find((entry) => entry?.agentId === "researcher") || null;
    if (isCanonicalContractSessionKey(initialResearcherWake?.sessionKey, "researcher", startResult.contractId)) {
      results.push({ id: "A1b", name: "Start wake uses contract session key", status: "PASS", elapsed: elapsed(), detail: initialResearcherWake.sessionKey });
    } else {
      results.push({
        id: "A1b",
        name: "Start wake uses contract session key",
        status: "FAIL",
        errorCode: "E_LOOP_STAGE_SESSIONKEY_MISS",
        elapsed: elapsed(),
        detail: jsonDetail({ wakeRequests, startResult }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await writeResearcherPipelineOutbox();
    const researcherEndContext = await runSyntheticAgentEnd("researcher", "test:auto:researcher", api);

    const stateAfterResearcher = await loadPipelineState();
    const workerContract = await loadActiveInboxContract("worker-d").catch(() => null);
    const workerWake = wakeRequests.find((entry) => entry?.agentId === "worker-d") || null;
    if (
      stateAfterResearcher?.currentStage === "worker-d"
      && workerContract?.pipelineStage?.stage === "worker-d"
      && isCanonicalContractSessionKey(workerWake?.sessionKey, "worker-d", workerContract?.id)
    ) {
      results.push({ id: "A2", name: "Researcher auto-advances to worker", status: "PASS", elapsed: elapsed(), detail: `next=${stateAfterResearcher.currentStage}` });
    } else {
      results.push({
        id: "A2",
        name: "Researcher auto-advances to worker",
        status: "FAIL",
        errorCode: wakeRequests.some((entry) => entry?.agentId === "worker-d")
          ? "E_LOOP_STATE_MISMATCH"
          : "E_LOOP_WAKE_MISS",
        elapsed: elapsed(),
        detail: jsonDetail({
          pipeline: stateAfterResearcher,
          workerStage: workerContract?.pipelineStage || null,
          wakeRequests,
          contract: researcherEndContext?.trackingState?.contract?.runtimeDiagnostics?.pipelineProgression || null,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await writeWorkerPipelineOutbox();
    const workerEndContext = await runSyntheticAgentEnd("worker-d", "test:auto:worker", api);

    const stateAfterWorker = await loadPipelineState();
    const evaluatorContract = await loadActiveInboxContract("evaluator").catch(() => null);
    const evaluatorWake = wakeRequests.find((entry) => entry?.agentId === "evaluator") || null;
    if (
      stateAfterWorker?.currentStage === "evaluator"
      && evaluatorContract?.pipelineStage?.stage === "evaluator"
      && isCanonicalContractSessionKey(evaluatorWake?.sessionKey, "evaluator", evaluatorContract?.id)
    ) {
      results.push({ id: "A3", name: "Worker auto-advances to evaluator", status: "PASS", elapsed: elapsed(), detail: `next=${stateAfterWorker.currentStage}` });
    } else {
      results.push({
        id: "A3",
        name: "Worker auto-advances to evaluator",
        status: "FAIL",
        errorCode: wakeRequests.some((entry) => entry?.agentId === "evaluator")
          ? "E_LOOP_STATE_MISMATCH"
          : "E_LOOP_WAKE_MISS",
        elapsed: elapsed(),
        detail: jsonDetail({
          pipeline: stateAfterWorker,
          evaluatorStage: evaluatorContract?.pipelineStage || null,
          wakeRequests,
          contract: workerEndContext?.trackingState?.contract?.runtimeDiagnostics?.pipelineProgression || null,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await writeEvaluatorPipelineOutbox();
    const evaluatorEndContext = await runSyntheticAgentEnd("evaluator", "test:auto:evaluator", api);

    const finalState = await loadPipelineState();
    const finalLoopSessionState = await loadLoopSessionState();
    const activeLoopSession = finalLoopSessionState?.activeSession || null;
    const researcherContract = await loadActiveInboxContract("researcher").catch(() => null);
    const researcherPreviousFeedback = researcherContract?.pipelineStage?.previousFeedback || "";
    const loopFeedback = activeLoopSession?.feedbackOutput?.feedback || "";
    const finalResearcherWake = [...wakeRequests].reverse().find((entry) => entry?.agentId === "researcher") || null;
    if (
      finalState?.currentStage === "researcher"
      && finalState?.round === 2
      && activeLoopSession?.currentStage === "researcher"
      && researcherContract?.pipelineStage?.round === 2
      && researcherPreviousFeedback.length > 0
      && loopFeedback.includes("继续迭代")
      && isCanonicalContractSessionKey(finalResearcherWake?.sessionKey, "researcher", researcherContract?.id)
    ) {
      results.push({
        id: "A4",
        name: "Evaluator loops back to researcher",
        status: "PASS",
        elapsed: elapsed(),
        detail: `round=${finalState.round} history=${finalState.stageHistory?.length || 0}`,
      });
    } else {
      results.push({
        id: "A4",
        name: "Evaluator loops back to researcher",
        status: "FAIL",
        errorCode: finalState?.round === 2 ? "E_LOOP_SESSION_SYNC" : "E_LOOP_ROUND_INCREMENT",
        elapsed: elapsed(),
        detail: jsonDetail({
          pipeline: finalState,
          activeLoopSession,
          researcherStage: researcherContract?.pipelineStage || null,
          previousFeedback: researcherPreviousFeedback || null,
          loopFeedback,
          wakeRequests,
          contract: evaluatorEndContext?.trackingState?.contract?.runtimeDiagnostics?.pipelineProgression || null,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
      contractId: evaluatorEndContext?.trackingState?.contract?.id || null,
      contractRuntime: pickLoopContractRuntimeSnapshot(evaluatorEndContext?.trackingState?.contract || null),
    };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState();
  }
}

export async function runPipelineLoopSessionTruthTest(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  LoopSession truth: active session must mirror runtime stage progression and archival");

  await cleanPipelineState();

  const { loadGraph, saveGraph } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
  } = await import("../lib/loop/graph-loop-registry.js");
  const { startLoopRound: startPipeline, concludeLoopRound: concludePipeline } = await import("../lib/loop/loop-round-runtime.js");

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const wakeRequests = [];
  const api = {
    runtime: {
      system: {
        requestHeartbeatNow(payload) {
          wakeRequests.push(payload);
        },
      },
    },
  };

  try {
    await installTestLoopGraph({ saveGraph, saveGraphLoopRegistry });

    const startResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "pipeline loop session truth test" },
      null,
      null,
      null,
      console,
    );
    const initialLoopSessionState = await loadLoopSessionState();
    const initialSession = initialLoopSessionState?.activeSession || null;
    if (
      startResult.action !== "started"
      || !startResult.loopSessionId
      || initialSession?.id !== startResult.loopSessionId
      || initialSession?.currentStage !== "researcher"
      || initialSession?.round !== 1
      || initialSession?.transitionCount !== 0
      || initialSession?.status !== "active"
    ) {
      results.push({
        id: "S1",
        name: "Start session truth",
        status: "FAIL",
        errorCode: "E_LOOP_SESSION_SYNC",
        elapsed: elapsed(),
        detail: jsonDetail({ startResult, initialSession }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "S1", name: "Start session truth", status: "PASS", elapsed: elapsed(), detail: `${initialSession.id} stage=${initialSession.currentStage}` });

    await writeResearcherPipelineOutbox();
    await runSyntheticAgentEnd("researcher", "test:session:researcher", api);

    const afterResearcher = (await loadLoopSessionState())?.activeSession || null;
    if (
      afterResearcher?.id !== startResult.loopSessionId
      || afterResearcher?.currentStage !== "worker-d"
      || afterResearcher?.previousStage !== "researcher"
      || afterResearcher?.round !== 1
      || afterResearcher?.transitionCount !== 1
      || afterResearcher?.lastTransition?.from !== "researcher"
      || afterResearcher?.lastTransition?.to !== "worker-d"
    ) {
      results.push({
        id: "S2",
        name: "Session tracks researcher→worker",
        status: "FAIL",
        errorCode: "E_LOOP_SESSION_SYNC",
        elapsed: elapsed(),
        detail: jsonDetail({ afterResearcher, wakeRequests }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "S2", name: "Session tracks researcher→worker", status: "PASS", elapsed: elapsed(), detail: `count=${afterResearcher.transitionCount} round=${afterResearcher.round}` });

    await writeWorkerPipelineOutbox();
    await runSyntheticAgentEnd("worker-d", "test:session:worker", api);

    const afterWorker = (await loadLoopSessionState())?.activeSession || null;
    if (
      afterWorker?.id !== startResult.loopSessionId
      || afterWorker?.currentStage !== "evaluator"
      || afterWorker?.previousStage !== "worker-d"
      || afterWorker?.round !== 1
      || afterWorker?.transitionCount !== 2
      || afterWorker?.lastTransition?.from !== "worker-d"
      || afterWorker?.lastTransition?.to !== "evaluator"
    ) {
      results.push({
        id: "S3",
        name: "Session tracks worker→evaluator",
        status: "FAIL",
        errorCode: "E_LOOP_SESSION_SYNC",
        elapsed: elapsed(),
        detail: jsonDetail({ afterWorker, wakeRequests }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "S3", name: "Session tracks worker→evaluator", status: "PASS", elapsed: elapsed(), detail: `count=${afterWorker.transitionCount} round=${afterWorker.round}` });

    await writeEvaluatorPipelineOutbox();
    const evaluatorEndContext = await runSyntheticAgentEnd("evaluator", "test:session:evaluator", api);

    const afterEvaluator = (await loadLoopSessionState())?.activeSession || null;
    if (
      afterEvaluator?.id !== startResult.loopSessionId
      || afterEvaluator?.currentStage !== "researcher"
      || afterEvaluator?.previousStage !== "evaluator"
      || afterEvaluator?.round !== 2
      || afterEvaluator?.transitionCount !== 3
      || afterEvaluator?.lastTransition?.from !== "evaluator"
      || afterEvaluator?.lastTransition?.to !== "researcher"
    ) {
      results.push({
        id: "S4",
        name: "Session tracks evaluator→researcher loop-back",
        status: "FAIL",
        errorCode: afterEvaluator?.round === 2 ? "E_LOOP_SESSION_SYNC" : "E_LOOP_ROUND_INCREMENT",
        elapsed: elapsed(),
        detail: jsonDetail({ afterEvaluator, wakeRequests }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "S4", name: "Session tracks evaluator→researcher loop-back", status: "PASS", elapsed: elapsed(), detail: `count=${afterEvaluator.transitionCount} round=${afterEvaluator.round}` });

    const concludeResult = await concludePipeline("truth_test_complete", console);
    const archivedLoopSessionState = await loadLoopSessionState();
    const archivedSession = archivedLoopSessionState?.recentSessions?.[0] || null;
    if (
      concludeResult?.action !== "concluded"
      || archivedLoopSessionState?.activeSession
      || archivedSession?.id !== startResult.loopSessionId
      || archivedSession?.status !== "concluded"
      || archivedSession?.round !== 2
      || archivedSession?.concludeReason !== "truth_test_complete"
    ) {
      results.push({
        id: "S5",
        name: "Session archive truth",
        status: "FAIL",
        errorCode: "E_LOOP_SESSION_ARCHIVE",
        elapsed: elapsed(),
        detail: jsonDetail({ concludeResult, archivedLoopSessionState, archivedSession }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "S5", name: "Session archive truth", status: "PASS", elapsed: elapsed(), detail: `${archivedSession.id} archived` });

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
      contractId: evaluatorEndContext?.trackingState?.contract?.id || null,
      contractRuntime: pickLoopContractRuntimeSnapshot(evaluatorEndContext?.trackingState?.contract || null),
    };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState().catch(() => {});
  }
}

function summarizeContractLifecycle(contract) {
  if (!contract) return "contract=missing";
  const progression = contract.runtimeDiagnostics?.pipelineProgression || null;
  const progressionText = progression
    ? `${progression.action || "none"} ${progression.from || "-"}->${progression.to || "-"} round=${progression.round || "-"}`
    : "progression=none";
  return [
    `status=${contract.status || "-"}`,
    `stage=${contract.pipelineStage?.stage || "-"}`,
    `round=${contract.pipelineStage?.round || "-"}`,
    progressionText,
  ].join(" ");
}

export async function runPipelineContractLifecycleTest(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Pipeline contract lifecycle: completed stage contracts must retain runtime progression truth");

  await cleanPipelineState();

  const { loadGraph, saveGraph } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
  } = await import("../lib/loop/graph-loop-registry.js");
  const {
    startLoopRound: startPipeline,
  } = await import("../lib/loop/loop-round-runtime.js");

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const wakeRequests = [];
  const api = {
    runtime: {
      system: {
        requestHeartbeatNow(payload) {
          wakeRequests.push(payload);
        },
      },
    },
  };

  try {
    await installTestLoopGraph({ saveGraph, saveGraphLoopRegistry });

    const startResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "pipeline contract lifecycle test" },
      null,
      null,
      null,
      console,
    );
    if (startResult.action !== "started" || !startResult.contractId) {
      results.push({
        id: "L1",
        name: "Start loop pipeline",
        status: "FAIL",
        errorCode: "E_LOOP_START_FAIL",
        elapsed: elapsed(),
        detail: jsonDetail(startResult),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "L1", name: "Start loop pipeline", status: "PASS", elapsed: elapsed(), detail: `contract=${startResult.contractId} stage=${startResult.currentStage}` });

    const initialResearcherContract = await loadActiveInboxContract("researcher").catch(() => null);
    if (!initialResearcherContract?.output) {
      results.push({
        id: "L2",
        name: "Output-only probe prepared",
        status: "FAIL",
        errorCode: "E_LOOP_CONTRACT_PROGRESS",
        elapsed: elapsed(),
        detail: jsonDetail({ initialResearcherContract }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await cleanDir(join(OC, "workspaces", "researcher", "outbox"));
    await writeWorkerPipelineOutputArtifact(initialResearcherContract.output);
    const outputOnlyProbeContract = await createSyntheticProbeContract(
      initialResearcherContract,
      `${initialResearcherContract.id}:output-only-probe`,
    );
    const outputOnlyProbeState = buildSyntheticTrackingState("researcher", outputOnlyProbeContract);
    const outputOnlyProbeContext = await runSyntheticAgentEnd(
      "researcher",
      "test:lifecycle:researcher:output-only-probe",
      api,
      outputOnlyProbeState,
    );
    const stateAfterOutputOnlyProbe = await loadPipelineState();
    const outputOnlyWorkerContract = await loadActiveInboxContract("worker-d").catch(() => null);
    const outputOnlyProgress = outputOnlyProbeContext?.trackingState?.contract?.runtimeDiagnostics?.pipelineProgression || null;
    if (
      stateAfterOutputOnlyProbe?.currentStage === "researcher"
      && !outputOnlyWorkerContract
      && outputOnlyProgress?.attempted === false
      && outputOnlyProgress?.skipped === true
      && outputOnlyProgress?.reason === "missing_stage_run_result"
    ) {
      results.push({
        id: "L2",
        name: "contract.output alone does not advance loop truth",
        status: "PASS",
        elapsed: elapsed(),
        detail: `stage=${stateAfterOutputOnlyProbe.currentStage} reason=${outputOnlyProgress.reason}`,
      });
    } else {
      results.push({
        id: "L2",
        name: "contract.output alone does not advance loop truth",
        status: "FAIL",
        errorCode: "E_LOOP_OUTPUT_ONLY_ADVANCE",
        elapsed: elapsed(),
        detail: jsonDetail({
          pipeline: stateAfterOutputOnlyProbe,
          workerStage: outputOnlyWorkerContract?.pipelineStage || null,
          progression: outputOnlyProgress,
          wakeRequests,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await cleanLoopRuntimeState();
    await cleanPipelineState();
    wakeRequests.length = 0;

    const restartedResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "pipeline contract lifecycle test (stage result path)" },
      null,
      null,
      null,
      console,
    );
    if (restartedResult.action !== "started" || !restartedResult.contractId) {
      results.push({
        id: "L3",
        name: "Restart loop pipeline",
        status: "FAIL",
        errorCode: "E_LOOP_START_FAIL",
        elapsed: elapsed(),
        detail: jsonDetail(restartedResult),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({
      id: "L3",
      name: "Restart loop pipeline",
      status: "PASS",
      elapsed: elapsed(),
      detail: `contract=${restartedResult.contractId} stage=${restartedResult.currentStage}`,
    });

    const activeResearcherContract = await loadActiveInboxContract("researcher").catch(() => null);
    if (!activeResearcherContract?.output) {
      results.push({
        id: "L4",
        name: "Stage-result probe prepared",
        status: "FAIL",
        errorCode: "E_LOOP_CONTRACT_PROGRESS",
        elapsed: elapsed(),
        detail: jsonDetail({ activeResearcherContract }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    const workerWakeCountBeforeHoldProbe = wakeRequests.filter((entry) => entry?.agentId === "worker-d").length;
    await writeResearcherMissingTransitionOutbox();
    const missingTransitionProbeContract = await createSyntheticProbeContract(
      activeResearcherContract,
      `${activeResearcherContract.id}:missing-transition-probe`,
    );
    const missingTransitionContext = await runSyntheticAgentEnd(
      "researcher",
      "test:lifecycle:researcher:missing-transition-probe",
      api,
      buildSyntheticTrackingState("researcher", missingTransitionProbeContract),
    );
    const stateAfterMissingTransitionProbe = await loadPipelineState();
    const missingTransitionWorkerContract = await loadActiveInboxContract("worker-d").catch(() => null);
    const missingTransitionProgress = missingTransitionContext?.trackingState?.contract?.runtimeDiagnostics?.pipelineProgression || null;
    if (
      stateAfterMissingTransitionProbe?.currentStage === "researcher"
      && !missingTransitionWorkerContract
      && missingTransitionProgress?.attempted === false
      && missingTransitionProgress?.skipped === true
      && missingTransitionProgress?.reason === "missing_stage_transition"
      && wakeRequests.filter((entry) => entry?.agentId === "worker-d").length === workerWakeCountBeforeHoldProbe
    ) {
      results.push({
        id: "L4",
        name: "stage_result without transition holds pipeline",
        status: "PASS",
        elapsed: elapsed(),
        detail: `stage=${stateAfterMissingTransitionProbe.currentStage} reason=${missingTransitionProgress.reason}`,
      });
    } else {
      results.push({
        id: "L4",
        name: "stage_result without transition holds pipeline",
        status: "FAIL",
        errorCode: "E_LOOP_MISSING_TRANSITION",
        elapsed: elapsed(),
        detail: jsonDetail({
          pipeline: stateAfterMissingTransitionProbe,
          workerStage: missingTransitionWorkerContract?.pipelineStage || null,
          progression: missingTransitionProgress,
          wakeRequests,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await restageSharedContract("researcher", restartedResult.contractId);
    await writeResearcherPipelineOutbox();
    const researcherStageResult = await readStageResult("researcher");
    const researcherEndContext = await runSyntheticAgentEnd("researcher", "test:lifecycle:researcher", api);

    const advancedResearcherContract = researcherEndContext?.trackingState?.contract || null;
    const workerContract = await loadActiveInboxContract("worker-d").catch(() => null);
    if (
      researcherStageResult?.completion?.transition?.kind === "advance"
      && researcherStageResult?.completion?.transition?.targetStage === "worker-d"
      && advancedResearcherContract?.assignee === "worker-d"
      && [CONTRACT_STATUS.PENDING, CONTRACT_STATUS.RUNNING].includes(advancedResearcherContract?.status)
      && advancedResearcherContract?.runtimeDiagnostics?.pipelineProgression?.action === "advanced"
      && advancedResearcherContract.runtimeDiagnostics.pipelineProgression?.to === "worker-d"
      && workerContract?.pipelineStage?.stage === "worker-d"
    ) {
      results.push({
        id: "L5",
        name: "Explicit stage_result transition advances to worker",
        status: "PASS",
        elapsed: elapsed(),
        detail: summarizeContractLifecycle(advancedResearcherContract),
      });
    } else {
      results.push({
        id: "L5",
        name: "Explicit stage_result transition advances to worker",
        status: "FAIL",
        errorCode: "E_LOOP_CONTRACT_PROGRESS",
        elapsed: elapsed(),
        detail: jsonDetail({
          stageResultCompletion: researcherStageResult?.completion || null,
          contract: advancedResearcherContract,
          workerStage: workerContract?.pipelineStage || null,
          wakeRequests,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await writeWorkerPipelineOutbox();
    const workerEndContext = await runSyntheticAgentEnd("worker-d", "test:lifecycle:worker", api);

    const advancedWorkerContract = workerEndContext?.trackingState?.contract || null;
    const evaluatorContract = await loadActiveInboxContract("evaluator").catch(() => null);
    if (
      advancedWorkerContract?.assignee === "evaluator"
      && [CONTRACT_STATUS.PENDING, CONTRACT_STATUS.RUNNING].includes(advancedWorkerContract?.status)
      && advancedWorkerContract?.runtimeDiagnostics?.pipelineProgression?.action === "advanced"
      && advancedWorkerContract.runtimeDiagnostics.pipelineProgression?.to === "evaluator"
      && evaluatorContract?.pipelineStage?.stage === "evaluator"
    ) {
      results.push({
        id: "L6",
        name: "Worker contract advances with progression",
        status: "PASS",
        elapsed: elapsed(),
        detail: summarizeContractLifecycle(advancedWorkerContract),
      });
    } else {
      results.push({
        id: "L6",
        name: "Worker contract advances with progression",
        status: "FAIL",
        errorCode: "E_LOOP_CONTRACT_PROGRESS",
        elapsed: elapsed(),
        detail: jsonDetail({
          contract: advancedWorkerContract,
          evaluatorStage: evaluatorContract?.pipelineStage || null,
          wakeRequests,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    await writeEvaluatorPipelineOutbox();
    const evaluatorEndContext = await runSyntheticAgentEnd("evaluator", "test:lifecycle:evaluator", api);

    const advancedEvaluatorContract = evaluatorEndContext?.trackingState?.contract || null;
    const nextResearcherContract = await loadActiveInboxContract("researcher").catch(() => null);
    const finalState = await loadPipelineState();
    const finalLoopSessionState = await loadLoopSessionState();
    const activeLoopSession = finalLoopSessionState?.activeSession || null;
    if (
      advancedEvaluatorContract?.assignee === "researcher"
      && [CONTRACT_STATUS.PENDING, CONTRACT_STATUS.RUNNING].includes(advancedEvaluatorContract?.status)
      && advancedEvaluatorContract?.runtimeDiagnostics?.pipelineProgression?.action === "advanced"
      && advancedEvaluatorContract.runtimeDiagnostics.pipelineProgression?.to === "researcher"
      && advancedEvaluatorContract.runtimeDiagnostics.pipelineProgression?.round === 2
      && nextResearcherContract?.pipelineStage?.stage === "researcher"
      && nextResearcherContract?.pipelineStage?.round === 2
      && nextResearcherContract?.id
      && nextResearcherContract.id === restartedResult.contractId
      && finalState?.currentStage === "researcher"
      && finalState?.round === 2
      && activeLoopSession?.currentStage === "researcher"
      && activeLoopSession?.round === 2
    ) {
      results.push({
        id: "L7",
        name: "Evaluator contract loops back with round-2 contract",
        status: "PASS",
        elapsed: elapsed(),
        detail: `${summarizeContractLifecycle(advancedEvaluatorContract)} next=${nextResearcherContract.id}`,
      });
    } else {
      results.push({
        id: "L7",
        name: "Evaluator contract loops back with round-2 contract",
        status: "FAIL",
        errorCode: finalState?.round === 2 ? "E_LOOP_CONTRACT_PROGRESS" : "E_LOOP_ROUND_INCREMENT",
        elapsed: elapsed(),
        detail: jsonDetail({
          contract: advancedEvaluatorContract,
          nextResearcher: nextResearcherContract?.pipelineStage || null,
          nextResearcherId: nextResearcherContract?.id || null,
          pipeline: finalState,
          activeLoopSession,
          wakeRequests,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
      contractId: advancedEvaluatorContract?.id || null,
      contractRuntime: pickLoopContractRuntimeSnapshot(advancedEvaluatorContract),
    };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState();
  }
}

export async function runPipelineLateCompletionRecoveryTest(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Pipeline late completion recovery: stale timeout must reconcile if the same stage later ends successfully");

  await cleanPipelineState();

  const { loadGraph, saveGraph } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
  } = await import("../lib/loop/graph-loop-registry.js");
  const { startLoopRound: startPipeline } = await import("../lib/loop/loop-round-runtime.js");
  const { updateContractStatus } = await import("../lib/contracts.js");
  const { armLateCompletionLease } = await import("../lib/late-completion-lease.js");
  const {
    createTrackingState,
    bindInboxContractEnvelope,
  } = await import("../lib/session-bootstrap.js");
  const { cleanupStaleRunningTracker } = await import("../index.js");

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const wakeRequests = [];
  const api = {
    runtime: {
      system: {
        requestHeartbeatNow(payload) {
          wakeRequests.push(payload);
        },
      },
    },
  };

  try {
    await installTestLoopGraph({ saveGraph, saveGraphLoopRegistry });

    const startResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "pipeline late completion recovery test" },
      null,
      null,
      null,
      console,
    );
    if (startResult.action !== "started") {
      results.push({
        id: "R1",
        name: "Start pipeline",
        status: "FAIL",
        errorCode: "E_LOOP_START_FAIL",
        elapsed: elapsed(),
        detail: jsonDetail(startResult),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "R1", name: "Start pipeline", status: "PASS", elapsed: elapsed(), detail: `${startResult.currentStage} loop=${startResult.loopId || "-"}` });

    await writeResearcherPipelineOutbox();
    await runSyntheticAgentEnd("researcher", "test:late:researcher", api);

    const workerContract = await loadActiveInboxContract("worker-d").catch(() => null);
    if (workerContract?.pipelineStage?.stage !== "worker-d") {
      results.push({
        id: "R2",
        name: "Worker stage prepared",
        status: "FAIL",
        errorCode: "E_LOOP_STATE_MISMATCH",
        elapsed: elapsed(),
        detail: jsonDetail({ workerContract, wakeRequests }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "R2", name: "Worker stage prepared", status: "PASS", elapsed: elapsed(), detail: workerContract.id });

    const bootstrapTrackingState = createTrackingState({
      sessionKey: "test:bootstrap:worker-d",
      agentId: "worker-d",
      parentSession: null,
    });
    await bindInboxContractEnvelope({
      agentId: "worker-d",
      trackingState: bootstrapTrackingState,
      logger: console,
      allowNonDirectRequest: true,
      requiredContractId: workerContract.id,
    });
    if (
      bootstrapTrackingState?.contract?.pipelineStage?.stage !== "worker-d"
      || bootstrapTrackingState?.contract?.pipelineStage?.pipelineId !== startResult.pipelineId
    ) {
      results.push({
        id: "R2A",
        name: "Bootstrap preserves pipeline stage",
        status: "FAIL",
        errorCode: "E_LOOP_STATE_MISMATCH",
        elapsed: elapsed(),
        detail: jsonDetail({
          trackingContract: bootstrapTrackingState?.contract || null,
          workerContract,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({
      id: "R2A",
      name: "Bootstrap preserves pipeline stage",
      status: "PASS",
      elapsed: elapsed(),
      detail: jsonDetail(bootstrapTrackingState.contract.pipelineStage),
    });

    const trackerTimeoutDiagnostic = {
      lane: "tracker_timeout",
      timeoutMs: 180000,
      elapsedMs: 181000,
      silenceMs: 181000,
      ts: Date.now(),
    };
    const fallbackTrackingState = createTrackingState({
      sessionKey: "test:late:fallback-worker-d",
      agentId: "worker-d",
      parentSession: null,
    });
    fallbackTrackingState.contract = {
      ...bootstrapTrackingState.contract,
      pipelineStage: null,
      runtimeDiagnostics: null,
      status: CONTRACT_STATUS.RUNNING,
    };
    await cleanupStaleRunningTracker({
      sessionKey: fallbackTrackingState.sessionKey,
      trackingState: fallbackTrackingState,
      api,
      logger: console,
    });
    const fallbackContractSnapshot = fallbackTrackingState?.contract?.path
      ? await readJsonFileOrNull(fallbackTrackingState.contract.path)
      : null;
    if (
      fallbackTrackingState?.lateCompletionLease?.active !== true
      || fallbackTrackingState?.contract?.status === CONTRACT_STATUS.FAILED
      || fallbackContractSnapshot?.runtimeDiagnostics?.lateCompletionLease?.active !== true
    ) {
      results.push({
        id: "R2B",
        name: "Tracker timeout fallback arms lease",
        status: "FAIL",
        errorCode: "E_LOOP_CONTRACT_PROGRESS",
        elapsed: elapsed(),
        detail: jsonDetail({
          trackingState: fallbackTrackingState,
          contract: fallbackContractSnapshot,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({
      id: "R2B",
      name: "Tracker timeout fallback arms lease",
      status: "PASS",
      elapsed: elapsed(),
      detail: jsonDetail(fallbackTrackingState.lateCompletionLease),
    });

    await updateContractStatus(workerContract.path, CONTRACT_STATUS.FAILED, console, {
      failReason: "tracker_timeout",
      runtimeDiagnostics: {
        ...(workerContract.runtimeDiagnostics || {}),
        trackerTimeout: trackerTimeoutDiagnostic,
      },
    });
    await cleanDir(join(OC, "workspaces", "worker-d", "outbox"));
    await writeWorkerPipelineOutbox();

    const timedOutTrackingState = buildSyntheticTrackingState("worker-d", {
      ...workerContract,
      status: CONTRACT_STATUS.FAILED,
      failReason: "tracker_timeout",
      runtimeDiagnostics: {
        ...(workerContract.runtimeDiagnostics || {}),
        trackerTimeout: trackerTimeoutDiagnostic,
      },
    });
    const lateCompletionLease = armLateCompletionLease(timedOutTrackingState, {
      now: Date.now() - 2000,
      diagnostic: trackerTimeoutDiagnostic,
    });
    if (!lateCompletionLease?.active) {
      results.push({
        id: "R3",
        name: "Late completion lease armed",
        status: "FAIL",
        errorCode: "E_LOOP_CONTRACT_PROGRESS",
        elapsed: elapsed(),
        detail: jsonDetail({ lateCompletionLease, trackingState: timedOutTrackingState }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "R3", name: "Late completion lease armed", status: "PASS", elapsed: elapsed(), detail: `expires=${lateCompletionLease.expiresAt}` });

    const workerEndContext = await runSyntheticAgentEnd("worker-d", "test:late:worker", api, timedOutTrackingState);
    const stateAfterWorker = await loadPipelineState();
    const evaluatorContract = await loadActiveInboxContract("evaluator").catch(() => null);
    const advancedWorkerContract = workerEndContext?.trackingState?.contract || null;
    if (
      stateAfterWorker?.currentStage === "evaluator"
      && evaluatorContract?.pipelineStage?.stage === "evaluator"
      && advancedWorkerContract?.assignee === "evaluator"
      && [CONTRACT_STATUS.PENDING, CONTRACT_STATUS.RUNNING].includes(advancedWorkerContract?.status)
      && advancedWorkerContract?.runtimeDiagnostics?.pipelineProgression?.action === "advanced"
      && advancedWorkerContract.runtimeDiagnostics.pipelineProgression?.to === "evaluator"
      && advancedWorkerContract?.runtimeDiagnostics?.lateCompletion?.recovered === true
    ) {
      results.push({
        id: "R4",
        name: "Late completion advances pipeline",
        status: "PASS",
        elapsed: elapsed(),
        detail: summarizeContractLifecycle(advancedWorkerContract),
      });
    } else {
      results.push({
        id: "R4",
        name: "Late completion advances pipeline",
        status: "FAIL",
        errorCode: "E_LOOP_CONTRACT_PROGRESS",
        elapsed: elapsed(),
        detail: jsonDetail({
          pipeline: stateAfterWorker,
          evaluatorStage: evaluatorContract?.pipelineStage || null,
          contract: advancedWorkerContract,
          wakeRequests,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
      contractId: advancedWorkerContract?.id || null,
      contractRuntime: pickLoopContractRuntimeSnapshot(advancedWorkerContract),
    };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState();
  }
}

export async function runPipelineGuardrailsTest(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Loop guardrails: ambiguous runtime progression must hold, illegal targets must be rejected");

  await cleanPipelineState();

  const { loadGraph, saveGraph } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
  } = await import("../lib/loop/graph-loop-registry.js");
  const { startLoopRound: startPipeline } = await import("../lib/loop/loop-round-runtime.js");

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const wakeRequests = [];
  const api = {
    runtime: {
      system: {
        requestHeartbeatNow(payload) {
          wakeRequests.push(payload);
        },
      },
    },
  };

  try {
    await installTestLoopGraph({
      saveGraph,
      saveGraphLoopRegistry,
      ambiguousResearcher: true,
    });

    const startResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "pipeline guardrail test" },
      null,
      null,
      null,
      console,
    );
    if (startResult.action !== "started") {
      results.push({
        id: "G1",
        name: "Start ambiguous loop pipeline",
        status: "FAIL",
        errorCode: "E_LOOP_START_FAIL",
        elapsed: elapsed(),
        detail: jsonDetail(startResult),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "G1", name: "Start ambiguous loop pipeline", status: "PASS", elapsed: elapsed(), detail: `${startResult.currentStage} loop=${startResult.loopId || "-"}` });

    await writeResearcherFollowGraphOutbox();
    const researcherEndContext = await runSyntheticAgentEnd("researcher", "test:guardrail:researcher", api);

    const guardedPipeline = await loadPipelineState();
    const guardedLoopSession = (await loadLoopSessionState())?.activeSession || null;
    const guardedWorkerContract = await loadActiveInboxContract("worker-d").catch(() => null);
    const guardedEvaluatorContract = await loadActiveInboxContract("evaluator").catch(() => null);
    const guardProgression = researcherEndContext?.trackingState?.contract?.runtimeDiagnostics?.pipelineProgression || null;
    if (
      guardProgression?.attempted !== false
      || guardProgression?.skipped !== true
      || guardProgression?.reason !== "ambiguous_runtime_transition"
      || guardedPipeline?.currentStage !== "researcher"
      || guardedLoopSession?.currentStage !== "researcher"
      || guardedLoopSession?.round !== 1
      || guardedWorkerContract
      || guardedEvaluatorContract
      || wakeRequests.length > 0
    ) {
      results.push({
        id: "G2",
        name: "Ambiguous runtime hold",
        status: "FAIL",
        errorCode: "E_LOOP_GUARD_AMBIGUOUS",
        elapsed: elapsed(),
        detail: jsonDetail({
          guardProgression,
          guardedPipeline,
          guardedLoopSession,
          guardedWorkerContract: guardedWorkerContract?.pipelineStage || null,
          guardedEvaluatorContract: guardedEvaluatorContract?.pipelineStage || null,
          wakeRequests,
        }),
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
        contractId: researcherEndContext?.trackingState?.contract?.id || null,
        contractRuntime: pickLoopContractRuntimeSnapshot(researcherEndContext?.trackingState?.contract || null),
      };
    }
    results.push({ id: "G2", name: "Ambiguous runtime hold", status: "PASS", elapsed: elapsed(), detail: `reason=${guardProgression.reason}` });

    const illegalAdvanceResult = await runSyntheticStageAdvance("researcher", {
      targetStage: "contractor",
      result: "illegal jump",
      feedback: "guardrail probe",
    });
    const finalPipeline = await loadPipelineState();
    if (
      illegalAdvanceResult?.action !== "invalid_state"
      || !String(illegalAdvanceResult?.error || "").includes("illegal transition")
      || finalPipeline?.currentStage !== "researcher"
    ) {
      results.push({
        id: "G3",
        name: "Illegal target rejected",
        status: "FAIL",
        errorCode: "E_LOOP_GUARD_ILLEGAL",
        elapsed: elapsed(),
        detail: jsonDetail({ illegalAdvanceResult, finalPipeline }),
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
        contractId: researcherEndContext?.trackingState?.contract?.id || null,
        contractRuntime: pickLoopContractRuntimeSnapshot(researcherEndContext?.trackingState?.contract || null),
      };
    }
    results.push({ id: "G3", name: "Illegal target rejected", status: "PASS", elapsed: elapsed(), detail: illegalAdvanceResult.error });

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
      contractId: researcherEndContext?.trackingState?.contract?.id || null,
      contractRuntime: pickLoopContractRuntimeSnapshot(researcherEndContext?.trackingState?.contract || null),
    };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState().catch(() => {});
  }
}

export async function runPipelineProtocolBoundaryTest(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Pipeline protocol boundary: previous stage output propagation");

  await cleanPipelineState();

  const { loadGraph, saveGraph } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
  } = await import("../lib/loop/graph-loop-registry.js");
  const { startLoopRound: startPipeline } = await import("../lib/loop/loop-round-runtime.js");

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const wakeRequests = [];
  const api = {
    runtime: {
      system: {
        requestHeartbeatNow(payload) {
          wakeRequests.push(payload);
        },
      },
    },
  };
  const wakeupFunc = async (targetAgentId, wakeOptions = {}) => {
    const payload = {
      agentId: targetAgentId,
      ...(wakeOptions?.sessionKey ? { sessionKey: wakeOptions.sessionKey } : {}),
    };
    api.runtime.system.requestHeartbeatNow(payload);
    return {
      ok: true,
      requested: true,
      mode: "heartbeat",
      targetAgent: targetAgentId,
      sessionKey: wakeOptions?.sessionKey || null,
    };
  };

  const MARKER_RESEARCHER = "MARKER_RESEARCHER_ABC";
  const MARKER_WORKER = "MARKER_WORKER_XYZ";

  try {
    await installTestLoopGraph({ saveGraph, saveGraphLoopRegistry });

    // ── P1: Start pipeline at researcher ──
    const startResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "protocol boundary test task" },
      wakeupFunc,
      null,
      null,
      console,
    );
    if (startResult.action !== "started") {
      results.push({
        id: "B1",
        name: "Start pipeline",
        status: "FAIL",
        errorCode: "E_PROTO_START_FAIL",
        elapsed: elapsed(),
        detail: jsonDetail(startResult),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "B1", name: "Start pipeline", status: "PASS", elapsed: elapsed(), detail: `stage=${startResult.currentStage}` });

    // ── P2: Write researcher outbox with MARKER summary, then agent_end ──
    const researcherOutboxDir = join(OC, "workspaces", "researcher", "outbox");
    await mkdir(researcherOutboxDir, { recursive: true });
    await cleanDir(researcherOutboxDir);
    await writeFile(join(researcherOutboxDir, "_manifest.json"), JSON.stringify(stageResultManifest(), null, 2), "utf8");
    await writeStageResult("researcher", buildStageResult({
      stage: "researcher",
      round: 1,
      status: "completed",
      summary: MARKER_RESEARCHER,
      feedback: "advance to worker-d",
      transition: { kind: "advance", targetStage: "worker-d", reason: "protocol boundary test" },
    }));

    const researcherEndContext = await runSyntheticAgentEnd("researcher", "test:proto:researcher", api);

    // ── P3: Read worker-d contract and assert MARKER in task + previousFeedback ──
    const workerContract = await loadActiveInboxContract("worker-d").catch(() => null);
    const workerTask = workerContract?.task || "";
    const workerPrevFeedback = workerContract?.pipelineStage?.previousFeedback || "";

    const taskHasMarker = workerTask.includes(MARKER_RESEARCHER);
    const feedbackHasMarker = workerPrevFeedback.includes(MARKER_RESEARCHER);

    if (taskHasMarker && feedbackHasMarker) {
      results.push({
        id: "B2",
        name: "Worker-d contract contains researcher marker",
        status: "PASS",
        elapsed: elapsed(),
        detail: `task includes marker: ${taskHasMarker}, previousFeedback includes marker: ${feedbackHasMarker}`,
      });
    } else {
      results.push({
        id: "B2",
        name: "Worker-d contract contains researcher marker",
        status: "FAIL",
        errorCode: "E_PROTO_MARKER_MISSING",
        elapsed: elapsed(),
        detail: jsonDetail({
          taskHasMarker,
          feedbackHasMarker,
          task: workerTask.slice(0, 200),
          previousFeedback: workerPrevFeedback.slice(0, 200),
          pipelineStage: workerContract?.pipelineStage || null,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    // ── P4: Write worker-d outbox with MARKER_WORKER, advance to evaluator ──
    const workerOutboxDir = join(OC, "workspaces", "worker-d", "outbox");
    await mkdir(workerOutboxDir, { recursive: true });
    await cleanDir(workerOutboxDir);
    await writeFile(join(workerOutboxDir, "_manifest.json"), JSON.stringify(stageResultManifest(), null, 2), "utf8");
    await writeStageResult("worker-d", buildStageResult({
      stage: "worker-d",
      round: 1,
      status: "completed",
      summary: MARKER_WORKER,
      feedback: "advance to evaluator",
      transition: { kind: "advance", targetStage: "evaluator", reason: "protocol boundary test" },
    }));

    const workerEndContext = await runSyntheticAgentEnd("worker-d", "test:proto:worker", api);

    // ── P5: Read evaluator contract and assert MARKER_WORKER in task + previousFeedback ──
    const evaluatorContract = await loadActiveInboxContract("evaluator").catch(() => null);
    const evaluatorTask = evaluatorContract?.task || "";
    const evaluatorPrevFeedback = evaluatorContract?.pipelineStage?.previousFeedback || "";

    const evalTaskHasMarker = evaluatorTask.includes(MARKER_WORKER);
    const evalFeedbackHasMarker = evaluatorPrevFeedback.includes(MARKER_WORKER);

    if (evalTaskHasMarker && evalFeedbackHasMarker) {
      results.push({
        id: "B3",
        name: "Evaluator contract contains worker marker",
        status: "PASS",
        elapsed: elapsed(),
        detail: `task includes marker: ${evalTaskHasMarker}, previousFeedback includes marker: ${evalFeedbackHasMarker}`,
      });
    } else {
      results.push({
        id: "B3",
        name: "Evaluator contract contains worker marker",
        status: "FAIL",
        errorCode: "E_PROTO_MARKER_MISSING",
        elapsed: elapsed(),
        detail: jsonDetail({
          evalTaskHasMarker,
          evalFeedbackHasMarker,
          task: evaluatorTask.slice(0, 200),
          previousFeedback: evaluatorPrevFeedback.slice(0, 200),
          pipelineStage: evaluatorContract?.pipelineStage || null,
        }),
      });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
    };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState().catch(() => {});
  }
}

export async function runPipelineControlTest(testCase, sse) {
  const startMs = Date.now();
  const results = [];
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);

  console.log("  Pipeline control: break -> repair -> interrupt -> resume");

  await cleanPipelineState();

  const { loadGraph, saveGraph, removeEdge } = await import("../lib/agent/agent-graph.js");
  const {
    loadGraphLoopRegistry,
    saveGraphLoopRegistry,
    listResolvedGraphLoops,
  } = await import("../lib/loop/graph-loop-registry.js");
  const {
    listResolvedLoopSessions,
  } = await import("../lib/loop/loop-session-store.js");
  const {
    startLoopRound: startPipeline,
    concludeLoopRound: concludePipeline,
  } = await import("../lib/loop/loop-round-runtime.js");
  const {
    executeAdminSurfaceOperation,
  } = await import("../lib/admin/admin-surface-operations.js");

  const loopId = "loop-test-cycle";
  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  try {
    await saveGraph({
      edges: [
        { from: "researcher", to: "worker-d", label: "coding", gates: [], metadata: {} },
        { from: "worker-d", to: "evaluator", label: "review", gates: [], metadata: {} },
        { from: "evaluator", to: "researcher", label: "feedback", gates: [], metadata: {} },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [{
        id: loopId,
        kind: "cycle-loop",
        entryAgentId: "researcher",
        nodes: ["researcher", "worker-d", "evaluator"],
        phaseOrder: ["researcher", "worker-d", "evaluator"],
      }],
    });

    const startResult = await startPipeline(
      { startAgent: "researcher", requestedTask: "pipeline control test" },
      null,
      null,
      null,
      console,
    );
    if (startResult.action !== "started" || !startResult.loopSessionId) {
      results.push({ id: "C1", name: "Start loop pipeline", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(startResult) });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "C1", name: "Start loop pipeline", status: "PASS", elapsed: elapsed(), detail: `${startResult.loopId} @ ${startResult.currentStage}` });

    await removeEdge("evaluator", "researcher");
    const brokenGraph = await loadGraph();
    const brokenLoops = await listResolvedGraphLoops({ graph: brokenGraph });
    const brokenSessions = await listResolvedLoopSessions({ loops: brokenLoops });
    const brokenSession = brokenSessions.find((session) => session?.active === true) || null;
    if (brokenSession?.runtimeStatus === "broken" && (brokenSession.missingEdges?.length || 0) > 0) {
      results.push({ id: "C2", name: "Break loop", status: "PASS", elapsed: elapsed(), detail: `missingEdges=${brokenSession.missingEdges.length}` });
    } else {
      results.push({ id: "C2", name: "Break loop", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(brokenSession) });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    const repairResult = await executeAdminSurfaceOperation({
      surfaceId: "graph.loop.repair",
      payload: { loopId },
      logger: console,
      onAlert: null,
      runtimeContext: null,
    });
    const repairedGraph = await loadGraph();
    const repairedLoops = await listResolvedGraphLoops({ graph: repairedGraph });
    const repairedLoop = repairedLoops.find((loop) => loop?.id === loopId) || null;
    if (repairResult?.ok === true && repairedLoop?.active === true && (repairedLoop.missingEdges?.length || 0) === 0) {
      results.push({ id: "C3", name: "Repair loop", status: "PASS", elapsed: elapsed(), detail: `added=${repairResult.addedEdges?.length || 0}` });
    } else {
      results.push({ id: "C3", name: "Repair loop", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(repairResult) });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    const advanceResult = await runSyntheticStageAdvance("researcher", {
      targetStage: "worker-d",
      result: "outbox/direction.json",
      feedback: "control advance",
    });
    if (advanceResult.action !== "advanced" || advanceResult.to !== "worker-d") {
      results.push({ id: "C4", name: "Advance before interrupt", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(advanceResult) });
      return { testCase, results, duration: elapsed(), pass: false };
    }
    results.push({ id: "C4", name: "Advance before interrupt", status: "PASS", elapsed: elapsed(), detail: `${advanceResult.from} -> ${advanceResult.to}` });

    const interruptResult = await executeAdminSurfaceOperation({
      surfaceId: "runtime.loop.interrupt",
      payload: { loopId, reason: "test_interrupt" },
      logger: console,
      onAlert: null,
      runtimeContext: null,
    });
    const interruptedPipeline = await loadPipelineState();
    const interruptedLoopSessionState = await loadLoopSessionState();
    const interruptedSession = interruptedLoopSessionState?.recentSessions?.[0] || null;
    if (
      interruptResult?.action === "interrupted"
      && interruptedPipeline?.currentStage === "concluded"
      && interruptedSession?.status === "interrupted"
      && interruptedSession?.currentStage === "worker-d"
    ) {
      results.push({ id: "C5", name: "Interrupt loop", status: "PASS", elapsed: elapsed(), detail: `stage=${interruptedSession.currentStage}` });
    } else {
      results.push({ id: "C5", name: "Interrupt loop", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify({ interruptResult, interruptedPipeline, interruptedSession })?.slice(0, 240) });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    const resumeResult = await executeAdminSurfaceOperation({
      surfaceId: "runtime.loop.resume",
      payload: { loopId, reason: "test_resume" },
      logger: console,
      onAlert: null,
      runtimeContext: null,
    });
    const resumedPipeline = await loadPipelineState();
    const resumedLoopSessionState = await loadLoopSessionState();
    const resumedSession = resumedLoopSessionState?.activeSession || null;
    if (
      resumeResult?.action === "resumed"
      && resumedPipeline?.currentStage === "worker-d"
      && resumedSession?.status === "active"
      && resumedSession?.currentStage === "worker-d"
      && resumedSession?.metadata?.resumedFromLoopSessionId
    ) {
      results.push({ id: "C6", name: "Resume loop", status: "PASS", elapsed: elapsed(), detail: `stage=${resumedSession.currentStage} round=${resumedSession.round}` });
    } else {
      results.push({ id: "C6", name: "Resume loop", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify({ resumeResult, resumedPipeline, resumedSession })?.slice(0, 240) });
      return { testCase, results, duration: elapsed(), pass: false };
    }

    const concludeResult = await concludePipeline("control_complete", console);
    if (concludeResult.action === "concluded") {
      results.push({ id: "C7", name: "Conclude resumed pipeline", status: "PASS", elapsed: elapsed(), detail: `reason=${concludeResult.reason}` });
    } else {
      results.push({ id: "C7", name: "Conclude resumed pipeline", status: "FAIL", elapsed: elapsed(), detail: JSON.stringify(concludeResult) });
    }

    return { testCase, results, duration: elapsed(), pass: results.every((result) => result.status === "PASS") };
  } finally {
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
    await cleanPipelineState().catch(() => {});
  }
}

export function generateLoopReport(testResults, totalDuration) {
  const lines = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const passed = testResults.filter(r => r.pass).length;
  const failed = testResults.filter(r => !r.pass).length;

  lines.push("══════════════════════════════════════════════════");
  lines.push(" OPENCLAW LOOP / PIPELINE TEST REPORT");
  lines.push(` Run: ${now}  Duration: ${totalDuration}s`);
  lines.push(` Gateway: localhost:${PORT}`);
  lines.push(` Tests: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`);
  lines.push("══════════════════════════════════════════════════");
  lines.push("");

  for (const tr of testResults) {
    const tc = tr.testCase;
    const result = tr.pass ? "PASS" : "FAIL";
    lines.push(`── TEST: ${tc.id} ──`);
    lines.push(`${tc.description}`);
    lines.push(`Duration: ${tr.duration}s  Result: ${result}`);
    if (tr.finalStats) lines.push(`Stats: ${tr.finalStats}`);
    lines.push("");

    for (const cp of tr.results) {
      const statusStr = `[${cp.status}]`.padEnd(6);
      const nameStr = cp.name.padEnd(24);
      const elapsedStr = `${cp.elapsed}s`.padStart(6);
      let line = `  ${statusStr} ${cp.id} ${nameStr} ${elapsedStr}`;
      if (cp.detail) line += `  ${cp.detail}`;
      lines.push(line);
      if ((cp.status === "FAIL" || cp.status === "BLOCKED") && cp.errorCode) {
        lines.push(`          └─ ${cp.errorCode}: ${cp.detail || "timeout"}`);
      }
    }
    if (!tr.pass) {
      const diagnosis = summarizeTestDiagnosis(tr);
      if (diagnosis) {
        lines.push(`  Diagnosis: [${diagnosis.subsystem}] ${diagnosis.conclusion}`);
        lines.push(`             ${diagnosis.errorCode} | ${diagnosis.evidence}`);
        if (diagnosis.suggestedFix) {
          lines.push(`  Fix Hint: ${diagnosis.suggestedFix}`);
        }
        if (diagnosis.runtimeHint) {
          lines.push(`  Runtime: [${diagnosis.runtimeHint.lane}] ${diagnosis.runtimeHint.summary}`);
          if (diagnosis.runtimeHint.detail) {
            lines.push(`           ${diagnosis.runtimeHint.detail}`);
          }
        }
      }
    }
    lines.push("");
  }

  lines.push("══════════════════════════════════════════════════");
  lines.push(` SUMMARY: ${passed}/${testResults.length} PASSED  ${failed} FAILED`);

  if (failed > 0) {
    lines.push("");
    lines.push(" FAILURES:");
    for (const tr of testResults.filter(r => !r.pass)) {
      const diagnosis = summarizeTestDiagnosis(tr);
      if (diagnosis) {
        lines.push(`   ${tr.testCase.id}: ${diagnosis.errorCode} [${diagnosis.subsystem}]`);
        lines.push(`     → ${diagnosis.conclusion}`);
        if (diagnosis.suggestedFix) lines.push(`       fix: ${diagnosis.suggestedFix}`);
      } else {
        const lastFail = tr.results.findLast(r => r.status === "FAIL");
        if (lastFail) {
          lines.push(`   ${tr.testCase.id}: ${lastFail.id} ${lastFail.name}`);
          if (lastFail.detail) lines.push(`     → ${lastFail.detail}`);
        }
      }
    }
  }

  lines.push("══════════════════════════════════════════════════");
  return lines.join("\n");
}
