// agent-guidance-drift.js — role-aware managed-guidance drift scanner.
//
// "Drift" means a configured agent's workspace has a guidance file
// (SOUL.md / HEARTBEAT.md / etc.) whose content no longer carries the
// runtime-managed marker. Scanning is scoped per role:
//   - execution-layer roles (executor / researcher / planner):
//     only SOUL.md + HEARTBEAT.md matter
//   - bridge / agent / other coordination roles: full managed guidance set
//
// The scanner is pure — it does not mutate workspace files. It only reports
// what state we are in right now. Callers decide whether to persist the
// evidence (see agent-guidance-drift-state.js) or act on it (takeover).

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "./admin/agent-admin-store.js";
import { composeAgentBinding } from "../effective-profile-composer.js";
import { normalizeString } from "../core/normalize.js";
import { defaultAgentWorkspace } from "../state/state-agent-helpers.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../prompt/managed-doc-markers.js";
import { getManagedGuidanceFilesForRole } from "./agent-enrollment-discovery.js";
import { recordGuidanceDriftScan } from "./agent-guidance-drift-state.js";

async function classifyFile(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.includes(MANAGED_BOOTSTRAP_MARKER) ? "managed" : "custom";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function scanAgent(agentConfig, config) {
  const agentId = normalizeString(agentConfig?.id);
  if (!agentId) return null;
  const binding = composeAgentBinding({ config, agentConfig });
  const role = binding.roleRef;
  const workspaceDir = resolve(
    binding.workspace?.effective || defaultAgentWorkspace(agentId),
  );
  const files = getManagedGuidanceFilesForRole(role);
  const fileStates = await Promise.all(files.map(async (name) => ({
    name,
    state: await classifyFile(join(workspaceDir, name)),
  })));
  const driftedFiles = fileStates
    .filter((entry) => entry.state === "custom")
    .map((entry) => entry.name);
  return {
    agentId,
    role,
    workspaceDir,
    fileStates,
    driftCount: driftedFiles.length,
    driftedFiles,
  };
}

export async function scanWorkspaceGuidanceDriftForConfig(config, { label = null } = {}) {
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const results = await Promise.all(agents.map(async (agentConfig) => {
    try {
      return (await scanAgent(agentConfig, config)) || null;
    } catch (error) {
      return {
        agentId: normalizeString(agentConfig?.id),
        role: null,
        error: error?.message || String(error),
        driftCount: 0,
        driftedFiles: [],
        fileStates: [],
      };
    }
  }));
  const perAgent = results.filter(Boolean);
  const totals = perAgent.reduce((acc, entry) => {
    acc.driftCount += entry.driftCount || 0;
    for (const name of entry.driftedFiles || []) {
      acc.driftedFilePairs.push({ agentId: entry.agentId, fileName: name });
    }
    return acc;
  }, { driftCount: 0, driftedFilePairs: [] });
  return {
    label: typeof label === "string" ? label : null,
    scannedAt: Date.now(),
    perAgent,
    driftCount: totals.driftCount,
    driftedFilePairs: totals.driftedFilePairs,
  };
}

export async function scanWorkspaceGuidanceDrift({ label = null } = {}) {
  const config = await loadConfig();
  return scanWorkspaceGuidanceDriftForConfig(config, { label });
}

export async function scanAndRecordWorkspaceGuidanceDrift({
  label = null,
  scanSource = "runtime",
} = {}) {
  const scan = await scanWorkspaceGuidanceDrift({ label });
  const driftedFiles = scan.driftedFilePairs.map((pair) => `${pair.agentId}/${pair.fileName}`);
  const stateAfter = await recordGuidanceDriftScan({
    label,
    driftCount: scan.driftCount,
    driftedFiles,
    scanSource,
  });
  return { scan, stateAfter };
}
