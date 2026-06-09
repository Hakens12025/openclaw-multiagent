// artifact-store.js — agent 产物按 contract+producer 整包独立保存 + 整包流转
//
// 用户最初设计:产物随 contract 流转 + 独立留存。产物可能是多个文件,系统搬运
// outbox 的全部产物文件(整包),不是单 md。此前 planner 产物没流给 worker、被
// 后续 agent 覆盖丢失 = 协作断裂的根因。
//
// 三件事:
//   1. 整包独立留存:agent_end 把该 agent 全部产物文件复制到
//      control-plane/artifacts/<cid>/<producer>/  + 写 manifest.json(身份/清单/主交付物)。
//      每个 producer 独立一包,互不覆盖。产物正本仍是 agent 写的(不造第二真值)。
//   2. 整包流入下游 inbox:下游启动时,把上游 producer 的整包(全部文件,递归)
//      复制到 <ws>/inbox/upstream/<producer>/,并在 contract.json 写 upstreamPackages 指针。
//   3. manifest 由 runtime_result 演进,只引 contractId;路由/状态机/来源仍是 contract 真值,
//      manifest 不重复(决策见 docs/decision-dual-file-package-flow-2026-05-31.md)。
//
// 红线:整段 try/catch 吞错,绝不破坏 agent_end / inbox 投递。

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { loadGraph, getEdgesTo } from "../agent/agent-graph.js";
import { agentWorkspace } from "../state-agent-helpers.js";

const ARTIFACTS_ROOT = join(CONTROL_PLANE_PATHS.root, "artifacts");
export const ARTIFACT_MANIFEST_FILE = "manifest.json";

export function artifactDir(contractId) {
  return join(ARTIFACTS_ROOT, contractId);
}

// 包目录:每个 producer 一个包(全部产物文件 + manifest.json)。
export function artifactPackageDir(contractId, agentId) {
  return join(ARTIFACTS_ROOT, contractId, agentId);
}

export function artifactManifestPath(contractId, agentId) {
  return join(artifactPackageDir(contractId, agentId), ARTIFACT_MANIFEST_FILE);
}

// 递归复制目录(文件 + 子目录结构);忽略不可读项,不抛。
async function copyDirRecursive(srcDir, destDir) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest);
    }
  }
}

/**
 * 把该 agent 的全部产物文件整包独立保存到
 *   control-plane/artifacts/<contractId>/<agentId>/
 * 并写 manifest.json(contractId / producer / producedAt / status / summary / files[] / primary)。
 * 每个 producer 独立一包,互不覆盖。无产物 / 缺参 → no-op。
 * 整段 try/catch 吞错,绝不抛(不破坏 agent_end)。
 *
 * @param {{ contractId?:string|null, agentId?:string|null, artifactPaths?:string[],
 *           primaryOutputPath?:string|null, status?:string|null, summary?:string|null }} params
 * @returns {Promise<{ saved:boolean, dir:string|null, files:string[], manifestPath:string|null }>}
 */
export async function saveAgentArtifact({
  contractId,
  agentId,
  artifactPaths,
  primaryOutputPath,
  status,
  summary,
} = {}) {
  const EMPTY = { saved: false, dir: null, files: [], manifestPath: null };
  try {
    const cid = typeof contractId === "string" ? contractId.trim() : "";
    const aid = typeof agentId === "string" ? agentId.trim() : "";
    if (!cid || !aid) return EMPTY;

    // 仅收落盘存在的产物文件;按 basename 落包,同名去重(保留首个)。
    const srcPaths = (Array.isArray(artifactPaths) ? artifactPaths : [])
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter((p) => p && existsSync(p));
    if (srcPaths.length === 0) return EMPTY;

    const dir = artifactPackageDir(cid, aid);
    await mkdir(dir, { recursive: true });

    const files = [];
    const seen = new Set();
    for (const src of srcPaths) {
      const name = basename(src);
      if (seen.has(name)) continue;
      try {
        await copyFile(src, join(dir, name));
        files.push(name);
        seen.add(name);
      } catch {
        // 单文件复制失败不影响其它文件
      }
    }
    if (files.length === 0) return EMPTY;

    const primaryName = typeof primaryOutputPath === "string" && primaryOutputPath.trim()
      ? basename(primaryOutputPath.trim())
      : null;
    const primary = primaryName && files.includes(primaryName)
      ? primaryName
      : files.find((f) => f.toLowerCase().endsWith(".md")) || files[0];

    const manifest = {
      contractId: cid,
      producer: aid,
      producedAt: new Date().toISOString(),
      status: typeof status === "string" && status.trim() ? status.trim() : "completed",
      summary: typeof summary === "string" && summary.trim() ? summary.trim() : null,
      files,
      primary,
    };
    const manifestPath = artifactManifestPath(cid, aid);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return { saved: true, dir, files, manifestPath };
  } catch {
    // 保存失败静默:绝不破坏 agent_end
    return EMPTY;
  }
}

// 从 graph 求本 agent 的上游 agent 列表(有入边指向它的)。
function resolveUpstreamAgents(graph, agentId) {
  const upstream = new Set();
  for (const edge of getEdgesTo(graph, agentId)) {
    if (typeof edge?.from === "string" && edge.from.trim()) {
      upstream.add(edge.from.trim());
    }
  }
  return [...upstream];
}

/**
 * 上游产物整包流入本 agent inbox:对每个上游 producer,若
 *   control-plane/artifacts/<contractId>/<producer>/ 存在
 * → 整包(全部文件,递归)复制到 <ws>/inbox/upstream/<producer>/。
 * 下游启动时 inbox 里就有上游整包(产物随 contract 流转);多上游各一包,互不覆盖。
 *
 * 整段 try/catch 吞错,绝不抛(失败不破坏 before_agent_start / inbox 投递)。
 *
 * @param {{ contractId?:string|null, agentId?:string|null }} params
 * @returns {Promise<{ copied:string[], packages:string[] }>}
 *   copied   = 实际复制的上游 producer 列表
 *   packages = 相对 inbox 的包路径(给 contract.json 的 upstreamPackages 指针)
 */
export async function copyUpstreamArtifactsToInbox({ contractId, agentId, logger = null } = {}) {
  const EMPTY = { copied: [], packages: [] };
  try {
    const cid = typeof contractId === "string" ? contractId.trim() : "";
    const aid = typeof agentId === "string" ? agentId.trim() : "";
    if (!cid || !aid) return EMPTY;

    const graph = await loadGraph();
    const upstreamAgents = resolveUpstreamAgents(graph, aid);
    if (upstreamAgents.length === 0) return EMPTY;

    const ws = agentWorkspace(aid);
    if (!ws) return EMPTY;

    const copied = [];
    const packages = [];
    for (const up of upstreamAgents) {
      const srcPkg = artifactPackageDir(cid, up);
      if (!existsSync(srcPkg)) continue; // 该上游本环未产出 → 跳过
      try {
        await copyDirRecursive(srcPkg, join(ws, "inbox", "upstream", up));
        copied.push(up);
        packages.push(`upstream/${up}/`);
      } catch (copyError) {
        // 单个上游复制失败不影响其它上游与主流程 —— 但绝不静默:这意味着 ${up} 的产物未进入 ${aid} 的
        // inbox(跨 agent 上下文丢失),必须可观测(否则下游静默缺料还以为正常)。
        logger?.warn?.(`[mailbox] upstream copy FAILED for ${up} → ${aid} (cid ${cid}): ${copyError?.message || copyError} — that upstream's context is MISSING from this inbox`);
      }
    }
    return { copied, packages };
  } catch (error) {
    // 整体失败兜底:绝不破坏 before_agent_start / inbox 投递,但记录(非静默)。
    logger?.warn?.(`[mailbox] copyUpstreamArtifactsToInbox failed (cid ${contractId}, agent ${agentId}): ${error?.message || error}`);
    return EMPTY;
  }
}
