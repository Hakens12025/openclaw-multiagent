import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { atomicWriteFile } from "../../state.js";
import { cacheContractSnapshot } from "../../store/contract-store.js";
import {
  resolveMailboxHandlerForAgent,
  resolveMailboxOutboxHandler,
} from "./runtime-mailbox-handler-registry.js";
import { ensureRealMailboxDir, getMailboxWorkspace, healDanglingMailboxDir } from "./runtime-mailbox-transport.js";
import { copyUpstreamArtifactsToInbox } from "../../delivery/upstream-package-inflow.js";
import { normalizeContractIdentity } from "../../core/normalize.js";
import { readContractSnapshotById } from "../../contract/contracts.js";
import { normalizeLineage } from "../../contract/contract-lineage.js";
import { ensureRunScaffold, participantOutboxDirFor, resolveThreadsRoot } from "../../archive/thread-tree-store.js";
import { CONTROL_PLANE_PATHS } from "../../control-plane/control-plane-paths.js";
import { isTerminalContractStatus } from "../../core/runtime-status.js";
import { resolvePhysicalWorkspacePath } from "../../state/state-agent-helpers.js";

// 从刚 stage 的 inbox/contract.json 读 contractId（最可靠：whatever was actually staged）；
// 读不到则回退 options.contractIdHint。
async function resolveStagedContractId(inboxDir, options) {
  try {
    const raw = await readFile(join(inboxDir, "contract.json"), "utf8");
    const parsed = JSON.parse(raw);
    const id = normalizeContractIdentity(parsed?.id);
    if (id) return id;
  } catch {
    // inbox/contract.json 不存在或不可解析 → 回退 hint
  }
  return normalizeContractIdentity(options?.contractIdHint) || null;
}

// ── routeInbox ─────────────────────────────────────────────────────────────
// before_agent_start: stage the relevant shared execution contract into the agent inbox
export async function routeInbox(agentId, logger, options = {}) {
  const ws = getMailboxWorkspace(agentId);
  if (!ws) return;

  const inboxDir = join(ws, "inbox");
  // 本体链守卫(审查 2026-08-16):inbox 本体设计态恒真目录,staging 前先矫正非设计态链。
  await ensureRealMailboxDir(inboxDir, logger, agentId);
  const handler = resolveMailboxHandlerForAgent(agentId);
  if (typeof handler?.routeInbox === "function") {
    await handler.routeInbox({ agentId, inboxDir, logger, ...options });
  }

  const contractId = await resolveStagedContractId(inboxDir, options);

  // staging 切链:合约轮把 workspace outbox 本体做成指向树 outbox 目录的链,
  // agent 写 outbox/ 即直落树内正本。内部整段兜底,失败保真目录继续派工。
  await bindParticipantOutbox({ agentId, workspace: ws, contractId, logger });

  // 上游产物整包流入本 agent inbox（产物随 contract 流转）。整段 try/catch 兜底，
  // 失败绝不破坏 inbox 投递主流程。
  try {
    if (contractId) {
      // Stale-upstream self-clean (write side): staging a contract is the exact
      // moment the previous contract's upstream entries become stale — remove
      // them before re-materializing, so downstream agents only ever see the
      // current contract's packages. Symlinked entries (upstream/<producer> →
      // producer tree outbox) are safe here: Node rm removes the link itself,
      // it never descends into the link target, so producer tree outboxes stay
      // intact. Copied entries are re-materialized from the same producer tree
      // outbox on the next staging; crash-retry re-wakes the same session
      // without re-staging, so mid-run retries keep their upstream.
      await rm(join(inboxDir, "upstream"), { recursive: true, force: true });
      const { packages } = await copyUpstreamArtifactsToInbox({ contractId, agentId, logger });
      if (packages.length > 0) {
        logger?.info?.(`[mailbox] routeInbox(${agentId}): upstream packages → inbox/upstream/ [${packages.map((pkg) => `${pkg.producer}(${pkg.files.length} file(s))`).join(", ")}]`);
        // 在 contract.json 写 upstreamPackages 指针：agent 读 contract 即知道读哪些包
        // （相对自己 inbox，不跨路径）。写失败不影响已落盘的包。
        await writeUpstreamPackagesPointer(inboxDir, packages, logger);
      }
    }
  } catch (upstreamError) {
    logger?.warn?.(`[mailbox] routeInbox(${agentId}): upstream package copy skipped: ${upstreamError?.message || upstreamError}`);
  }
}

// 迁移隔离目录:staging 时刻仍留在真目录里的条目定义上属于前轮残件(本轮尚未开工),
// 归树时进 .migrated/,点前缀在采集侧整类排除 —— 残件随 run 归档可追,永不入交付。
const MIGRATED_QUARANTINE_DIR = ".migrated";

// 真值域同域判定(切链前置门):workspace outbox 链目标住在树店根之下,
// 两端必须同属一个真值域,否则真 workspace 的 outbox 会被链进测试种子树,
// 种子树被清场时真产物随之消失(2026-08 live 事故)。同域 =
//   ① 树根即生产根(未种子/种子指回生产)——生产对生产;
//   ② workspace 物理落点在 os.tmpdir() 物理根之下——沙箱对沙箱。
// 混域(真 workspace + 种子树根)→ false,调用方保真目录 fail-open。
export function isSameTruthDomain(workspaceDir) {
  const treeRoot = resolveThreadsRoot();
  if (treeRoot === CONTROL_PLANE_PATHS.threadsDir) return true;
  const treeRootPhysical = resolvePhysicalWorkspacePath(treeRoot);
  const productionRootPhysical = resolvePhysicalWorkspacePath(CONTROL_PLANE_PATHS.threadsDir);
  if (treeRootPhysical && treeRootPhysical === productionRootPhysical) return true;
  const workspacePhysical = resolvePhysicalWorkspacePath(workspaceDir);
  const tmpRootPhysical = resolvePhysicalWorkspacePath(tmpdir());
  return Boolean(
    workspacePhysical
    && tmpRootPhysical
    && (workspacePhysical === tmpRootPhysical || workspacePhysical.startsWith(tmpRootPhysical + sep)),
  );
}

// 中场摘链守卫(D7):无谱系 staging 撞上仍指向活跃合约树 outbox 的链时,链必须留住——
// 中场摘链会把该合约前半产物滞留树内无 seal、后半落真目录,采集读序两头分裂。
// 判定:readlink 解析现链目标 → 从 outbox-{cid} 段取 cid → 读合约快照 →
// 非终态(pending/running)即活跃。终态/解析不出 → 照旧摘链恢复真目录。
async function isLinkTargetBoundToActiveContract(outboxDir) {
  const rawTarget = await readlink(outboxDir).catch(() => null);
  if (!rawTarget) return false;
  const targetName = basename(resolve(dirname(outboxDir), rawTarget));
  const match = targetName.match(/^outbox-(.+)$/);
  if (!match) return false;
  const snapshot = await readContractSnapshotById(match[1]).catch(() => null);
  const status = typeof snapshot?.status === "string" ? snapshot.status : null;
  return Boolean(status) && !isTerminalContractStatus(status);
}

// ── bindParticipantOutbox ─────────────────────────────────────────────────
// workspace outbox 本体的每轮处置(staging 时刻,幂等):
//   合约轮(正本带完整谱系) → outbox 本体 = 指向树 outbox 目录
//     threads/{t}/runs/{r}/participants/{agent}/outbox-{cid}/ 的 symlink
//     (树链规范:绝对路径目标;目录名用正本原串 id,查询串可能是小写形态)。
//     切链前的真目录条目逐个迁进树目录 .migrated/ 隔离区(staging 时刻在场的
//     都是前轮残件),EXDEV 时回退 copy+删源;已指向正确目标的链原样保留。
//   无 contractId/无谱系轮 → outbox 本体保真目录(直达信封等非合约轮的
//     atomicWriteFile/rename 需要真落点),遗留的链摘除后恢复真目录;
//     链仍指向活跃合约树 outbox 时留链(中场摘链守卫)。
//   混域(isSameTruthDomain=false) → skip 切链,保真目录 fail-open + 留痕。
// 任何一步失败 → warn + 保真目录继续(采集侧按物理落点自动走真目录模式,
// 派工链路照跑)。
export async function bindParticipantOutbox({ agentId, workspace, contractId, logger } = {}) {
  const outboxDir = join(workspace, "outbox");
  try {
    let lineage = null;
    let canonicalId = null;
    if (contractId) {
      const shared = await readContractSnapshotById(contractId).catch(() => null);
      const normalized = normalizeLineage(shared?.lineage);
      if (normalized?.threadId && normalized?.runId) {
        lineage = normalized;
        canonicalId = typeof shared?.id === "string" && shared.id.trim() ? shared.id.trim() : contractId;
      }
    }

    if (!lineage) {
      const bodyStat = await lstat(outboxDir).catch(() => null);
      if (bodyStat?.isSymbolicLink()) {
        if (await isLinkTargetBoundToActiveContract(outboxDir)) {
          logger?.info?.(`[mailbox] bindParticipantOutbox(${agentId}): non-lineage staging kept the live link — target contract is still active`);
          return { linked: false, reason: "active_contract_link_kept" };
        }
        await unlink(outboxDir);
        logger?.info?.(`[mailbox] bindParticipantOutbox(${agentId}): non-lineage round — outbox restored to a real dir`);
      }
      await mkdir(outboxDir, { recursive: true });
      return { linked: false, reason: contractId ? "no_lineage" : "no_contract" };
    }

    if (!isSameTruthDomain(workspace)) {
      logger?.info?.(`[mailbox] bindParticipantOutbox(${agentId}): link skipped — workspace and threads root live in different truth domains (seeded tree root ${resolveThreadsRoot()}); keeping a real outbox dir`);
      return { linked: false, reason: "truth_domain_mismatch" };
    }

    await ensureRunScaffold(lineage);
    const treeOutboxDir = participantOutboxDirFor(lineage, agentId, canonicalId);
    await mkdir(treeOutboxDir, { recursive: true });
    await mkdir(workspace, { recursive: true }); // 链本体的家目录必须先在

    const bodyStat = await lstat(outboxDir).catch(() => null);
    if (bodyStat?.isSymbolicLink()) {
      const rawTarget = await readlink(outboxDir).catch(() => null);
      const resolvedTarget = rawTarget ? resolve(dirname(outboxDir), rawTarget) : null;
      if (resolvedTarget === treeOutboxDir) {
        return { linked: true, treeOutboxDir, idempotent: true };
      }
      await unlink(outboxDir);
    } else if (bodyStat?.isDirectory()) {
      const entries = await readdir(outboxDir);
      const migratedDir = join(treeOutboxDir, MIGRATED_QUARANTINE_DIR);
      if (entries.length > 0) await mkdir(migratedDir, { recursive: true });
      for (const name of entries) {
        const src = join(outboxDir, name);
        const dest = join(migratedDir, name);
        try {
          await rename(src, dest);
        } catch (moveError) {
          if (moveError?.code === "EXDEV") {
            await cp(src, dest, { recursive: true });
            await rm(src, { recursive: true, force: true });
          } else {
            throw moveError;
          }
        }
      }
      await rmdir(outboxDir);
      if (entries.length > 0) {
        logger?.info?.(`[mailbox] bindParticipantOutbox(${agentId}): quarantined ${entries.length} pre-round outbox entrie(s) into ${migratedDir}`);
      }
    } else if (bodyStat) {
      // 本体是文件等异形态:摘掉后按链重建
      await unlink(outboxDir);
    }

    await symlink(treeOutboxDir, outboxDir, "dir");
    logger?.info?.(`[mailbox] bindParticipantOutbox(${agentId}): outbox → ${treeOutboxDir}`);
    return { linked: true, treeOutboxDir };
  } catch (bindError) {
    logger?.warn?.(`[mailbox] bindParticipantOutbox(${agentId}): link skipped (${bindError?.message || bindError}) — keeping a real outbox dir`);
    await mkdir(outboxDir, { recursive: true }).catch(() => {});
    return { linked: false, error: bindError?.message || String(bindError) };
  }
}

// 把 upstreamPackages 指针写进刚 stage 的 inbox/contract.json。
// 原子写(与隔壁 runtime-mailbox-inbox-handlers.js 的 stageInboxContract 一致):裸 writeFile 是
// truncate-then-write,被并发读撞上会读到半截 JSON。E-CONTRACT-006 的到达探测以这个指针为判据,
// 指针写坏会把一次正确投递记成 mismatch。
async function writeUpstreamPackagesPointer(inboxDir, packages, logger) {
  if (!Array.isArray(packages) || packages.length === 0) return;
  try {
    const contractPath = join(inboxDir, "contract.json");
    const raw = await readFile(contractPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    parsed.upstreamPackages = packages;
    await atomicWriteFile(contractPath, JSON.stringify(parsed, null, 2));
    // 落盘后刷新路径缓存,使缓存与磁盘一致:stage 时缓存的是"加指针前"的对象,
    // 而 direct_request 信封的 trackingState.contract.path 就是这个 inbox 路径,
    // 会被 preferCache:true 读到旧值(delivery-terminal.js:77、agent-end/contract-refresh.js:18)。
    cacheContractSnapshot(contractPath, parsed);
  } catch (pointerError) {
    logger?.warn?.(`[mailbox] routeInbox: upstreamPackages pointer write skipped: ${pointerError?.message || pointerError}`);
  }
}

// ── collectOutbox ──────────────────────────────────────────────────────────
// agent_end: read the agent outbox and collect artifacts from the unified outbox protocol
export async function collectOutbox(agentId, logger, { sessionStartMs = 0, declaredOutput = null, boundContractId = null, sessionKey = null, turnSucceeded = true, messageText = null } = {}) {
  const ws = getMailboxWorkspace(agentId);
  if (!ws) {
    // gateway agent 无 outbox 腿，这里是正常路径而非故障，因此只留痕、不置 error。
    logger?.info?.(`[mailbox] collectOutbox(${agentId}): skipped — no mailbox workspace (gateway agent)`);
    return { collected: false };
  }

  const outboxDir = join(ws, "outbox");
  await healDanglingMailboxDir(outboxDir, logger, agentId); // 悬链自愈(批④刀2):悬链会让 mkdir 拒建
  await mkdir(outboxDir, { recursive: true });

  let files;
  try {
    files = await readdir(outboxDir);
  } catch (readdirError) {
    const message = readdirError?.message || String(readdirError);
    logger?.warn?.(`[mailbox] collectOutbox(${agentId}): readdir failed on ${outboxDir}: ${message}`);
    return { collected: false, error: `outbox_readdir_failed: ${message}` };
  }

  // 消息面缺省交付:合约轮成功收官且正文在场时,空 outbox 不再是终点——继续走
  // 采集器,由它把正文物化成交付物(物化与鲜度/控制文件判定同点,单一真值)。
  const messageCandidate = typeof messageText === "string" && messageText.trim() ? messageText.trim() : null;
  const canMaterializeMessage = Boolean(messageCandidate && boundContractId && turnSucceeded !== false);
  if (files.length === 0 && !canMaterializeMessage) {
    logger.info(`[mailbox] collectOutbox(${agentId}): outbox empty`);
    return { collected: false };
  }
  const handler = resolveMailboxOutboxHandler(agentId);
  if (typeof handler?.collectOutbox !== "function") {
    // registry 回退链保证默认 handler 恒带 collectOutbox；命中此处即 registry 退化。
    logger?.warn?.(
      `[mailbox] collectOutbox(${agentId}): handler "${handler?.id || "none"}" exposes no collectOutbox — `
      + `${files.length} outbox file(s) left uncollected in ${outboxDir}`,
    );
    return { collected: false, error: `outbox_handler_missing: ${handler?.id || "none"}` };
  }
  const result = await handler.collectOutbox({ agentId, outboxDir, files, logger, sessionStartMs, declaredOutput, boundContractId, sessionKey, turnSucceeded, messageText: messageCandidate });
  return {
    ...(result || { collected: false }),
    routerHandlerId: handler.id,
  };
}
