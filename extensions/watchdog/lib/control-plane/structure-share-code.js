// structure-share-code.js — ⑤ Operator control plane: portable, scoped, compressed
// "structure share code" for community sharing + personal reproduction.
//
// Format: OCS-v1-<L>-<hash8>-<base64url(brotli(minified canonical JSON))>
//   L ∈ { S (structure), SC (structure+content), SCA (full+api) }
//   hash8 = first 8 hex of sha256(canonical payload) — integrity / self-describing id.
//
// Efficiency (few-KB shareable L2): brotli (node:zlib, 0 dep) + builtin skills referenced
// by name (NOT embedded — community shares the same platform base) + only custom content
// embedded + minified canonical JSON.
//
// Security (encoding is NOT encryption — anyone can decode):
//   L1/L2 run scanForSecrets and BLOCK export if any live secret value leaked into the payload.
//   L3 carries plaintext secrets by design → marked containsSecrets, NEVER offered as "share".

import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadGraph } from "../agent/agent-graph.js";
import { loadGraphLoopRegistry } from "../loop/graph-loop-registry.js";
import { loadConfig } from "../agent/agent-admin-store.js";
import { listAutomationSpecs } from "../automation/automation-registry.js";
import { agentWorkspace } from "../state.js";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILLS_DIR = join(homedir(), ".openclaw", "skills");

const CODE_PREFIX = "OCS-v1-";
export const SHARE_LEVELS = Object.freeze({ STRUCTURE: "S", CONTENT: "SC", FULL: "SCA" });

// Platform-baseline skills that ship with the standard OpenClaw distribution: referenced by
// name (not embedded), since any importer has them. Anything else is treated as custom → embedded.
const PLATFORM_BUILTIN_SKILLS = new Set([
  "platform-map", "platform-tools", "error-avoidance", "system-action",
]);

// Agent prose files captured at L2+ (static, per-workspace). Reference, don't regenerate.
const AGENT_PROSE_FILES = ["SOUL.md", "IDENTITY.md", "HEARTBEAT.md"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}
function minCanonicalJson(obj) {
  return JSON.stringify(canonicalize(obj));
}
function shortHash(obj) {
  return createHash("sha256").update(minCanonicalJson(obj)).digest("hex").slice(0, 8);
}
function bodyHash(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 12);
}
async function readIfExists(path) {
  try { const t = await readFile(path, "utf8"); return t; } catch { return null; }
}

// ── secret detection ────────────────────────────────────────────────────────
// Collect concrete secret VALUES from the live config (so we scan for the actual leaked string),
// plus a few generic high-entropy key patterns as a backstop.
export function collectLiveSecretValues(config, acc = new Set(), depth = 0) {
  if (!config || typeof config !== "object" || depth > 8) return acc;
  for (const [key, val] of Object.entries(config)) {
    if (typeof val === "string" && val.length >= 12 && /token|key|secret|password|apikey|auth/i.test(key)) {
      acc.add(val);
    } else if (val && typeof val === "object") {
      collectLiveSecretValues(val, acc, depth + 1);
    }
  }
  return acc;
}
const GENERIC_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/,            // OpenAI-style
  /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{8,}\b/, // token.suffix
  /\bBSA[A-Za-z0-9_-]{20,}\b/,          // Brave-style
];
export function scanForSecrets(payloadStr, liveSecretValues) {
  const hits = [];
  for (const secret of liveSecretValues) {
    if (secret && payloadStr.includes(secret)) hits.push(`live-secret-value(${secret.slice(0, 4)}…len${secret.length})`);
  }
  for (const re of GENERIC_SECRET_PATTERNS) {
    const m = payloadStr.match(re);
    if (m) hits.push(`pattern(${re.source.slice(0, 18)}…):${m[0].slice(0, 6)}…`);
  }
  return hits;
}

// ── payload building per level ────────────────────────────────────────────────
function structureAgents(config) {
  return (config?.agents?.list || []).map((a) => ({
    id: a.id,
    role: a.role || null,
    tools: a.tools || null,
    skills: Array.isArray(a.skills) ? a.skills : [],
    binding: a.binding || null,       // policy/wiring only (no secrets — secrets live at top-level providers)
  }));
}

async function buildStructurePayload(level) {
  const [graph, loopReg, config, automations] = await Promise.all([
    loadGraph(), loadGraphLoopRegistry(), loadConfig(), listAutomationSpecs(),
  ]);

  const payload = {
    v: 1,
    level,
    graph: { edges: graph.edges || [] },
    loops: loopReg.loops || [],
    agents: structureAgents(config),
    automations,
  };

  if (level === SHARE_LEVELS.STRUCTURE) return payload;

  // L2 (SC) + L3 (SCA): embed agent prose + custom (non-builtin) skill bodies; builtins by name.
  const prose = {};
  for (const a of payload.agents) {
    const ws = agentWorkspace(a.id);
    const files = {};
    for (const f of AGENT_PROSE_FILES) {
      const text = await readIfExists(join(ws, f));
      if (text != null) files[f] = text;
    }
    if (Object.keys(files).length) prose[a.id] = files;
  }
  const referencedSkills = new Set(payload.agents.flatMap((a) => a.skills));
  const builtinRefs = [];
  const customSkills = {};
  for (const skill of referencedSkills) {
    if (PLATFORM_BUILTIN_SKILLS.has(skill)) {
      builtinRefs.push(skill); // by name only — importer resolves from its own install
    } else {
      const body = await readIfExists(join(SKILLS_DIR, skill, "SKILL.md"));
      customSkills[skill] = body != null ? { hash: bodyHash(body), body } : { hash: null, missing: true };
    }
  }
  payload.content = { prose, builtinSkills: builtinRefs.sort(), customSkills };

  if (level === SHARE_LEVELS.CONTENT) return payload;

  // L3 (SCA): + full config (secrets). Personal reproduction only.
  payload.fullConfig = config;
  return payload;
}

// ── public API ────────────────────────────────────────────────────────────────
export async function exportStructureCode({ level = SHARE_LEVELS.STRUCTURE } = {}) {
  if (!Object.values(SHARE_LEVELS).includes(level)) {
    throw new Error(`unknown share level: ${level}`);
  }
  const config = await loadConfig();
  const payload = await buildStructurePayload(level);
  const json = minCanonicalJson(payload);

  const containsSecrets = level === SHARE_LEVELS.FULL;
  if (!containsSecrets) {
    // L1/L2 must never carry secrets — block export if a live secret leaked into structure/prose.
    const hits = scanForSecrets(json, collectLiveSecretValues(config));
    if (hits.length) {
      return { ok: false, level, blocked: true, error: "secret leak detected — export blocked", hits };
    }
  }

  const hash8 = shortHash(payload);
  const compressed = brotliCompressSync(Buffer.from(json, "utf8"));
  const b64 = compressed.toString("base64url");
  const code = `${CODE_PREFIX}${level}-${hash8}-${b64}`;
  return {
    ok: true,
    code,
    level,
    contentHash: hash8,
    sizeBytes: Buffer.byteLength(code, "utf8"),
    rawJsonBytes: Buffer.byteLength(json, "utf8"),
    containsSecrets,
    shareable: !containsSecrets,
  };
}

export function decodeStructureCode(code) {
  const str = typeof code === "string" ? code.trim() : "";
  if (!str.startsWith(CODE_PREFIX)) return { ok: false, error: "not an OCS-v1 code" };
  const rest = str.slice(CODE_PREFIX.length);
  const m = rest.match(/^(S|SC|SCA)-([0-9a-f]{8})-(.+)$/);
  if (!m) return { ok: false, error: "malformed OCS code" };
  const [, level, hash8, b64] = m;
  let payload;
  try {
    const json = brotliDecompressSync(Buffer.from(b64, "base64url")).toString("utf8");
    payload = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `decode failed: ${e.message}` };
  }
  const recomputed = shortHash(payload);
  return {
    ok: true,
    level,
    payload,
    contentHash: hash8,
    integrityOk: recomputed === hash8,
  };
}

// Size preview without persisting — for the UI to show "this code is N KB (mostly: …)".
export async function estimateCodeSize({ level = SHARE_LEVELS.STRUCTURE } = {}) {
  const res = await exportStructureCode({ level });
  if (!res.ok) return res;
  return {
    ok: true,
    level,
    sizeBytes: res.sizeBytes,
    sizeKb: Math.round((res.sizeBytes / 1024) * 10) / 10,
    rawJsonBytes: res.rawJsonBytes,
    compressionRatio: Math.round((res.rawJsonBytes / res.sizeBytes) * 10) / 10,
    containsSecrets: res.containsSecrets,
  };
}
