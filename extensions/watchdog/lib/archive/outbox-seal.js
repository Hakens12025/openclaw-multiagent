// lib/archive/outbox-seal.js — 树 outbox 封包(seal)的读写与查找。
//
// seal.json 是采集封条,住在树 outbox 目录
// threads/{t}/runs/{r}/participants/{agent}/outbox-{cid}/seal.json,
// 载荷 {contractId,sessionKey,collectedAt,primary,files,declaredStatus}。
// 在场语义:①再次采集短路幂等返回;②交付判定与 delivery 读面以 seal.primary
// 为第一读序。树内产物文件是正本,seal 只记采集事实——两者同目录同生命周期,
// 随 run GC 整删,平时只增不改(采集成功当刻一次原子写)。
//
// 查找面全部同步(readFileSync/readdirSync):消费方包括同步热路径投影与
// suite 判定,统一同步签名免得读序分叉。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

import { atomicWriteFile } from "../state/state-file-utils.js";
import { resolvePhysicalWorkspacePath } from "../state/state-agent-helpers.js";
import {
  RUN_PARTICIPANTS_DIRNAME,
  resolveContractHome,
  resolveThreadsRoot,
  runDirFor,
} from "./thread-tree-store.js";

export const OUTBOX_SEAL_FILENAME = "seal.json";

// 树 outbox 目录身份:末段 `outbox-{cid}` 的 cid,解析单一来源。封条写端
// (collectRuntimeResult)与读端(findSealedOutbox)的归属核对都以此为准:
// 封条归目录身份合约所有,身份错配的轮次(借道采集)对封条零写零删。
export function parseOutboxDirContractId(outboxDir) {
  const name = typeof outboxDir === "string" ? basename(outboxDir) : "";
  return name.startsWith("outbox-") && name.length > "outbox-".length
    ? name.slice("outbox-".length)
    : null;
}

// 合约身份比对:目录名/封条用登记原串,查询串可能是会话键派生的小写形态,
// 统一按大小写不敏感比对(同名异例即同一合约)。
export function sameContractIdentity(a, b) {
  const left = typeof a === "string" ? a.trim().toLowerCase() : "";
  const right = typeof b === "string" ? b.trim().toLowerCase() : "";
  return Boolean(left) && left === right;
}

// 物理落点是否在树店根之下。判定走守卫同款 physicalize(symlink 逐跳解析),
// 因此 workspace outbox 链在切链后判 true、fail-open 保下来的真目录判 false ——
// 树模式与真目录模式的分流以这一个判定为准。
export function isTreePhysicalPath(inputPath) {
  const physical = resolvePhysicalWorkspacePath(inputPath);
  if (!physical) return false;
  const root = resolvePhysicalWorkspacePath(resolveThreadsRoot());
  return physical === root || physical.startsWith(root + sep);
}

// 采集成功当刻一次原子写。目录必须已在(树 outbox 由 staging 建),写失败由调用方兜。
export async function writeOutboxSeal(outboxDir, seal) {
  await atomicWriteFile(join(outboxDir, OUTBOX_SEAL_FILENAME), `${JSON.stringify(seal, null, 2)}\n`);
}

// seal 缺席/损坏一律 null:封条是幂等与读序的凭据,半截 JSON 不作数。
export function readOutboxSeal(outboxDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(outboxDir, OUTBOX_SEAL_FILENAME), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function orderedParticipantNames(participantsDir, agentId) {
  let names = [];
  try {
    names = readdirSync(participantsDir);
  } catch {
    return null;
  }
  return agentId ? [agentId, ...names.filter((name) => name !== agentId)] : names;
}

// 经 contract-index 找家 → 扫 participants/*/outbox-{cid}/seal.json。
// agentId(最后一跳受托人提示)给定且其封条在场 → 用之;否则扫描全参与者取
// seal.collectedAt 最新者 —— 多跳管线同 cid 有多份封条,字典序首个是上游中间跳,
// 时间序最新者才是终局采集事实。目录名一律用登记原串 home.id(查询串可能是
// 会话键派生的小写形态)。归属核对:seal.contractId 与查询 cid 错配的封条
// 一律跳过——目录名对上但载荷归属另一份合约的封条(借道轮/伪造残留)在读端
// 即失效,终局判定采信不到它。无家/无有效封条 → null,由调用方走回退读序。
export function findSealedOutbox(contractId, { agentId = null } = {}) {
  try {
    const home = contractId ? resolveContractHome(contractId) : null;
    if (!home) return null;
    const cid = home.id || contractId;
    const participantsDir = join(runDirFor(home), RUN_PARTICIPANTS_DIRNAME);
    const buildHit = (name, outboxDir, seal) => {
      const primaryName = typeof seal.primary === "string" && seal.primary.trim()
        ? seal.primary.trim()
        : null;
      return {
        agentId: name,
        outboxDir,
        seal,
        primaryPath: primaryName ? join(outboxDir, primaryName) : null,
      };
    };
    if (agentId) {
      const hintedDir = join(participantsDir, agentId, `outbox-${cid}`);
      const hintedSeal = readOutboxSeal(hintedDir);
      if (hintedSeal && sameContractIdentity(hintedSeal.contractId, cid)) {
        return buildHit(agentId, hintedDir, hintedSeal);
      }
    }
    let names = [];
    try {
      names = readdirSync(participantsDir);
    } catch {
      return null;
    }
    let latest = null;
    for (const name of names) {
      const outboxDir = join(participantsDir, name, `outbox-${cid}`);
      const seal = readOutboxSeal(outboxDir);
      if (!seal || !sameContractIdentity(seal.contractId, cid)) continue;
      const collectedAt = Number(seal.collectedAt) || 0;
      if (!latest || collectedAt > latest.collectedAt) {
        latest = { name, outboxDir, seal, collectedAt };
      }
    }
    return latest ? buildHit(latest.name, latest.outboxDir, latest.seal) : null;
  } catch {
    return null;
  }
}

// 产出件快照回退面:participants/*/delivery-{cid}.md(agent_end 清理前留档)。
// 写者 agent 名不定(末位实际执行者),agentId 已知时其目录优先,再扫其余参与者。
export function findDeliverySnapshotPath(contractId, { agentId = null } = {}) {
  try {
    const home = contractId ? resolveContractHome(contractId) : null;
    if (!home) return null;
    const cid = home.id || contractId;
    const participantsDir = join(runDirFor(home), RUN_PARTICIPANTS_DIRNAME);
    const ordered = orderedParticipantNames(participantsDir, agentId);
    if (!ordered) return null;
    for (const name of ordered) {
      const candidate = join(participantsDir, name, `delivery-${cid}.md`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
