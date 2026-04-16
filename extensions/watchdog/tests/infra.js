// tests/infra.js — Shared test infrastructure: config, HTTP, SSE, log, cleanup, utils

import { readFile, readdir, writeFile, mkdir, unlink, rm, cp, mkdtemp } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import http from "node:http";
import { agentWorkspace } from "../lib/state.js";
import {
  AGENT_ROLE,
  listAgentIdsByRole,
  listRuntimeAgentIds,
  registerRuntimeAgents,
  resolveGatewayAgentIdForSource,
} from "../lib/agent/agent-identity.js";
import { readStoredAgentBinding } from "../lib/agent/agent-binding-store.js";

// ── Paths & Constants ────────────────────────────────────────────────────────
export const HOME = homedir();
export const OC = join(HOME, ".openclaw");
export const CONTRACTS_DIR = join(OC, "workspaces", "controller", "contracts");
export const OUTPUT_DIR = join(OC, "workspaces", "controller", "output");
export const REPORTS_DIR = join(OC, "test-reports");
export const CONFIG_FILE = join(OC, "openclaw.json");
const LEGACY_WEB_DELIVERIES_DIR = join(OC, "workspaces", "controller", "deliveries");
const LEGACY_QQ_DELIVERIES_DIR = join(OC, "workspaces", "kksl", "deliveries");
const LEGACY_WORKER_IDS = ["worker-a", "worker-b", "worker-c", "worker-d"];
const LEGACY_RUNTIME_AGENT_IDS = ["contractor", "researcher", "evaluator", ...LEGACY_WORKER_IDS];
const LEGACY_ACTIVE_WORK_AGENT_IDS = new Set(LEGACY_RUNTIME_AGENT_IDS);

export let DELIVERIES_DIR = LEGACY_WEB_DELIVERIES_DIR;
export let QQ_DELIVERIES_DIR = LEGACY_QQ_DELIVERIES_DIR;
export let WORKER_IDS = [...LEGACY_WORKER_IDS];
export let RUNTIME_AGENT_IDS = [...LEGACY_RUNTIME_AGENT_IDS];

export const PORT = 18789;
export const BASE = `http://localhost:${PORT}`;

// ── Mutable config (set by loadConfig) ───────────────────────────────────────
export const tokens = { gateway: "", hook: "" };
let cfg = null;
let ACTIVE_WORK_AGENT_IDS = new Set(LEGACY_ACTIVE_WORK_AGENT_IDS);
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
    ...listAgentIdsByRole(AGENT_ROLE.EVALUATOR),
    ...listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
  ];
  return ids.length > 0 ? ids : [...LEGACY_ACTIVE_WORK_AGENT_IDS];
}

export async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, "utf8");
  cfg = JSON.parse(raw);
  tokens.gateway = cfg.gateway?.auth?.token ?? "";
  tokens.hook = cfg.hooks?.token ?? "";

  registerRuntimeAgents(cfg);
  WORKER_IDS = listAgentIdsByRole(AGENT_ROLE.EXECUTOR);
  if (WORKER_IDS.length === 0) {
    WORKER_IDS = [...LEGACY_WORKER_IDS];
  }
  RUNTIME_AGENT_IDS = listRuntimeAgentIds();
  if (RUNTIME_AGENT_IDS.length === 0) {
    RUNTIME_AGENT_IDS = [...LEGACY_RUNTIME_AGENT_IDS];
  }
  DELIVERIES_DIR = resolveGatewayDeliveryDir("webui", LEGACY_WEB_DELIVERIES_DIR);
  QQ_DELIVERIES_DIR = resolveGatewayDeliveryDir("qq", LEGACY_QQ_DELIVERIES_DIR);
  ACTIVE_WORK_AGENT_IDS = new Set(resolveRuntimeWorkAgentIds());
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
  // Use sendWebhook (no agentId) — gateway routes to its default bridge agent,
  // which has ingress capability and creates contracts.
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

// ── SSE Client ──────────────────────────────────────────────────────────────
export class SSEClient {
  constructor() {
    this.events = [];
    this.listeners = [];
    this.req = null;
    this.connected = false;
    this.connectedAt = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(`${BASE}/watchdog/stream?token=${tokens.gateway}`);
      this.req = http.get({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { "Accept": "text/event-stream" },
      }, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            const eventLine = part.match(/^event:\s*(.+)$/m);
            const dataLine = part.match(/^data:\s*(.+)$/m);
            if (!eventLine || !dataLine) continue;
            const eventType = eventLine[1].trim();
            let data;
            try { data = JSON.parse(dataLine[1]); } catch { data = dataLine[1]; }
            const replay = !this.connected;
            const evt = { type: eventType, data, receivedAt: Date.now(), replay };
            this.events.push(evt);
            if (eventType === "connected") {
              this.connected = true;
              this.connectedAt = Date.now();
              resolve();
            }
            if (!replay) {
              for (let i = this.listeners.length - 1; i >= 0; i--) {
                const l = this.listeners[i];
                if (!evt.claimed && l.filter(evt)) {
                  evt.claimed = true;
                  clearTimeout(l.timer);
                  this.listeners.splice(i, 1);
                  l.resolve(evt);
                }
              }
            }
          }
        });
        res.on("error", reject);
      });
      this.req.on("error", reject);
    });
  }

  waitFor(filter, timeoutMs) {
    const existing = this.events.find(e => !e.replay && !e.claimed && filter(e));
    if (existing) {
      existing.claimed = true;
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.listeners.findIndex(l => l.timer === timer);
        if (idx >= 0) this.listeners.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.listeners.push({ filter, resolve, timer });
    });
  }

  resetBaseline() {
    for (const evt of this.events) evt.claimed = true;
  }

  close() {
    for (const l of this.listeners) clearTimeout(l.timer);
    this.listeners = [];
    if (this.req) {
      try { this.req.destroy(); } catch {}
    }
  }
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

export async function fullReset() {
  console.log("  Full reset: clearing memory + files...");
  await ensurePreservedWorkspaceSnapshot();
  try {
    const res = await httpFetch(`${BASE}/watchdog/reset?token=${tokens.gateway}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ explicitConfirm: true }),
    });
    const data = JSON.parse(res.body);
    console.log(`  Memory cleared: ${data.cleared.sessions} sessions, ${data.cleared.history} history`);
  } catch (e) {
    console.log(`  Memory reset failed: ${e.message}`);
  }
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
  console.log("  Waiting for all worker/contractor sessions to fully end...");
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const runtime = await fetchJSON("/watchdog/runtime");
      const sessions = Object.entries(runtime.trackingSessions || {});
      const wcSessions = sessions.filter(([key, v]) => {
        const id = v.agentId || key;
        return id.includes("worker") || id.includes("contractor") || id.includes("evaluator") || id.includes("researcher");
      });
      if (wcSessions.length === 0) {
        console.log("  All worker/contractor sessions ended.");
        return true;
      }
      for (const [key, v] of wcSessions) {
        console.log(`  (still active: ${v.agentId} status=${v.status} elapsed=${Math.round(v.elapsedMs/1000)}s)`);
      }
    } catch {}
    await sleep(5000);
  }
  console.log("  (settle timeout — forcing proceed)");
  return false;
}
