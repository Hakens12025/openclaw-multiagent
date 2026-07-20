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

// FIX(B8-context-compression): drop dead `readFile` import; add open/stat + dirname/relative for size-aware selective copy.
import { copyFile, mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { loadGraph, getEdgesTo } from "../agent/agent-graph.js";
import { agentWorkspace } from "../state-agent-helpers.js";
// FIX(B8-context-compression): pull in the single budget/manifest truth source.
import {
  MAX_UPSTREAM_INBOX_BYTES,
  COMPRESSED_MANIFEST_FILE,
  MISSING_MARKER_FILE,
  MANIFEST_HEAD_READ_BYTES,
  computeContextBudgetPlan,
  buildCompressedManifest,
  buildMissingMarker,
} from "../context-compression.js";

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

// 递归枚举包内文件（相对包根路径 + 绝对路径 + 字节大小）。
// FIX(B8-context-compression): 盲目整包复制 -> 先枚举带大小，交预算函数取舍。
// FIX(B8-context-compression/review): 不再静默吞 readdir 失败——把不可读目录记入 errors，
// 让调用方能落 _MISSING.md（否则一个 existsSync 通过但 readdir 抛错的包会整个消失、零可观测，
// 比 B8 之前的 logger.warn 更糟）。
async function listPackageFiles(srcDir, baseDir = srcDir, errors = null) {
  const out = [];
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (readError) {
    if (Array.isArray(errors)) errors.push({ dir: srcDir, reason: readError?.message || String(readError) });
    return out;
  }
  for (const entry of entries) {
    const abs = join(srcDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listPackageFiles(abs, baseDir, errors)));
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = (await stat(abs)).size;
      } catch {
        size = 0;
      }
      out.push({ absPath: abs, relPath: relative(baseDir, abs), size });
    }
  }
  return out;
}

// FIX(B8-context-compression/review): single writer for the visible _MISSING.md marker,
// reused by both the "nothing enumerated" early return and the normal path (one-path).
async function writeMissingMarkerFile(upstreamRoot, agentId, contractId, failures, logger) {
  if (!Array.isArray(failures) || failures.length === 0) return;
  try {
    await mkdir(upstreamRoot, { recursive: true });
    await writeFile(
      join(upstreamRoot, MISSING_MARKER_FILE),
      buildMissingMarker({ agentId, contractId, failures }),
      "utf8",
    );
  } catch (markerError) {
    logger?.warn?.(`[mailbox] _MISSING.md write failed for ${agentId} (cid ${contractId}): ${markerError?.message || markerError}`);
  }
  logger?.warn?.(`[mailbox] upstream copy had ${failures.length} failure(s) for ${agentId} (cid ${contractId}); see inbox/upstream/${MISSING_MARKER_FILE}`);
}

// 只读文件前 N 字节作 head（避免为取 head 读入整个大文件）；不可读 → 空串。
// FIX(B8-context-compression): 溢出文件常达数 MB -> 只 open+read 头 N 字节，不整读。
async function readHead(absPath, maxBytes = MANIFEST_HEAD_READ_BYTES) {
  let handle;
  try {
    handle = await open(absPath, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close?.();
  }
}

function groupByProducer(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.producer)) map.set(item.producer, []);
    map.get(item.producer).push(item);
  }
  return map;
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
    const upstreamRoot = join(ws, "inbox", "upstream");

    // 1) 枚举每个上游包的文件（带大小），按上游顺序 + 文件名排序 → 预算决策确定。
    // FIX(B8-context-compression): 无界整包复制 -> 先枚举再按字节预算取舍。
    const failures = [];
    const perProducer = new Map();
    for (const up of upstreamAgents) {
      const srcPkg = artifactPackageDir(cid, up);
      if (!existsSync(srcPkg)) continue; // 该上游本环未产出 → 跳过
      const enumErrors = [];
      const files = (await listPackageFiles(srcPkg, srcPkg, enumErrors))
        .map((f) => ({ ...f, producer: up }))
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
      // FIX(B8-context-compression/review): 存在但（部分）不可读的包不再静默丢——记入 failures，
      // 后续落 _MISSING.md，下游读 inbox 即知该上游上下文缺失。
      for (const e of enumErrors) failures.push({ producer: up, reason: `enumerate ${e.dir}: ${e.reason}` });
      if (files.length > 0) perProducer.set(up, files);
    }
    if (perProducer.size === 0) {
      // FIX(B8-context-compression/review): 即使没东西可拷，也要把枚举失败落成可见 _MISSING.md，
      // 否则「整个上游不可读」会零可观测地消失（正是 B8 想消灭的静默缺料）。
      await writeMissingMarkerFile(upstreamRoot, aid, cid, failures, logger);
      return EMPTY;
    }

    // 2) 唯一预算真值：跨所有上游共享一个字节池，决定整包流入 vs 溢出压清单。
    // FIX(B8-context-compression): 用 computeContextBudgetPlan 作单一预算真值，禁止分散判断。
    const allFiles = [...perProducer.values()].flat();
    const { included, overflow, needsCompression } = computeContextBudgetPlan({
      files: allFiles,
      maxBytes: MAX_UPSTREAM_INBOX_BYTES,
    });

    // 3) 复制装得下的文件（保子目录结构）；失败入 failures（可观测，不静默）。
    // FIX(B8-context-compression): 单文件复制失败此前只 warn -> 记入 failures，后落 _MISSING.md。
    const copiedProducers = new Set();
    for (const [up, files] of groupByProducer(included)) {
      for (const f of files) {
        const dest = join(upstreamRoot, up, f.relPath);
        try {
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(f.absPath, dest);
          copiedProducers.add(up);
        } catch (copyError) {
          failures.push({ producer: up, reason: `copy ${f.relPath}: ${copyError?.message || copyError}` });
        }
      }
    }

    // 4) 溢出文件不复制正本，改按 producer 汇成 COMPRESSED_MANIFEST.md（path+size+截断 head）。
    // FIX(B8-context-compression): 溢出正文丢失=静默缺料 -> 落可见压缩清单，LLM 侧按需取正本。
    const compressedProducers = new Set();
    for (const [up, files] of groupByProducer(overflow)) {
      const entries = [];
      for (const f of files) entries.push({ path: f.relPath, size: f.size, head: await readHead(f.absPath) });
      try {
        await mkdir(join(upstreamRoot, up), { recursive: true });
        await writeFile(
          join(upstreamRoot, up, COMPRESSED_MANIFEST_FILE),
          buildCompressedManifest({ producer: up, entries, maxBytes: MAX_UPSTREAM_INBOX_BYTES }),
          "utf8",
        );
        compressedProducers.add(up);
      } catch (manifestError) {
        failures.push({ producer: up, reason: `compressed manifest: ${manifestError?.message || manifestError}` });
      }
    }

    // 5) 复制/枚举失败可见化：落 inbox/upstream/_MISSING.md（下游读 inbox 即知道缺了谁）。
    // FIX(B8-context-compression): 此前失败只 logger.warn（下游看不到）-> 落可见 _MISSING.md 标记。
    await writeMissingMarkerFile(upstreamRoot, aid, cid, failures, logger);
    if (needsCompression) {
      logger?.info?.(`[mailbox] upstream context over ${MAX_UPSTREAM_INBOX_BYTES}B for ${aid} (cid ${cid}); ${overflow.length} file(s) → ${COMPRESSED_MANIFEST_FILE}`);
    }

    // copied = 有正本文件流入的 producer；packages = 有任何内容（正本或压缩清单）的包路径。
    const copied = [...copiedProducers];
    const packages = [...new Set([...copiedProducers, ...compressedProducers])].map((up) => `upstream/${up}/`);
    return { copied, packages };
  } catch (error) {
    // 整体失败兜底:绝不破坏 before_agent_start / inbox 投递,但记录(非静默)。
    logger?.warn?.(`[mailbox] copyUpstreamArtifactsToInbox failed (cid ${contractId}, agent ${agentId}): ${error?.message || error}`);
    return EMPTY;
  }
}
