// upstream-package-inflow.js — 上游产物整包流入下游 inbox
//
// 用户最初设计:产物随 contract 流转。产物可能是多个文件,系统搬运 outbox 的全部
// 产物文件(整包),不是单 md。此前 planner 产物没流给 worker、被后续 agent 覆盖丢失
// = 协作断裂的根因。
//
// 数据源只有一个:上游 agent 的树 outbox
//   threads/{t}/runs/{r}/participants/<producer>/outbox-<cid>/
//   ① 已封包(seal 在场,终态不可变)→ inbox/upstream/<producer> 直接 symlink,零拷贝;
//   ② 未封包(源仍在跑 / 崩溃轮)→ 拷当前内容做快照(可变,故不可链)。
// 落地后往 contract.json 写 upstreamPackages 指针,下游读 contract 即知道读哪些包。
//
// 上游是谁,问合约的 upstreamProducers 指针(派工收口登记),不问图。
// 此前这里另有一个 control-plane/artifacts/<cid>/<producer>/ 副本店做②的数据源,
// 已于 2026-08-19 退役:封条落地后树 outbox 就是不可变正本,副本店从 08-16 起没再被
// 读过,只剩单测垃圾在堆。
//
// 红线:整段 try/catch 吞错,绝不破坏 agent_end / inbox 投递。

import { copyFile, mkdir, open, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { agentWorkspace } from "../state/state-agent-helpers.js";
import { isControlOutboxFile } from "../routing/mailbox/runtime-mailbox-outbox-helpers.js";
import { normalizeString } from "../core/normalize.js";
import { findSealedOutbox, readOutboxSeal } from "../archive/outbox-seal.js";
import { participantOutboxDirFor, resolveContractHome } from "../archive/thread-tree-store.js";
import { readContractSnapshotById } from "../contract/contracts.js";
import {
  UPSTREAM_GUIDE_FILE,
  MISSING_MARKER_FILE,
  GUIDE_HEAD_READ_BYTES,
  buildUpstreamGuide,
  buildMissingMarker,
} from "../delivery/upstream-guide.js";

// 递归枚举包内文件（相对包根路径 + 绝对路径 + 字节大小）。readdir 失败记入 errors，
// 由调用方落可见 _MISSING.md（一个 existsSync 通过但 readdir 抛错的包必须可观测）。
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

// 可见 _MISSING.md 标记的唯一写点(one-path):零流入早退与正常路共用。
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

// 只读文件前 N 字节作 head 预览（避免为取 head 读入整个大文件）；不可读 → 空串。
async function readHead(absPath, maxBytes = GUIDE_HEAD_READ_BYTES) {
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

// 上游自己声明的主交付物,取自树 outbox 的封条。未封包(中场快照)时封条还不在,
// 返回 null——清单本身已经够下游导航,primary 缺席不该让整个指针失效。
function readPackagePrimary(outboxDir) {
  return normalizeString(readOutboxSeal(outboxDir)?.primary) || null;
}

// UPSTREAM_GUIDE.md:可选便利导览(path+size+head 预览),落在 inbox/upstream/ 根——
// 包目录可能是指向产者树 outbox 的链,终态封包保持只读,导览一律写在链外。
// 正本已整包在场,导览写失败只降便利,不入 failures。
async function writeUpstreamGuideFile(upstreamRoot, packages, logger) {
  try {
    const entries = [];
    for (const pkg of packages) {
      for (const rel of pkg.files) {
        const abs = join(upstreamRoot, pkg.producer, rel);
        let size = 0;
        try {
          size = (await stat(abs)).size;
        } catch {
          size = 0;
        }
        entries.push({ path: `${pkg.producer}/${rel}`, size, head: await readHead(abs) });
      }
    }
    await writeFile(join(upstreamRoot, UPSTREAM_GUIDE_FILE), buildUpstreamGuide({ entries }), "utf8");
  } catch (guideError) {
    logger?.warn?.(`[mailbox] ${UPSTREAM_GUIDE_FILE} write skipped: ${guideError?.message || guideError}`);
  }
}

// 上游名单来自合约自带的 upstreamProducers 指针(派工收口登记,见
// dispatch-graph-policy.js 的 applyUpstreamProducerPointer),不查图。
// 图入边只是「传送带投递授权」,把它当产物来源会在两处出错:动态派工/评审的目标
// 本就不在图上(拿不到上游包),而拓扑一改历史合约的上游会跟着变。
// 每条指针带自己的 contractId —— 评审这类新约的源产物挂在别的合约名下。
function resolveUpstreamProducers(contract, agentId) {
  const declared = Array.isArray(contract?.upstreamProducers) ? contract.upstreamProducers : [];
  const seen = new Set();
  const producers = [];
  for (const entry of declared) {
    const producer = normalizeString(entry?.agentId);
    if (!producer || producer === agentId || seen.has(producer)) continue;
    seen.add(producer);
    producers.push({
      agentId: producer,
      contractId: normalizeString(entry?.contractId) || normalizeString(contract?.id),
    });
  }
  return producers.filter((entry) => entry.contractId);
}

/**
 * 上游产物整包流入本 agent inbox(链接优先物化器):对每个上游 producer——
 *   产者树 outbox 已封包(findSealedOutbox 命中,seal=已采集事实,终态包不可变)
 *     → inbox/upstream/<producer> 直接 symlink(绝对路径)指向树 outbox 目录,零拷贝;
 *   seal 缺席(源仍在跑/崩溃轮/采集失败)
 *     → 拷同一个树 outbox 目录的当前内容到 <ws>/inbox/upstream/<producer>/
 *       (内容此刻可变,链会让下游读到半成品)。
 * 下游启动时 inbox 里就有上游整包(产物随 contract 流转);多上游各一包,互不覆盖。
 *
 * 整段 try/catch 吞错,绝不抛(失败不破坏 before_agent_start / inbox 投递)。
 *
 * @param {{ contractId?:string|null, agentId?:string|null }} params
 * @returns {Promise<{ copied:string[], packages:Array<{path:string,producer:string,files:string[],primary:string|null}> }>}
 *   copied   = 有正本文件流入(链或拷贝)的上游 producer 列表
 *   packages = 给 contract.json 的 upstreamPackages 指针:包路径 + 实投文件清单 + 主交付物
 */
export async function copyUpstreamArtifactsToInbox({ contractId, agentId, logger = null } = {}) {
  const EMPTY = { copied: [], packages: [] };
  try {
    const cid = typeof contractId === "string" ? contractId.trim() : "";
    const aid = typeof agentId === "string" ? agentId.trim() : "";
    if (!cid || !aid) return EMPTY;

    const contract = await readContractSnapshotById(cid).catch(() => null);
    const upstreamProducers = resolveUpstreamProducers(contract, aid);
    if (upstreamProducers.length === 0) return EMPTY;

    const ws = agentWorkspace(aid);
    if (!ws) return EMPTY;
    const upstreamRoot = join(ws, "inbox", "upstream");

    const failures = [];
    const copiedProducers = [];
    const packages = [];
    for (const { agentId: up, contractId: sourceCid } of upstreamProducers) {
      try {
      // 1) 链接优先:findSealedOutbox 的 agentId 提示未命中时会退回全参与者扫描,
      // 可能返回别的参与者的封包——归属核对 hit.agentId === up,别人的包零链接。
      const sealed = findSealedOutbox(sourceCid, { agentId: up });
      if (sealed && sealed.agentId === up) {
        const linkPath = join(upstreamRoot, up);
        try {
          await mkdir(upstreamRoot, { recursive: true });
          // 陈旧条目(前轮拷贝目录/旧链)先摘,再落链;树链规范:绝对路径目标。
          await rm(linkPath, { recursive: true, force: true });
          await symlink(sealed.outboxDir, linkPath, "dir");
          // 指针清单/主交付物从 seal 取(采集事实),异于拷贝路的落盘实况。
          const files = (Array.isArray(sealed.seal?.files) ? sealed.seal.files : [])
            .filter((name) => typeof name === "string" && name.trim())
            .sort();
          const declaredPrimary = typeof sealed.seal?.primary === "string" ? sealed.seal.primary : null;
          copiedProducers.push(up);
          packages.push({
            path: `upstream/${up}/`,
            producer: up,
            files,
            primary: declaredPrimary && files.includes(declaredPrimary) ? declaredPrimary : null,
          });
          continue;
        } catch (linkError) {
          // 链接失败与 seal 缺席同路:走树内正本拷贝回退。
          logger?.warn?.(`[mailbox] upstream link for ${up} (cid ${sourceCid}) fell back to copy: ${linkError?.message || linkError}`);
        }
      }

      // 2) 未封包窗:源仍在跑(评审中场上车)或采集失败,树 outbox 目录在但没有 seal。
      // 内容此刻可变,"终态不可变才可链"不满足 → 拷当前内容做快照。
      // 数据源仍是树内正本同一份,不经任何中转店:上下游永远只对着一个真值。
      // 目录名用登记原串 sourceHome.id(与 findSealedOutbox 同规矩):查询串可能是
      // 会话键派生的小写形态,大小写不敏感 FS 会掩盖,敏感 FS 上就是整包取不到。
      const sourceHome = resolveContractHome(sourceCid);
      const srcPkg = sourceHome ? participantOutboxDirFor(sourceHome, up, sourceHome.id || sourceCid) : null;
      if (!srcPkg || !existsSync(srcPkg)) continue; // 该上游本环未产出 → 跳过
      const enumErrors = [];
      // 树 outbox 里除了产物还住着平台自己的东西:控制载荷(seal.json /
      // runtime_result.json …)与点前缀隔离区(.migrated/.stale 的上一轮残件)。
      // 链路径不用管——链过去的是终态封包,seal.files 本身就是过滤后的清单;
      // 拷贝路直接枚举目录,不滤就会把这些一并送进下游 inbox 当成上游交付物。
      const files = (await listPackageFiles(srcPkg, srcPkg, enumErrors))
        .filter((f) => !f.relPath.split(sep).some((seg) => seg.startsWith(".")))
        .filter((f) => !isControlOutboxFile(basename(f.relPath)))
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
      // 存在但(部分)不可读的包记入 failures,后落 _MISSING.md,下游读 inbox 即知缺失。
      for (const e of enumErrors) failures.push({ producer: up, reason: `enumerate ${e.dir}: ${e.reason}` });
      if (files.length === 0) continue;

      const copiedRel = [];
      for (const f of files) {
        const dest = join(upstreamRoot, up, f.relPath);
        try {
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(f.absPath, dest);
          copiedRel.push(f.relPath);
        } catch (copyError) {
          failures.push({ producer: up, reason: `copy ${f.relPath}: ${copyError?.message || copyError}` });
        }
      }
      if (copiedRel.length === 0) continue;
      copiedProducers.push(up);

      // 指针带文件清单,不只带目录:下游 agent 手里只有 read(要确定路径),拿到一个目录
      // 名等于没有入口——live 实测它会连着猜四次文件名(metadata.json / brief.json /
      // input.md / result.json 全落空),还会拿 read 去读目录得到 EISDIR。
      //
      // primary 是**描述性**的(上游认为自己的主交付物是哪个),供下游导航;它不决定本环
      // 该交付什么——那是 expectations 的事。与实投清单取交集,不在其中就置 null
      // (给一个读不到的路径正是要消灭的病)。
      const sortedRel = copiedRel.sort();
      const declaredPrimary = readPackagePrimary(srcPkg);
      packages.push({
        path: `upstream/${up}/`,
        producer: up,
        files: sortedRel,
        primary: declaredPrimary && sortedRel.includes(declaredPrimary) ? declaredPrimary : null,
      });
      } catch (producerError) {
        // 单个上游出岔(畸形 agentId 让路径构造抛、树目录竞态摘除等)只毁它自己:
        // 记进 failures 落 _MISSING.md,其余上游照常流入。整批静默返回空正是要消灭的病。
        failures.push({ producer: up, reason: `upstream inflow failed: ${producerError?.message || producerError}` });
        logger?.warn?.(`[mailbox] upstream inflow for ${up} (cid ${sourceCid}) failed: ${producerError?.message || producerError}`);
      }
    }

    // 3) 链/拷贝/枚举失败可见化:落 inbox/upstream/_MISSING.md(下游读 inbox 即知道缺了谁)。
    await writeMissingMarkerFile(upstreamRoot, aid, cid, failures, logger);
    if (packages.length === 0) return { copied: copiedProducers, packages: [] };

    // 4) 可选导览:UPSTREAM_GUIDE.md(path+size+head 预览)落 upstream 根,写失败只降便利。
    await writeUpstreamGuideFile(upstreamRoot, packages, logger);
    return { copied: copiedProducers, packages };
  } catch (error) {
    // 整体失败兜底:绝不破坏 before_agent_start / inbox 投递,但记录(非静默)。
    logger?.warn?.(`[mailbox] copyUpstreamArtifactsToInbox failed (cid ${contractId}, agent ${agentId}): ${error?.message || error}`);
    return EMPTY;
  }
}
