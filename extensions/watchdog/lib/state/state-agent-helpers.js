// lib/state/state-agent-helpers.js — Agent identity and workspace helpers
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HOME } from "./state-paths.js";
import { runtimeAgentConfigs } from "./state-collections.js";
import { AGENT_ROLE, AGENT_WORKSPACE_OVERRIDES } from "../agent/agent-metadata.js";

function expandHomePath(filePath) {
  return typeof filePath === "string" && filePath.trim()
    ? filePath.trim().replace(/^~(?=\/|$)/, HOME)
    : null;
}

export const isWorker = (agentId) => {
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!normalizedAgentId) return false;
  const configuredRole = runtimeAgentConfigs.get(normalizedAgentId)?.role;
  if (configuredRole) return configuredRole === AGENT_ROLE.EXECUTOR;
  return normalizedAgentId.startsWith("worker-");
};

export function defaultAgentWorkspace(agentId) {
  const dir = AGENT_WORKSPACE_OVERRIDES[agentId] || `workspaces/${agentId}`;
  return join(HOME, ".openclaw", dir);
}

export function agentWorkspace(agentId) {
  const configuredWorkspace = expandHomePath(runtimeAgentConfigs.get(agentId)?.workspace);
  if (configuredWorkspace) {
    return resolve(configuredWorkspace);
  }

  return defaultAgentWorkspace(agentId);
}

// Canonical tool-path resolution — the ONE copy (three byte-identical private
// copies used to live in the two tool hooks and the deleted contract-output
// alias module). Tilde expansion is deliberately unguarded to match the
// behavior all call sites already had.
export function normalizeToolPath(rawPath) {
  return String(rawPath || "").replace(/^~/, HOME).trim();
}

export function resolveWorkspacePath(rawPath, workspaceDir) {
  const normalized = normalizeToolPath(rawPath);
  if (!normalized) return "";
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) {
    return resolve(normalized);
  }
  return workspaceDir ? resolve(workspaceDir, normalized) : normalized;
}

// —— Physical path resolution for the write guards ——
// resolveWorkspacePath above is purely lexical: a symlink inside a workspace
// that points outside would pass every path guard judged on the lexical path.
// Guards therefore judge the PHYSICAL path from this helper. Constraints:
// - The deepest existing ancestor is realpath'd; not-yet-existing tail
//   segments (a new file about to be written) cannot be symlinks, so they are
//   re-joined lexically — a missing target must NOT fall back to the raw
//   unresolved input (that would let ENOENT bypass the guard).
// - Existence is probed with lstat so a symlink — even a dangling one —
//   counts as existing and gets its target resolved (writing through a
//   dangling symlink creates the TARGET file).
// - Symlink hops are capped so a link cycle cannot spin the guard; past the
//   cap the lexical path is returned and judged as-is.
// - Honest limits: Bash/exec writes never pass through the path guards that
//   consume this helper, and between a hook-time check and the tool's actual
//   filesystem write there is a TOCTOU window (the path can be re-pointed in
//   between). This is defense-in-depth for the internal-agent threat model,
//   not a hard security boundary.
const MAX_GUARD_SYMLINK_HOPS = 40;

// —— Per-agent physical guard anchors ——
// Tree-link norm: workspace tree links (outbox/, inbox/ → threads/{t}/runs/{r}/
// participants/{agent}/...) always carry ABSOLUTE-path targets, and
// directory-level links are the only link form in the tree contract —
// atomicWriteFile and rename always land on real files, with each link one
// level above the file. Guards that judge physicalized target
// paths need anchors physicalized at the same depth: an agent's workspace root
// plus the physical location of its outbox/ and inbox/ dirs (each resolved as
// a DIRECTORY before any file name is joined). While outbox/inbox are real
// directories both extra anchors collapse inside the workspace root, so the
// anchor set is behavior-neutral until the dirs become links.
// Cached briefly: the cross-workspace guard consults every registered agent on
// every tool call, and per-call realpath over the full roster is the cost this
// cache bounds. The TTL bounds staleness after a dir is swapped for a link.
const GUARD_ANCHOR_CACHE_TTL_MS = 2000;
const GUARD_ANCHOR_CACHE_MAX_ENTRIES = 256;
const guardAnchorCache = new Map();

export function resolveAgentGuardAnchors(agentId) {
  const workspace = agentWorkspace(agentId);
  const cacheKey = `${agentId}\u0000${workspace}`;
  const now = Date.now();
  const cached = guardAnchorCache.get(cacheKey);
  if (cached && now - cached.at <= GUARD_ANCHOR_CACHE_TTL_MS) return cached.anchors;
  const anchors = [...new Set([
    resolvePhysicalWorkspacePath(workspace),
    resolvePhysicalWorkspacePath(join(workspace, "outbox")),
    resolvePhysicalWorkspacePath(join(workspace, "inbox")),
  ].filter(Boolean))];
  if (guardAnchorCache.size >= GUARD_ANCHOR_CACHE_MAX_ENTRIES) guardAnchorCache.clear();
  guardAnchorCache.set(cacheKey, { at: now, anchors });
  return anchors;
}

export function resolvePhysicalWorkspacePath(inputPath) {
  const normalized = typeof inputPath === "string" ? inputPath.trim() : "";
  if (!normalized) return "";
  return physicalizeAbsolutePath(resolve(normalized), 0);
}

function physicalizeAbsolutePath(lexicalAbsolutePath, hops) {
  if (hops > MAX_GUARD_SYMLINK_HOPS) return lexicalAbsolutePath;

  let existingAncestor = lexicalAbsolutePath;
  const missingTail = [];
  for (;;) {
    let stats = null;
    try {
      stats = lstatSync(existingAncestor);
    } catch {
      stats = null;
    }
    if (stats) {
      if (stats.isSymbolicLink()) {
        // The deepest existing entry is itself a symlink (realpath would throw
        // on a dangling one): resolve its target manually and re-physicalize,
        // so dangling links still map to their physical target path.
        let linkTarget = null;
        try {
          linkTarget = readlinkSync(existingAncestor);
        } catch {
          linkTarget = null;
        }
        if (linkTarget !== null) {
          return physicalizeAbsolutePath(
            join(resolve(dirname(existingAncestor), linkTarget), ...missingTail),
            hops + 1,
          );
        }
      }
      break;
    }
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingTail.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  let physicalAncestor = existingAncestor;
  try {
    physicalAncestor = realpathSync(existingAncestor);
  } catch {
    physicalAncestor = existingAncestor;
  }
  return missingTail.length ? join(physicalAncestor, ...missingTail) : physicalAncestor;
}
