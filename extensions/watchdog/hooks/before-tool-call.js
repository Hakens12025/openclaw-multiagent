// hooks/before-tool-call.js — Composite interception: loop detection + role restrictions + harness whitelist + security

import { access } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import { checkToolCall, checkWriteSize } from "../lib/security.js"; // FIX(A3-write-size-cap): pull in size guard
import { resolveMaxWriteBytesFromPolicy } from "../lib/execution-policy-defaults.js"; // FIX(A3-write-size-cap): resolve byte cap
import { getContractPath } from "../lib/contracts.js";
import { isSessionHardStopped } from "../lib/loop/loop-detection.js";
import { resolveLoopEpochKey } from "../lib/loop/loop-epoch-key.js";
import { getTrackingState } from "../lib/store/tracker-store.js";
// FIX(A1-path-unify): three path-containment impls existed (local isInsidePath, naive startsWith, canonical isPathInsideRoot)
//                     -> consume the single canonical relative()-based isPathInsideRoot everywhere in this hook
import { resolveHarnessModuleConfig, isPathInsideRoot } from "../lib/harness/harness-module-evidence.js";
import { getAgentRole } from "../lib/agent/agent-identity.js";
import { getToolRestrictions } from "../lib/capability/capability-preset-registry.js";
import { agentWorkspace } from "../lib/state.js";
import { canonicalizeContractOutputPath } from "../lib/runtime-contract-output-alias.js";
import { classifyRuntimeControlPayload } from "../lib/runtime-user-facing-output.js";
import { parseAgentContractSessionKey } from "../lib/session-keys.js";
import { readCachedContractSnapshotById } from "../lib/store/contract-store.js";
import { isManagedGuidanceFileName } from "../lib/agent/managed-guidance-files.js";
import { RUNTIME_RESULT_FILE } from "../lib/protocol-primitives.js";

const READ_TOOL_PATTERN = /^(read|Read)$/i;
const EDIT_TOOL_PATTERN = /^(edit|Edit)$/i;
const WRITE_TOOL_PATTERN = /^(write|Write|create|Create)$/i;
const WEB_SEARCH_TOOL_PATTERN = /^(web_search|websearch)$/i;
const WEB_FETCH_TOOL_PATTERN = /^(web_fetch|webfetch)$/i;
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

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildOwnInboxContractHint(ownInboxContractPath) {
  return "请读取相对路径 inbox/contract.json。";
}

function buildContractOutputWriteHint() {
  // 统一约定：agent 只写 outbox/inbox。交付物写进 outbox/（文件名自定），系统整包收集并流转给下游/用户。
  // 中央 output 路径由系统内部管理，agent 面只暴露 outbox（output 与 outbox 易混，曾有 agent 把 output 误当写入路径）。
  return "请把最终交付物写进 outbox/(文件名自定)。";
}

function buildRuntimeResultCommitHint() {
  return `Write relative path outbox/${RUNTIME_RESULT_FILE}.`;
}

function buildContractDeliverableCommitHint(agentId, contractOutput) {
  return `${buildContractOutputWriteHint(agentId, contractOutput)}完成后写 outbox/${RUNTIME_RESULT_FILE} 作为 runtime status metadata。`;
}

function isWorkspaceRootManagedGuidancePath(targetPath, workspaceDir) {
  if (!targetPath || !workspaceDir) return false;
  const fileName = basename(targetPath);
  return isManagedGuidanceFileName(fileName)
    && resolve(workspaceDir, fileName) === resolve(targetPath);
}

async function resolveGuardTrackingState({ agentId, sessionKey, trackingState }) {
  if (trackingState?.contract?.id) {
    return trackingState;
  }

  const contractSession = parseAgentContractSessionKey(sessionKey);
  if (!contractSession || contractSession.agentId !== agentId) {
    return trackingState;
  }

  const contract = await readCachedContractSnapshotById(contractSession.contractId, {
    contractPathHint: getContractPath(contractSession.contractId),
    preferCache: false,
  });
  if (!contract || contract.assignee !== agentId) {
    return trackingState;
  }

  return {
    ...trackingState,
    sessionKey,
    contract: {
      id: contract.id,
      assignee: contract.assignee || null,
      output: contract.output || "",
      status: contract.status || null,
      protocol: contract.protocol || null,
      pipelineStage: contract.pipelineStage || null,
      automationContext: contract.automationContext || null,
    },
    toolCallTotal: Number(trackingState?.toolCallTotal || 0),
    toolCalls: Array.isArray(trackingState?.toolCalls) ? trackingState.toolCalls : [],
  };
}

export function register(api, logger) {
  api.on("before_tool_call", async (event, ctx) => {
    const agentId = ctx.agentId ?? "unknown";
    const sessionKey = ctx.sessionKey ?? "";
    const toolName = event.toolName ?? "unknown";
    const params = event.params ?? {};
    const trackingState = await resolveGuardTrackingState({
      agentId,
      sessionKey,
      trackingState: getTrackingState(sessionKey),
    });
    const contractSession = parseAgentContractSessionKey(sessionKey);
    const isContractSession = Boolean(contractSession && contractSession.agentId === agentId);
    const ws = agentWorkspace(agentId);
    const rawPath = normalizePath(params.path ?? params.file_path ?? params.filePath ?? "");
    const resolvedInputPath = resolveWorkspacePath(rawPath, ws);
    const ownInboxContractPath = ws ? resolve(ws, "inbox", "contract.json") : "";
    const ownOutboxRuntimeResultPath = ws ? resolve(ws, "outbox", RUNTIME_RESULT_FILE) : "";
    const isOwnInboxContractRead = READ_TOOL_PATTERN.test(toolName)
      && resolvedInputPath === ownInboxContractPath;
    const hasSuccessfulOwnInboxContractRead = Number.isFinite(trackingState?.ownInboxContractReadAt);
    const contractOutput = resolveWorkspacePath(trackingState?.contract?.output ?? "", ws);
    const canonicalToolPath = canonicalizeContractOutputPath({
      agentId,
      rawPath: resolvedInputPath,
      contractOutput,
    });

    // 1. Loop detection hard stop — block ALL tools
    if (isSessionHardStopped(resolveLoopEpochKey(trackingState) || sessionKey)) {
      return { block: true, blockReason: "[LOOP DETECTED] runtime 已完成本轮工具阶段；请用普通文本给出最终结果。" };
    }

    if (isContractSession && !trackingState?.contract?.id) {
      return {
        block: true,
        blockReason: "runtime 语义：contract session 已归档；请等待 runtime 下一次唤醒。",
      };
    }

    // 1b. Contract-backed sessions must first bind to their own inbox contract truth
    if (
      trackingState?.contract?.id
      && !hasSuccessfulOwnInboxContractRead
      && !isOwnInboxContractRead
    ) {
      return {
        block: true,
        blockReason: `runtime 语义：contract-backed session 的第一步是读取当前会话自己的 inbox/contract.json。${buildOwnInboxContractHint(ownInboxContractPath)}`,
      };
    }

    if (
      trackingState?.contract?.id
      && READ_TOOL_PATTERN.test(toolName)
      && isOwnInboxContractRead
      && hasSuccessfulOwnInboxContractRead
    ) {
      return {
        block: true,
        blockReason: `runtime 语义：当前 contract-backed session 的 inbox/contract.json 已读取；请直接完成任务，并${buildContractOutputWriteHint(agentId, contractOutput)}`,
      };
    }

    if (
      trackingState?.contract?.id
      && (WRITE_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName))
      && resolvedInputPath === ownInboxContractPath
    ) {
      return {
        block: true,
        blockReason: `runtime 语义：inbox/contract.json 是当前 contract truth，由 runtime 管理；${buildContractDeliverableCommitHint(agentId, contractOutput)}`,
      };
    }

    if (
      trackingState?.contract?.id
      && (WRITE_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName))
      && isWorkspaceRootManagedGuidancePath(resolvedInputPath, ws)
    ) {
      return {
        block: true,
        blockReason: `runtime 语义：managed guidance 由 runtime 管理；${buildContractDeliverableCommitHint(agentId, contractOutput)}`,
      };
    }

    if (
      trackingState?.contract?.id
      && (WRITE_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName))
      && basename(resolvedInputPath || "") === RUNTIME_RESULT_FILE
      && resolvedInputPath !== ownOutboxRuntimeResultPath
    ) {
      return {
        block: true,
        blockReason: `runtime 语义：runtime result 写入当前会话自己的 outbox/${RUNTIME_RESULT_FILE}。${buildRuntimeResultCommitHint()}`,
      };
    }

    if (
      trackingState?.contract?.id
      && WRITE_TOOL_PATTERN.test(toolName)
      && contractOutput
      && canonicalToolPath === contractOutput
    ) {
      const invalidPayloadReason = classifyRuntimeControlPayload(
        params.content ?? params.text ?? "",
        { outputPath: contractOutput },
      );
      if (invalidPayloadReason) {
        return {
          block: true,
          blockReason: `runtime 语义：contract.output 接收用户可读的最终产物；当前内容属于工具错误或控制载荷（${invalidPayloadReason}）。${buildContractOutputWriteHint(agentId, contractOutput)}`,
        };
      }
    }

    // 1c. Runtime capability truth — unavailable remote tools must be blocked up front
    if (WEB_SEARCH_TOOL_PATTERN.test(toolName) && !String(process.env.BRAVE_API_KEY || "").trim()) {
      return {
        block: true,
        blockReason: "runtime 能力：web_search 当前走本地上下文与已有输入路径完成任务。",
      };
    }

    // 1d. OPERATOR CODE/CONFIG GUARD — operator is a meta-agent: it changes the system ONLY via
    // CLI-system admin surfaces (plan→execute→change-set); raw write/edit stays confined to its
    // own workspace. Scratch inside ~/.openclaw/workspaces/operator stays allowed.
    if (
      agentId === "operator"
      && (WRITE_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName))
    ) {
      const target = canonicalToolPath || resolvedInputPath;
      if (target && ws && !isPathInsideRoot(target, ws)) {
        return {
          block: true,
          blockReason: "运维原则：operator 是 meta-agent，工作区外的代码与平台配置请经 CLI-system admin surface（plan→execute→change-set）修改；raw write/edit 仅限 operator 自己的工作区内。",
        };
      }
    }

    // 1e. WRITE SIZE CAP — FIX(A3-write-size-cap): before_tool_call never bounded write/edit byte
    // size, so an agent could write an arbitrarily huge file to disk (disk_full was only recorded
    // post-hoc in error-ledger) -> reject oversized content up front, before it reaches the tool.
    const writeSizeBlock = checkWriteSize(
      toolName,
      params,
      resolveMaxWriteBytesFromPolicy(trackingState?.executionPolicy),
    );
    if (writeSizeBlock) return writeSizeBlock;

    // 2. Role-level tool + path restrictions (Rule 12 enforcement)
    const role = getAgentRole(agentId);
    const restrictions = getToolRestrictions(role);
    if (restrictions) {
      // 2a. Tool whitelist
      if (restrictions.allowedTools && !restrictions.allowedTools.includes(toolName)) {
        return { block: true, blockReason: `角色限制：${role} 使用已授权工具集处理当前任务；本次工具为 ${toolName}` };
      }

      // 2b. Read path scope
      if (restrictions.readPathScope && READ_TOOL_PATTERN.test(toolName)) {
        const targetPath = resolvedInputPath;
        if (targetPath) {
          const inboxDir = ws ? `${ws}/inbox` : null;

          if (restrictions.readPathScope === "inbox") {
            // Planner: only read from own inbox/
            if (inboxDir && !isPathInsideRoot(targetPath, inboxDir)) {
              return { block: true, blockReason: `路径限制：${role} 的读取范围是 inbox/ 目录` };
            }
          } else if (restrictions.readPathScope === "contract") {
            // Reviewer: read inbox/ + contract-declared output path
            const contractOutput = resolveWorkspacePath(trackingState?.contract?.output ?? "", ws);
            const previousArtifact = resolveWorkspacePath(
              trackingState?.contract?.pipelineStage?.previousArtifactPath ?? "",
              ws,
            );
            // workingDir: the contract may declare an external project root (loop on a project
            // outside the workspace) — reviewer is then authorized to read inside it.
            const workingDir = resolveWorkspacePath(trackingState?.contract?.workingDir ?? "", ws);
            const allowedPaths = [inboxDir, contractOutput, previousArtifact, workingDir].filter(Boolean);

            const allowed = allowedPaths.some((p) => isPathInsideRoot(targetPath, p));
            if (!allowed) {
              return { block: true, blockReason: `路径限制：${role} 的读取范围是 inbox/ 和合约声明的产物路径` };
            }
          }
        }
      }
    }

    // 2c. Runtime IO truth — contract.output is a write sink until materialized
    if (READ_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName)) {
      const ownInboxDir = ws ? resolve(ws, "inbox") : "";
      const targetPath = canonicalToolPath;
      const isInboxProbe = targetPath.endsWith(`${sep}inbox`)
        || targetPath.includes(`${sep}inbox${sep}`);
      if (
        trackingState?.contract?.id
        && targetPath
        && ownInboxDir
        && isInboxProbe
        && !isPathInsideRoot(targetPath, ownInboxDir)
      ) {
        return {
          block: true,
          blockReason: `runtime 语义：当前会话的 contract truth 位于 inbox/contract.json；请读取当前会话的 contract。${buildOwnInboxContractHint(ownInboxContractPath)}`,
        };
      }
      if (
        contractOutput
        && (
          targetPath === contractOutput
          || (
            basename(targetPath) === basename(contractOutput)
            && targetPath.includes(`${sep}output${sep}`)
          )
        )
        && !(await pathExists(contractOutput))
      ) {
        return {
          block: true,
          blockReason: EDIT_TOOL_PATTERN.test(toolName)
            ? `runtime 语义：contract.output 是本轮输出路径；文件生成前请用写入创建最终产物；${buildContractOutputWriteHint(agentId, contractOutput)}`
            : `runtime 语义：contract.output 是本轮输出路径；文件生成前请把最终产物写入该路径；${buildContractOutputWriteHint(agentId, contractOutput)}`,
        };
      }
    }

    // 3. Harness tool whitelist — block tools not in harness spec allowedTools
    const automationSpec = trackingState?.contract?.automationContext;
    if (automationSpec?.harness) {
      const moduleConfig = resolveHarnessModuleConfig(automationSpec, "harness:guard.tool_access");
      const allowedTools = Array.isArray(moduleConfig?.allowedTools) ? moduleConfig.allowedTools : null;
      if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(toolName)) {
        return { block: true, blockReason: `Harness 工具边界：使用 [${allowedTools.join(", ")}] 处理当前任务；本次工具为 ${toolName}` };
      }

      // 3b. Harness scope boundary — block file writes outside allowed workspace roots
      const scopeConfig = resolveHarnessModuleConfig(automationSpec, "harness:guard.scope");
      const allowedRoots = Array.isArray(scopeConfig?.allowedWorkspaceRoots) && scopeConfig.allowedWorkspaceRoots.length > 0
        ? scopeConfig.allowedWorkspaceRoots
        : null;
      if (allowedRoots && /^(write|Write|edit|Edit|exec|Bash)$/i.test(toolName)) {
        const targetPath = normalizePath(params.path ?? params.file_path ?? params.filePath ?? params.command ?? "");
        // FIX(A1-path-unify): naive startsWith let "<root>-evil/…" pass a "<root>" allow-root -> canonical relative()-based containment
        if (targetPath && !allowedRoots.some((root) => isPathInsideRoot(targetPath, root))) {
          return { block: true, blockReason: `沙箱边界：使用工作空间范围 [${allowedRoots.join(", ")}] 处理当前任务；本次路径为 ${targetPath}` };
        }
      }
    }

    // 4. Security check (existing)
    return checkToolCall(agentId, sessionKey, toolName, params, logger);
  });
}
