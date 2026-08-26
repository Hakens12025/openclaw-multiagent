// lib/security/declared-sandbox-guard.js — 合约声明沙箱:guard.tool_access / guard.scope 两道守卫
//
// D-F 守卫迁移(先例:v215 退役时执行硬停闸从 lib/loop 搬到 lib/runtime):
// 判定逻辑自 hooks/before-tool-call.js 的内联段迁入本模块,与 lib/harness 解耦。
// 这两道门的事后评估器(harness-guard-checks.js 等)已随 harness 全退役删除(v226)。
// 改名收尾(2026-08-26,备忘录156):模块 id 去掉 harness 保留前缀
// (harness:guard.* → guard.*),拦截文案不再自称 Harness。
// 配置容器仍是 contract.automationContext.harness.moduleConfig —— 那是 automation
// spec 的历史形状(automation-registry.js normalizeAutomationHarness 注释),
// 容器改名属 schema 迁移,不在本批。
//
// 顺手修复(裁决内):原实现配置侧 uniqueTools 小写归一、判定侧裸 includes,
// 大小写不对称——tool_access 判定改为大小写不敏感。

import { resolve, sep } from "node:path";

import { normalizeRecord } from "../core/normalize.js";
import { normalizeToolPath, resolvePhysicalWorkspacePath } from "../state.js";

const EXEC_TOOL_PATTERN = /^(exec|Bash)$/i;
const SCOPE_TARGET_TOOL_PATTERN = /^(write|Write|edit|Edit|exec|Bash)$/i;

// 与 hooks/before-tool-call.js 的 isInsidePath 同判定(同一坐标系内前缀包含)。
function isInsidePath(targetPath, allowedPath) {
  if (!targetPath || !allowedPath) return false;
  const resolvedTargetPath = resolve(targetPath);
  const resolvedAllowedPath = resolve(allowedPath);
  return resolvedTargetPath === resolvedAllowedPath
    || resolvedTargetPath.startsWith(`${resolvedAllowedPath}${sep}`);
}

function readModuleConfig(automationContext, moduleId) {
  const moduleConfig = normalizeRecord(automationContext?.harness?.moduleConfig, {});
  return normalizeRecord(moduleConfig[moduleId], {});
}

// 返回 { block, blockReason } 或 null(放行)。resolvedInputPath 由调用方
// (before_tool_call 守卫链的物理化单点)物理化好传入,本模块不重复物理化目标路径。
export function evaluateDeclaredSandboxGuard({
  automationContext = null,
  toolName = "",
  params = {},
  resolvedInputPath = "",
} = {}) {
  const harness = normalizeRecord(automationContext?.harness, null);
  if (!harness) return null;

  // guard.tool_access:白名单非空才激活;判定大小写不敏感(修复配置侧小写归一、
  // 判定侧裸 includes 的不对称)。
  const toolAccessConfig = readModuleConfig(automationContext, "guard.tool_access");
  const allowedTools = Array.isArray(toolAccessConfig.allowedTools) ? toolAccessConfig.allowedTools : null;
  if (allowedTools && allowedTools.length > 0) {
    const allowed = new Set(allowedTools.map((name) => String(name).toLowerCase()));
    if (!allowed.has(String(toolName).toLowerCase())) {
      return { block: true, blockReason: `工具边界：使用 [${allowedTools.join(", ")}] 处理当前任务；本次工具为 ${toolName}` };
    }
  }

  // guard.scope:allowedWorkspaceRoots 非空才激活,对 write/edit/exec 做路径域检查。
  const scopeConfig = readModuleConfig(automationContext, "guard.scope");
  const allowedRoots = Array.isArray(scopeConfig.allowedWorkspaceRoots) && scopeConfig.allowedWorkspaceRoots.length > 0
    ? scopeConfig.allowedWorkspaceRoots
    : null;
  if (allowedRoots && SCOPE_TARGET_TOOL_PATTERN.test(toolName)) {
    // File tools judge the same physicalized path as the rest of the guard
    // chain, against physicalized roots. exec/Bash carries a command string,
    // not a path — it keeps the lexical prefix check only: Bash-mediated
    // disk writes are NOT covered by this or any other path guard here.
    const isExecCommand = EXEC_TOOL_PATTERN.test(toolName);
    const targetPath = isExecCommand
      ? normalizeToolPath(params.command ?? "")
      : (resolvedInputPath || normalizeToolPath(params.path ?? params.file_path ?? params.filePath ?? ""));
    // Same-depth physical anchors per root: a root's outbox/ or inbox/
    // may be a directory-level link out of the root — its physical
    // location belongs to the root's authorized scope, nothing beyond it.
    // While those are real dirs (or absent) the extra anchors collapse
    // inside the physical root, so the set is behavior-neutral.
    const matchesRoot = (root) => {
      if (isExecCommand) return targetPath.startsWith(normalizeToolPath(root));
      const lexicalRoot = resolve(normalizeToolPath(root));
      return [
        resolvePhysicalWorkspacePath(lexicalRoot),
        resolvePhysicalWorkspacePath(resolve(lexicalRoot, "outbox")),
        resolvePhysicalWorkspacePath(resolve(lexicalRoot, "inbox")),
      ].some((anchor) => isInsidePath(targetPath, anchor));
    };
    if (targetPath && !allowedRoots.some(matchesRoot)) {
      return { block: true, blockReason: `沙箱边界：使用工作空间范围 [${allowedRoots.join(", ")}] 处理当前任务；本次路径为 ${targetPath}` };
    }
  }

  return null;
}
