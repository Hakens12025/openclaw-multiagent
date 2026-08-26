// lib/runtime-mailbox-outbox-helpers.js — shared runtime mailbox outbox helpers

import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { evictContractSnapshotByPath } from "../../store/contract-store.js";
import { ARTIFACT_TYPES, MESSAGE_DELIVERABLE_FILE, RUNTIME_RESULT_FILE } from "../../protocol/protocol-primitives.js";
import {
  normalizeStageCompletion,
  normalizeStageRunResult,
} from "../../stage/stage-results.js";
import { CONTROL_PLANE_PATHS } from "../../control-plane/control-plane-paths.js";
import { agentWorkspace } from "../../state.js";
import { resolvePhysicalWorkspacePath } from "../../state/state-agent-helpers.js";
import {
  OUTBOX_SEAL_FILENAME,
  isTreePhysicalPath,
  parseOutboxDirContractId,
  readOutboxSeal,
  sameContractIdentity,
  writeOutboxSeal,
} from "../../archive/outbox-seal.js";

const OUTPUT_DIR = CONTROL_PLANE_PATHS.outputDir;
// 控制载荷:出现在 outbox 里也不算交付物。遗留的双真值结果文件不再阻断采集
// (阻断正是这条路径上被拆掉的病),但它们仍然不是产物——排除,不交付。
// seal.json 是平台写的采集封条,同样排除。
const CONTROL_OUTBOX_FILE_NAMES = new Set([
  RUNTIME_RESULT_FILE,
  "stage_result.json",
  "contract_result.json",
  OUTBOX_SEAL_FILENAME,
]);

// 「这个文件算不算交付物」的单一判据。采集侧与搬运侧(评审上车、上游整包流入)
// 共用同一份名单——各自维护一份的话,同一个文件会在一处是产物、另一处不是。
export function isControlOutboxFile(fileName) {
  return CONTROL_OUTBOX_FILE_NAMES.has(String(fileName || ""));
}

export { OUTPUT_DIR };

export async function removeFileQuietly(path) {
  await unlink(path).catch(() => {});
  evictContractSnapshotByPath(path);
}

function listCommittedOutboxFiles(files) {
  return [...new Set((Array.isArray(files) ? files : [])
    .map((fileName) => typeof fileName === "string" ? fileName.trim() : "")
    .filter((fileName) => fileName && !CONTROL_OUTBOX_FILE_NAMES.has(fileName)))];
}

function inferImplicitArtifactType(fileName) {
  return fileName.toLowerCase().endsWith(".md")
    ? ARTIFACT_TYPES.TEXT_OUTPUT
    : "artifact";
}

function resolvePreferredPrimaryArtifactFile({ artifactFiles, explicitPrimaryFileName, activeContract }) {
  if (explicitPrimaryFileName && artifactFiles.includes(explicitPrimaryFileName)) {
    return explicitPrimaryFileName;
  }

  const contractOutputFileName = typeof activeContract?.output === "string" && activeContract.output.trim()
    ? basename(activeContract.output.trim())
    : null;
  if (contractOutputFileName && artifactFiles.includes(contractOutputFileName)) {
    return contractOutputFileName;
  }

  const markdownFile = artifactFiles.find((fileName) => fileName.toLowerCase().endsWith(".md"));
  if (markdownFile) {
    return markdownFile;
  }

  return artifactFiles[0] || null;
}

export async function readActiveInboxContract(agentId) {
  if (typeof agentId !== "string" || !agentId.trim()) {
    return null;
  }

  try {
    // agentWorkspace is config-aware (honors per-agent workspace overrides);
    // the previous hardcoded join silently read the wrong dir.
    const raw = await readFile(join(agentWorkspace(agentId), "inbox", "contract.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// 采集侧的 stage 兜底。回路运行时退役(2026-08-18)后 contract.pipelineStage 不再存在,
// 语义阶段单源收口到 contract.stageRuntime.currentStageId(阶段真值本来就归 stagePlan/
// stageRuntime,路由段只是回路推进时的第二份写法);stage 退到 agentId,round 不再由平台
// 代填——agent 若在 runtime_result.json 里自报 round,normalizeStageRunResult 照收。
export function buildStageDefaults(activeContract, agentId) {
  return {
    stage: agentId || null,
    round: null,
    semanticStageId: activeContract?.stageRuntime?.currentStageId || null,
  };
}

export function normalizeObservedStageRunResult(stageRunResult) {
  return normalizeStageRunResult(stageRunResult);
}

export async function materializeOutboxArtifacts({
  outboxDir,
  fileNames,
  logger,
  primaryFileName = null,
  mirrorOutputPath = null,
  treeOutboxDir = null,
} = {}) {
  const normalizedFiles = [...new Set((Array.isArray(fileNames) ? fileNames : []).filter(Boolean))];

  // 树模式(treeOutboxDir = outbox 的树内物理落点):树内文件即正本,采集只登记
  // 物理路径——零拷贝、零删源、零 contract.output 镜像。真目录模式(下方)是
  // 非合约轮/切链 fail-open 轮的回退路,行为原样。
  if (treeOutboxDir) {
    const pathByFile = new Map();
    const artifactPaths = [];
    const collected = [];
    for (const fileName of normalizedFiles) {
      // 点前缀条目(.stale/.migrated 等隔离区)整类排除;产物必须是普通文件——
      // 目录混进 seal.files/artifactPaths 会把隔离区封成交付凭据。
      if (fileName.startsWith(".")) continue;
      const physicalPath = join(treeOutboxDir, fileName);
      let entryStat = null;
      try {
        entryStat = await stat(physicalPath);
      } catch (statError) {
        logger?.warn?.(`[mailbox] collectOutbox: tree artifact unreadable ${fileName}: ${statError.message}`);
        continue;
      }
      if (!entryStat.isFile()) continue;
      pathByFile.set(fileName, physicalPath);
      artifactPaths.push(physicalPath);
      collected.push(fileName);
      logger?.info?.(`[mailbox] collectOutbox: ${fileName} collected in-tree (${physicalPath})`);
    }
    return {
      collected,
      artifactPaths,
      pathByFile,
      primaryArtifactPath: primaryFileName ? pathByFile.get(primaryFileName) || null : artifactPaths[0] || null,
    };
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const pathByFile = new Map();
  const artifactPaths = [];
  const collected = [];

  for (const fileName of normalizedFiles) {
    try {
      const src = join(outboxDir, fileName);
      const dest = join(OUTPUT_DIR, fileName);
      await copyFile(src, dest);
      pathByFile.set(fileName, dest);
      artifactPaths.push(dest);
      if (primaryFileName && fileName === primaryFileName && mirrorOutputPath && mirrorOutputPath !== dest) {
        await mkdir(dirname(mirrorOutputPath), { recursive: true });
        await copyFile(src, mirrorOutputPath);
        logger?.info?.(`[mailbox] collectOutbox: mirrored ${fileName} -> ${mirrorOutputPath}`);
      }
      await removeFileQuietly(src);
      collected.push(fileName);
      logger?.info?.(`[mailbox] collectOutbox: ${fileName} -> output/${fileName}`);
    } catch (error) {
      logger?.warn?.(`[mailbox] collectOutbox: failed to move ${fileName}: ${error.message}`);
    }
  }

  return {
    collected,
    artifactPaths,
    pathByFile,
    primaryArtifactPath: primaryFileName ? pathByFile.get(primaryFileName) || null : artifactPaths[0] || null,
  };
}

export function remapStageRunArtifacts(stageRunResult, pathByFile) {
  const runResult = normalizeStageRunResult(stageRunResult);
  if (!runResult) return null;
  const artifactMap = pathByFile instanceof Map ? pathByFile : new Map();
  const artifacts = runResult.artifacts.map((artifact) => {
    const fileName = basename(artifact.path);
    const materializedPath = artifactMap.get(fileName) || artifact.path;
    return {
      ...artifact,
      path: materializedPath,
    };
  });
  const explicitPrimary = runResult.primaryArtifactPath ? basename(runResult.primaryArtifactPath) : null;
  const primaryArtifactPath = explicitPrimary
    ? artifactMap.get(explicitPrimary) || runResult.primaryArtifactPath
    : artifacts.find((entry) => entry.primary)?.path || artifacts[0]?.path || null;
  return normalizeStageRunResult({
    ...runResult,
    artifacts,
    primaryArtifactPath,
  });
}

// 陈旧残件隔离目录:上一轮早退(缺 runtime_result)留下的产物移到这里,
// 移出采集视野但不删除——判错也能捞回来。
const STALE_QUARANTINE_DIR = ".stale";

// 本轮产物 vs 上一轮残件:未在 runtime_result 里声明的文件按 mtime 定界,
// 早于本会话起点的判定为残件(live 复现 2026-08-05:上一轮缺 runtime_result
// 早退留下的 md 被下一轮无归属采走并入包,污染下游 inbox/upstream)。
// sessionStartMs 缺失时不过滤(fail-open,与 isPathFreshForSession 同语义)。
async function partitionStaleImplicitFiles({ outboxDir, fileNames, sessionStartMs, activeContract, logger, agentId }) {
  // 基准三级(live 2026-08-05 逐轮实测定序):
  //   ① 会话起点——最准,但传参链路实测可能给出 0;
  //   ② 本轮合约 createdAt——语义最贴:"上一份合约的残件"必然早于本合约诞生;
  //   ③ runtime_result 落盘时刻减容差——最后兜底,容差取 2 分钟(产出与提交同期)。
  // 三级全缺 → fail-open(缺证据不冤枉本轮产物)。
  let baselineMs = Number(sessionStartMs) > 0 ? Number(sessionStartMs) : 0;
  let baselineSource = baselineMs > 0 ? "session_start" : null;
  if (!baselineMs) {
    const contractCreatedAt = Number(activeContract?.createdAt) || 0;
    if (contractCreatedAt > 0) {
      baselineMs = contractCreatedAt;
      baselineSource = "contract_created_at";
    }
  }
  if (!baselineMs) {
    try {
      const submitStats = await stat(join(outboxDir, RUNTIME_RESULT_FILE));
      baselineMs = submitStats.mtimeMs - 120_000;
      baselineSource = "runtime_result_mtime";
    } catch { /* 基准不可得 → 保持 fail-open */ }
  }
  if (!(baselineMs > 0)) {
    logger?.info?.(`[mailbox] collectOutbox(${agentId}): freshness gate open (no session baseline)`);
    return { fresh: fileNames, stale: [] };
  }
  const sessionStartMsResolved = baselineMs;
  const fresh = [];
  const stale = [];
  for (const fileName of fileNames) {
    try {
      const stats = await stat(join(outboxDir, fileName));
      (stats.mtimeMs >= sessionStartMsResolved ? fresh : stale).push(fileName);
    } catch {
      fresh.push(fileName);
    }
  }
  if (stale.length > 0) {
    logger?.warn?.(`[mailbox] collectOutbox(${agentId}): quarantined ${stale.length} stale outbox file(s) from an earlier contract (baseline=${baselineSource}): ${stale.join(", ")}`);
    const quarantineDir = join(outboxDir, STALE_QUARANTINE_DIR);
    await mkdir(quarantineDir, { recursive: true }).catch(() => {});
    for (const fileName of stale) {
      await rename(join(outboxDir, fileName), join(quarantineDir, `${Date.now()}-${fileName}`)).catch(() => {});
    }
  }
  return { fresh, stale };
}

// 树模式鲜度门:mtime >= 会话起点的文件才进本轮采集视野。纯过滤——零 rename、
// 零删除、零隔离目录,树内文件全部原地留档(树即归档,判错也能捞回)。
// 覆盖三类越轮混采:回投轮收上轮产物、借道轮收宿主产物、宿主下轮收借道残件。
// sessionStartMs<=0(无会话起点)时不过滤(保守:缺证据不冤枉本轮产物)。
async function filterTreeFreshImplicitFiles({ treeOutboxDir, fileNames, sessionStartMs, logger, agentId }) {
  const baselineMs = Number(sessionStartMs) > 0 ? Number(sessionStartMs) : 0;
  if (!(baselineMs > 0)) {
    return { fresh: fileNames, stale: [] };
  }
  const fresh = [];
  const stale = [];
  for (const fileName of fileNames) {
    try {
      const stats = await stat(join(treeOutboxDir, fileName));
      (stats.mtimeMs >= baselineMs ? fresh : stale).push(fileName);
    } catch {
      fresh.push(fileName);
    }
  }
  if (stale.length > 0) {
    logger?.info?.(`[mailbox] collectOutbox(${agentId}): ${stale.length} earlier-round tree file(s) left in place, outside this round's collection: ${stale.join(", ")}`);
  }
  return { fresh, stale };
}

// seal 短路的幂等回放:第二次采集不再扫文件/不再解析声明,按封条原样重建观测。
// declaredStatus 只在封条记着 agent 显式声明时回放 explicitRuntimeResult。
function buildSealedCollectionResult({ agentId, treeOutboxDir, seal, activeContract }) {
  const defaults = buildStageDefaults(activeContract, agentId);
  const fileNames = (Array.isArray(seal.files) ? seal.files : [])
    .filter((name) => typeof name === "string" && name.trim());
  const primaryName = typeof seal.primary === "string" && fileNames.includes(seal.primary)
    ? seal.primary
    : null;
  const artifacts = fileNames.map((name) => ({
    type: inferImplicitArtifactType(name),
    path: join(treeOutboxDir, name),
    label: name,
    required: true,
    primary: name === primaryName,
  }));
  const artifactPaths = artifacts.map((artifact) => artifact.path);
  const primaryArtifactPath = primaryName ? join(treeOutboxDir, primaryName) : artifactPaths[0] || null;
  const stageRunResult = normalizeObservedStageRunResult(normalizeStageRunResult({
    status: typeof seal.declaredStatus === "string" && seal.declaredStatus ? seal.declaredStatus : "completed",
    artifacts,
    primaryArtifactPath,
  }, defaults));
  return {
    collected: true,
    sealed: true,
    files: fileNames,
    artifactPaths,
    primaryOutputPath: primaryArtifactPath,
    stageRunResult,
    stageCompletion: normalizeStageCompletion(null, stageRunResult?.completion || {}),
    explicitRuntimeResult: Boolean(seal.declaredStatus),
  };
}

export async function collectRuntimeResult({
  agentId,
  outboxDir,
  files,
  logger,
  activeContract,
  sessionStartMs = 0,
  declaredOutput = null,
  sessionKey = null,
  turnSucceeded = true,
  messageText = null,
} = {}) {
  const outboxFiles = Array.isArray(files) ? files : [];
  // 树模式判定按【物理落点】走:staging 已切链的 outbox 物理住在树店内。
  // 谱系轮但切链 fail-open 的现场物理仍在 workspace → 真目录模式,拷贝/镜像/
  // 新鲜度门原样生效——判定与切链结果自洽,两半永不错位。
  const physicalOutboxDir = resolvePhysicalWorkspacePath(outboxDir);
  const treeOutboxDir = isTreePhysicalPath(physicalOutboxDir) ? physicalOutboxDir : null;
  // 采集不要求提交令牌。要求 agent 额外写一个约定文件名才肯收它的产出,是把平台自己
  // 的记账义务外包给 agent——live 实测这条闸让写对了内容的轮次整轮判空,连正文里合法
  // 的 [ACTION] 标记都随文件一起静默消失。
  //
  // 拆开看,runtime_result 四件职责里只有一件平台不可能自己知道:status 的
  // "failed"(收口按声明转述;awaiting_input/hold 已随假等待态一并删除)。
  // stage/semanticStageId 有 buildStageDefaults;artifacts 有 implicit 采集兜底;
  // "completed" 本就不被信任(:255,284 仍要另判产物证据)。那一件由工具承载。
  //
  // 文件保留为降级路:写了就读,读坏了只丢它自己的声明,不牵连整轮交付。
  const hasSubmitToken = outboxFiles.includes(RUNTIME_RESULT_FILE);

  try {
    // 封条身份三绑定(写端/回放端;读端归属核对在 findSealedOutbox):
    //   身份基准 = 树 outbox 目录末段 outbox-{cid} 的 cid(parseOutboxDirContractId
    //   单一来源)。只有 activeContract.id 与目录身份一致的轮(ownsTreeOutbox)
    //   才写/才 unlink 封条——借道轮(D7 留链的无谱系/直达信封轮)对宿主封条零触碰。
    //   回放仅在 seal.contractId 与本轮合约、seal.sessionKey 与本轮会话双双匹配时
    //   成立;合约同而会话异 = 回投/沿回边再来一轮,旧封条让位,本轮重新采集重封;
    //   合约异 = 封条归别人,原样留在场,本轮走鲜度过滤采集且零封。
    //   崩溃轮(turnSucceeded=false)跳过回放与封条处置走正常采集——封条是终局
    //   凭据,崩溃轮的观测只作证据,终局判定留给 retry 轮的重采。
    const normalizedSessionKey = typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
    const treeDirContractId = treeOutboxDir ? parseOutboxDirContractId(treeOutboxDir) : null;
    const ownsTreeOutbox = Boolean(
      treeOutboxDir && activeContract?.id && sameContractIdentity(treeDirContractId, activeContract.id),
    );
    if (treeOutboxDir && turnSucceeded !== false) {
      const existingSeal = readOutboxSeal(treeOutboxDir);
      if (existingSeal) {
        const sealSessionKey = typeof existingSeal.sessionKey === "string" && existingSeal.sessionKey.trim()
          ? existingSeal.sessionKey.trim()
          : null;
        if (activeContract?.id && sameContractIdentity(existingSeal.contractId, activeContract.id)) {
          if (sealSessionKey === normalizedSessionKey) {
            logger?.info?.(`[mailbox] collectOutbox(${agentId}): outbox already sealed — idempotent replay`);
            return buildSealedCollectionResult({ agentId, treeOutboxDir, seal: existingSeal, activeContract });
          }
          if (ownsTreeOutbox) {
            logger?.info?.(`[mailbox] collectOutbox(${agentId}): seal from earlier session superseded — this round collects and reseals`);
            await unlink(join(treeOutboxDir, OUTBOX_SEAL_FILENAME)).catch(() => {});
          }
        } else {
          logger?.warn?.(`[mailbox] collectOutbox(${agentId}): seal belongs to contract ${existingSeal.contractId || "(unknown)"} — left untouched, this round collects unsealed`);
        }
      }
    }

    const defaults = buildStageDefaults(activeContract, agentId);
    // parsed 是提交文件的原文对象,后面 stageCompletion 等读取要用它;
    // 没有提交时留空对象,让那些读取自然落空而不是抛错。
    let parsed = {};
    let submitted = null;
    if (hasSubmitToken) {
      let unusableReason = null;
      try {
        parsed = JSON.parse(await readFile(join(outboxDir, RUNTIME_RESULT_FILE), "utf8")) || {};
        submitted = normalizeStageRunResult(parsed, defaults);
        if (!submitted) unusableReason = "not a JSON object";
      } catch (parseError) {
        unusableReason = parseError?.message || String(parseError);
      }
      if (unusableReason) {
        logger?.warn?.(
          `[mailbox] collectOutbox(${agentId}): ${RUNTIME_RESULT_FILE} unusable (${unusableReason}) — `
          + "collecting on defaults; any status declared in it is lost",
        );
      }
    }
    // 梯子:L1(submit_output 工具)> L3(runtime_result.json 文件)> 无声明(按产物证据推断)。
    // 工具声明只覆写它真正表达的那三个字段,其余仍走文件/默认——因为工具刻意不接管
    // artifacts,产物永远以 outbox 扫描为准(声明 completed 不算数,contract-outcome
    // 仍要另判产物证据)。
    const declared = declaredOutput && typeof declaredOutput === "object" ? declaredOutput : null;
    const base = submitted || normalizeStageRunResult({}, defaults);
    const normalized = declared
      ? normalizeStageRunResult({
          ...base,
          status: declared.status,
          ...(declared.summary ? { summary: declared.summary } : {}),
          ...(declared.reason ? { feedback: declared.reason } : {}),
        }, defaults)
      : base;
    if (declared) {
      logger?.info?.(
        `[mailbox] collectOutbox(${agentId}): status from submit_output = ${declared.status}`
        + (hasSubmitToken ? ` (overrides ${RUNTIME_RESULT_FILE})` : ""),
      );
    }

    // 显式声明不能绕过控制载荷排除:把控制文件写进 artifacts[] 也不算产物。
    const declaredArtifactFiles = normalized.artifacts
      .map((artifact) => basename(artifact.path))
      .filter((fileName) => files.includes(fileName) && !CONTROL_OUTBOX_FILE_NAMES.has(fileName));
    const implicitCandidateFiles = listCommittedOutboxFiles(files).filter((fileName) => !declaredArtifactFiles.includes(fileName));
    // 树模式统一鲜度过滤:批③新鲜度门的"判定"半边在树内复活(退役的只是搬运/
    // rename/.stale 隔离)。同一 outbox-{cid} 目录会被多轮会话复用(回投/沿回边再来一轮/
    // 借道留链),mtime < 会话起点的文件是上轮或他轮的存量——原地留档,
    // 只移出本轮采集视野;seal.files 随过滤结果。
    const { fresh: implicitArtifactFiles } = treeOutboxDir
      ? await filterTreeFreshImplicitFiles({
          treeOutboxDir,
          fileNames: implicitCandidateFiles,
          sessionStartMs,
          logger,
          agentId,
        })
      : await partitionStaleImplicitFiles({
          outboxDir,
          fileNames: implicitCandidateFiles,
          sessionStartMs,
          activeContract,
          logger,
          agentId,
        });
    const artifactFiles = [...new Set([
      ...declaredArtifactFiles,
      ...implicitArtifactFiles,
    ])];

    // 消息面缺省交付:本轮文件清点为零而收官正文在场时,平台把正文物化成
    // message.md 进 outbox 链——此后封条/判定/搬运把它当普通交付物,零新协议。
    // 仅合约轮+成功收官轮;文件在场时文件优先,消息不与文件并列成产物。
    // 放在鲜度过滤之后:上轮残档在场但本轮零产出的轮次同样享有消息路。
    let messageDeliverable = false;
    const trimmedMessage = typeof messageText === "string" ? messageText.trim() : "";
    if (artifactFiles.length === 0 && trimmedMessage && activeContract?.id && turnSucceeded !== false) {
      const messageDir = treeOutboxDir || outboxDir;
      try {
        await writeFile(join(messageDir, MESSAGE_DELIVERABLE_FILE), `${trimmedMessage}\n`, "utf8");
        artifactFiles.push(MESSAGE_DELIVERABLE_FILE);
        messageDeliverable = true;
        logger?.info?.(
          `[mailbox] collectOutbox(${agentId}): message deliverable materialized (${trimmedMessage.length} chars)`,
        );
      } catch (materializeError) {
        logger?.warn?.(
          `[mailbox] collectOutbox(${agentId}): message deliverable write failed: ${materializeError?.message || materializeError}`,
        );
      }
    }

    // Collect external artifacts (absolute paths outside the outbox that exist on disk)
    const externalArtifacts = [];
    for (const artifact of normalized.artifacts) {
      const artPath = artifact.path;
      if (isAbsolute(artPath) && !files.includes(basename(artPath))) {
        try {
          await stat(artPath);
          externalArtifacts.push(artifact);
        } catch {
          // External file doesn't exist, skip
        }
      }
    }

    const primaryFileName = resolvePreferredPrimaryArtifactFile({
      artifactFiles,
      explicitPrimaryFileName: normalized.primaryArtifactPath ? basename(normalized.primaryArtifactPath) : null,
      activeContract,
    });
    // 树模式免镜像:交付判定/读面直接消费树内封包(seal.primary),
    // contract.output 地址只服务直写链路与真目录模式。
    const mirrorOutputPath = !treeOutboxDir && typeof activeContract?.output === "string" && activeContract.output.trim()
      ? activeContract.output.trim()
      : null;
    const materialized = await materializeOutboxArtifacts({
      outboxDir,
      fileNames: artifactFiles,
      logger,
      primaryFileName,
      mirrorOutputPath,
      treeOutboxDir,
    });
    // 没有提交令牌时这次 unlink 必然 ENOENT——取消强制之后它成了常态而非例外。
    // 树模式连声明文件也留在树里(采集证据随 run 归档,不删源)。
    if (!treeOutboxDir && hasSubmitToken) await removeFileQuietly(join(outboxDir, RUNTIME_RESULT_FILE));

    const remapped = remapStageRunArtifacts(normalized, materialized.pathByFile);
    const remappedArtifacts = Array.isArray(remapped?.artifacts) ? remapped.artifacts : [];
    const existingArtifactPaths = new Set(remappedArtifacts.map((artifact) => artifact.path));
    for (const fileName of materialized.collected) {
      const materializedPath = materialized.pathByFile.get(fileName);
      if (!materializedPath || existingArtifactPaths.has(materializedPath)) {
        continue;
      }
      remappedArtifacts.push({
        type: inferImplicitArtifactType(fileName),
        path: materializedPath,
        label: fileName,
        required: true,
        primary: materializedPath === materialized.primaryArtifactPath,
      });
      existingArtifactPaths.add(materializedPath);
    }

    const stageRunResult = normalizeObservedStageRunResult(normalizeStageRunResult({
      ...(remapped || normalized),
      artifacts: remappedArtifacts,
      primaryArtifactPath: materialized.primaryArtifactPath
        || remapped?.primaryArtifactPath
        || normalized.primaryArtifactPath
        || null,
    }));

    // Merge external artifacts into the stage run result
    if (externalArtifacts.length > 0 && stageRunResult) {
      const existingPaths = new Set(stageRunResult.artifacts.map((a) => a.path));
      for (const ext of externalArtifacts) {
        if (!existingPaths.has(ext.path)) {
          stageRunResult.artifacts.push(ext);
        }
      }
    }

    // 封包:树模式采集成功当刻写 seal(交付判定/读面的第一读序 + 二次采集幂等闸)。
    // 写端身份绑定(ownsTreeOutbox):合约 id 与目录身份一致 + 本轮会话成功收官
    // (turnSucceeded)才封。借道轮身份错配 → 零封,免得把宿主目录重封成己方
    // 归属;崩溃轮封条会让 crash-retry 重跑被幂等短路回放半截产物——崩溃轮
    // 产物留树无封条,retry 轮重采后才成终局。封条写失败只降级到"可被二次
    // 采集",不拦交付。
    if (ownsTreeOutbox && turnSucceeded !== false) {
      try {
        await writeOutboxSeal(treeOutboxDir, {
          contractId: activeContract.id,
          sessionKey: normalizedSessionKey,
          collectedAt: Date.now(),
          primary: primaryFileName && materialized.collected.includes(primaryFileName)
            ? primaryFileName
            : materialized.collected[0] || null,
          files: materialized.collected,
          declaredStatus: declared?.status || submitted?.status || null,
          ...(messageDeliverable ? { messageDeliverable: true } : {}),
        });
      } catch (sealError) {
        logger?.warn?.(`[mailbox] collectOutbox(${agentId}): seal write failed: ${sealError?.message || sealError}`);
      }
    }

    return {
      collected: true,
      files: materialized.collected,
      artifactPaths: stageRunResult?.artifacts.map((artifact) => artifact.path) || [],
      primaryOutputPath: stageRunResult?.primaryArtifactPath || null,
      stageRunResult,
      stageCompletion: normalizeStageCompletion(parsed.completion, stageRunResult?.completion || {}),
      // 这个标志是「本轮真有一份可用的提交声明」,hard-stop-terminalize.js:99 拿它
      // 当硬停会话能否判完成的闸。取消令牌之后 stageRunResult 恒有值,写死 true 会让
      // 那道闸的两个析取项同时恒真——什么都没声明的硬停会话会被判成 completed。
      // "agent 显式声明过本轮结果"——两条路任一成立即为真:L1 工具或 L3 文件。
      // hard-stop 收口闸靠它区分"真的交代了"与"平台按默认值兜出来的"。
      explicitRuntimeResult: Boolean(submitted) || Boolean(declared),
      ...(messageDeliverable ? { messageDeliverable: true } : {}),
    };
  } catch (error) {
    logger?.warn?.(`[mailbox] collectOutbox(${agentId}): collection failed: ${error.message}`);
    return { collected: false, error: error.message };
  }
}
