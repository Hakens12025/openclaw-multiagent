// lib/formal-runtime/infra.js — Formal runtime shared infrastructure

import { readFile, readdir, mkdir, unlink, rm, cp, mkdtemp } from "node:fs/promises";
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
import { readStoredAgentBinding } from "../agent/agent-binding-store.js";
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
const LEGACY_WEB_DELIVERIES_DIR = join(OC, "workspaces", "controller", "deliveries");
const LEGACY_QQ_DELIVERIES_DIR = join(OC, "workspaces", "kksl", "deliveries");

export let DELIVERIES_DIR = LEGACY_WEB_DELIVERIES_DIR;
export let QQ_DELIVERIES_DIR = LEGACY_QQ_DELIVERIES_DIR;
export let WORKER_IDS = [];
export let RUNTIME_AGENT_IDS = [];

// ── Mutable config (set by loadConfig) ───────────────────────────────────────
let cfg = null;
let ACTIVE_WORK_AGENT_IDS = new Set();
let preservedWorkspaceSnapshot = null;

function resolveGatewayDeliveryDir(source, fallbackDir) {
  const gatewayAgentId = resolveGatewayAgentIdForSource(source);
  return gatewayAgentId
    ? join(agentWorkspace(gatewayAgentId), "deliveries")
    : fallbackDir;
}

function resolveRuntimeWorkAgentIds() {
  const ids = [
    ...listAgentIdsByRole(AGENT_ROLE.PLANNER),
    ...listAgentIdsByRole(AGENT_ROLE.RESEARCHER),
    ...listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
    ...listAgentIdsByRole(AGENT_ROLE.REVIEWER),
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
  DELIVERIES_DIR = resolveGatewayDeliveryDir("webui", LEGACY_WEB_DELIVERIES_DIR);
  QQ_DELIVERIES_DIR = resolveGatewayDeliveryDir("qq", LEGACY_QQ_DELIVERIES_DIR);
  ACTIVE_WORK_AGENT_IDS = new Set(runtimeConfig.activeWorkAgentIds);
}

// ── Bridge Agent Resolution ──────────────────────────────────────────────────
export function resolveBridgeAgent() {
  const agents = cfg?.agents?.list || [];
  const bindings = cfg?.bindings || [];
  const withBinding = agents.find(a =>
    readStoredAgentBinding(a)?.roleRef === "bridge" && bindings.some(b => b.agentId === a.id)
  );
  if (withBinding) return withBinding.id;
  const anyBridge = agents.find(a => readStoredAgentBinding(a)?.roleRef === "bridge");
  return anyBridge?.id || null;
}

export async function sendViaBridge(message) {
  return sendWebhook(message);
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

export async function sendWebhook(message) {
  const res = await httpFetch(`${BASE}/hooks/agent`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokens.hook}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });
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
export async function cleanTestArtifacts() {
  console.log("Cleaning test artifacts...");
  const dirs = [
    CONTRACTS_DIR, DELIVERIES_DIR, OUTPUT_DIR,
    QQ_DELIVERIES_DIR,
    ...RUNTIME_AGENT_IDS.flatMap(agentId => [
      join(agentWorkspace(agentId), "inbox"),
      join(agentWorkspace(agentId), "outbox"),
    ]),
  ];
  for (const dir of dirs) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.startsWith("TC-") || f.startsWith("DL-") || f.startsWith("REQ-")) {
          await unlink(join(dir, f));
        }
      }
    } catch {}
  }
  console.log("Cleanup done.");
}

function getPreservedWorkspaceDirs() {
  return [
    ...RUNTIME_AGENT_IDS.flatMap(agentId => [
      join(agentWorkspace(agentId), "inbox"),
      join(agentWorkspace(agentId), "outbox"),
    ]),
    QQ_DELIVERIES_DIR,
  ];
}

async function ensurePreservedWorkspaceSnapshot() {
  if (preservedWorkspaceSnapshot) {
    return preservedWorkspaceSnapshot;
  }

  const root = await mkdtemp(join(tmpdir(), "openclaw-test-preserve-"));
  const entries = [];
  for (const sourceDir of getPreservedWorkspaceDirs()) {
    try {
      const files = await readdir(sourceDir);
      if (files.length === 0) {
        continue;
      }
      const backupDir = join(root, relative(OC, sourceDir));
      await mkdir(dirname(backupDir), { recursive: true });
      await cp(sourceDir, backupDir, { recursive: true, force: true });
      entries.push({ sourceDir, backupDir });
    } catch {}
  }

  preservedWorkspaceSnapshot = { root, entries };
  return preservedWorkspaceSnapshot;
}

export async function restorePreservedWorkspaceState() {
  if (!preservedWorkspaceSnapshot) {
    return;
  }

  const snapshot = preservedWorkspaceSnapshot;
  preservedWorkspaceSnapshot = null;

  for (const dir of getPreservedWorkspaceDirs()) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  for (const entry of snapshot.entries) {
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
  const inboxOutbox = [
    ...RUNTIME_AGENT_IDS.flatMap(agentId => [
      join(agentWorkspace(agentId), "inbox"),
      join(agentWorkspace(agentId), "outbox"),
    ]),
    QQ_DELIVERIES_DIR,
  ];
  for (const dir of inboxOutbox) {
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

export async function waitForAllSettled(sse, maxWaitMs = 180000) {
  console.log("  Waiting for registered work-agent sessions to fully end...");
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const runtime = await fetchJSON("/watchdog/runtime");
      const sessions = Object.entries(runtime.trackingSessions || {});
      const activeWorkSessions = sessions.filter(([key, v]) => {
        const id = v.agentId || key;
        return ACTIVE_WORK_AGENT_IDS.has(id);
      });
      if (activeWorkSessions.length === 0) {
        console.log("  All registered work-agent sessions ended.");
        return true;
      }
      for (const [key, v] of activeWorkSessions) {
        console.log(`  (still active: ${v.agentId} status=${v.status} elapsed=${Math.round(v.elapsedMs/1000)}s)`);
      }
    } catch {}
    await sleep(5000);
  }
  console.log("  (settle timeout — forcing proceed)");
  return false;
}
