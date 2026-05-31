// workflow-trace-snapshot.js — agent_end 清理前快照 inbox 过滤副本到 trace
//
// 背景（设计稿）：agent_end 清理会 unlink workspaces/<a>/inbox/ 的工作副本。
// 其中 inbox contract 经 projectTaskFacingInboxContract 过滤，异于 contracts
// 正本，值得在清理前留档。本 helper 把 inbox 现有文件 cp 到
//   control-plane/workflow-trace/<contractId>/<agentId>/inbox/
// 供「工作流」页回溯。
//
// 红线：本 helper 是清理路径的旁路补充，绝不能因快照失败而中断清理。
// 调用方（agent-end-transport）整段包 try/catch，本函数内部也兜底吞错。

import { cp, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

/**
 * 把 inbox 现有文件快照到 workflow-trace。
 * 任一前置条件缺失（无 contractId / agentId / inboxDir）直接跳过（no-op）。
 *
 * @param {{ contractId?:string|null, agentId?:string|null, inboxDir?:string|null }} params
 * @returns {Promise<{ snapshotted:boolean, dest:string|null }>}
 */
export async function snapshotInboxToTrace({ contractId, agentId, inboxDir } = {}) {
  const cid = typeof contractId === "string" ? contractId.trim() : "";
  const aid = typeof agentId === "string" ? agentId.trim() : "";
  const src = typeof inboxDir === "string" ? inboxDir.trim() : "";
  if (!cid || !aid || !src) {
    return { snapshotted: false, dest: null };
  }

  const dest = join(CONTROL_PLANE_PATHS.root, "workflow-trace", cid, aid, "inbox");
  await mkdir(dest, { recursive: true });
  // recursive cp 整个 inbox 目录内容；源不存在时 cp 抛错，由调用方/此处兜底吞掉。
  await cp(src, dest, { recursive: true });
  return { snapshotted: true, dest };
}

/**
 * 把产出件正本（control-plane/output/<contractId>.md）快照到 workflow-trace。
 *   control-plane/workflow-trace/<contractId>/output.md
 * 覆盖写（last-writer-wins）：每个 agent_end 都覆盖，末位 agent 跑完即最终件。
 * 供 delivery 在 live 产出件被清后回退读取（快照=历史副本，live=truth）。
 *
 * 产出件不存在 / contractId 缺 → no-op。整段 try/catch 吞错，绝不破坏 agent_end。
 *
 * @param {{ contractId?:string|null, outputPath?:string|null }} params
 * @returns {Promise<{ snapshotted:boolean, dest:string|null }>}
 */
export async function snapshotOutputToTrace({ contractId, outputPath } = {}) {
  try {
    const cid = typeof contractId === "string" ? contractId.trim() : "";
    const src = typeof outputPath === "string" ? outputPath.trim() : "";
    if (!cid || !src || !existsSync(src)) {
      return { snapshotted: false, dest: null };
    }
    const destDir = join(CONTROL_PLANE_PATHS.root, "workflow-trace", cid);
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, "output.md");
    await copyFile(src, dest);
    return { snapshotted: true, dest };
  } catch {
    // 快照失败静默：绝不破坏 agent_end
    return { snapshotted: false, dest: null };
  }
}
