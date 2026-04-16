// hooks/before-tool-call.js — Composite interception: loop detection + role restrictions + harness whitelist + security

import { resolve, sep } from "node:path";

import { checkToolCall } from "../lib/security.js";
import { isSessionHardStopped } from "../lib/loop/loop-detection.js";
import { getTrackingState } from "../lib/store/tracker-store.js";
import { resolveHarnessModuleConfig } from "../lib/harness/harness-module-evidence.js";
import { getAgentRole } from "../lib/agent/agent-identity.js";
import { getToolRestrictions } from "../lib/capability/capability-preset-registry.js";
import { agentWorkspace } from "../lib/state.js";

const READ_TOOL_PATTERN = /^(read|Read)$/i;
const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";

function normalizePath(rawPath) {
  return String(rawPath || "").replace(/^~/, HOME).trim();
}

function isAbsolutePath(filePath) {
  return filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
}

function resolveWorkspacePath(rawPath, workspaceDir) {
  const normalized = normalizePath(rawPath);
  if (!normalized) return "";
  if (isAbsolutePath(normalized)) {
    return resolve(normalized);
  }
  return workspaceDir ? resolve(workspaceDir, normalized) : normalized;
}

function isInsidePath(targetPath, allowedPath) {
  if (!targetPath || !allowedPath) return false;
  const resolvedTargetPath = resolve(targetPath);
  const resolvedAllowedPath = resolve(allowedPath);
  return resolvedTargetPath === resolvedAllowedPath
    || resolvedTargetPath.startsWith(`${resolvedAllowedPath}${sep}`);
}

export function register(api, logger) {
  api.on("before_tool_call", async (event, ctx) => {
    const agentId = ctx.agentId ?? "unknown";
    const sessionKey = ctx.sessionKey ?? "";
    const toolName = event.toolName ?? "unknown";
    const params = event.params ?? {};

    // 1. Loop detection hard stop — block ALL tools
    if (isSessionHardStopped(sessionKey)) {
      return { block: true, blockReason: "[LOOP DETECTED] 工具调用已被禁止，请直接输出文本结果" };
    }

    // 2. Role-level tool + path restrictions (Rule 12 enforcement)
    const role = getAgentRole(agentId);
    const restrictions = getToolRestrictions(role);
    if (restrictions) {
      // 2a. Tool whitelist
      if (restrictions.allowedTools && !restrictions.allowedTools.includes(toolName)) {
        return { block: true, blockReason: `角色限制：${role} 不允许使用 ${toolName}` };
      }

      // 2b. Read path scope
      if (restrictions.readPathScope && READ_TOOL_PATTERN.test(toolName)) {
        const ws = agentWorkspace(agentId);
        const rawPath = normalizePath(params.path ?? params.file_path ?? params.filePath ?? "");
        const targetPath = resolveWorkspacePath(rawPath, ws);
        if (targetPath) {
          const inboxDir = ws ? `${ws}/inbox` : null;

          if (restrictions.readPathScope === "inbox") {
            // Planner: only read from own inbox/
            if (inboxDir && !isInsidePath(targetPath, inboxDir)) {
              return { block: true, blockReason: `路径限制：${role} 只能读取 inbox/ 目录` };
            }
          } else if (restrictions.readPathScope === "contract") {
            // Reviewer: read inbox/ + contract-declared output path
            const trackingState = getTrackingState(sessionKey);
            const contractOutput = resolveWorkspacePath(trackingState?.contract?.output ?? "", ws);
            const previousArtifact = resolveWorkspacePath(
              trackingState?.contract?.pipelineStage?.previousArtifactPath ?? "",
              ws,
            );
            const allowedPaths = [inboxDir, contractOutput, previousArtifact].filter(Boolean);

            const allowed = allowedPaths.some((p) => isInsidePath(targetPath, p));
            if (!allowed) {
              return { block: true, blockReason: `路径限制：${role} 只能读取 inbox/ 和合约声明的产物路径` };
            }
          }
        }
      }
    }

    // 3. Harness tool whitelist — block tools not in harness spec allowedTools
    const trackingState = getTrackingState(sessionKey);
    const automationSpec = trackingState?.contract?.automationContext;
    if (automationSpec?.harness) {
      const moduleConfig = resolveHarnessModuleConfig(automationSpec, "harness:guard.tool_access");
      const allowedTools = Array.isArray(moduleConfig?.allowedTools) ? moduleConfig.allowedTools : null;
      if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(toolName)) {
        return { block: true, blockReason: `Harness 白名单：工具 ${toolName} 不在允许列表 [${allowedTools.join(", ")}]` };
      }

      // 3b. Harness scope boundary — block file writes outside allowed workspace roots
      const scopeConfig = resolveHarnessModuleConfig(automationSpec, "harness:guard.scope");
      const allowedRoots = Array.isArray(scopeConfig?.allowedWorkspaceRoots) && scopeConfig.allowedWorkspaceRoots.length > 0
        ? scopeConfig.allowedWorkspaceRoots
        : null;
      if (allowedRoots && /^(write|Write|edit|Edit|exec|Bash)$/i.test(toolName)) {
        const targetPath = normalizePath(params.path ?? params.file_path ?? params.filePath ?? params.command ?? "");
        if (targetPath && !allowedRoots.some((root) => targetPath.startsWith(normalizePath(root)))) {
          return { block: true, blockReason: `沙箱限制：路径 ${targetPath} 不在允许的工作空间范围 [${allowedRoots.join(", ")}]` };
        }
      }
    }

    // 4. Security check (existing)
    return checkToolCall(agentId, sessionKey, toolName, params, logger);
  });
}
