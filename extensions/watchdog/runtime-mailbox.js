import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  readRouterOutboxManifest,
  resolveRouterHandlerForAgent,
  resolveRouterOutboxHandler,
} from "./lib/routing/runtime-mailbox-handler-registry.js";
import { getRouterWorkspace } from "./lib/routing/runtime-mailbox-transport.js";

// ── routeInbox ─────────────────────────────────────────────────────────────
// before_agent_start: stage the relevant shared execution contract into the agent inbox
export async function routeInbox(agentId, logger, options = {}) {
  const ws = getRouterWorkspace(agentId);
  if (!ws) return;

  const inboxDir = join(ws, "inbox");
  await mkdir(inboxDir, { recursive: true });
  const handler = resolveRouterHandlerForAgent(agentId);
  if (typeof handler?.routeInbox === "function") {
    await handler.routeInbox({ agentId, inboxDir, logger, ...options });
  }
}

// ── collectOutbox ──────────────────────────────────────────────────────────
// agent_end: read the agent outbox, validate the manifest, and collect artifacts
export async function collectOutbox(agentId, logger) {
  const ws = getRouterWorkspace(agentId);
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
    logger.info(`[router] collectOutbox(${agentId}): outbox empty`);
    return { collected: false };
  }
  const { manifest, manifestPath } = await readRouterOutboxManifest(outboxDir, logger);
  const handler = resolveRouterOutboxHandler(agentId, manifest);
  if (typeof handler?.collectOutbox !== "function") {
    return { collected: false };
  }
  const result = await handler.collectOutbox({ agentId, outboxDir, files, logger, manifest, manifestPath });
  return {
    ...(result || { collected: false }),
    routerHandlerId: handler.id,
    outboxManifest: manifest,
  };
}
