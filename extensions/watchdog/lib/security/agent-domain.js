// lib/security/agent-domain.js — agent 工作区域权的唯一属主(备忘录157 §二,2026-08-26 裁决)。
//
// 病理:「哪些物理路径属于 agent 自己的工作区」这个真值,曾被守卫各规则各自重算
// (ws/物理化邮箱/上游链锚各一套,规则各挑子集)——域的真相是挂载基础设施创造的
// (批4 邮箱软链、派工 upstream 链),规则凭记忆重算,每多一种挂载每条规则欠一刀:
// 漏读侧=误拦(planner-outbox 实锤),漏写侧=逃逸(静默)。
//
// law:每类真值只有一个属主;属主之外只能引用、不能重算。本模块即"域"的门:
//   - rw 锚(ws + 物理化 outbox/inbox)单源 = state-agent-helpers.resolveAgentGuardAnchors
//     (有机融合:跨 agent 写拦截早已用它,本模块从同一函数长出,不另造平行真值);
//   - r 锚 = inbox/upstream/<producer> 目录级链的物理目标(平台 staging 落的授权别名,
//     只授权读——上游是产者的 sealed 树 outbox,写它=篡改别家封包);
//   - 规则只消费谓词(isInAgentDomain / isOwnUpstreamTarget),锚点清单集中在本模块;
//   - 新挂载类型在此登记一处,守卫全部规则自动跟随,零补丁。
//
// 坐标系纪律(继承守卫链):一切判定走物理路径(resolvePhysicalWorkspacePath,软链解析、
// 悬链取目标、跳数封顶);锚与目标必须同坐标系。诚实边界同守卫链:Bash/exec 绕过
// 路径守卫,hook 检查与工具落盘之间有 TOCTOU 窗——纵深防御,非硬安全边界。
import { lstat, readdir, readlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  agentWorkspace,
  resolveAgentGuardAnchors,
  resolvePhysicalWorkspacePath,
} from "../state.js";

export const DOMAIN_ANCHOR_MODE = Object.freeze({
  RW: "rw", // 自己的工作区面:读写皆可(树店写屏障等上层不变量另行收紧)
  R: "r",   // 授权别名面(上游链目标):只读
});

export function isInsidePath(targetPath, allowedPath) {
  if (!targetPath || !allowedPath) return false;
  const resolvedTargetPath = resolve(targetPath);
  const resolvedAllowedPath = resolve(allowedPath);
  return resolvedTargetPath === resolvedAllowedPath
    || resolvedTargetPath.startsWith(`${resolvedAllowedPath}${sep}`);
}

// 上游别名锚:本 agent inbox/upstream/ 下的目录级链是平台 staging 落的授权别名
// (copyUpstreamArtifactsToInbox 链接优先物化,目标=产者的 sealed 树 outbox)。
// 只收目录级链的目标(lstat 判链→readlink 解析);真目录条目已被 inbox 锚覆盖;
// 单条解析失败只影响该条目。逐 call 枚举(上游条目通常只有几个)。
async function resolveUpstreamLinkAnchors(workspaceDir) {
  const anchors = [];
  if (!workspaceDir) return anchors;
  const upstreamRoot = join(workspaceDir, "inbox", "upstream");
  let entries = [];
  try {
    entries = await readdir(upstreamRoot);
  } catch {
    return anchors; // upstream 缺席 = 无上游别名
  }
  for (const name of entries) {
    const entryPath = join(upstreamRoot, name);
    try {
      const stats = await lstat(entryPath);
      if (!stats.isSymbolicLink()) continue;
      const linkTarget = await readlink(entryPath);
      const physical = resolvePhysicalWorkspacePath(resolve(dirname(entryPath), linkTarget));
      if (physical) anchors.push(physical);
    } catch {
      // 悬链/竞态摘除:该条目零授权,其余条目照常
    }
  }
  return anchors;
}

// 域解析:一次调用产出该 agent 的全部域锚 + 常用物理坐标。
// includeUpstream 由调用方按需关(纯写规则不需要上游枚举的 IO 开销)。
export async function resolveAgentDomain(agentId, { includeUpstream = true } = {}) {
  const workspaceDir = agentWorkspace(agentId);
  const ws = resolvePhysicalWorkspacePath(workspaceDir);
  // rw 锚单源:与跨 agent 写拦截同一函数(TTL 缓存),ws/物理化 outbox/inbox 三锚。
  const rwAnchors = resolveAgentGuardAnchors(agentId);
  const outboxDir = resolvePhysicalWorkspacePath(join(workspaceDir, "outbox"));
  const inboxDir = resolvePhysicalWorkspacePath(join(workspaceDir, "inbox"));
  const upstream = includeUpstream ? await resolveUpstreamLinkAnchors(workspaceDir) : [];
  return {
    agentId,
    ws,
    outboxDir,
    inboxDir,
    anchors: [
      ...rwAnchors.map((path) => ({ path, mode: DOMAIN_ANCHOR_MODE.RW })),
      ...upstream.map((path) => ({ path, mode: DOMAIN_ANCHOR_MODE.R })),
    ],
  };
}

// 域谓词:规则唯一的提问方式。契约:targetPath 必须已物理化(守卫链的 resolvedInputPath),
// 锚与目标同坐标系(macOS /var→/private/var 之类由物理化统一),谓词自身不做二次物理化。mode="read" 全锚可答;mode="write" 只认 rw 锚
// (上游链目标永不作写锚——1d/1d2 write 边界绝不能把只读别名当自己的地盘)。
export function isInAgentDomain(domain, targetPath, { mode = "read" } = {}) {
  if (!domain || !targetPath) return false;
  for (const anchor of domain.anchors) {
    if (mode === "write" && anchor.mode !== DOMAIN_ANCHOR_MODE.RW) continue;
    if (isInsidePath(targetPath, anchor.path)) return true;
  }
  return false;
}

// 子域谓词:目标是否落在上游授权别名内(2b/2c 的"算作自己 inbox"判定)。
export function isOwnUpstreamTarget(domain, targetPath) {
  if (!domain || !targetPath) return false;
  return domain.anchors.some(
    (anchor) => anchor.mode === DOMAIN_ANCHOR_MODE.R && isInsidePath(targetPath, anchor.path),
  );
}
