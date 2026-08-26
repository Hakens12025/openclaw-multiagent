// run-tree-snapshot.js — agent_end 清理前把 inbox 过滤副本与产出件快照进 run 树。
//
// inbox contract 经 projectTaskFacingInboxContract 过滤,异于 contracts 正本,
// 值得在 unlink 前留档;产出件 live 正本会被 session-clean 清,快照是 delivery
// 的回退读面。落点(布局权威 thread-tree-store):
//   threads/{t}/runs/{r}/participants/{agentId}/inbox-{contractId}/
//   threads/{t}/runs/{r}/participants/{agentId}/delivery-{contractId}.md
// 落点由 trackingState.contract.lineage 决定 —— 无谱系(=无合约轮次)无 run 家,
// 不快照(批③B 裁定)。
//
// 红线:本模块是清理路径的旁路补充,绝不能因快照失败而中断清理。
// 调用方(agent-end/transport)整段包 try/catch;output 变体内部也兜底吞错。

import { cp, copyFile, lstat, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { normalizeLineage } from "../contract/contract-lineage.js";
import {
  participantDeliverySnapshotFor,
  participantInboxSnapshotDirFor,
} from "../archive/thread-tree-store.js";
import { isTreePhysicalPath } from "../archive/outbox-seal.js";

function normalizeHome(lineage) {
  const home = normalizeLineage(lineage);
  return home?.threadId && home?.runId ? home : null;
}

/**
 * 把 inbox 现有文件快照到 run 树。
 * 任一前置条件缺失（无 lineage / contractId / agentId / inboxDir）直接跳过（no-op）。
 *
 * @param {{ lineage?:object|null, contractId?:string|null, agentId?:string|null, inboxDir?:string|null }} params
 * @returns {Promise<{ snapshotted:boolean, dest:string|null }>}
 */
export async function snapshotInboxToRunTree({ lineage, contractId, agentId, inboxDir } = {}) {
  const cid = typeof contractId === "string" ? contractId.trim() : "";
  const aid = typeof agentId === "string" ? agentId.trim() : "";
  const src = typeof inboxDir === "string" ? inboxDir.trim() : "";
  const home = normalizeHome(lineage);
  if (!cid || !aid || !src || !home) {
    return { snapshotted: false, dest: null };
  }

  const dest = participantInboxSnapshotDirFor(home, aid, cid);
  await mkdir(dest, { recursive: true });
  // recursive cp 整个 inbox 目录内容（含 upstream/）；源不存在时 cp 抛错，由调用方兜底吞掉。
  // dereference: inbox/upstream/<producer> 可能是指向产者树 outbox 的链（链接优先物化），
  // 快照必须物化内容自足——照抄链会让 E-CONTRACT-006 的证据面悬在产者 run 的 GC 命运上。
  // 源缺失照旧抛错（调用方 try/catch 兜底）——filter 会把缺失根静默滤掉，先显式探源保契约。
  await stat(src);
  // filter 剔悬链：dereference 撞悬链会整体 ENOENT 中断（部分拷贝残缺），
  // 悬挂条目跳过、其余照拷，证据面保持尽力自足。
  await cp(src, dest, {
    recursive: true,
    dereference: true,
    filter: async (source) => {
      try {
        const entryStat = await lstat(source);
        if (!entryStat.isSymbolicLink()) return true;
        await stat(source); // 经链 stat:目标健在才拷
        return true;
      } catch {
        return false;
      }
    },
  });
  return { snapshotted: true, dest };
}

/**
 * 把产出件正本快照到 run 树 participants/{agent}/delivery-{contractId}.md。
 * 覆盖写（last-writer-wins）：同 agent 重跑覆盖，快照=历史副本，live=truth。
 *
 * 产出件不存在 / 前置缺失 → no-op。整段 try/catch 吞错，绝不破坏 agent_end。
 *
 * @param {{ lineage?:object|null, contractId?:string|null, agentId?:string|null, outputPath?:string|null }} params
 * @returns {Promise<{ snapshotted:boolean, dest:string|null }>}
 */
export async function snapshotOutputToRunTree({ lineage, contractId, agentId, outputPath } = {}) {
  try {
    const cid = typeof contractId === "string" ? contractId.trim() : "";
    const aid = typeof agentId === "string" ? agentId.trim() : "";
    const src = typeof outputPath === "string" ? outputPath.trim() : "";
    const home = normalizeHome(lineage);
    if (!cid || !aid || !src || !home || !existsSync(src)) {
      return { snapshotted: false, dest: null };
    }
    // 源已物理住在树内(树模式轮的产物正本)→ 树内自拷无意义,no-op。
    if (isTreePhysicalPath(src)) {
      return { snapshotted: false, dest: null };
    }
    const dest = participantDeliverySnapshotFor(home, aid, cid);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return { snapshotted: true, dest };
  } catch {
    // 快照失败静默：绝不破坏 agent_end
    return { snapshotted: false, dest: null };
  }
}
