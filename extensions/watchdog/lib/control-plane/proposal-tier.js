// proposal-tier.js — ⑤ Operator control plane: danger tiering + effect description + dedup.
// Pure functions. Tier is derived ONLY from the existing surface `risk` + `confirmation`
// fields (no new surface flags, no dynamic payload analysis in v1). Tier ≥ T3 (structural /
// destructive) triggers UI double-confirm + auto-snapshot-before-apply.

import { createHash } from "node:crypto";

function norm(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

// Tier from (risk, confirmation). risk values: read/observe/safe/runtime_gate/structural/destructive.
export function evaluateProposalTier({ risk, confirmation } = {}) {
  const r = norm(risk);
  const c = norm(confirmation);

  if (r === "destructive") {
    return tier(4, "DESTRUCTIVE", { needsDoubleConfirm: true, needsTypedAck: true, autoSnapshotBeforeApply: true });
  }
  if (r === "structural") {
    return tier(3, "STRUCTURAL", { needsDoubleConfirm: true, needsTypedAck: false, autoSnapshotBeforeApply: true });
  }
  if (c === "explicit") {
    return tier(2, "GUARDED", { needsDoubleConfirm: false, needsTypedAck: false, autoSnapshotBeforeApply: false });
  }
  return tier(1, "SAFE", { needsDoubleConfirm: false, needsTypedAck: false, autoSnapshotBeforeApply: false });
}

function tier(level, key, flags) {
  return { tier: level, key, label: key, ...flags };
}

// Stable fingerprint for de-duplicating proposals (operator generates continuously; skip if an
// undecided draft with the same surface+payload already exists).
export function dedupeKey(surfaceId, payload) {
  const sid = norm(surfaceId);
  const body = createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 12);
  return `${sid}:${body}`;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

// Human-readable "what the system becomes after this change" — one sentence per surface family.
// Generic fallback keeps it honest for surfaces without a tailored description.
export function describeProposalEffect(surfaceId, payload = {}) {
  const sid = norm(surfaceId);
  const p = payload && typeof payload === "object" ? payload : {};

  switch (sid) {
    case "graph.edge.add":
      return `新增管线边：${norm(p.from)} → ${norm(p.to)}（${norm(p.from)} 之后可投递给 ${norm(p.to)}）`;
    case "graph.edge.delete":
      return `删除管线边：${norm(p.from)} → ${norm(p.to)}`;
    case "agents.model":
      return `把 ${norm(p.agentId)} 的模型改为 ${norm(p.model)}`;
    case "agents.heartbeat":
      return `把 ${norm(p.agentId)} 的心跳间隔改为 ${norm(p.every)}`;
    case "agents.skills":
    case "agents.defaults.skills":
      return `调整 ${norm(p.agentId) || "默认"} 的技能集为 ${Array.isArray(p.skills) ? p.skills.join("/") : norm(p.skills)}`;
    case "agents.policy":
      return `调整 ${norm(p.agentId)} 的策略（gateway/protected/ingress 等）`;
    case "agents.create":
      return `新建 agent ${norm(p.id)}（role=${norm(p.role) || "?"}, model=${norm(p.model) || "默认"}）`;
    case "agents.delete":
    case "agents.hard_delete":
      return `删除 agent ${norm(p.agentId) || norm(p.id)}（不可逆，先拍快照）`;
    case "automations.delete":
      return `删除 automation ${norm(p.automationId)}`;
    case "runtime.reset":
      return `重置运行时状态（清 session/queue 等，不可逆）`;
    default:
      return `执行 ${sid || "(未知 surface)"}`;
  }
}
