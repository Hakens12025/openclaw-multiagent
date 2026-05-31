import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { NETWORK_CAPABLE_TOOLS, isPathInsideRoot } from "./harness-module-evidence.js";

// ---------------------------------------------------------------------------
// Guard sub-check functions — each returns { status, summary, reason, evidence }
// ---------------------------------------------------------------------------

export function evaluateToolWhitelist(ctx) {
  const { moduleConfig, targetTools, allowedTools, configuredAllowedTools, executionContext } = ctx;
  const mode = normalizeString(moduleConfig.mode)?.toLowerCase() === "exact" ? "exact" : "subset";
  const extraTools = targetTools.filter((tool) => !allowedTools.includes(tool));
  const missingAllowedTools = allowedTools.filter((tool) => !targetTools.includes(tool));
  const matched = mode === "exact"
    ? extraTools.length === 0 && missingAllowedTools.length === 0
    : extraTools.length === 0;
  return {
    status: matched ? "passed" : "failed",
    summary: configuredAllowedTools.length > 0
      ? (matched ? "tool whitelist satisfied" : "tool whitelist drift detected")
      : "declared tool surface captured as whitelist",
    reason: configuredAllowedTools.length > 0
      ? (matched ? "tool_whitelist_matched" : "tool_whitelist_drift")
      : "tool_surface_declared",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      mode,
      targetTools,
      allowedTools,
      extraTools,
      missingAllowedTools,
    },
  };
}

export function evaluateSandboxPolicy(ctx) {
  const { moduleConfig, workspaceDir, effectiveWorkspaceRoots, executionContext } = ctx;
  const policy = normalizeString(moduleConfig.policy)?.toLowerCase() || null;
  if (!policy && effectiveWorkspaceRoots.length === 0) {
    return {
      status: "skipped",
      summary: "no explicit sandbox policy configured",
      reason: "sandbox_policy_missing",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        workspaceDir,
      },
    };
  }
  const workspaceAllowed = workspaceDir
    ? (effectiveWorkspaceRoots.length === 0 || effectiveWorkspaceRoots.some((root) => isPathInsideRoot(workspaceDir, root)))
    : false;
  return {
    status: workspaceAllowed ? "passed" : "failed",
    summary: workspaceAllowed ? "sandbox policy anchored to workspace scope" : "sandbox workspace scope mismatch",
    reason: workspaceAllowed ? "sandbox_policy_declared" : "sandbox_scope_mismatch",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      policy,
      workspaceDir,
      allowedWorkspaceRoots: effectiveWorkspaceRoots,
    },
  };
}

export function evaluateNetworkPolicy(ctx) {
  const { moduleConfig, networkTools, executionContext } = ctx;
  if (networkTools.length === 0) {
    return {
      status: "passed",
      summary: "network closed by declared tool surface",
      reason: "network_closed",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        networkTools,
        allowNetwork: false,
      },
    };
  }
  if (moduleConfig.allowNetwork === true) {
    return {
      status: "passed",
      summary: "network-capable tools allowed by explicit policy",
      reason: "network_policy_open",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        networkTools,
        allowNetwork: true,
        allowedDomains: uniqueStrings(moduleConfig.allowedDomains || []),
      },
    };
  }
  if (moduleConfig.allowNetwork === false) {
    return {
      status: "failed",
      summary: "network-capable tools violate closed network policy",
      reason: "network_policy_violation",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        networkTools,
        allowNetwork: false,
      },
    };
  }
  return {
    status: "skipped",
    summary: "network-capable tools present but policy missing",
    reason: "network_policy_missing",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      networkTools,
      allowNetwork: null,
    },
  };
}

export function evaluateWorkspaceScope(ctx) {
  const { workspaceDir, effectiveWorkspaceRoots, executionContext } = ctx;
  if (!workspaceDir || effectiveWorkspaceRoots.length === 0) {
    return {
      status: "failed",
      summary: "workspace scope could not be resolved",
      reason: "workspace_scope_missing",
      evidence: {
        targetAgent: executionContext?.targetAgent || null,
        workspaceDir,
        allowedWorkspaceRoots: effectiveWorkspaceRoots,
      },
    };
  }
  const withinScope = effectiveWorkspaceRoots.some((root) => isPathInsideRoot(workspaceDir, root));
  return {
    status: withinScope ? "passed" : "failed",
    summary: withinScope ? "workspace scope resolved" : "workspace outside allowed roots",
    reason: withinScope ? "workspace_scope_ok" : "workspace_scope_violation",
    evidence: {
      targetAgent: executionContext?.targetAgent || null,
      workspaceDir,
      allowedWorkspaceRoots: effectiveWorkspaceRoots,
    },
  };
}

// ---------------------------------------------------------------------------
// combineStatuses — worst-status wins: failed > passed > skipped
// ---------------------------------------------------------------------------

export function combineStatuses(a, b) {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "passed" || b === "passed") return "passed";
  return "skipped";
}

// ---------------------------------------------------------------------------
// Merged guard wrappers — combine sub-checks, worst status wins
// ---------------------------------------------------------------------------

export function evaluateToolAccessGuard(ctx) {
  const whitelistResult = evaluateToolWhitelist(ctx);
  const networkResult = evaluateNetworkPolicy(ctx);
  const worstStatus = combineStatuses(whitelistResult.status, networkResult.status);
  return {
    status: worstStatus,
    summary: `tool_access: ${whitelistResult.summary}; network: ${networkResult.summary}`,
    reason: worstStatus === "failed" ? (whitelistResult.status === "failed" ? whitelistResult.reason : networkResult.reason) : whitelistResult.reason,
    evidence: { toolWhitelist: whitelistResult.evidence, networkPolicy: networkResult.evidence },
  };
}

export function evaluateScopeGuard(ctx) {
  const sandboxResult = evaluateSandboxPolicy(ctx);
  const workspaceResult = evaluateWorkspaceScope(ctx);
  const worstStatus = combineStatuses(sandboxResult.status, workspaceResult.status);
  return {
    status: worstStatus,
    summary: `sandbox: ${sandboxResult.summary}; workspace: ${workspaceResult.summary}`,
    reason: worstStatus === "failed" ? (sandboxResult.status === "failed" ? sandboxResult.reason : workspaceResult.reason) : sandboxResult.reason,
    evidence: { sandboxPolicy: sandboxResult.evidence, workspaceScope: workspaceResult.evidence },
  };
}
