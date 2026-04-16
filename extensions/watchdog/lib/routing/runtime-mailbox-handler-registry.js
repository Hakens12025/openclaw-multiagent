import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  OUTBOX_COMMIT_KINDS,
  normalizeOutboxCommitManifest,
} from "../protocol-primitives.js";
import {
  getRuntimeAgentConfig,
  hasExecutionPolicy,
  isExecutorAgent,
  isResearcherAgent,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";
import {
  routeWorkerInbox,
} from "./runtime-mailbox-inbox-handlers.js";
import {
  collectWorkerOutbox,
} from "./runtime-mailbox-outbox-handlers.js";
import { composeRuntimeCapabilityProfile } from "../effective-profile-composer.js";
import { normalizeString } from "../core/normalize.js";
import { getAgentCard } from "../store/agent-card-store.js";

const ROUTER_HANDLER_REGISTRY = Object.freeze([
  // All execution-layer agents use the unified executor_contract handler.
  {
    id: "executor_contract",
    kinds: [OUTBOX_COMMIT_KINDS.EXECUTION_RESULT, "worker_output", "executor_contract"],
    matchAgent: isExecutorAgent,
    routeInbox: (params) => routeWorkerInbox(params),
    collectOutbox: ({ agentId, outboxDir, files, logger, manifest }) => collectWorkerOutbox({
      agentId,
      outboxDir,
      files,
      logger,
      manifest,
    }),
    preserveInbox: () => false,
  },
  // research_search_space and evaluation_result handlers removed.
  // All execution-layer agents now use executor_contract handler.
]);

function normalizeManifestSelector(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  if (typeof manifest.handlerId === "string" && manifest.handlerId.trim()) {
    return { type: "handlerId", value: manifest.handlerId.trim() };
  }
  if (typeof manifest.kind === "string" && manifest.kind.trim()) {
    return { type: "kind", value: manifest.kind.trim() };
  }
  return null;
}

function resolveRouterHandlerByKind(kind) {
  const normalizedKind = normalizeString(kind);
  if (!normalizedKind) return null;
  return ROUTER_HANDLER_REGISTRY.find((handler) => Array.isArray(handler.kinds) && handler.kinds.includes(normalizedKind)) || null;
}

function readAgentRouterCapabilities(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    return { routerHandlerId: null, outboxCommitKinds: [] };
  }

  return composeRuntimeCapabilityProfile({
    agentId: normalizedAgentId,
    runtimeConfig: getRuntimeAgentConfig(normalizedAgentId),
    card: getAgentCard(normalizedAgentId),
  });
}

function resolveCapabilityRouterHandler(agentId) {
  const capabilities = readAgentRouterCapabilities(agentId);
  if (capabilities.routerHandlerId) {
    const handlerById = resolveRouterHandlerById(capabilities.routerHandlerId);
    if (handlerById) {
      return handlerById;
    }
  }

  for (const kind of capabilities.outboxCommitKinds) {
    const handlerByKind = resolveRouterHandlerByKind(kind);
    if (handlerByKind) {
      return handlerByKind;
    }
  }

  return null;
}

function resolveDefaultRouterHandler() {
  return resolveRouterHandlerById("executor_contract");
}

export function resolveRouterHandlerForAgent(agentId) {
  const capabilityHandler = resolveCapabilityRouterHandler(agentId);
  if (capabilityHandler) {
    return capabilityHandler;
  }

  return resolveDefaultRouterHandler();
}

function resolveRouterHandlerById(handlerId) {
  return ROUTER_HANDLER_REGISTRY.find((handler) => handler.id === handlerId) || null;
}

export function resolveAgentByRouterHandler(handlerId) {
  const normalizedHandlerId = normalizeString(handlerId);
  if (!normalizedHandlerId) return null;
  for (const agentId of listRuntimeAgentIds()) {
    if (readAgentRouterCapabilities(agentId).routerHandlerId === normalizedHandlerId) {
      return agentId;
    }
  }
  return null;
}

export async function readRouterOutboxManifest(outboxDir, logger) {
  const manifestPath = join(outboxDir, "_manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = normalizeOutboxCommitManifest(JSON.parse(raw));
    return manifest
      ? { manifest, manifestPath }
      : { manifest: null, manifestPath };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger?.warn?.(`[router] invalid outbox manifest ${manifestPath}: ${error.message}`);
    }
    return { manifest: null, manifestPath };
  }
}

export function resolveRouterOutboxHandler(agentId, manifest = null) {
  const selector = normalizeManifestSelector(manifest);
  if (selector) {
    const manifestHandler = selector.type === "handlerId"
      ? resolveRouterHandlerById(selector.value)
      : resolveRouterHandlerByKind(selector.value);
    if (manifestHandler) {
      return manifestHandler;
    }
  }
  return resolveRouterHandlerForAgent(agentId) || resolveDefaultRouterHandler();
}

export function shouldPreserveRouterInbox(agentId, executionObservation) {
  const handler = resolveRouterHandlerById(executionObservation?.routerHandlerId)
    || resolveRouterHandlerForAgent(agentId)
    || resolveDefaultRouterHandler();
  return handler?.preserveInbox?.(agentId, executionObservation?.collected === true) === true;
}
