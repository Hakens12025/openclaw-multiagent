// hooks/before-tool-call.js — Composite interception: loop detection + role restrictions + declared sandbox guards + security

import { access } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import { checkToolCall, checkWriteSize } from "../lib/security/security.js"; // FIX(A3-write-size-cap): pull in size guard
import { resolveMaxWriteBytesFromPolicy } from "../lib/security/execution-policy-defaults.js"; // FIX(A3-write-size-cap): resolve byte cap
import { getContractPath } from "../lib/contract/contracts.js";
import { isSessionHardStopped, HARD_STOP_BLOCK_REASON } from "../lib/runtime/execution-hard-stop-registry.js";
import { resolveSessionEpochKey } from "../lib/runtime/session-epoch-key.js";
import { getTrackingState } from "../lib/store/tracker-store.js";
import { recordRefusedToolCall } from "../lib/evidence/evidence-bridge.js";
import { evaluateDeclaredSandboxGuard } from "../lib/security/declared-sandbox-guard.js";
import { getAgentRole } from "../lib/agent/agent-identity.js";
import { getToolRestrictions } from "../lib/security/capability-preset-registry.js";
import { isExposedCollabToolForRole } from "../lib/system-action/system-action-role-policy.js";
import { isExposedPlatformServiceTool } from "../lib/system-action/platform-service-tools.js";
import { OC, agentWorkspace, normalizeToolPath, resolveAgentGuardAnchors, resolvePhysicalWorkspacePath, resolveWorkspacePath, runtimeAgentConfigs } from "../lib/state.js";
import { classifyRuntimeControlPayload } from "../lib/delivery/runtime-user-facing-output.js";
import { parseAgentContractSessionKey } from "../lib/session/session-keys.js";
import { readCachedContractSnapshotById } from "../lib/store/contract-store.js";
import { isManagedGuidanceFileName } from "../lib/agent/managed-guidance-files.js";
import { isTreePhysicalPath } from "../lib/archive/outbox-seal.js";
import { RUNTIME_RESULT_FILE } from "../lib/protocol/protocol-primitives.js";
// 域单源(备忘录157 §二):「agent 自己的工作区域」唯一属主。本文件的规则只消费
// 谓词,锚点清单集中在域属主一处——新挂载类型在 agent-domain 登记即可,规则零改动。
import { resolveAgentDomain, isInAgentDomain, isOwnUpstreamTarget } from "../lib/security/agent-domain.js";

const READ_TOOL_PATTERN = /^(read|Read)$/i;
// D-G:ls/grep 是发现能力不是新读权限,与 read 走同一片路径域(2b/2c)与敏感文件检查。
const DISCOVERY_TOOL_PATTERN = /^(ls|grep)$/i;
const EDIT_TOOL_PATTERN = /^(edit|Edit)$/i;
const WRITE_TOOL_PATTERN = /^(write|Write|create|Create)$/i;
const WEB_SEARCH_TOOL_PATTERN = /^(web_search|websearch)$/i;
const WEB_FETCH_TOOL_PATTERN = /^(web_fetch|webfetch)$/i;
const normalizePath = normalizeToolPath;

function isInsidePath(targetPath, allowedPath) {
  if (!targetPath || !allowedPath) return false;
  const resolvedTargetPath = resolve(targetPath);
  const resolvedAllowedPath = resolve(allowedPath);
  return resolvedTargetPath === resolvedAllowedPath
    || resolvedTargetPath.startsWith(`${resolvedAllowedPath}${sep}`);
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

// (上游别名锚枚举已随域单源化移交属主 lib/security/agent-domain.js,2026-08-26)

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
      automationContext: contract.automationContext || null,
    },
    toolCallTotal: Number(trackingState?.toolCallTotal || 0),
    toolCalls: Array.isArray(trackingState?.toolCalls) ? trackingState.toolCalls : [],
  };
}

export function register(api, logger) {
  api.on("before_tool_call", async (event, ctx) => {
    const decision = await evaluateBeforeToolCall(event, ctx, logger);
    // Evidence: refused calls are ledger events too (spec §2 — one wrapper
    // covers every scattered block exit, including checkToolCall's).
    if (decision?.block === true) {
      await recordRefusedToolCall({
        sessionKey: ctx.sessionKey ?? "",
        agentId: ctx.agentId ?? "unknown",
        toolName: event.toolName ?? "unknown",
        params: event.params ?? {},
        blockReason: decision.blockReason,
        contractId: getTrackingState(ctx.sessionKey ?? "")?.contract?.id ?? null,
        logger,
      });
    }
    return decision;
  });
}

async function evaluateBeforeToolCall(event, ctx, logger) {
  {
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
    // Physical-path single point: the whole guard chain below judges PHYSICAL
    // paths (symlinks resolved), so a workspace-internal symlink that targets
    // an out-of-workspace location is judged by where it physically lands
    // rather than by its lexical spelling. The workspace anchor is
    // physicalized too — target and anchors must live in the same coordinate
    // system (e.g. /var vs /private/var on macOS). Honest limits: Bash/exec
    // writes bypass these path guards entirely, and between this hook's check
    // and the tool's own filesystem write there is a TOCTOU window — this
    // chain is defense-in-depth for the internal-agent threat model, short of
    // a hard security boundary.
    const ws = resolvePhysicalWorkspacePath(agentWorkspace(agentId));
    const rawPath = normalizePath(params.path ?? params.file_path ?? params.filePath ?? "");
    const lexicalInputPath = resolveWorkspacePath(rawPath, ws);
    const resolvedInputPath = resolvePhysicalWorkspacePath(lexicalInputPath);
    // 域单源(备忘录157 §二):锚点物理化语义(树链绝对路径目标/目录级链先解析再拼文件名)
    // 全部收进属主 agent-domain;本文件只消费域谓词。上游别名枚举只在带路径的
    // 读/发现/编辑调用时才做(纯写与零 IO 工具省掉这趟 readdir——与旧 :408 门等价)。
    const domain = await resolveAgentDomain(agentId, {
      includeUpstream: Boolean(resolvedInputPath)
        && (READ_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName) || DISCOVERY_TOOL_PATTERN.test(toolName)),
    });
    const ownInboxDir = domain.inboxDir;
    const ownOutboxDir = domain.outboxDir;
    const ownInboxContractPath = ownInboxDir ? resolve(ownInboxDir, "contract.json") : "";
    const ownOutboxRuntimeResultPath = ownOutboxDir ? resolve(ownOutboxDir, RUNTIME_RESULT_FILE) : "";
    const isInsideOwnWorkspace = (targetPath) => isInAgentDomain(domain, targetPath, { mode: "write" });
    const isOwnInboxContractRead = READ_TOOL_PATTERN.test(toolName)
      && resolvedInputPath === ownInboxContractPath;
    const hasSuccessfulOwnInboxContractRead = Number.isFinite(trackingState?.ownInboxContractReadAt);
    const contractOutput = resolvePhysicalWorkspacePath(
      resolveWorkspacePath(trackingState?.contract?.output ?? "", ws),
    );

    // 0. 树店写屏障(批④刀4审验):threads 树是归档正本区,"终态包不可变"必须是机制。
    // agent 写树的唯一合法通道 = 自己的 outbox 链(物理锚由 agent-domain 单源供给);
    // 其余树内物理落点(上游链目标=别家封包正本、他人 outbox、事件账/投影)一律拦——
    // 上游别名只授权读,写/改经此屏障挡下,封包篡改与 seal 伪造在工具面失效。
    if (
      (WRITE_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName))
      && resolvedInputPath
      && isTreePhysicalPath(resolvedInputPath)
      && !isInsidePath(resolvedInputPath, ownOutboxDir)
    ) {
      return {
        block: true,
        blockReason: "runtime 语义:归档树是只读正本区;请把交付物写进自己的 outbox/(相对路径)。",
      };
    }

    // 1. Loop detection hard stop — block ALL tools
    if (isSessionHardStopped(resolveSessionEpochKey(trackingState) || sessionKey)) {
      return { block: true, blockReason: HARD_STOP_BLOCK_REASON };
    }

    if (isContractSession && !trackingState?.contract?.id) {
      return {
        block: true,
        blockReason: "runtime 语义：contract session 已归档；请等待 runtime 下一次唤醒。",
      };
    }

    // 1b. Contract-backed sessions must first bind to their own inbox contract truth
    // 平台服务族豁免(与 2a 白名单闸同款理由):submit_output 扛的正是"平台观察不到的
    // 失败"。信封缺席(TOCTOU 竞态)时本闸的指令不可满足,再拦住逃生门就是死锁——
    // live 实证 2026-08-18 TC-…495631:读不到合约、写被拦、连 status:failed 都申报不出去。
    // ls/grep 豁免(2026-08-23 用户裁决"守卫放行 ls"):列目录/搜索是找到 contract.json
    // 的前提(ENOENT 病灶正是没有发现能力逼出来的猜路径);只读零写风险,且放行后仍受
    // 2b 路径域、2c 探他人 inbox、敏感路径三道后段守卫约束。
    if (
      trackingState?.contract?.id
      && !hasSuccessfulOwnInboxContractRead
      && !isOwnInboxContractRead
      && !isExposedPlatformServiceTool(toolName)
      && !DISCOVERY_TOOL_PATTERN.test(toolName)
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
      && resolvedInputPath === contractOutput
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
      const target = resolvedInputPath;
      // Physical own-workspace anchors: a linked outbox/inbox physically lands
      // in the run tree and must still count as operator's own workspace.
      if (target && ws && !isInsideOwnWorkspace(target)) {
        return {
          block: true,
          blockReason: "运维原则：operator 是 meta-agent，工作区外的代码与平台配置请经 CLI-system admin surface（plan→execute→change-set）修改；raw write/edit 仅限 operator 自己的工作区内。",
        };
      }
    }

    // 1d2. CROSS-WORKSPACE WRITE CONFINEMENT — outbox is the collectOutbox truth
    // source, so a write into ANOTHER agent's workspace forges that agent's
    // deliverables and splits ledger attribution from goods attribution.
    // Scope: the workspaces tree only — external project paths stay allowed,
    // and the declared contract.output stays allowed even
    // when it lives under another agent's workspace. Bash-mediated writes are
    // outside this path guard, same as every other path guard in this file.
    if (WRITE_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName)) {
      const target = resolvedInputPath;
      // Anchors physicalized to match the physical target (same coordinate system).
      // The foreign-anchor set covers every OTHER agent's physical workspace,
      // outbox and inbox: once outbox/inbox are links, a forged write into
      // another agent's mailbox physically lands in the run tree — outside the
      // lexical workspaces root — and must still hit an anchor. Anchors come
      // from resolveAgentGuardAnchors (lazily computed, briefly cached).
      const workspacesRoot = resolvePhysicalWorkspacePath(join(OC, "workspaces"));
      const isContractOutputTarget = Boolean(contractOutput) && target === contractOutput;
      // 词法兜底(纵深):落点按词法拼写落在 workspaces 树内、拼写归属他人工作区时,
      // 即使物理化把它解析到了 anchors 覆盖之外(他人工作区内的链指向别处),
      // 仍按 foreign 拦——物理化绕过词法域的写与物理命中同罪。
      const lexicalWorkspacesRoot = resolve(join(OC, "workspaces"));
      const lexicalOwnWorkspace = agentWorkspace(agentId) ? resolve(agentWorkspace(agentId)) : "";
      const lexicalForeignWorkspaceHit = Boolean(lexicalInputPath)
        && isInsidePath(lexicalInputPath, lexicalWorkspacesRoot)
        && !(lexicalOwnWorkspace && isInsidePath(lexicalInputPath, lexicalOwnWorkspace))
        && !(ws && isInsidePath(lexicalInputPath, ws));
      if (
        target && ws
        && !isContractOutputTarget
        && !isInsideOwnWorkspace(target)
        && (isInsidePath(target, workspacesRoot)
          || lexicalForeignWorkspaceHit
          || [...runtimeAgentConfigs.keys()].some((otherId) => otherId !== agentId
            && resolveAgentGuardAnchors(otherId).some((anchor) => isInsidePath(target, anchor))))
      ) {
        return {
          block: true,
          blockReason: "工作区边界：每个 agent 的产出写入自己的工作区（如 outbox/）或 contract 声明的 output 路径；跨 agent 交接由平台传送带完成。",
        };
      }
    }

    // 1e. WRITE SIZE CAP — FIX(A3-write-size-cap): bound write/edit byte size up front so oversized
    // content is rejected before it reaches the tool, keeping an arbitrarily huge file off disk
    // (previously disk_full was only recorded post-hoc in error-ledger).
    const writeSizeBlock = checkWriteSize(
      toolName,
      params,
      resolveMaxWriteBytesFromPolicy(trackingState?.executionPolicy),
    );
    if (writeSizeBlock) return writeSizeBlock;

    // 上游别名判定已随域单源化并入 domain(r 锚);2b/2c 消费 isOwnUpstreamTarget。
    const isOwnUpstreamLinkTarget = (targetPath) => isOwnUpstreamTarget(domain, targetPath);

    // 2. Role-level tool + path restrictions (Rule 12 enforcement)
    const role = getAgentRole(agentId);
    const restrictions = getToolRestrictions(role);
    if (restrictions) {
      // 2a. Tool whitelist(与两个 FC 工具族并集:授权单源 collaboration-intent-policy
      // 授予该角色的暴露协作 FC 不受本地白名单约束——两表矛盾时授权单源赢,P4。
      // 平台服务族同理但无角色维度:它只能动自己,因此对全角色放行——被角色白名单挡住的
      // 后果是 agent 连"我失败了"都说不出口。)
      if (restrictions.allowedTools
        && !restrictions.allowedTools.includes(toolName)
        && !isExposedCollabToolForRole(role, toolName)
        && !isExposedPlatformServiceTool(toolName)) {
        return { block: true, blockReason: `角色限制：${role} 使用已授权工具集处理当前任务；本次工具为 ${toolName}` };
      }

      // 2b. Read path scope
      // D-G:ls/grep 与 read 走同一片路径域;path 缺省时按 agent 工作区根目录
      // 处理再查域——不给 scope=inbox 的角色开全盘目录发现的洞。
      if (restrictions.readPathScope && (READ_TOOL_PATTERN.test(toolName) || DISCOVERY_TOOL_PATTERN.test(toolName))) {
        const targetPath = resolvedInputPath
          || (DISCOVERY_TOOL_PATTERN.test(toolName) ? ws : "");
        if (targetPath) {
          // Physical-only inbox scope (审查 2026-08-16): the anchor ownInboxDir
          // is the PHYSICALIZED inbox directory, so a real-dir inbox and a
          // platform-staged directory link both resolve target and anchor into
          // the same coordinate system. A lexical disjunct here would let a
          // file-level symlink planted inside a real inbox (inbox/leak.md →
          // anywhere) pass on spelling alone — exactly the escape the
          // physical hardening closes. The threads tree as a whole stays out
          // of scope (no cross-run reads via tree paths) — the ONLY tree
          // locations in scope are this agent's own upstream link targets
          // (platform staging = authorized alias; owned by agent-domain r-anchors).
          const isOwnInboxRead = Boolean(ownInboxDir && isInsidePath(targetPath, ownInboxDir))
            || isOwnUpstreamLinkTarget(targetPath);

          if (restrictions.readPathScope === "inbox") {
            // Planner: only read from own inbox/
            if (ownInboxDir && !isOwnInboxRead) {
              return { block: true, blockReason: `路径限制：${role} 的读取范围是 inbox/ 目录` };
            }
          } else if (restrictions.readPathScope === "workspace") {
            // Planner(workspace scope):读域=问域属主(ws+物理化 outbox/inbox 的 rw 锚
            // + 上游链 r 锚)。合约轮邮箱软链进树的物理落点天然在域内——曾经的裸 ws
            // 单锚误拦(备忘录156 A线实锤)在域单源下无从发生:锚集不在本规则手里。
            if (ws && !isInAgentDomain(domain, targetPath, { mode: "read" })) {
              return { block: true, blockReason: `路径限制：${role} 的读取范围是自己的工作区（含 inbox/upstream）` };
            }
          }
        }
      }
    }

    // 2c. Runtime IO truth — contract.output is a write sink until materialized
    // D-G:ls/grep 同 read 参与本段(合约会话经发现工具探他人 inbox 与 read 同罪)。
    if (READ_TOOL_PATTERN.test(toolName) || EDIT_TOOL_PATTERN.test(toolName) || DISCOVERY_TOOL_PATTERN.test(toolName)) {
      const targetPath = resolvedInputPath
        || (DISCOVERY_TOOL_PATTERN.test(toolName) ? ws : "");
      // Probe runs on BOTH coordinates (a foreign inbox spelled lexically may
      // physicalize into the run tree — probe must still fire); own-inbox
      // judgment is PHYSICAL-ONLY (审查 2026-08-16): a lexical disjunct would
      // authorize file-level symlink escapes planted inside a real inbox.
      const isInboxProbe = [lexicalInputPath, targetPath].some((candidate) => candidate
        && (candidate.endsWith(`${sep}inbox`) || candidate.includes(`${sep}inbox${sep}`)));
      // Own-upstream link targets count as own inbox: the lexical spelling
      // inbox/upstream/<producer>/… physicalizes into the producer's sealed
      // tree outbox once staging links the package (authorized alias).
      const isOwnInboxTarget = Boolean(ownInboxDir && isInsidePath(targetPath, ownInboxDir))
        || isOwnUpstreamLinkTarget(targetPath);
      if (
        trackingState?.contract?.id
        && targetPath
        && ownInboxDir
        && isInboxProbe
        && !isOwnInboxTarget
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

    // 3. Declared sandbox guards — D-F:判定迁至 lib/security/declared-sandbox-guard.js,
    // 配置面直接读 contract.automationContext.harness.moduleConfig,与 lib/harness 解耦。
    const sandboxBlock = evaluateDeclaredSandboxGuard({
      automationContext: trackingState?.contract?.automationContext,
      toolName,
      params,
      resolvedInputPath,
    });
    if (sandboxBlock) return sandboxBlock;

    // 4. Security check (existing)
    return checkToolCall(agentId, sessionKey, toolName, params, logger);
  }
}
