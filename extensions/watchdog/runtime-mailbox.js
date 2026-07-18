import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveMailboxHandlerForAgent,
  resolveMailboxOutboxHandler,
} from "./lib/routing/runtime-mailbox-handler-registry.js";
import { getMailboxWorkspace } from "./lib/routing/runtime-mailbox-transport.js";
import { copyUpstreamArtifactsToInbox } from "./lib/lifecycle/artifact-store.js";
import { normalizeContractIdentity } from "./lib/core/normalize.js";

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
  await mkdir(inboxDir, { recursive: true });
  const handler = resolveMailboxHandlerForAgent(agentId);
  if (typeof handler?.routeInbox === "function") {
    await handler.routeInbox({ agentId, inboxDir, logger, ...options });
  }

  // 上游产物整包流入本 agent inbox（产物随 contract 流转）。整段 try/catch 兜底，
  // 失败绝不破坏 inbox 投递主流程。
  try {
    const contractId = await resolveStagedContractId(inboxDir, options);
    if (contractId) {
      const { packages } = await copyUpstreamArtifactsToInbox({ contractId, agentId, logger });
      // FIX(B8-context-compression): gate on packages (not copied) so a compressed-only upstream
      // (all files overflowed → COMPRESSED_MANIFEST.md, zero copied) still gets its pointer.
      if (packages.length > 0) {
        logger?.info?.(`[mailbox] routeInbox(${agentId}): upstream packages → inbox/upstream/ [${packages.join(", ")}]`);
        // 在 contract.json 写 upstreamPackages 指针：agent 读 contract 即知道读哪些包
        // （相对自己 inbox，不跨路径）。写失败不影响已落盘的包。
        await writeUpstreamPackagesPointer(inboxDir, packages, logger);
      }
    }
  } catch (upstreamError) {
    logger?.warn?.(`[mailbox] routeInbox(${agentId}): upstream package copy skipped: ${upstreamError?.message || upstreamError}`);
  }
}

// 把 upstreamPackages 指针写进刚 stage 的 inbox/contract.json。
async function writeUpstreamPackagesPointer(inboxDir, packages, logger) {
  if (!Array.isArray(packages) || packages.length === 0) return;
  try {
    const contractPath = join(inboxDir, "contract.json");
    const raw = await readFile(contractPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    parsed.upstreamPackages = packages;
    await writeFile(contractPath, JSON.stringify(parsed, null, 2), "utf8");
  } catch (pointerError) {
    logger?.warn?.(`[mailbox] routeInbox: upstreamPackages pointer write skipped: ${pointerError?.message || pointerError}`);
  }
}

// ── collectOutbox ──────────────────────────────────────────────────────────
// agent_end: read the agent outbox and collect artifacts from the unified outbox protocol
export async function collectOutbox(agentId, logger) {
  const ws = getMailboxWorkspace(agentId);
  if (!ws) return { collected: false };

  const outboxDir = join(ws, "outbox");
  await mkdir(outboxDir, { recursive: true });

  let files;
  try {
    files = await readdir(outboxDir);
  } catch {
    return { collected: false };
  }

  if (files.length === 0) {
    logger.info(`[mailbox] collectOutbox(${agentId}): outbox empty`);
    return { collected: false };
  }
  const handler = resolveMailboxOutboxHandler(agentId);
  if (typeof handler?.collectOutbox !== "function") {
    return { collected: false };
  }
  const result = await handler.collectOutbox({ agentId, outboxDir, files, logger });
  return {
    ...(result || { collected: false }),
    routerHandlerId: handler.id,
  };
}
