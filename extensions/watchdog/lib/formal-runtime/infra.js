// lib/formal-runtime/infra.js — Formal runtime shared infrastructure

import { readFile, readdir, lstat, mkdir, unlink, rm, cp, mkdtemp } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import http from "node:http";
import { agentWorkspace } from "../state.js";
import {
  AGENT_ROLE,
  listAgentIdsByRole,
  listRuntimeAgentIds,
  registerRuntimeAgents,
  resolveGatewayAgentIdForSource,
} from "../agent/agent-identity.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { PORT, BASE, tokens } from "./infra-tokens.js";

export { PORT, BASE, tokens } from "./infra-tokens.js";
export { SSEClient } from "./infra-sse.js";

// ── Paths & Constants ────────────────────────────────────────────────────────
export const HOME = homedir();
export const OC = join(HOME, ".openclaw");
export const CONTRACTS_DIR = CONTROL_PLANE_PATHS.contractsDir;
export const OUTPUT_DIR = CONTROL_PLANE_PATHS.outputDir;
export const REPORTS_DIR = join(OC, "test-reports");
export const CONFIG_FILE = join(OC, "openclaw.json");

// Delivery dirs resolve purely from the gateway agent binding (set by loadConfig).
// null = no resolved gateway agent for that source → no delivery dir to clean.
export let DELIVERIES_DIR = null;
export let QQ_DELIVERIES_DIR = null;
export let WORKER_IDS = [];
export let RUNTIME_AGENT_IDS = [];

// ── Mutable config (set by loadConfig) ───────────────────────────────────────
let cfg = null;
let ACTIVE_WORK_AGENT_IDS = new Set();
let preservedWorkspaceSnapshot = null;

function resolveGatewayDeliveryDir(source) {
  const gatewayAgentId = resolveGatewayAgentIdForSource(source);
  return gatewayAgentId
    ? join(agentWorkspace(gatewayAgentId), "deliveries")
    : null;
}

function resolveRuntimeWorkAgentIds() {
  const ids = [
    ...listAgentIdsByRole(AGENT_ROLE.PLANNER),
    ...listAgentIdsByRole(AGENT_ROLE.RESEARCHER),
    ...listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
  ];
  return ids;
}

export function resolveFormalRuntimeConfig(config) {
  registerRuntimeAgents(config);
  const runtimeAgentIds = listRuntimeAgentIds();
  if (runtimeAgentIds.length === 0) {
    throw new Error("formal runtime requires registered runtime agents");
  }
  return {
    workerIds: listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
    runtimeAgentIds,
    activeWorkAgentIds: resolveRuntimeWorkAgentIds(),
  };
}

export async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, "utf8");
  cfg = JSON.parse(raw);
  tokens.gateway = cfg.gateway?.auth?.token ?? "";
  tokens.hook = cfg.hooks?.token ?? "";

  const runtimeConfig = resolveFormalRuntimeConfig(cfg);
  WORKER_IDS = runtimeConfig.workerIds;
  RUNTIME_AGENT_IDS = runtimeConfig.runtimeAgentIds;
  DELIVERIES_DIR = resolveGatewayDeliveryDir("webui");
  QQ_DELIVERIES_DIR = resolveGatewayDeliveryDir("qq");
  ACTIVE_WORK_AGENT_IDS = new Set(runtimeConfig.activeWorkAgentIds);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
export function httpFetch(url, options = {}) {
  const timeoutMs = options.timeout ?? 30000;
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP request timeout after ${timeoutMs}ms: ${options.method || "GET"} ${url}`));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export async function fetchJSON(path) {
  const res = await httpFetch(`${BASE}${path}?token=${tokens.gateway}`);
  return JSON.parse(res.body);
}

export async function wakeAgentNow(agentId, message) {
  const res = await httpFetch(`${BASE}/hooks/agent`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokens.hook}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, agentId, wakeMode: "now" }),
  });
  return JSON.parse(res.body);
}

export async function sendTestInject(message, source = "webui", replyTo = null) {
  const res = await httpFetch(`${BASE}/watchdog/tests/inject?token=${tokens.gateway}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, source, replyTo }),
  });
  return JSON.parse(res.body);
}

export async function postAdmin(path, payload) {
  const res = await httpFetch(`${BASE}${path}?token=${tokens.gateway}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return JSON.parse(res.body);
}

export async function addGraphEdgeViaSurface(from, to, payload = {}) {
  return postAdmin("/watchdog/graph/edge/add", {
    ...payload,
    from,
    to,
  });
}

export async function deleteGraphEdgeViaSurface(from, to, payload = {}) {
  return postAdmin("/watchdog/graph/edge/delete", {
    ...payload,
    from,
    to,
  });
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

// 清理面 lstat 化(批④刀2,备忘录143 §七):workspace inbox/outbox 本体是 symlink 时
// 只摘链本体+恢复真目录,绝不 readdir 进链删文件(经链删=删穿树内正本)。
// 真目录期无链,恒 false=行为零变化。
async function unlinkIfMailboxSymlink(dir) {
  try {
    if (!(await lstat(dir)).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  await unlink(dir).catch(() => {});
  await mkdir(dir, { recursive: true }).catch(() => {});
  return true;
}

function getRuntimeMailboxDirs() {
  return RUNTIME_AGENT_IDS.flatMap(agentId => [
    join(agentWorkspace(agentId), "inbox"),
    join(agentWorkspace(agentId), "outbox"),
  ]);
}

export async function cleanTestArtifacts() {
  console.log("Cleaning test artifacts...");
  const mailboxDirs = getRuntimeMailboxDirs();
  const dirs = [
    CONTRACTS_DIR, DELIVERIES_DIR, OUTPUT_DIR,
    QQ_DELIVERIES_DIR,
    ...mailboxDirs,
  ].filter(Boolean);
  for (const dir of dirs) {
    if (mailboxDirs.includes(dir) && await unlinkIfMailboxSymlink(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.startsWith("TC-") || f.startsWith("DL-") || f.startsWith("REQ-")) {
          await unlink(join(dir, f));
        }
      }
    } catch {}
  }
  await cleanTreeContractLeftovers();
  console.log("Cleanup done.");
}

/**
 * 树店清扫(审查⑤ / 2026-08-19 收窄)。live 套件的合约落 threads 树,清的目的是
 * 不给下一轮留活跃残留 —— boot 时 recoverOrphanedContracts 扫全树补关 running 孤儿,
 * 上一轮跑剩的活跃合约会污染它。
 *
 * **只清活跃态(pending/running),终态合约一概留下。** 此前按 TC-/DL-/REQ- 前缀
 * 盲删全树,而生产合约 id 恰好也是 TC- 开头 —— 每跑一次 live 预设,历史 run 的合约
 * 正本被删光(实测 354 个 run 的 contracts/ 全空)。树按 run 分区,历史合约不干扰新 run,
 * 它们该随 run 的 30 天 TTL 走,不该被下一轮测试抹掉:那是记录面缺一层,不是清理。
 *
 * 单独导出是为了能被单测直接调:整个 cleanTestArtifacts 还会清 agent 的 inbox/outbox,
 * 在沙箱单测里调那个等于伸手进生产工作区。
 *
 * @returns {Promise<{removed:number, kept:number}>}
 */
export async function cleanTreeContractLeftovers() {
  const stats = { removed: 0, kept: 0 };
  try {
    const { listTreeContractPaths, clearContractStore } = await import("../store/contract-store.js");
    const { rebuildContractIndex } = await import("../archive/thread-tree-store.js");
    const { isTerminalContractStatus } = await import("../core/runtime-status.js");
    const { basename } = await import("node:path");
    const { readFile } = await import("node:fs/promises");
    for (const contractPath of await listTreeContractPaths()) {
      const name = basename(contractPath);
      if (!(name.startsWith("TC-") || name.startsWith("DL-") || name.startsWith("REQ-"))) continue;
      let status = null;
      try {
        status = JSON.parse(await readFile(contractPath, "utf8"))?.status ?? null;
      } catch {
        status = null; // 读不出来按活跃处理:清掉一份坏文件好过留个扫不动的孤儿
      }
      if (status && isTerminalContractStatus(status)) {
        stats.kept += 1;
        continue;
      }
      try { await unlink(contractPath); stats.removed += 1; } catch {}
    }
    if (stats.removed > 0) {
      await rebuildContractIndex({});
      clearContractStore();
    }
    console.log(`Tree cleanup: removed ${stats.removed} active leftover(s), kept ${stats.kept} terminal contract(s) as run records.`);
  } catch { /* 清理面严格弱于执行面,失败不阻断 */ }
  return stats;
}

function getPreservedWorkspaceDirs() {
  return [
    ...getRuntimeMailboxDirs(),
    QQ_DELIVERIES_DIR,
  ].filter(Boolean);
}

// 链目录整体跳过(批④刀2):内容的家在树,快照/恢复只管真目录。
// dirs 参数仅供行为锁测试注入沙箱目录,fullReset 走默认名单。
export async function ensurePreservedWorkspaceSnapshot({ dirs = null } = {}) {
  if (preservedWorkspaceSnapshot) {
    return preservedWorkspaceSnapshot;
  }

  const root = await mkdtemp(join(tmpdir(), "openclaw-test-preserve-"));
  const entries = [];
  for (const sourceDir of dirs || getPreservedWorkspaceDirs()) {
    try {
      if ((await lstat(sourceDir)).isSymbolicLink()) continue; // 链目录不入快照
      const files = await readdir(sourceDir);
      if (files.length === 0) {
        continue;
      }
      // OC 外的源目录(自定义 workspace/测试沙箱):relative 会带 .. 逃出快照根,
      // 改用编码绝对路径,快照必须整体落在快照根内。
      const rel = relative(OC, sourceDir);
      const backupDir = rel.startsWith("..")
        ? join(root, "external", sourceDir.replaceAll("/", "__"))
        : join(root, rel);
      await mkdir(dirname(backupDir), { recursive: true });
      await cp(sourceDir, backupDir, { recursive: true, force: true });
      entries.push({ sourceDir, backupDir });
    } catch {}
  }

  preservedWorkspaceSnapshot = { root, entries };
  return preservedWorkspaceSnapshot;
}

export async function restorePreservedWorkspaceState({ dirs = null } = {}) {
  if (!preservedWorkspaceSnapshot) {
    return;
  }

  const snapshot = preservedWorkspaceSnapshot;
  preservedWorkspaceSnapshot = null;

  for (const dir of dirs || getPreservedWorkspaceDirs()) {
    try {
      if ((await lstat(dir)).isSymbolicLink()) continue; // 链目录跳过:恢复只管真目录
    } catch {}
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  for (const entry of snapshot.entries) {
    try {
      if ((await lstat(entry.sourceDir)).isSymbolicLink()) continue; // 快照后被切成链 → 树是家,不回灌
    } catch {}
    await mkdir(dirname(entry.sourceDir), { recursive: true });
    await cp(entry.backupDir, entry.sourceDir, { recursive: true, force: true });
  }
  await rm(snapshot.root, { recursive: true, force: true }).catch(() => {});
}

export function buildFullResetRequestBody() {
  return JSON.stringify({ explicitConfirm: true });
}

export async function requestRuntimeReset({ fetchImpl = httpFetch } = {}) {
  const res = await fetchImpl(`${BASE}/watchdog/reset?token=${tokens.gateway}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: buildFullResetRequestBody(),
  });
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`runtime reset failed: HTTP ${res?.status ?? "unknown"}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (error) {
    throw new Error(`runtime reset returned invalid JSON: ${error.message}`);
  }
  if (!data?.cleared || !Number.isFinite(data.cleared.sessions) || !Number.isFinite(data.cleared.history)) {
    throw new Error("runtime reset returned malformed response");
  }
  return data;
}

export async function fullReset() {
  console.log("  Full reset: clearing memory + files...");
  await ensurePreservedWorkspaceSnapshot();
  const data = await requestRuntimeReset();
  console.log(`  Memory cleared: ${data.cleared.sessions} sessions, ${data.cleared.history} history`);
  await cleanTestArtifacts();
  const mailboxDirs = getRuntimeMailboxDirs();
  const inboxOutbox = [
    ...mailboxDirs,
    QQ_DELIVERIES_DIR,
  ].filter(Boolean);
  for (const dir of inboxOutbox) {
    if (mailboxDirs.includes(dir) && await unlinkIfMailboxSymlink(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const f of files) await rm(join(dir, f), { recursive: true, force: true });
    } catch {}
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function waitForIdle(maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const runtime = await fetchJSON("/watchdog/runtime");
      const sessions = Object.entries(runtime.trackingSessions || {});
      const running = sessions.filter(([key, v]) => {
        if (v.status !== "running") return false;
        const id = v.agentId || key;
        return ACTIVE_WORK_AGENT_IDS.has(id);
      });
      if (running.length === 0) return true;
      const runningAgents = running.map(([, v]) => v.agentId).join(", ");
      console.log(`  (waiting for idle... ${runningAgents} still running)`);
    } catch {}
    await sleep(5000);
  }
  console.log("  (idle wait timeout, proceeding anyway)");
  return false;
}

