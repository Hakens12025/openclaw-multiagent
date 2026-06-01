// run-tsp-loop.js — 驱动一次真实的 TSP 固定 loop 运行并量化评分。
//
// 架构（关键）：本模块跑在独立进程，loop 的真实执行由【网关进程】完成（心跳唤醒 agent →
// 真 LLM → agent_end 路由到下一环）。所以这里走【网关 HTTP surface 驱动】+【磁盘观测】：
//   - 驱动：POST /watchdog/runtime/loop/start（网关在自身进程内用真实 runtime context 执行 → 真唤醒）
//   - 观测：轮询 research-lab/loop_session_state.json 判结束；扫 control-plane/artifacts 读各 agent 巡回
//
// 【复用现存 loop，绝不 compose 第二个】(Bug A 教训)：在同一套边上再 compose 第二个 active loop 会
// 让 loop session 拓扑归属打架、runtime 把会话归档（"contract session 已归档"）。所以这里直接复用已
// 注册的 loop-researcher1-worker-e-reviewer1，maxRounds 经 budget 逐次覆盖（不污染注册的 maxRounds）。
//
// 治理隔离：纯 loop 运行不经 automation-finalize（不派生 ProfileLifecycle / 不沉淀 skill），构造性隔离。
// maxRounds 到点由 evaluateLoopBudgetGovernance 强制 force-conclude。

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";

import { buildTspTaskMessage, KNOWN_OPTIMAL, NEAREST_NEIGHBOR_BASELINE } from "./tsp-task.js";
import { scoreTspOutput } from "./tsp-scoring.js";
import { loadLoopSessionState } from "../../loop/loop-session-store.js";
import { CONTROL_PLANE_PATHS } from "../../control-plane/control-plane-paths.js";

const OC = join(homedir(), ".openclaw");
const CONFIG_FILE = join(OC, "openclaw.json");
const ARTIFACTS_ROOT = join(CONTROL_PLANE_PATHS.root, "artifacts");
const GATEWAY_HOST = "localhost";
const GATEWAY_PORT = 18789;

// 复用已注册的生产 loop（researcher1 -> worker-e -> reviewer1）。不另建。
export const TSP_LOOP_ID = "loop-researcher1-worker-e-reviewer1";
export const TSP_LOOP_AGENTS = ["researcher1", "worker-e", "reviewer1"];
export const TSP_ENTRY_AGENT = "researcher1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadGatewayToken() {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  return cfg.gateway?.auth?.token ?? "";
}

// 向网关 admin surface POST。返回解析后的 JSON 结果（网关在自身进程内真实执行该 surface）。
function postSurface(path, token, payload) {
  const body = JSON.stringify(payload ?? {});
  const search = token ? `?token=${encodeURIComponent(token)}` : "";
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: GATEWAY_HOST,
      port: GATEWAY_PORT,
      path: `${path}${search}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function resolveTerminalReason(session) {
  if (!session || typeof session !== "object") return null;
  return session.terminalOutcome?.reason
    || session.concludeReason
    || session.lastTransition?.reason
    || session.status
    || null;
}

// 轮询 loop session 状态直到结束或超时。每当轮次/阶段推进调 onTick。
async function waitForLoopConclusion({ timeoutMs, pollIntervalMs, onTick }) {
  const deadline = Date.now() + timeoutMs;
  let sawActive = false;
  let loopSessionId = null;
  let lastRound = 0;
  let lastStage = null;

  while (Date.now() < deadline) {
    const state = await loadLoopSessionState().catch(() => null);
    const active = state?.activeSession || null;
    const recent = Array.isArray(state?.recentSessions) ? state.recentSessions : [];

    if (active && active.loopId === TSP_LOOP_ID) {
      sawActive = true;
      loopSessionId = active.id || loopSessionId;
      const round = Number.isFinite(active.round) ? active.round : lastRound;
      if (round !== lastRound || active.currentStage !== lastStage) {
        lastRound = round;
        lastStage = active.currentStage || lastStage;
        onTick?.({ round, stage: active.currentStage || null, status: active.status || "active" });
      }
      if (active.status && active.status !== "active") {
        return { concluded: true, status: active.status, reason: resolveTerminalReason(active), session: active, lastRound };
      }
    } else {
      const archived = recent.find((s) => (loopSessionId && s.id === loopSessionId) || s.loopId === TSP_LOOP_ID) || null;
      if (archived && sawActive) {
        return { concluded: true, status: archived.status || "concluded", reason: resolveTerminalReason(archived), session: archived, lastRound };
      }
      if (sawActive) {
        return { concluded: true, status: "concluded", reason: "session_cleared", session: null, lastRound };
      }
    }
    await sleep(pollIntervalMs);
  }
  return { concluded: false, status: "timeout", reason: "poll_timeout", session: null, lastRound };
}

// 扫 control-plane/artifacts，读本次运行（mtime >= sinceMs）期间各 agent 产物，解析+评分巡回。
async function collectTourArtifacts(sinceMs) {
  const results = [];
  if (!existsSync(ARTIFACTS_ROOT)) return results;
  const contractDirs = await readdir(ARTIFACTS_ROOT, { withFileTypes: true }).catch(() => []);
  for (const contractEntry of contractDirs) {
    if (!contractEntry.isDirectory()) continue;
    const contractId = contractEntry.name;
    const agentDirs = await readdir(join(ARTIFACTS_ROOT, contractId), { withFileTypes: true }).catch(() => []);
    for (const agentEntry of agentDirs) {
      if (!agentEntry.isDirectory()) continue;
      const agentId = agentEntry.name;
      const pkgDir = join(ARTIFACTS_ROOT, contractId, agentId);
      const files = await readdir(pkgDir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || file.name === "manifest.json") continue;
        const filePath = join(pkgDir, file.name);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat || fileStat.mtimeMs < sinceMs) continue;
        const content = await readFile(filePath, "utf8").catch(() => "");
        const scored = scoreTspOutput(content);
        if (scored.tour === null) continue; // 无 TOUR 标记的产物跳过(非巡回交付物)
        results.push({
          contractId,
          agentId,
          file: file.name,
          mtimeMs: fileStat.mtimeMs,
          valid: scored.valid,
          score: scored.score,
          length: scored.length,
          ratio: scored.ratio,
          optimalityGap: scored.optimalityGap,
          beatsNearestNeighbor: scored.beatsNearestNeighbor,
          tour: scored.tour,
        });
      }
    }
  }
  return results;
}

/**
 * 跑一次完整的 TSP 固定 loop 并评分。复用现存 loop，不另建。
 * @param {{maxRounds?:number, timeoutMs?:number, pollIntervalMs?:number, logger?:Console}} opts
 */
export async function runTspLoop({
  maxRounds = 5,
  timeoutMs = 600000,
  pollIntervalMs = 5000,
  logger = console,
} = {}) {
  const runStartMs = Date.now();
  const token = await loadGatewayToken();
  const ticks = [];

  // 前置：不得有活跃 loop session（避免与真实任务/其他 loop 撞车）。
  const preState = await loadLoopSessionState().catch(() => null);
  if (preState?.activeSession && preState.activeSession.status === "active") {
    return { ok: false, phase: "preflight", detail: { error: "已有活跃 loop session，拒绝启动", activeSession: preState.activeSession } };
  }

  const startRes = await postSurface("/watchdog/runtime/loop/start", token, {
    loopId: TSP_LOOP_ID,
    requestedTask: buildTspTaskMessage(),
    startAgent: TSP_ENTRY_AGENT,
    budget: { maxRounds }, // 逐次覆盖，不改注册的 LoopSpec.maxRounds
  });
  if (startRes.status !== 200 || startRes?.body?.action !== "started") {
    return { ok: false, phase: "start", detail: startRes };
  }
  logger?.info?.(`[tsp] loop started (reuse ${TSP_LOOP_ID}): contract=${startRes.body.contractId} -> ${startRes.body.targetAgent}  maxRounds=${maxRounds}`);

  const conclusion = await waitForLoopConclusion({
    timeoutMs,
    pollIntervalMs,
    onTick: (tick) => {
      ticks.push(tick);
      logger?.info?.(`[tsp] round ${tick.round}  stage=${tick.stage}  status=${tick.status}`);
    },
  });
  logger?.info?.(`[tsp] loop ${conclusion.concluded ? "concluded" : "TIMED OUT"}: status=${conclusion.status} reason=${conclusion.reason}`);

  const artifacts = await collectTourArtifacts(runStartMs);
  const valid = artifacts.filter((a) => a.valid).sort((a, b) => b.score - a.score);
  const best = valid[0] || null;

  return {
    ok: true,
    loopId: TSP_LOOP_ID,
    maxRounds,
    started: startRes?.body?.action === "started",
    startContractId: startRes?.body?.contractId || null,
    concluded: conclusion?.concluded || false,
    finalStatus: conclusion?.status || null,
    terminalReason: conclusion?.reason || null,
    roundsObserved: conclusion?.lastRound || (ticks.length ? Math.max(...ticks.map((t) => t.round || 0)) : 0),
    ticks,
    artifactCount: artifacts.length,
    validTourCount: valid.length,
    best,
    allTours: artifacts.sort((a, b) => b.score - a.score),
    knownOptimal: Math.round(KNOWN_OPTIMAL * 1e4) / 1e4,
    nearestNeighborBaseline: Math.round(NEAREST_NEIGHBOR_BASELINE * 1e4) / 1e4,
    durationMs: Date.now() - runStartMs,
  };
}
